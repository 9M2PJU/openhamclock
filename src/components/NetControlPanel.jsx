/**
 * NetControlPanel — run a voice net on a repeater or simplex frequency
 * (dockable panel `net-control`, also in the EmComm layout's rail).
 *
 *   • Start: pick a net from the Net Schedule or type name / frequency /
 *     net control callsign. Running timer and check-in counter.
 *   • Check-in line: type a callsign (+ optional flag letters) and Enter.
 *     Name/location fill from remembered stations, the logbook, then the
 *     callbook. Re-checks move a station to the top; duplicates are ignored.
 *   • Traffic queue with Next / Passed, logged to the EmComm event log.
 *   • Net script (preamble / closing) with placeholders, read-aloud view.
 *   • Close → report (copy text, CSV, print), history of past nets.
 *
 * All logic lives in utils/netControl.js; this component only wires state,
 * storage and side effects (event log, callbook lookups, downloads).
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FLAG_DEFS,
  parseCheckin,
  createNet,
  checkIn,
  checkOut,
  toggleFlag,
  updateStation,
  removeStation,
  undoLast,
  trafficQueue,
  passTraffic,
  nextTraffic,
  closeNet,
  buildReport,
  reportToText,
  reportToCsv,
  reportToPrintHtml,
  historyToCsv,
  flagsToText,
  formatElapsed,
  formatDuration,
  fillTemplate,
  scriptContext,
  stationFromLogbook,
  stationFromLookup,
  loadRunningNet,
  saveRunningNet,
  clearRunningNet,
  loadHistory,
  saveHistory,
  pushHistory,
  loadScript,
  saveScript,
  loadStationCache,
  saveStationCache,
  rememberStation,
  saveRosterSnapshot,
  DEFAULT_PREAMBLE,
  DEFAULT_CLOSING,
} from '../utils/netControl.js';
import { loadNetSchedule, sortByNextOccurrence } from '../utils/netSchedule.js';
import { formatMemoryFreq } from '../utils/freqMemories.js';
import { recordEvent } from '../utils/emcommEventLog.js';
import { apiFetch } from '../utils/apiFetch.js';
import { callbookAuthHeaders } from '../utils/callbookAuth.js';
import { spellPhonetic } from '../utils/phonetics.js';
import { init as initLogbook, getAll as getLogbookQsos } from '../services/logbookStore.js';

const ACCENT = '#14b8a6';

const inputStyle = {
  padding: '4px 6px',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: '3px',
  color: 'var(--text-primary)',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  minWidth: 0,
  width: '100%',
  boxSizing: 'border-box',
};

const btnStyle = {
  background: 'transparent',
  border: '1px solid var(--border-color)',
  borderRadius: '3px',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontSize: '10px',
  padding: '2px 6px',
  fontFamily: 'var(--font-mono)',
  whiteSpace: 'nowrap',
};

const primaryBtn = { ...btnStyle, borderColor: ACCENT, color: ACCENT, fontWeight: 700 };
const dangerBtn = { ...btnStyle, borderColor: '#ef4444', color: '#ef4444' };

const fmtUtcHHMM = (ts) => (ts == null ? '' : new Date(ts).toISOString().substring(11, 16));
const fmtDateTime = (ts) => {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ts).toISOString().substring(0, 16).replace('T', ' ');
  }
};

const baseCallOf = (call) => String(call || '').split('/')[0];

const downloadText = (text, filename, type = 'text/csv;charset=utf-8') => {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const printHtml = (html) => {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
};

const fileSlug = (s) =>
  String(s || 'net')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'net';

function FlagPill({ def, active, onClick, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={{
        background: active ? def.color : 'transparent',
        color: active ? '#000' : 'var(--text-muted)',
        border: `1px solid ${active ? def.color : 'var(--border-color)'}`,
        borderRadius: '3px',
        fontSize: '9px',
        fontWeight: 700,
        padding: '0 4px',
        lineHeight: '14px',
        cursor: onClick ? 'pointer' : 'default',
        fontFamily: 'var(--font-mono)',
      }}
    >
      {def.short}
    </button>
  );
}

export default function NetControlPanel({ callsign = '', embedded = false }) {
  const { t } = useTranslation();

  // ── State ─────────────────────────────────────────────────────────────
  const [net, setNet] = useState(loadRunningNet);
  const [history, setHistory] = useState(loadHistory);
  const [script, setScript] = useState(loadScript);
  const [view, setView] = useState('roster'); // roster | script | report | history
  const [reportNet, setReportNet] = useState(null); // closed net shown in the report view
  const [input, setInput] = useState('');
  const [pendingFlags, setPendingFlags] = useState([]);
  const [flash, setFlash] = useState(null); // { text, color }
  const [now, setNow] = useState(() => Date.now());
  const [scriptPart, setScriptPart] = useState('preamble');
  const [editingScript, setEditingScript] = useState(false);
  const [scriptDraft, setScriptDraft] = useState(null);
  const [readAloud, setReadAloud] = useState(false);
  const [startForm, setStartForm] = useState(() => ({ scheduleId: '', name: '', frequency: '', ncs: callsign || '' }));
  const [schedule, setSchedule] = useState(loadNetSchedule);
  const inputRef = useRef(null);
  const flashTimer = useRef(null);
  const stationCacheRef = useRef(null);
  const lookupsInFlight = useRef(new Set());
  const running = !!net;
  // Docked, the panel has a fixed height and its lists flex to fill it. In the
  // EmComm rail the height is auto, where flex:1 would collapse a scrolling
  // list to nothing — there the lists get a max height instead.
  const grow = embedded ? {} : { flex: 1, minHeight: 0 };

  // ── Effects ───────────────────────────────────────────────────────────
  // Logbook feeds name/location fills; init is idempotent.
  useEffect(() => {
    initLogbook().catch(() => {});
  }, []);

  // Running-net timer
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Persist the running net + mirror it into the EmComm roster store
  useEffect(() => {
    if (net) {
      saveRunningNet(net);
      saveRosterSnapshot(net, { active: true });
    }
  }, [net]);

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // Esc closes the read-aloud view
  useEffect(() => {
    if (!readAloud) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setReadAloud(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readAloud]);

  // Keep the NCS default in step with the station callsign until edited
  useEffect(() => {
    setStartForm((f) => (f.ncs ? f : { ...f, ncs: callsign || '' }));
  }, [callsign]);

  const sortedSchedule = useMemo(() => sortByNextOccurrence(schedule), [schedule]);
  const queue = useMemo(() => trafficQueue(net), [net]);
  // The called station only counts while it is still queued (not removed / checked out)
  const calling = net?.calling && queue.some((s) => s.call === net.calling) ? net.calling : null;
  const activeCount = useMemo(() => (net?.stations || []).filter((s) => s.checkoutTime == null).length, [net]);
  const totalCheckins = useMemo(() => (net?.stations || []).reduce((n, s) => n + 1 + (s.recheckCount || 0), 0), [net]);
  const report = useMemo(() => (reportNet ? buildReport(reportNet) : null), [reportNet]);
  const scriptText = useMemo(() => {
    const raw = scriptPart === 'closing' ? script.closing : script.preamble;
    return fillTemplate(raw, scriptContext(net || { name: startForm.name, ncs: startForm.ncs }, now));
  }, [script, scriptPart, net, startForm.name, startForm.ncs, now]);

  // ── Helpers ───────────────────────────────────────────────────────────
  const showFlash = useCallback((text, color = ACCENT) => {
    setFlash({ text, color });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 4000);
  }, []);

  const getStationCache = () => {
    if (!stationCacheRef.current) stationCacheRef.current = loadStationCache();
    return stationCacheRef.current;
  };

  const remember = (call, info) => {
    const next = rememberStation(getStationCache(), baseCallOf(call), info);
    if (next !== stationCacheRef.current) {
      stationCacheRef.current = next;
      saveStationCache(next);
    }
  };

  /** Instant local fill: previous nets first, then the logbook. */
  const localFill = (call) => {
    const base = baseCallOf(call);
    const cached = getStationCache()[base];
    if (cached && (cached.name || cached.location)) return { name: cached.name, location: cached.location };
    return stationFromLogbook(getLogbookQsos(), base);
  };

  /** Callbook lookup for a station still missing a name (best effort, offline-safe). */
  const lookupCallbook = async (call) => {
    const base = baseCallOf(call);
    if (lookupsInFlight.current.has(base)) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    lookupsInFlight.current.add(base);
    try {
      const res = await apiFetch(`/api/callsign/${encodeURIComponent(base)}`, {
        headers: callbookAuthHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res || !res.ok) return;
      const info = stationFromLookup(await res.json());
      if (!info) return;
      setNet((prev) => {
        if (!prev) return prev;
        const s = prev.stations.find((x) => x.call === call);
        if (!s) return prev;
        return updateStation(prev, call, {
          name: s.name || info.name,
          location: s.location || info.location,
        });
      });
      if (info.name) remember(call, info);
    } catch {
      /* offline / timeout — the row just stays without a name */
    } finally {
      lookupsInFlight.current.delete(base);
    }
  };

  // ── Actions ───────────────────────────────────────────────────────────
  const pickSchedule = (id) => {
    const entry = schedule.find((n) => n.id === id);
    if (!entry) {
      setStartForm((f) => ({ ...f, scheduleId: '' }));
      return;
    }
    const freq = entry.freq_mhz != null ? `${formatMemoryFreq(entry.freq_mhz)} MHz` : '';
    setStartForm((f) => ({
      ...f,
      scheduleId: id,
      name: entry.name,
      frequency: [freq, entry.mode].filter(Boolean).join(' '),
    }));
  };

  const startNet = (e) => {
    e?.preventDefault();
    const created = createNet({
      name: startForm.name,
      frequency: startForm.frequency,
      ncs: startForm.ncs || callsign,
      scheduleId: startForm.scheduleId || null,
    });
    if (!created) {
      showFlash(t('netControl.needName', { defaultValue: 'Give the net a name first' }), '#ef4444');
      return;
    }
    setNet(created);
    setView('roster');
    setReportNet(null);
    recordEvent('net_open', {
      callsign: created.ncs,
      summary: `Opened ${created.name}`,
      details: [created.frequency, created.ncs ? `NCS ${created.ncs}` : ''].filter(Boolean).join(' · '),
      ts: created.startTime,
    });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const submitCheckin = () => {
    if (!net) return;
    const parsed = parseCheckin(input);
    if (!parsed) {
      if (input.trim()) showFlash(t('netControl.notCall', { defaultValue: 'Not a callsign' }), '#ef4444');
      return;
    }
    const fill = localFill(parsed.call) || {};
    const flags = [...new Set([...parsed.flags, ...pendingFlags])];
    const res = checkIn(net, {
      call: parsed.call,
      flags,
      note: parsed.note,
      name: fill.name || '',
      location: fill.location || '',
    });
    setInput('');
    setPendingFlags([]);
    const st = res.station;
    if (res.result === 'duplicate') {
      showFlash(
        t('netControl.flashDuplicate', { defaultValue: '{{call}} is already checked in', call: st.call }),
        '#f59e0b',
      );
      return;
    }
    setNet(res.net);
    const label = [flagsToText(st.flags), st.name].filter(Boolean).join(' · ');
    if (res.result === 'new') {
      showFlash(
        t('netControl.flashNew', {
          defaultValue: '✓ {{call}} checked in (#{{n}})',
          call: st.call,
          n: res.net.stations.length,
        }),
      );
    } else if (res.result === 'recheck') {
      showFlash(t('netControl.flashRecheck', { defaultValue: '↻ {{call}} re-checked', call: st.call }));
    } else {
      showFlash(t('netControl.flashReturn', { defaultValue: '↩ {{call}} back in the net', call: st.call }));
    }
    recordEvent('net_checkin', {
      callsign: st.call,
      summary: `${res.result === 'new' ? 'Checked into' : 'Re-checked into'} ${net.name} (voice)`,
      details: label,
    });
    if (fill.name || fill.location) remember(st.call, fill);
    if (!st.name) lookupCallbook(st.call);
  };

  const onInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCheckin();
      return;
    }
    if (e.key === 'Escape') {
      setInput('');
      setPendingFlags([]);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && input === '') {
      e.preventDefault();
      doUndo();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      // e.code keeps working on macOS, where Alt+letter types a symbol
      const letter = (e.code || '').replace(/^Key/, '');
      const def = FLAG_DEFS.find((f) => f.letter === letter);
      if (def) {
        e.preventDefault();
        togglePending(def.key);
      } else if (letter === 'N') {
        e.preventDefault();
        callNext();
      }
    }
  };

  const togglePending = (key) =>
    setPendingFlags((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const doUndo = () => {
    if (!net?.undo?.length) return;
    setNet(undoLast(net));
    showFlash(t('netControl.flashUndo', { defaultValue: 'Undone' }), '#f59e0b');
  };

  const doCheckOut = (call) => {
    const next = checkOut(net, call);
    if (next === net) return;
    setNet(next);
    recordEvent('net_checkout', { callsign: call, summary: `Checked out of ${net.name} (voice)` });
  };

  const doToggleFlag = (call, key) => setNet((prev) => (prev ? toggleFlag(prev, call, key) : prev));

  const doRemove = (call) => {
    setNet((prev) => (prev ? removeStation(prev, call) : prev));
    showFlash(t('netControl.flashRemoved', { defaultValue: '{{call}} removed — Undo to restore', call }), '#f59e0b');
  };

  const callNext = () => {
    if (!net) return;
    const next = nextTraffic(net);
    if (next !== net) setNet(next);
    if (!next.calling) showFlash(t('netControl.queueEmpty', { defaultValue: 'No traffic waiting' }), '#f59e0b');
  };

  const doPassTraffic = (call) => {
    const next = passTraffic(net, call);
    if (next === net) return;
    setNet(next);
    const s = next.stations.find((x) => x.call === call);
    recordEvent('net_traffic', {
      callsign: call,
      summary: `Traffic passed on ${net.name}`,
      details: [s?.name, s?.note].filter(Boolean).join(' · '),
    });
  };

  const doCloseNet = () => {
    if (!net) return;
    if (
      !window.confirm(
        t('netControl.confirmClose', { defaultValue: 'Close {{name}} and produce the net report?', name: net.name }),
      )
    )
      return;
    const closed = closeNet(net);
    const rep = buildReport(closed);
    const nextHistory = pushHistory(history, closed);
    setHistory(nextHistory);
    saveHistory(nextHistory);
    saveRosterSnapshot(closed, { active: false });
    for (const s of closed.stations) if (s.name || s.location) remember(s.call, s);
    recordEvent('net_close', {
      callsign: closed.ncs,
      summary: `Closed ${closed.name}: ${rep.uniqueStations} stations, ${rep.totalCheckins} check-ins, ${rep.trafficCount} traffic`,
      details: `${formatDuration(rep.durationMs)}${closed.frequency ? ` · ${closed.frequency}` : ''}`,
      ts: closed.endTime,
    });
    clearRunningNet();
    setNet(null);
    setReportNet(closed);
    setView('report');
  };

  const copyReport = async () => {
    if (!report) return;
    const text = reportToText(report);
    try {
      await navigator.clipboard.writeText(text);
      showFlash(t('netControl.copied', { defaultValue: 'Report copied' }));
    } catch {
      downloadText(text, `${fileSlug(report.name)}-report.txt`, 'text/plain;charset=utf-8');
    }
  };

  const downloadReportCsv = () => {
    if (!report) return;
    const day = new Date(report.startTime).toISOString().substring(0, 10);
    downloadText(reportToCsv(report), `${fileSlug(report.name)}-${day}.csv`);
  };

  const deleteHistory = (id) => {
    const next = history.filter((h) => h.id !== id);
    setHistory(next);
    saveHistory(next);
    if (reportNet?.id === id) setReportNet(null);
  };

  const clearAllHistory = () => {
    if (!window.confirm(t('netControl.confirmClearHistory', { defaultValue: 'Delete all past nets?' }))) return;
    setHistory([]);
    saveHistory([]);
  };

  const beginEditScript = () => {
    setScriptDraft({ ...script });
    setEditingScript(true);
  };
  const saveScriptDraft = () => {
    setScript(scriptDraft);
    saveScript(scriptDraft);
    setEditingScript(false);
  };
  const resetScriptPart = () =>
    setScriptDraft((d) => ({
      ...d,
      [scriptPart]: scriptPart === 'closing' ? DEFAULT_CLOSING : DEFAULT_PREAMBLE,
    }));

  // ── Render pieces ─────────────────────────────────────────────────────
  const tabBtn = (id, label) => (
    <button
      key={id}
      type="button"
      onClick={() => setView(id)}
      style={{
        ...btnStyle,
        borderColor: view === id ? ACCENT : 'var(--border-color)',
        color: view === id ? ACCENT : 'var(--text-secondary)',
      }}
    >
      {label}
    </button>
  );

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '6px',
        marginBottom: '6px',
        fontSize: '11px',
        color: 'var(--accent-primary)',
        fontWeight: 700,
      }}
    >
      {!embedded && <span>🎙️ {t('netControl.title', { defaultValue: 'NET CONTROL' })}</span>}
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginLeft: embedded ? 0 : 'auto' }}>
        {tabBtn(
          'roster',
          running
            ? t('netControl.tabNet', { defaultValue: 'Net' })
            : t('netControl.tabStart', { defaultValue: 'Start' }),
        )}
        {tabBtn('script', t('netControl.tabScript', { defaultValue: 'Script' }))}
        {report && tabBtn('report', t('netControl.tabReport', { defaultValue: 'Report' }))}
        {tabBtn(
          'history',
          `${t('netControl.tabHistory', { defaultValue: 'History' })}${history.length ? ` (${history.length})` : ''}`,
        )}
      </div>
    </div>
  );

  const flashLine = flash && (
    <div style={{ color: flash.color, fontSize: '11px', fontWeight: 600, minHeight: '14px', marginTop: '3px' }}>
      {flash.text}
    </div>
  );

  const renderStart = () => (
    <form onSubmit={startNet} style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '10px' }}>
      {sortedSchedule.length > 0 && (
        <select
          style={inputStyle}
          value={startForm.scheduleId}
          onChange={(e) => pickSchedule(e.target.value)}
          onFocus={() => setSchedule(loadNetSchedule())}
          aria-label={t('netControl.fromSchedule', { defaultValue: 'From Net Schedule' })}
        >
          <option value="">{t('netControl.fromSchedule', { defaultValue: 'From Net Schedule' })}…</option>
          {sortedSchedule.map(({ net: n, next }) => (
            <option key={n.id} value={n.id}>
              {n.name}
              {next?.onNow ? ` — ${t('netControl.onNow', { defaultValue: 'ON NOW' })}` : ''}
            </option>
          ))}
        </select>
      )}
      <input
        style={inputStyle}
        value={startForm.name}
        maxLength={80}
        onChange={(e) => setStartForm((f) => ({ ...f, name: e.target.value }))}
        placeholder={t('netControl.namePlaceholder', { defaultValue: 'Net name (e.g. County ARES Weekly Net)' })}
        aria-label={t('netControl.namePlaceholder', { defaultValue: 'Net name (e.g. County ARES Weekly Net)' })}
      />
      <input
        style={inputStyle}
        value={startForm.frequency}
        maxLength={80}
        onChange={(e) => setStartForm((f) => ({ ...f, frequency: e.target.value }))}
        placeholder={t('netControl.freqPlaceholder', {
          defaultValue: 'Frequency / repeater (e.g. 146.940 − PL 100.0)',
        })}
        aria-label={t('netControl.freqPlaceholder', {
          defaultValue: 'Frequency / repeater (e.g. 146.940 − PL 100.0)',
        })}
      />
      <input
        style={{ ...inputStyle, textTransform: 'uppercase' }}
        value={startForm.ncs}
        maxLength={15}
        onChange={(e) => setStartForm((f) => ({ ...f, ncs: e.target.value.toUpperCase() }))}
        placeholder={t('netControl.ncsPlaceholder', { defaultValue: 'Net control callsign' })}
        aria-label={t('netControl.ncsPlaceholder', { defaultValue: 'Net control callsign' })}
      />
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <button type="submit" style={{ ...primaryBtn, padding: '4px 12px', fontSize: '11px' }}>
          ▶ {t('netControl.start', { defaultValue: 'Start net' })}
        </button>
        <button type="button" style={btnStyle} onClick={() => setView('script')}>
          {t('netControl.previewScript', { defaultValue: 'Preview script' })}
        </button>
      </div>
      {flashLine}
    </form>
  );

  const renderRunning = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', ...grow }}>
      {/* Net status */}
      <div
        style={{
          border: `1px solid ${ACCENT}`,
          borderRadius: '4px',
          padding: '5px 7px',
          background: 'var(--bg-tertiary)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px' }}>
          <span
            style={{
              color: 'var(--text-primary)',
              fontWeight: 700,
              fontSize: '12px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={net.name}
          >
            {net.name}
          </span>
          <span
            style={{ color: ACCENT, fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: 700 }}
            title={t('netControl.elapsed', { defaultValue: 'Time since the net opened' })}
          >
            {formatElapsed(now - net.startTime)}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '6px',
            fontSize: '10px',
            color: 'var(--text-muted)',
            marginTop: '2px',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {[net.frequency, net.ncs ? `NCS ${net.ncs}` : ''].filter(Boolean).join(' · ')}
          </span>
          <span
            style={{ whiteSpace: 'nowrap' }}
            title={t('netControl.counterTitle', { defaultValue: 'Stations in the net / total check-ins' })}
          >
            <b style={{ color: 'var(--text-primary)', fontSize: '12px' }}>{activeCount}</b>{' '}
            {t('netControl.inNet', { defaultValue: 'in' })} · {totalCheckins}{' '}
            {t('netControl.checkins', { defaultValue: 'check-ins' })}
          </span>
        </div>
      </div>

      {/* Check-in line */}
      <div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <input
            ref={inputRef}
            style={{ ...inputStyle, fontSize: '14px', padding: '5px 7px', flex: 1 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t('netControl.checkinPlaceholder', { defaultValue: 'Callsign + Enter  (e.g. W1AW T)' })}
            aria-label={t('netControl.checkinLabel', { defaultValue: 'Check in a station' })}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" style={primaryBtn} onClick={submitCheckin}>
            {t('netControl.checkIn', { defaultValue: 'In' })}
          </button>
        </div>
        <div style={{ display: 'flex', gap: '3px', marginTop: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
          {FLAG_DEFS.map((def) => (
            <FlagPill
              key={def.key}
              def={def}
              active={pendingFlags.includes(def.key)}
              onClick={() => togglePending(def.key)}
              title={`${t(`netControl.flag.${def.key}`, { defaultValue: def.label })} — ${def.letter} / Alt+${def.letter}`}
            />
          ))}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={{ ...btnStyle, opacity: net.undo?.length ? 1 : 0.4 }}
            disabled={!net.undo?.length}
            onClick={doUndo}
            title={t('netControl.undoTitle', {
              defaultValue: 'Undo the last change (Ctrl+Z in an empty check-in box)',
            })}
          >
            ↶ {t('netControl.undo', { defaultValue: 'Undo' })}
          </button>
          <button type="button" style={dangerBtn} onClick={doCloseNet}>
            ■ {t('netControl.close', { defaultValue: 'Close net' })}
          </button>
        </div>
        {flashLine}
      </div>

      {/* Traffic queue */}
      {(queue.length > 0 || calling) && (
        <div style={{ border: '1px solid #ef444466', borderRadius: '4px', padding: '4px 6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px' }}>
            <span style={{ color: '#ef4444', fontWeight: 700 }}>
              {t('netControl.trafficQueue', { defaultValue: 'TRAFFIC' })} ({queue.length})
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={{ ...btnStyle, borderColor: '#ef4444', color: '#ef4444' }}
              onClick={callNext}
              title="Alt+N"
            >
              {t('netControl.next', { defaultValue: 'Next' })} ▶
            </button>
          </div>
          {calling && (
            <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    color: 'var(--text-primary)',
                    fontSize: '16px',
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {calling}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{spellPhonetic(calling)}</div>
              </div>
              <button type="button" style={primaryBtn} onClick={() => doPassTraffic(calling)}>
                ✓ {t('netControl.passed', { defaultValue: 'Passed' })}
              </button>
            </div>
          )}
          {queue
            .filter((s) => s.call !== calling)
            .map((s, i) => (
              <div
                key={s.call}
                style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px', marginTop: '2px' }}
              >
                <span style={{ color: 'var(--text-muted)', width: '14px' }}>{i + 1}.</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {s.call}
                </span>
                <span
                  style={{
                    color: 'var(--text-muted)',
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {s.note || s.name}
                </span>
                <button
                  type="button"
                  style={btnStyle}
                  onClick={() => doPassTraffic(s.call)}
                  title={t('netControl.passTitle', { defaultValue: 'Mark traffic passed' })}
                >
                  ✓
                </button>
              </div>
            ))}
        </div>
      )}

      {/* Roster */}
      <div style={{ overflowY: 'auto', ...grow, maxHeight: embedded ? '360px' : undefined }}>
        {net.stations.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '11px', padding: '8px 2px', lineHeight: 1.5 }}>
            {t('netControl.emptyHint', {
              defaultValue:
                'Type a callsign and press Enter. Add flag letters after it — T traffic, M mobile, S short time, R relay, I in-and-out — e.g. "W1AW TM" or "W1AW/M".',
            })}
          </div>
        ) : (
          net.stations.map((s) => {
            const out = s.checkoutTime != null;
            return (
              <div
                key={s.call}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '36px 1fr auto',
                  gap: '6px',
                  alignItems: 'center',
                  padding: '3px 4px',
                  borderBottom: '1px solid var(--border-color)',
                  opacity: out ? 0.45 : 1,
                  fontSize: '11px',
                }}
              >
                <span
                  style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '10px' }}
                  title="UTC"
                >
                  {fmtUtcHHMM(s.checkinTime)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 700,
                        color: out ? 'var(--text-muted)' : 'var(--text-primary)',
                        textDecoration: out ? 'line-through' : 'none',
                      }}
                    >
                      {s.call}
                    </span>
                    {s.recheckCount > 0 && (
                      <span
                        style={{ color: ACCENT, fontSize: '9px' }}
                        title={t('netControl.rechecks', { defaultValue: 'Re-checks' })}
                      >
                        ↻{s.recheckCount}
                      </span>
                    )}
                    {FLAG_DEFS.filter((d) => s.flags.includes(d.key) || !out).map((def) => (
                      <FlagPill
                        key={def.key}
                        def={def}
                        active={s.flags.includes(def.key)}
                        onClick={out ? undefined : () => doToggleFlag(s.call, def.key)}
                        title={t(`netControl.flag.${def.key}`, { defaultValue: def.label })}
                      />
                    ))}
                    {s.trafficPassed != null && (
                      <span style={{ color: '#22c55e', fontSize: '9px' }}>
                        ✓ {t('netControl.passedShort', { defaultValue: 'passed' })}
                      </span>
                    )}
                  </div>
                  {(s.name || s.location || s.note) && (
                    <div
                      style={{
                        color: 'var(--text-muted)',
                        fontSize: '10px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {[s.name, s.location, s.note].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '3px' }}>
                  {!out && (
                    <button
                      type="button"
                      style={btnStyle}
                      onClick={() => doCheckOut(s.call)}
                      title={t('netControl.checkOutTitle', { defaultValue: 'Check out' })}
                    >
                      {t('netControl.out', { defaultValue: 'Out' })}
                    </button>
                  )}
                  <button
                    type="button"
                    style={{ ...btnStyle, padding: '2px 4px' }}
                    onClick={() => doRemove(s.call)}
                    title={t('netControl.removeTitle', { defaultValue: 'Remove (mistyped call)' })}
                    aria-label={t('netControl.removeTitle', { defaultValue: 'Remove (mistyped call)' })}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  const renderScript = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', ...grow }}>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
        {['preamble', 'closing'].map((part) => (
          <button
            key={part}
            type="button"
            onClick={() => setScriptPart(part)}
            style={{
              ...btnStyle,
              borderColor: scriptPart === part ? ACCENT : 'var(--border-color)',
              color: scriptPart === part ? ACCENT : 'var(--text-secondary)',
            }}
          >
            {part === 'closing'
              ? t('netControl.closing', { defaultValue: 'Closing' })
              : t('netControl.preamble', { defaultValue: 'Preamble' })}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {editingScript ? (
          <>
            <button type="button" style={btnStyle} onClick={resetScriptPart}>
              {t('netControl.resetDefault', { defaultValue: 'Default' })}
            </button>
            <button type="button" style={btnStyle} onClick={() => setEditingScript(false)}>
              {t('netControl.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button type="button" style={primaryBtn} onClick={saveScriptDraft}>
              {t('netControl.save', { defaultValue: 'Save' })}
            </button>
          </>
        ) : (
          <>
            <button type="button" style={btnStyle} onClick={beginEditScript}>
              {t('netControl.edit', { defaultValue: 'Edit' })}
            </button>
            <button
              type="button"
              style={primaryBtn}
              onClick={() => {
                setNow(Date.now());
                setReadAloud(true);
              }}
            >
              ⛶ {t('netControl.readAloud', { defaultValue: 'Read aloud' })}
            </button>
          </>
        )}
      </div>
      {editingScript ? (
        <>
          <textarea
            style={{
              ...inputStyle,
              flex: 1,
              minHeight: '220px',
              resize: 'vertical',
              fontFamily: 'inherit',
              fontSize: '12px',
              lineHeight: 1.5,
            }}
            value={scriptDraft?.[scriptPart] ?? ''}
            onChange={(e) => setScriptDraft((d) => ({ ...d, [scriptPart]: e.target.value }))}
            aria-label={t('netControl.scriptLabel', { defaultValue: 'Net script' })}
          />
          <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
            {t('netControl.placeholders', {
              defaultValue: 'Placeholders: {net} {ncs} {freq} {date} {time} {count}',
            })}
          </div>
        </>
      ) : (
        <div
          style={{
            whiteSpace: 'pre-wrap',
            fontSize: '14px',
            lineHeight: 1.6,
            color: 'var(--text-primary)',
            overflowY: 'auto',
            ...grow,
            maxHeight: embedded ? '360px' : undefined,
          }}
        >
          {scriptText}
        </div>
      )}
    </div>
  );

  const renderReport = () => {
    if (!report) return null;
    const stat = (label, value) => (
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ color: 'var(--text-muted)' }}>{label}</span>
        <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
          {value}
        </span>
      </div>
    );
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', ...grow }}>
        <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '12px' }}>{report.name}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
          {stat(t('netControl.rNcs', { defaultValue: 'Net control' }), report.ncs || '—')}
          {report.frequency && stat(t('netControl.rFreq', { defaultValue: 'Frequency' }), report.frequency)}
          {stat(
            t('netControl.rTimes', { defaultValue: 'Opened – closed (UTC)' }),
            `${fmtUtcHHMM(report.startTime)} – ${fmtUtcHHMM(report.endTime)}`,
          )}
          {stat(t('netControl.rDuration', { defaultValue: 'Duration' }), formatDuration(report.durationMs))}
          {stat(t('netControl.rCheckins', { defaultValue: 'Check-ins' }), report.totalCheckins)}
          {stat(t('netControl.rUnique', { defaultValue: 'Unique stations' }), report.uniqueStations)}
          {stat(
            t('netControl.rTraffic', { defaultValue: 'Traffic (listed / passed)' }),
            `${report.trafficCount} / ${report.trafficPassed}`,
          )}
        </div>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          <button type="button" style={primaryBtn} onClick={copyReport}>
            {t('netControl.copyText', { defaultValue: 'Copy text' })}
          </button>
          <button type="button" style={btnStyle} onClick={downloadReportCsv}>
            CSV
          </button>
          <button type="button" style={btnStyle} onClick={() => printHtml(reportToPrintHtml(report))}>
            {t('netControl.print', { defaultValue: 'Print' })}
          </button>
          {!running && (
            <button type="button" style={btnStyle} onClick={() => setView('roster')}>
              {t('netControl.newNet', { defaultValue: 'New net' })}
            </button>
          )}
        </div>
        {flashLine}
        <div style={{ overflowY: 'auto', ...grow, maxHeight: embedded ? '300px' : undefined }}>
          {report.stations.map((s) => (
            <div
              key={s.call}
              style={{ display: 'flex', gap: '6px', padding: '2px 0', borderBottom: '1px solid var(--border-color)' }}
            >
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
                {fmtUtcHHMM(s.checkinTime)}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                  minWidth: '62px',
                }}
              >
                {s.call}
              </span>
              <span style={{ color: ACCENT, fontSize: '10px' }}>{flagsToText(s.flags)}</span>
              <span
                style={{
                  color: 'var(--text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {[s.name, s.location].filter(Boolean).join(', ')}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderHistory = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', ...grow }}>
      <div style={{ display: 'flex', gap: '4px' }}>
        <button
          type="button"
          style={{ ...btnStyle, opacity: history.length ? 1 : 0.4 }}
          disabled={!history.length}
          onClick={() =>
            downloadText(historyToCsv(history), `net-history-${new Date().toISOString().substring(0, 10)}.csv`)
          }
        >
          {t('netControl.exportAll', { defaultValue: 'Export all (CSV)' })}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={{ ...dangerBtn, opacity: history.length ? 1 : 0.4 }}
          disabled={!history.length}
          onClick={clearAllHistory}
        >
          {t('netControl.clearHistory', { defaultValue: 'Clear' })}
        </button>
      </div>
      <div style={{ overflowY: 'auto', ...grow, maxHeight: embedded ? '360px' : undefined }}>
        {history.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', padding: '6px 2px' }}>
            {t('netControl.noHistory', { defaultValue: 'Closed nets appear here.' })}
          </div>
        ) : (
          history.map((h) => (
            <div
              key={h.id}
              style={{
                display: 'flex',
                gap: '6px',
                alignItems: 'center',
                padding: '3px 2px',
                borderBottom: '1px solid var(--border-color)',
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setReportNet(h);
                  setView('report');
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  textAlign: 'left',
                  flex: 1,
                  minWidth: 0,
                  color: 'var(--text-primary)',
                }}
              >
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {h.name}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                  {fmtDateTime(h.startTime)} · {h.stations.length}{' '}
                  {t('netControl.stations', { defaultValue: 'stations' })} ·{' '}
                  {formatDuration((h.endTime ?? h.startTime) - h.startTime)}
                </div>
              </button>
              <button
                type="button"
                style={{ ...btnStyle, padding: '2px 4px' }}
                onClick={() => deleteHistory(h.id)}
                aria-label={t('netControl.deleteNet', { defaultValue: 'Delete this net' })}
                title={t('netControl.deleteNet', { defaultValue: 'Delete this net' })}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );

  const body =
    view === 'script'
      ? renderScript()
      : view === 'report' && report
        ? renderReport()
        : view === 'history'
          ? renderHistory()
          : running
            ? renderRunning()
            : renderStart();

  return (
    <div
      className={embedded ? undefined : 'panel'}
      style={{
        padding: embedded ? '6px 8px' : '8px',
        height: embedded ? undefined : '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {header}
      {body}
      {readAloud && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('netControl.readAloud', { defaultValue: 'Read aloud' })}
          onClick={() => setReadAloud(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10050,
            background: 'rgba(0,0,0,0.92)',
            color: '#f5f5f5',
            overflowY: 'auto',
            padding: 'clamp(16px, 5vw, 64px)',
            cursor: 'pointer',
          }}
        >
          <div style={{ maxWidth: '900px', margin: '0 auto' }}>
            <div style={{ color: ACCENT, fontSize: '14px', fontWeight: 700, marginBottom: '16px' }}>
              {scriptPart === 'closing'
                ? t('netControl.closing', { defaultValue: 'Closing' })
                : t('netControl.preamble', { defaultValue: 'Preamble' })}{' '}
              · {t('netControl.escToClose', { defaultValue: 'click or Esc to close' })}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 'clamp(20px, 2.6vw, 32px)', lineHeight: 1.55 }}>
              {scriptText}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { NetControlPanel };
