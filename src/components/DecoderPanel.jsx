/**
 * DecoderPanel — "what my receiver actually hears".
 *
 * Listens to the receiver's audio in the browser — a sound-card / line input
 * (getUserMedia) or a KiwiSDR relayed by Rig Bridge — shows it on a live
 * waterfall, and decodes CW with the AudioWorklet decoder
 * (src/utils/cwDecoder.js). Callsigns in the copy are clickable (callsign
 * popup, set DX) and can be logged to the local "My decodes" list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRig } from '../contexts/RigContext.jsx';
import { useCallsignPopup } from './CallsignPopupManager.jsx';
import CallsignLink, { extractBaseCall } from './CallsignLink.jsx';
import DecoderWaterfall from './DecoderWaterfall.jsx';
import { DecoderAudioEngine, audioDecoderSupported, listAudioInputs } from '../utils/decoderAudio.js';
import { findCallsigns, tokenizeCallsigns } from '../utils/cwDecoder.js';
import {
  MY_DECODES_EVENT,
  addMyDecode,
  clearMyDecodes,
  loadMyDecodes,
  myDecodeToSpot,
  removeMyDecode,
} from '../utils/myDecodes.js';
import { apiFetch } from '../utils/apiFetch.js';
import { callbookAuthHeaders } from '../utils/callbookAuth.js';

const SETTINGS_KEY = 'ohc_decoder_settings';
const COPY_MAX = 4000;
const BANDWIDTHS = ['auto', 50, 100, 200, 300];
const DEFAULTS = {
  source: 'mic',
  deviceId: '',
  tone: 600,
  bandwidth: 'auto',
  squelch: 'normal',
  kiwiFreqKhz: 14025,
  kiwiMode: 'cw',
  monitor: false,
};

const loadSettings = () => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}) };
  } catch {
    return { ...DEFAULTS };
  }
};

const btn = (accent, disabled) => ({
  padding: '3px 9px',
  fontSize: 11,
  borderRadius: 4,
  border: `1px solid ${accent || 'var(--border-color)'}`,
  background: accent ? `color-mix(in srgb, ${accent} 18%, transparent)` : 'var(--bg-tertiary)',
  color: disabled ? 'var(--text-muted)' : accent || 'var(--text-primary)',
  cursor: disabled ? 'default' : 'pointer',
  fontFamily: 'inherit',
  opacity: disabled ? 0.6 : 1,
});

const field = {
  padding: '2px 4px',
  fontSize: 11,
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  borderRadius: 3,
  fontFamily: 'var(--font-mono)',
};

const fmtTime = (ms) => {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}z`;
};

export default function DecoderPanel({ onSetDX, dxLocked = false, onSpotClick, apiToken = '' }) {
  const { t } = useTranslation();
  const rig = useRig();
  const { showPopup } = useCallsignPopup();

  const [settings, setSettings] = useState(loadSettings);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [copy, setCopy] = useState('');
  const [meter, setMeter] = useState({ wpm: 0, snrDb: 0, keyed: false, bandwidth: null, finding: false });
  const [devices, setDevices] = useState([]);
  const [tab, setTab] = useState('copy');
  const [myDecodes, setMyDecodes] = useState(loadMyDecodes);
  const [kiwiStatus, setKiwiStatus] = useState(null);
  const [sampleRate, setSampleRate] = useState(0);

  const engineRef = useRef(null);
  const copyRef = useRef(null);
  const noteTimer = useRef(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const supported = audioDecoderSupported();
  const secure = typeof window === 'undefined' || window.isSecureContext !== false;
  const bridgeUrl = rig?.enabled && !rig?.isCloudRelay ? rig?.rigUrl : null;

  const flash = useCallback((msg) => {
    setNote(msg);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 3000);
  }, []);

  const update = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable — settings just won't persist
      }
      return next;
    });
  }, []);

  // ── devices ──
  const refreshDevices = useCallback(async () => setDevices(await listAudioInputs()), []);
  useEffect(() => {
    refreshDevices();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refreshDevices);
    return () => md?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  // ── my decodes list ──
  useEffect(() => {
    const onChange = () => setMyDecodes(loadMyDecodes());
    window.addEventListener(MY_DECODES_EVENT, onChange);
    return () => window.removeEventListener(MY_DECODES_EVENT, onChange);
  }, []);

  // ── Kiwi relay status (only when that source is picked) ──
  useEffect(() => {
    if (settings.source !== 'kiwi' || !bridgeUrl) {
      setKiwiStatus(null);
      return undefined;
    }
    const ctrl = new AbortController();
    fetch(`${bridgeUrl}/api/kiwi-audio/status`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setKiwiStatus(s || { enabled: false }))
      .catch(() => setKiwiStatus({ unreachable: true }));
    return () => ctrl.abort();
  }, [settings.source, bridgeUrl]);

  // ── engine ──
  const stop = useCallback(async () => {
    const eng = engineRef.current;
    engineRef.current = null;
    setRunning(false);
    setStatus('');
    setMeter((m) => ({ ...m, keyed: false, finding: false }));
    if (eng) await eng.stop();
  }, []);

  useEffect(() => () => void stop(), [stop]);

  const onUpdate = useCallback(
    (msg) => {
      if (msg?.type !== 'update') return;
      if (msg.text) setCopy((prev) => (prev + msg.text).slice(-COPY_MAX));
      if (msg.state) setMeter(msg.state);
      if (msg.found) {
        if (msg.found.freq) {
          setSettings((prev) => {
            const next = { ...prev, tone: msg.found.freq };
            try {
              localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
            } catch {
              // ignore
            }
            return next;
          });
          flash(t('decoder.find.locked', { defaultValue: 'Locked to {{hz}} Hz', hz: msg.found.freq }));
        } else {
          flash(t('decoder.find.none', { defaultValue: 'No clear tone found — click a trace instead' }));
        }
      }
    },
    [flash, t],
  );

  const start = useCallback(async () => {
    setError('');
    setBusy(true);
    const s = settingsRef.current;
    const eng = new DecoderAudioEngine({
      onUpdate,
      onStatus: setStatus,
      onError: (err) => {
        setError(err?.message || String(err));
        stop();
      },
    });
    engineRef.current = eng;
    try {
      await eng.start({
        source: s.source,
        deviceId: s.deviceId,
        tone: s.tone,
        bandwidth: s.bandwidth,
        squelch: s.squelch,
        kiwi: { bridgeUrl, token: apiToken, freqKhz: s.kiwiFreqKhz, mode: s.kiwiMode },
      });
      if (engineRef.current !== eng) return;
      eng.setMonitor(s.monitor);
      setSampleRate(eng.sampleRate);
      setRunning(true);
      if (s.source === 'mic')
        refreshDevices(); // labels appear once permission is granted
      // A Kiwi in CW mode puts the tuned signal at its own pitch, not
      // necessarily ours — look for it once the audio has settled.
      else setTimeout(() => engineRef.current === eng && eng.findTone(3), 1500);
    } catch (err) {
      engineRef.current = null;
      let msg = err?.message || String(err);
      if (err?.name === 'NotAllowedError')
        msg = t('decoder.error.permission', { defaultValue: 'Microphone permission was denied.' });
      else if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError')
        msg = t('decoder.error.noDevice', { defaultValue: 'That audio input is not available.' });
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [apiToken, bridgeUrl, onUpdate, refreshDevices, stop, t]);

  // Live changes while running
  const setTone = (hz) => {
    const v = Math.max(150, Math.min(3000, Math.round(Number(hz) || 0)));
    update({ tone: v });
    engineRef.current?.setTone(v);
  };
  const setBandwidth = (v) => {
    const value = v === 'auto' ? 'auto' : Number(v);
    update({ bandwidth: value });
    engineRef.current?.setBandwidth(value);
  };
  const setSquelch = (level) => {
    update({ squelch: level });
    engineRef.current?.setSquelch(level);
  };
  const setMonitor = (on) => {
    update({ monitor: on });
    engineRef.current?.setMonitor(on);
  };
  const retuneKiwi = async (freqKhz, mode = settings.kiwiMode) => {
    update({ kiwiFreqKhz: freqKhz, kiwiMode: mode });
    if (!running || settings.source !== 'kiwi' || !bridgeUrl) return;
    try {
      await fetch(`${bridgeUrl}/api/kiwi-audio/tune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiToken ? { 'X-RigBridge-Token': apiToken } : {}) },
        body: JSON.stringify({ freqKHz: freqKhz, mode }),
      });
      engineRef.current?.resetDecoder();
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  // ── frequency context for spots/log ──
  const freqKhz = useMemo(() => {
    if (settings.source === 'kiwi') return Number(settings.kiwiFreqKhz) || null;
    return rig?.enabled && rig?.freq > 0 ? rig.freq / 1000 : null;
  }, [settings.source, settings.kiwiFreqKhz, rig?.enabled, rig?.freq]);
  const spotCtx = useMemo(() => (freqKhz ? { freq: freqKhz, mode: 'CW' } : undefined), [freqKhz]);

  // ── copy + callsigns ──
  useEffect(() => {
    const el = copyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [copy]);
  const runs = useMemo(() => tokenizeCallsigns(copy), [copy]);
  const heard = useMemo(
    () =>
      findCallsigns(copy.slice(-800))
        .map((c) => c.call)
        .reverse()
        .slice(0, 8),
    [copy],
  );

  const setDX = async (call) => {
    if (!onSetDX || dxLocked) return;
    const base = extractBaseCall(call);
    try {
      const res = await apiFetch(`/api/callsign/${encodeURIComponent(base)}`, { headers: callbookAuthHeaders() });
      const data = res?.ok ? await res.json() : null;
      if (data?.lat != null && data?.lon != null) {
        onSetDX({ lat: data.lat, lon: data.lon, callsign: call });
        flash(t('decoder.dxSet', { defaultValue: 'DX set to {{call}}', call }));
      } else flash(t('decoder.dxNotFound', { defaultValue: 'No location for {{call}}', call }));
    } catch {
      flash(t('decoder.dxNotFound', { defaultValue: 'No location for {{call}}', call }));
    }
  };

  const logCall = (call) => {
    const idx = copy.lastIndexOf(call);
    const context = idx >= 0 ? copy.slice(Math.max(0, idx - 40), idx + call.length + 20) : '';
    addMyDecode({
      call,
      freqKhz,
      mode: 'CW',
      wpm: meter.wpm,
      snrDb: meter.snrDb,
      text: context.replace(/\s+/g, ' '),
      source: settings.source === 'kiwi' ? 'kiwisdr' : 'audio',
    });
    flash(t('decoder.logged', { defaultValue: '{{call}} added to My decodes', call }));
  };

  // ── render ──
  const kiwiBlocked = !bridgeUrl;
  const maxHz = settings.source === 'kiwi' && settings.kiwiMode === 'cw' ? 1500 : 2500;
  const snrPct = Math.max(0, Math.min(100, (meter.snrDb / 30) * 100));

  if (!supported || !secure) {
    return (
      <div className="panel" style={{ padding: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
        <div style={{ fontWeight: 700, color: 'var(--accent-amber)', marginBottom: 6 }}>
          🎧 {t('decoder.title', { defaultValue: 'DECODER' })}
        </div>
        {!secure
          ? t('decoder.needsSecure', {
              defaultValue:
                'Listening to audio in the browser needs a secure page: open OpenHamClock over HTTPS, on localhost, or in the desktop app.',
            })
          : t('decoder.unsupported', {
              defaultValue: 'This browser does not support AudioWorklet, which the decoder needs.',
            })}
      </div>
    );
  }

  return (
    <div
      className="panel"
      style={{
        padding: 8,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 11,
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontWeight: 700, color: 'var(--accent-amber)' }}>
          🎧 {t('decoder.title', { defaultValue: 'DECODER' })}
          <span style={{ marginLeft: 6, color: 'var(--text-muted)', fontWeight: 400 }}>CW</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {status && running && <span style={{ color: 'var(--text-muted)' }}>{status}</span>}
          <button
            type="button"
            onClick={running ? stop : start}
            disabled={busy || (settings.source === 'kiwi' && kiwiBlocked)}
            style={btn(running ? 'var(--accent-red)' : 'var(--accent-green)', busy)}
          >
            {busy
              ? '…'
              : running
                ? t('decoder.stop', { defaultValue: 'Stop' })
                : t('decoder.start', { defaultValue: 'Start' })}
          </button>
        </span>
      </div>

      {/* Source */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {t('decoder.source', { defaultValue: 'Source' })}
          <select
            value={settings.source}
            disabled={running}
            onChange={(e) => update({ source: e.target.value })}
            style={field}
          >
            <option value="mic">{t('decoder.source.mic', { defaultValue: 'Sound input' })}</option>
            <option value="kiwi">{t('decoder.source.kiwi', { defaultValue: 'KiwiSDR (Rig Bridge)' })}</option>
          </select>
        </label>
        {settings.source === 'mic' ? (
          <select
            aria-label={t('decoder.device', { defaultValue: 'Audio input device' })}
            value={settings.deviceId}
            disabled={running}
            onChange={(e) => update({ deviceId: e.target.value })}
            style={{ ...field, maxWidth: 190 }}
          >
            <option value="">{t('decoder.device.default', { defaultValue: 'Default input' })}</option>
            {devices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `${t('decoder.device.input', { defaultValue: 'Input' })} ${i + 1}`}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              type="number"
              aria-label={t('decoder.kiwiFreq', { defaultValue: 'KiwiSDR frequency (kHz)' })}
              value={settings.kiwiFreqKhz}
              min={10}
              max={32000}
              step={0.1}
              onChange={(e) => update({ kiwiFreqKhz: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && retuneKiwi(Number(settings.kiwiFreqKhz))}
              onBlur={() => running && retuneKiwi(Number(settings.kiwiFreqKhz))}
              style={{ ...field, width: 78 }}
            />
            <span style={{ color: 'var(--text-muted)' }}>kHz</span>
            {rig?.freq > 0 && (
              <button
                type="button"
                onClick={() => retuneKiwi(Math.round(rig.freq / 100) / 10)}
                style={btn()}
                title={t('decoder.fromRig', { defaultValue: 'Use the rig frequency' })}
              >
                {t('decoder.fromRigShort', { defaultValue: '← rig' })}
              </button>
            )}
          </>
        )}
      </div>
      {settings.source === 'kiwi' && (
        <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
          {kiwiBlocked
            ? rig?.isCloudRelay
              ? t('decoder.kiwi.relay', {
                  defaultValue: 'KiwiSDR audio needs a direct connection to Rig Bridge (not the Cloud Relay).',
                })
              : t('decoder.kiwi.noBridge', {
                  defaultValue: 'Enable Rig Bridge in Settings → Rig Bridge to listen through a KiwiSDR.',
                })
            : kiwiStatus?.unreachable
              ? t('decoder.kiwi.unreachable', { defaultValue: 'Rig Bridge is not reachable.' })
              : kiwiStatus && !kiwiStatus.running
                ? t('decoder.kiwi.disabled', {
                    defaultValue: 'Turn on “KiwiSDR Audio (Decoder panel)” in the Rig Bridge setup page.',
                  })
                : kiwiStatus?.host
                  ? t('decoder.kiwi.host', { defaultValue: 'Receiver: {{host}}', host: kiwiStatus.host })
                  : null}
        </div>
      )}

      {/* Waterfall */}
      <DecoderWaterfall
        getAnalyser={() => engineRef.current?.analyser}
        sampleRate={sampleRate}
        running={running}
        tone={settings.tone}
        bandwidth={meter.bandwidth || (settings.bandwidth === 'auto' ? 100 : settings.bandwidth)}
        maxHz={maxHz}
        onTune={setTone}
        height={110}
      />

      {/* Decoder controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          {t('decoder.tone', { defaultValue: 'Tone' })}
          <input
            type="number"
            value={settings.tone}
            min={150}
            max={3000}
            step={10}
            onChange={(e) => setTone(e.target.value)}
            style={{ ...field, width: 54 }}
          />
          Hz
        </label>
        <button
          type="button"
          onClick={() => engineRef.current?.findTone(3)}
          disabled={!running || meter.finding}
          style={btn('var(--accent-cyan)', !running || meter.finding)}
          title={t('decoder.find.title', {
            defaultValue: 'Listen for 3 seconds and lock onto the strongest keyed tone',
          })}
        >
          {meter.finding ? '…' : t('decoder.find', { defaultValue: 'Find' })}
        </button>
        <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          {t('decoder.filter', { defaultValue: 'Filter' })}
          <select value={settings.bandwidth} onChange={(e) => setBandwidth(e.target.value)} style={field}>
            {BANDWIDTHS.map((b) => (
              <option key={b} value={b}>
                {b === 'auto' ? t('decoder.filter.auto', { defaultValue: 'Auto' }) : `${b} Hz`}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          {t('decoder.squelch', { defaultValue: 'Squelch' })}
          <select value={settings.squelch} onChange={(e) => setSquelch(e.target.value)} style={field}>
            <option value="low">{t('decoder.squelch.low', { defaultValue: 'Low' })}</option>
            <option value="normal">{t('decoder.squelch.normal', { defaultValue: 'Normal' })}</option>
            <option value="high">{t('decoder.squelch.high', { defaultValue: 'High' })}</option>
          </select>
        </label>
        <label
          style={{ display: 'flex', gap: 3, alignItems: 'center' }}
          title={t('decoder.monitor.title', { defaultValue: 'Play the audio through your speakers' })}
        >
          <input type="checkbox" checked={!!settings.monitor} onChange={(e) => setMonitor(e.target.checked)} />
          🔊
        </label>
      </div>

      {/* Meters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)' }}>
        <span
          aria-label={meter.keyed ? 'key down' : 'key up'}
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: running && meter.keyed ? 'var(--accent-green)' : 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            flexShrink: 0,
          }}
        />
        <span style={{ color: 'var(--accent-cyan)', minWidth: 52 }}>
          {running && meter.wpm ? `${meter.wpm} WPM` : '-- WPM'}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>S/N</span>
        <div
          role="meter"
          aria-label={t('decoder.signal', { defaultValue: 'Signal to noise' })}
          aria-valuemin={0}
          aria-valuemax={30}
          aria-valuenow={Math.round(meter.snrDb || 0)}
          style={{
            flex: 1,
            height: 8,
            background: 'var(--bg-tertiary)',
            borderRadius: 4,
            overflow: 'hidden',
            minWidth: 40,
          }}
        >
          <div
            style={{
              width: `${running ? snrPct : 0}%`,
              height: '100%',
              background:
                snrPct > 40 ? 'var(--accent-green)' : snrPct > 20 ? 'var(--accent-amber)' : 'var(--accent-red)',
              transition: 'width 0.1s',
            }}
          />
        </div>
        <span style={{ color: 'var(--text-secondary)', minWidth: 38, textAlign: 'right' }}>
          {running ? `${Math.round(meter.snrDb || 0)} dB` : ''}
        </span>
      </div>

      {(error || note) && (
        <div
          role={error ? 'alert' : 'status'}
          style={{
            padding: '3px 6px',
            borderRadius: 3,
            background: error ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.12)',
            color: error ? 'var(--accent-red)' : 'var(--accent-green)',
          }}
        >
          {error || note}
        </div>
      )}

      {/* Tabs */}
      <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-color)' }}>
        {[
          ['copy', t('decoder.tab.copy', { defaultValue: 'Copy' })],
          ['log', `${t('decoder.tab.myDecodes', { defaultValue: 'My decodes' })} (${myDecodes.length})`],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            style={{
              ...btn(),
              border: 'none',
              borderBottom: tab === id ? '2px solid var(--accent-amber)' : '2px solid transparent',
              borderRadius: 0,
              background: 'transparent',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'copy' ? (
        <>
          {heard.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {heard.map((call) => (
                <span
                  key={call}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    padding: '1px 4px',
                    border: '1px solid var(--border-color)',
                    borderRadius: 3,
                    background: 'var(--bg-secondary)',
                  }}
                >
                  <CallsignLink
                    call={call}
                    onPopup={showPopup}
                    spot={spotCtx}
                    color="var(--accent-cyan)"
                    fontWeight={700}
                  />
                  {onSetDX && (
                    <button
                      type="button"
                      onClick={() => setDX(call)}
                      disabled={dxLocked}
                      title={
                        dxLocked
                          ? t('decoder.dxLocked', { defaultValue: 'DX is locked' })
                          : t('decoder.setDx', { defaultValue: 'Set as DX target' })
                      }
                      style={{ ...btn(null, dxLocked), padding: '0 4px', border: 'none' }}
                    >
                      🎯
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => logCall(call)}
                    title={t('decoder.log', { defaultValue: 'Add to My decodes' })}
                    style={{ ...btn(), padding: '0 4px', border: 'none' }}
                  >
                    ＋
                  </button>
                </span>
              ))}
            </div>
          )}
          <div
            ref={copyRef}
            aria-live="off"
            style={{
              flex: 1,
              minHeight: 60,
              overflowY: 'auto',
              padding: 6,
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: 4,
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-primary)',
            }}
          >
            {copy ? (
              runs.map((r, i) =>
                r.call ? (
                  <CallsignLink
                    key={i}
                    call={r.call}
                    onPopup={showPopup}
                    spot={spotCtx}
                    color="var(--accent-cyan)"
                    fontWeight={700}
                  >
                    {r.text}
                  </CallsignLink>
                ) : (
                  <span key={i}>{r.text}</span>
                ),
              )
            ) : (
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {running
                  ? t('decoder.waiting', {
                      defaultValue: 'Listening… tune a CW signal into the yellow passband, or press Find.',
                    })
                  : t('decoder.hint', {
                      defaultValue:
                        'Feed the receiver audio into a sound input (or pick a KiwiSDR), press Start, then click a trace on the waterfall.',
                    })}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setCopy('')} disabled={!copy} style={btn(null, !copy)}>
              {t('decoder.clear', { defaultValue: 'Clear' })}
            </button>
          </div>
        </>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {myDecodes.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', padding: 6 }}>
              {t('decoder.myDecodes.empty', {
                defaultValue: 'Nothing logged yet. Press ＋ next to a callsign in the copy to keep it here.',
              })}
            </div>
          ) : (
            <>
              {myDecodes.map((d) => (
                <div
                  key={d.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 2px',
                    borderBottom: '1px solid var(--border-color)',
                  }}
                >
                  <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{fmtTime(d.time)}</span>
                  <CallsignLink
                    call={d.call}
                    onPopup={showPopup}
                    spot={d.freqKhz ? { freq: d.freqKhz, mode: d.mode } : undefined}
                    color="var(--accent-cyan)"
                    fontWeight={700}
                  />
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                    {d.freqKhz ? d.freqKhz.toFixed(1) : ''}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {[
                      d.wpm ? `${d.wpm}wpm` : null,
                      d.snrDb != null ? `${d.snrDb}dB` : null,
                      d.count > 1 ? `×${d.count}` : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  </span>
                  <span
                    title={d.text}
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {d.text}
                  </span>
                  {onSpotClick && d.freqKhz && (
                    <button
                      type="button"
                      onClick={() => onSpotClick(myDecodeToSpot(d))}
                      title={t('decoder.myDecodes.tune', { defaultValue: 'Tune / show on map' })}
                      style={{ ...btn(), padding: '0 4px' }}
                    >
                      📻
                    </button>
                  )}
                  {onSetDX && (
                    <button
                      type="button"
                      onClick={() => setDX(d.call)}
                      disabled={dxLocked}
                      title={t('decoder.setDx', { defaultValue: 'Set as DX target' })}
                      style={{ ...btn(null, dxLocked), padding: '0 4px' }}
                    >
                      🎯
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeMyDecode(d.id)}
                    title={t('decoder.myDecodes.remove', { defaultValue: 'Remove' })}
                    style={{ ...btn(), padding: '0 4px' }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4 }}>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(t('decoder.myDecodes.confirmClear', { defaultValue: 'Clear all of My decodes?' }))
                    )
                      clearMyDecodes();
                  }}
                  style={btn()}
                >
                  {t('decoder.myDecodes.clear', { defaultValue: 'Clear all' })}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
