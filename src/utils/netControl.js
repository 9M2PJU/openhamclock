/**
 * netControl — pure logic for the Net Control panel (`net-control`), which
 * runs a voice net on a repeater or simplex frequency.
 *
 * A running net:
 *   { id, name, frequency, ncs, scheduleId, startTime, endTime: null,
 *     calling: null|call (traffic station called with "next"),
 *     stations: [station…] (display order, newest activity first),
 *     undo: [stations…] (snapshots, newest last, capped) }
 *
 * A station (one roster line):
 *   { id, call, name, location, flags: ['traffic'|'inout'|'relay'|'mobile'|
 *     'short'], note, checkinTime, lastActivity, checkoutTime: null|ms,
 *     recheckCount, trafficPassed: null|ms }
 *
 * Every mutator is pure: it returns a new net (or the same object when
 * nothing changed) and never touches storage. The panel persists the result
 * with saveRunningNet().
 *
 * Storage: the net script (openhamclock_netControlScript) is listed in
 * config.js SYNC_KEYS and profiles.js like other user settings. The running
 * net, the history of past nets and the remembered station names stay
 * per-browser. The voice roster snapshot (openhamclock_emcommNetRoster) holds
 * the stations in the EmComm roster entry shape for the Net Roster panel and
 * anything else built on the roster.
 */
import { csvEscape } from './emcommEventLog.js';
import { esc } from './escapeHtml.js';

export const NET_CONTROL_KEY = 'openhamclock_netControl';
export const NET_CONTROL_HISTORY_KEY = 'openhamclock_netControlHistory';
export const NET_CONTROL_SCRIPT_KEY = 'openhamclock_netControlScript';
export const NET_CONTROL_STATIONS_KEY = 'openhamclock_netControlStations';
/** Running (or last closed) net's stations, in the EmComm roster entry shape (see toRosterEntries). */
export const NET_CONTROL_ROSTER_KEY = 'openhamclock_emcommNetRoster';

export const MAX_HISTORY = 50;
export const MAX_UNDO = 20;
export const STATION_CACHE_MAX = 1000;
/** A second Enter on the same call within this window is a fat-finger duplicate, not a recheck. */
export const DUPLICATE_WINDOW_MS = 10 * 1000;

/**
 * Check-in status flags. `letter` is the keyboard code typed after the
 * callsign (`K0CJH T`, `K0CJH/M`, `K0CJH TM`); `key` is what is stored.
 */
export const FLAG_DEFS = [
  { key: 'inout', letter: 'I', label: 'In and out', short: 'I/O', color: '#f59e0b' },
  { key: 'traffic', letter: 'T', label: 'Traffic', short: 'TFC', color: '#ef4444' },
  { key: 'relay', letter: 'R', label: 'Relay', short: 'RLY', color: '#a855f7' },
  { key: 'mobile', letter: 'M', label: 'Mobile', short: 'MOB', color: '#3b82f6' },
  { key: 'short', letter: 'S', label: 'Short time', short: 'SHT', color: '#eab308' },
];
const FLAG_BY_LETTER = Object.fromEntries(FLAG_DEFS.map((f) => [f.letter, f.key]));
const FLAG_ORDER = FLAG_DEFS.map((f) => f.key);
const FLAG_TOKEN = /^[ITRMS]{1,5}$/;

/** Flags in canonical order, deduplicated, unknown keys dropped. */
export const normalizeFlags = (flags) => FLAG_ORDER.filter((k) => Array.isArray(flags) && flags.includes(k));

/** Short labels for a flag list ("TFC MOB"). */
export const flagsToText = (flags) =>
  normalizeFlags(flags)
    .map((k) => FLAG_DEFS.find((f) => f.key === k).short)
    .join(' ');

/** Loose callsign check: 3+ alphanumerics with at least one letter and one digit. */
export const isPlausibleCall = (s) => /^[A-Z0-9]{3,12}$/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);

/**
 * Parse one check-in line.
 *
 *   "k0cjh"            → { call: 'K0CJH', flags: [], note: '' }
 *   "K0CJH T"          → traffic
 *   "K0CJH/M"          → mobile (slash suffix made only of flag letters)
 *   "K0CJH TM Chris"   → traffic + mobile, note "Chris"
 *   "K0CJH /TMS"       → traffic + mobile + short time
 *   "K0CJH Chris"      → note "Chris" (a token with non-flag letters is a note)
 *   "K0CJH Tim"        → note "Tim" (bare flag tokens are at most 2 letters)
 *   "K0CJH-9"          → SSID stripped
 *
 * Returns null when the first token is not a plausible callsign.
 */
export function parseCheckin(input) {
  const tokens = String(input || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  let call = tokens[0].toUpperCase().replace(/-\d+$/, '');
  const flags = new Set();
  // Slash suffixes: strip SSID-like and flag-letter suffixes (K0CJH/M, K0CJH/T).
  // Other suffixes (/P, /QRP, /7) are left on the call.
  const parts = call.split('/');
  if (parts.length > 1) {
    const kept = [parts[0]];
    for (const p of parts.slice(1)) {
      if (FLAG_TOKEN.test(p) && p.length <= 2) {
        for (const ch of p) flags.add(FLAG_BY_LETTER[ch]);
      } else {
        kept.push(p);
      }
    }
    call = kept.join('/');
  }
  const base = call.split('/')[0];
  if (!isPlausibleCall(base)) return null;
  // Flag tokens before any note: 1–2 bare flag letters ("T", "TM"), or any
  // combination behind a "/" or "+" ("/TMS"). Longer bare tokens are notes,
  // so a name made of flag letters ("Tim", "Mitt") is never eaten as flags.
  const noteTokens = [];
  for (const tok of tokens.slice(1)) {
    const up = tok.toUpperCase();
    const prefixed = /^[/+]/.test(up) ? up.slice(1) : null;
    const flagText = prefixed ?? (up.length <= 2 ? up : '');
    if (noteTokens.length === 0 && FLAG_TOKEN.test(flagText)) {
      for (const ch of flagText) flags.add(FLAG_BY_LETTER[ch]);
    } else {
      noteTokens.push(tok);
    }
  }
  return { call, flags: normalizeFlags([...flags]), note: noteTokens.join(' ') };
}

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Start a new net. `name` is required; blanks fall back to sensible defaults. */
export function createNet({ name, frequency = '', ncs = '', scheduleId = null, now = Date.now() } = {}) {
  const n = String(name || '').trim();
  if (!n) return null;
  return {
    id: newId('net'),
    name: n,
    frequency: String(frequency || '').trim(),
    ncs: String(ncs || '')
      .trim()
      .toUpperCase(),
    scheduleId: scheduleId || null,
    startTime: now,
    endTime: null,
    calling: null,
    stations: [],
    undo: [],
  };
}

const withUndo = (net, stations) => ({
  ...net,
  stations,
  undo: [...(net.undo || []), net.stations].slice(-MAX_UNDO),
});

const findStation = (net, call) => {
  const c = String(call || '').toUpperCase();
  return (net?.stations || []).find((s) => s.call === c) || null;
};

/**
 * Check a station in. Returns { net, station, result } where result is
 * 'new', 'recheck' (already on the roster → moved to the top, count bumped,
 * flags merged), 'return' (was checked out → back in) or 'duplicate' (same
 * call within DUPLICATE_WINDOW_MS → ignored, net unchanged).
 */
export function checkIn(net, { call, flags = [], note = '', name = '', location = '', now = Date.now() }) {
  const c = String(call || '').toUpperCase();
  const existing = findStation(net, c);
  const newFlags = normalizeFlags(flags);
  if (existing) {
    if (existing.checkoutTime == null && now - existing.lastActivity < DUPLICATE_WINDOW_MS) {
      return { net, station: existing, result: 'duplicate' };
    }
    const result = existing.checkoutTime != null ? 'return' : 'recheck';
    const updated = {
      ...existing,
      flags: normalizeFlags([...existing.flags, ...newFlags]),
      note: note || existing.note,
      name: existing.name || name,
      location: existing.location || location,
      lastActivity: now,
      checkoutTime: null,
      recheckCount: existing.recheckCount + 1,
    };
    const rest = net.stations.filter((s) => s.call !== c);
    return { net: withUndo(net, [updated, ...rest]), station: updated, result };
  }
  const station = {
    id: newId('stn'),
    call: c,
    name: String(name || ''),
    location: String(location || ''),
    flags: newFlags,
    note: String(note || ''),
    checkinTime: now,
    lastActivity: now,
    checkoutTime: null,
    recheckCount: 0,
    trafficPassed: null,
  };
  return { net: withUndo(net, [station, ...net.stations]), station, result: 'new' };
}

/** Mark a station checked out (stays on the roster, greyed). */
export function checkOut(net, call, now = Date.now()) {
  const s = findStation(net, call);
  if (!s || s.checkoutTime != null) return net;
  return withUndo(
    net,
    net.stations.map((x) => (x.call === s.call ? { ...x, checkoutTime: now, lastActivity: now } : x)),
  );
}

/** Toggle one flag on a station. */
export function toggleFlag(net, call, flag) {
  const s = findStation(net, call);
  if (!s || !FLAG_ORDER.includes(flag)) return net;
  const flags = s.flags.includes(flag) ? s.flags.filter((f) => f !== flag) : normalizeFlags([...s.flags, flag]);
  return withUndo(
    net,
    net.stations.map((x) => (x.call === s.call ? { ...x, flags } : x)),
  );
}

/** Patch name/location/note on a station (no undo entry — these are fills, not actions). */
export function updateStation(net, call, patch) {
  const s = findStation(net, call);
  if (!s) return net;
  const clean = {};
  for (const k of ['name', 'location', 'note']) {
    if (patch?.[k] != null) clean[k] = String(patch[k]);
  }
  if (Object.keys(clean).length === 0) return net;
  return { ...net, stations: net.stations.map((x) => (x.call === s.call ? { ...x, ...clean } : x)) };
}

/** Remove a station entirely (a mis-typed call). */
export function removeStation(net, call) {
  const s = findStation(net, call);
  if (!s) return net;
  return withUndo(
    net,
    net.stations.filter((x) => x.call !== s.call),
  );
}

/** Restore the roster to the state before the last check-in/out/flag/remove/pass. */
export function undoLast(net) {
  const undo = net?.undo || [];
  if (undo.length === 0) return net;
  return { ...net, stations: undo[undo.length - 1], undo: undo.slice(0, -1) };
}

/**
 * Stations waiting to pass traffic: on the roster, flagged traffic, not yet
 * passed — oldest check-in first (first come, first served).
 */
export function trafficQueue(net) {
  return (net?.stations || [])
    .filter((s) => s.flags.includes('traffic') && s.trafficPassed == null && s.checkoutTime == null)
    .sort((a, b) => a.checkinTime - b.checkinTime);
}

/** Mark a station's traffic as passed (pops it from the queue). Returns the same net when not queued. */
export function passTraffic(net, call, now = Date.now()) {
  const s = findStation(net, call);
  if (!s || !s.flags.includes('traffic') || s.trafficPassed != null) return net;
  const next = withUndo(
    net,
    net.stations.map((x) => (x.call === s.call ? { ...x, trafficPassed: now, lastActivity: now } : x)),
  );
  return net.calling === s.call ? { ...next, calling: null } : next;
}

/**
 * "Next": call the head of the traffic queue — sets `calling` to that
 * station (shown large, with phonetics, until its traffic is passed).
 * Calling the same station again is a no-op; an empty queue clears it.
 */
export function nextTraffic(net) {
  if (!net) return net;
  const head = trafficQueue(net)[0]?.call ?? null;
  return (net.calling ?? null) === head ? net : { ...net, calling: head };
}

/** Close the net (sets endTime; a closed net is immutable from here on). */
export function closeNet(net, now = Date.now()) {
  if (!net || net.endTime != null) return net;
  return { ...net, endTime: now, undo: [] };
}

// ── Report ──────────────────────────────────────────────────────────────────

/** Duration of a net (end, or `now` while running) in ms. */
export const netDurationMs = (net, now = Date.now()) => Math.max(0, (net?.endTime ?? now) - (net?.startTime ?? now));

/** "00:12:34" running-timer format. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** "1h 05m" / "12m" / "<1m" report format. */
export function formatDuration(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

const fmtUtc = (ts) => (ts == null ? '' : new Date(ts).toISOString().replace('T', ' ').substring(0, 16) + 'Z');
const fmtHHMM = (ts) => (ts == null ? '' : new Date(ts).toISOString().substring(11, 16));

/**
 * Build the net summary. Stations are listed in check-in order (oldest
 * first). totalCheckins counts rechecks; uniqueStations does not.
 */
export function buildReport(net, now = Date.now()) {
  const stations = [...(net?.stations || [])].sort((a, b) => a.checkinTime - b.checkinTime);
  const endTime = net?.endTime ?? now;
  return {
    id: net?.id || '',
    name: net?.name || '',
    ncs: net?.ncs || '',
    frequency: net?.frequency || '',
    startTime: net?.startTime ?? null,
    endTime,
    durationMs: netDurationMs(net, now),
    totalCheckins: stations.reduce((n, s) => n + 1 + (s.recheckCount || 0), 0),
    uniqueStations: stations.length,
    trafficCount: stations.filter((s) => s.flags.includes('traffic')).length,
    trafficPassed: stations.filter((s) => s.trafficPassed != null).length,
    stations: stations.map((s) => ({
      call: s.call,
      name: s.name || '',
      location: s.location || '',
      flags: normalizeFlags(s.flags),
      note: s.note || '',
      checkinTime: s.checkinTime,
      checkoutTime: s.checkoutTime,
      recheckCount: s.recheckCount || 0,
      trafficPassed: s.trafficPassed,
    })),
  };
}

/** Plain-text report for the clipboard / email. */
export function reportToText(report) {
  const r = report;
  const lines = [
    `NET REPORT — ${r.name}`,
    `Net control: ${r.ncs || '—'}`,
    `Frequency: ${r.frequency || '—'}`,
    `Opened: ${fmtUtc(r.startTime)}   Closed: ${fmtUtc(r.endTime)}   Duration: ${formatDuration(r.durationMs)}`,
    `Check-ins: ${r.totalCheckins}   Unique stations: ${r.uniqueStations}   Traffic: ${r.trafficCount} listed, ${r.trafficPassed} passed`,
    '',
    'TIME  CALL        FLAGS        NAME / LOCATION',
  ];
  for (const s of r.stations) {
    const who = [s.name, s.location].filter(Boolean).join(', ');
    const extra = [
      s.recheckCount > 0 ? `recheck x${s.recheckCount}` : '',
      s.checkoutTime != null ? `out ${fmtHHMM(s.checkoutTime)}` : '',
      s.note,
    ]
      .filter(Boolean)
      .join('; ');
    const tail = [who, extra ? `(${extra})` : ''].filter(Boolean).join(' ');
    lines.push(`${fmtHHMM(s.checkinTime)} ${s.call.padEnd(11)} ${flagsToText(s.flags).padEnd(12)} ${tail}`.trimEnd());
  }
  lines.push('', 'Generated by OpenHamClock');
  return lines.join('\n');
}

const REPORT_CSV_HEADER = [
  'Net',
  'NCS',
  'Frequency',
  'Net Opened (UTC)',
  'Net Closed (UTC)',
  'Callsign',
  'Name',
  'Location',
  'Flags',
  'Check-In (UTC)',
  'Check-Out (UTC)',
  'Rechecks',
  'Traffic Passed (UTC)',
  'Note',
];

const reportRows = (r) =>
  r.stations.map((s) =>
    [
      r.name,
      r.ncs,
      r.frequency,
      r.startTime != null ? new Date(r.startTime).toISOString() : '',
      r.endTime != null ? new Date(r.endTime).toISOString() : '',
      s.call,
      s.name,
      s.location,
      flagsToText(s.flags),
      new Date(s.checkinTime).toISOString(),
      s.checkoutTime != null ? new Date(s.checkoutTime).toISOString() : '',
      s.recheckCount,
      s.trafficPassed != null ? new Date(s.trafficPassed).toISOString() : '',
      s.note,
    ]
      .map(csvEscape)
      .join(','),
  );

/** One CSV row per station. */
export function reportToCsv(report) {
  return [REPORT_CSV_HEADER.join(','), ...reportRows(report)].join('\r\n') + '\r\n';
}

/** All past nets as one CSV (one row per station per net). */
export function historyToCsv(history) {
  const rows = [REPORT_CSV_HEADER.join(',')];
  for (const net of history || []) rows.push(...reportRows(buildReport(net, net.endTime ?? net.startTime)));
  return rows.join('\r\n') + '\r\n';
}

/** Self-contained print-ready HTML (caller opens a window and prints). */
export function reportToPrintHtml(report) {
  const r = report;
  const rows = r.stations
    .map(
      (s) => `<tr>
        <td class="mono">${fmtHHMM(s.checkinTime)}</td>
        <td class="mono">${esc(s.call)}</td>
        <td>${esc(flagsToText(s.flags))}</td>
        <td>${esc(s.name)}</td>
        <td>${esc(s.location)}</td>
        <td class="mono">${s.checkoutTime != null ? fmtHHMM(s.checkoutTime) : ''}</td>
        <td>${esc(
          [
            s.recheckCount > 0 ? `recheck x${s.recheckCount}` : '',
            s.trafficPassed != null ? 'traffic passed' : '',
            s.note,
          ]
            .filter(Boolean)
            .join('; '),
        )}</td>
      </tr>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Net Report — ${esc(r.name)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 2px 0; }
  .sub { color: #555; font-size: 11px; margin-bottom: 14px; }
  table.head { border-collapse: collapse; margin-bottom: 16px; font-size: 12px; }
  table.head td { padding: 2px 12px 2px 0; }
  table.head td.k { color: #555; font-weight: bold; }
  table.log { border-collapse: collapse; width: 100%; font-size: 11px; }
  table.log th { text-align: left; border-bottom: 2px solid #333; padding: 4px 8px; }
  table.log td { border-bottom: 1px solid #ddd; padding: 4px 8px; vertical-align: top; }
  .mono { font-family: "Courier New", monospace; white-space: nowrap; }
  @media print { body { margin: 8mm; } }
</style>
</head>
<body>
<h1>Net Report — ${esc(r.name)}</h1>
<div class="sub">Generated ${fmtUtc(Date.now())} by OpenHamClock</div>
<table class="head">
  <tr><td class="k">Net control</td><td class="mono">${esc(r.ncs || '—')}</td></tr>
  <tr><td class="k">Frequency</td><td class="mono">${esc(r.frequency || '—')}</td></tr>
  <tr><td class="k">Opened (UTC)</td><td class="mono">${fmtUtc(r.startTime)}</td></tr>
  <tr><td class="k">Closed (UTC)</td><td class="mono">${fmtUtc(r.endTime)}</td></tr>
  <tr><td class="k">Duration</td><td class="mono">${esc(formatDuration(r.durationMs))}</td></tr>
  <tr><td class="k">Check-ins</td><td class="mono">${r.totalCheckins} (${r.uniqueStations} unique)</td></tr>
  <tr><td class="k">Traffic</td><td class="mono">${r.trafficCount} listed, ${r.trafficPassed} passed</td></tr>
</table>
<table class="log">
  <thead><tr><th>In (UTC)</th><th>Callsign</th><th>Flags</th><th>Name</th><th>Location</th><th>Out</th><th>Notes</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
</body>
</html>`;
}

// ── EmComm roster bridge ────────────────────────────────────────────────────

/**
 * A station as an EmComm Net Roster entry — the same shape the APRS roster
 * (`GET /api/aprs/net`) hands out, so anything built on the roster (ICS
 * forms, the Net Roster panel) can consume a voice net's check-ins unchanged.
 * The `status` string mirrors what a manual API check-in would carry.
 */
export function toRosterEntries(net) {
  return (net?.stations || [])
    .slice()
    .sort((a, b) => a.checkinTime - b.checkinTime)
    .map((s) => {
      const bits = [
        flagsToText(s.flags),
        s.name,
        s.location,
        s.checkoutTime != null ? `out ${fmtHHMM(s.checkoutTime)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        call: s.call,
        netName: net.name,
        status: bits ? `Voice net: ${bits}` : 'Checked in',
        checkinTime: s.checkinTime,
        lastHeard: s.checkoutTime ?? s.lastActivity ?? s.checkinTime,
        lat: null,
        lon: null,
        tokens: [],
        source: 'net-control',
      };
    });
}

// ── Script templates ────────────────────────────────────────────────────────

export const DEFAULT_PREAMBLE = `Calling all stations, calling all stations. This is {ncs} opening the {net}.

This net meets to pass traffic, share information, and keep our operators trained and ready. This is a directed net; please do not transmit unless called upon by net control. If you have emergency or priority traffic at any time, break in with your callsign and the word EMERGENCY.

Today is {date} and the time is {time}. Before we begin, is there any emergency or priority traffic? ... Nothing heard.

When checking in, give your callsign phonetically, your name, and your location, then say "no traffic" or "with traffic". Please wait for acknowledgement.

Stations with traffic for the net, please check in now.

Mobile and short-time stations, please check in now.

All other stations, please check in now.`;

export const DEFAULT_CLOSING = `Is there anything further for the net? ... Hearing nothing, this is {ncs} closing the {net} at {time} with {count} stations checked in.

Thank you to all who participated. The frequency is returned to normal amateur use. This is {ncs}, clear.`;

/** Date/time strings for the script placeholders. */
export function scriptContext(net, now = Date.now()) {
  const d = new Date(now);
  let date = d.toDateString();
  let time = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')} local`;
  try {
    date = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    time = `${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} local (${fmtHHMM(now)} UTC)`;
  } catch {
    /* Intl unavailable — keep the plain fallbacks */
  }
  return {
    net: net?.name || '',
    ncs: net?.ncs || '',
    freq: net?.frequency || '',
    date,
    time,
    count: String((net?.stations || []).length),
  };
}

/** Replace {net} {ncs} {freq} {date} {time} {count} in a script block. */
export function fillTemplate(text, ctx = {}) {
  return String(text || '').replace(/\{(net|ncs|freq|date|time|count)\}/g, (m, k) =>
    ctx[k] != null && ctx[k] !== '' ? String(ctx[k]) : m,
  );
}

// ── Station memory (name/location fills) ────────────────────────────────────

/**
 * Pick a name/location for a call from the logbook (most recent QSO with a
 * name wins). Location comes from ADIF QTH, then STATE.
 */
export function stationFromLogbook(qsos, call) {
  const c = String(call || '').toUpperCase();
  if (!c || !Array.isArray(qsos)) return null;
  let best = null;
  for (const q of qsos) {
    if (String(q?.call || '').toUpperCase() !== c) continue;
    const name = String(q.name || '').trim();
    const location = String(q.extras?.QTH || q.extras?.qth || q.extras?.STATE || q.extras?.state || '').trim();
    if (!name && !location) continue;
    const stamp = `${q.qso_date || ''}${q.time_on || ''}`;
    if (!best || stamp > best.stamp) best = { name, location, stamp };
  }
  return best ? { name: best.name, location: best.location } : null;
}

/** Name/location from a /api/callsign lookup result. */
export function stationFromLookup(data) {
  // Prefix / DXCC estimates know the country and nothing about the operator
  if (!data || typeof data !== 'object' || data.estimated || data.source === 'prefix') return null;
  const name = [data.fname, data.name].filter(Boolean).join(' ').trim();
  // Country alone is noise on a local net — only used alongside a real name
  const location =
    [data.county, data.state].filter(Boolean).join(', ') || (name && data.country !== 'Unknown' && data.country) || '';
  if (!name && !location) return null;
  return { name, location: String(location || '').trim() };
}

// ── Storage ─────────────────────────────────────────────────────────────────

const readJson = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
};
const writeJson = (key, value) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — the panel keeps working in memory */
  }
};

/** The in-progress net, or null. */
export function loadRunningNet() {
  const net = readJson(NET_CONTROL_KEY, null);
  return net && typeof net === 'object' && Array.isArray(net.stations) && net.name ? { undo: [], ...net } : null;
}
export const saveRunningNet = (net) => writeJson(NET_CONTROL_KEY, net);
export const clearRunningNet = () => writeJson(NET_CONTROL_KEY, null);

/** Past nets, newest first. */
export function loadHistory() {
  const list = readJson(NET_CONTROL_HISTORY_KEY, []);
  return Array.isArray(list) ? list.filter((n) => n && Array.isArray(n.stations)) : [];
}
export const saveHistory = (list) => writeJson(NET_CONTROL_HISTORY_KEY, list);

/** Prepend a closed net to the history (undo stack dropped), capped at MAX_HISTORY. */
export function pushHistory(list, net) {
  const { undo: _undo, ...rest } = net || {};
  return [rest, ...(list || []).filter((n) => n.id !== rest.id)].slice(0, MAX_HISTORY);
}

export function loadScript() {
  const s = readJson(NET_CONTROL_SCRIPT_KEY, null);
  return {
    preamble: typeof s?.preamble === 'string' ? s.preamble : DEFAULT_PREAMBLE,
    closing: typeof s?.closing === 'string' ? s.closing : DEFAULT_CLOSING,
  };
}
export const saveScript = (script) => writeJson(NET_CONTROL_SCRIPT_KEY, script);

/** callsign → { name, location, ts } remembered from previous nets. */
export function loadStationCache() {
  const c = readJson(NET_CONTROL_STATIONS_KEY, {});
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}

/** Remember a station's name/location (newest STATION_CACHE_MAX kept). Returns the new cache. */
export function rememberStation(cache, call, { name = '', location = '' } = {}, now = Date.now()) {
  const c = String(call || '').toUpperCase();
  if (!c || (!name && !location)) return cache;
  const prev = cache?.[c] || {};
  const next = { ...cache, [c]: { name: name || prev.name || '', location: location || prev.location || '', ts: now } };
  const keys = Object.keys(next);
  if (keys.length > STATION_CACHE_MAX) {
    keys.sort((a, b) => (next[a].ts || 0) - (next[b].ts || 0));
    for (const k of keys.slice(0, keys.length - STATION_CACHE_MAX)) delete next[k];
  }
  return next;
}
export const saveStationCache = (cache) => writeJson(NET_CONTROL_STATIONS_KEY, cache);

/** Window event fired after the roster snapshot changes (same-tab listeners). */
export const NET_CONTROL_ROSTER_EVENT = 'ohc-net-control-roster';

/**
 * Write the voice net's stations into the EmComm roster store, in the same
 * entry shape as `GET /api/aprs/net` roster entries. `active` is true while
 * the net runs (the EmComm Net Roster shows these stations live); a closed
 * net's roster stays readable (active: false) for reports and forms until
 * the next net starts.
 */
export function saveRosterSnapshot(net, { active = false, now = Date.now() } = {}) {
  writeJson(NET_CONTROL_ROSTER_KEY, {
    active: !!active,
    netId: net?.id || '',
    net: net?.name || '',
    ncs: net?.ncs || '',
    frequency: net?.frequency || '',
    startTime: net?.startTime ?? null,
    endTime: net?.endTime ?? null,
    roster: toRosterEntries(net),
    ts: now,
  });
  try {
    window.dispatchEvent(new Event(NET_CONTROL_ROSTER_EVENT));
  } catch {
    /* no window (tests/SSR) */
  }
}

/** The stored voice-net roster snapshot, or null. */
export function getNetControlRoster() {
  const snap = readJson(NET_CONTROL_ROSTER_KEY, null);
  return snap && Array.isArray(snap.roster) ? snap : null;
}

/**
 * Merge the APRS roster with the active voice net's roster entries for
 * display. An APRS entry wins over a voice entry for the same base call;
 * voice entries get age/stale like the APRS ones.
 */
export function mergeRosters(aprsRoster, snapshot, now = Date.now()) {
  const base = Array.isArray(aprsRoster) ? aprsRoster : [];
  if (!snapshot?.active || !Array.isArray(snapshot.roster)) return base;
  const baseCall = (c) =>
    String(c || '')
      .toUpperCase()
      .split('-')[0];
  const seen = new Set(base.map((op) => baseCall(op.call)));
  const extra = snapshot.roster
    .filter((op) => !seen.has(baseCall(op.call)))
    .map((op) => {
      const age = Math.max(0, Math.floor((now - (op.lastHeard ?? op.checkinTime ?? now)) / 60000));
      return { ...op, age, stale: false };
    });
  return extra.length ? [...base, ...extra] : base;
}
