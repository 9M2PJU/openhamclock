/**
 * emcommEventLog — client-side session event log for EmComm operations.
 *
 * Accumulates significant events (net check-ins/outs, APRS messages sent and
 * received, new NWS alerts, shelter and field reports, first-heard EmComm
 * stations) into localStorage so operators can export an After Action Review
 * as CSV or a print-friendly report.
 *
 * Storage: localStorage key `openhamclock_emcommEventLog`, capped at 2000
 * events (oldest dropped first). Events carry an optional dedupe key so the
 * same real-world event (e.g. an NWS alert re-observed after a page reload)
 * is only recorded once per log lifetime.
 */
import { esc } from './escapeHtml.js';

export const STORAGE_KEY = 'openhamclock_emcommEventLog';
export const MAX_EVENTS = 2000;

/** Human-readable labels + colors per event type (used by UI + print export) */
export const EVENT_TYPE_META = {
  net_checkin: { label: 'Net Check-In', color: '#22c55e' },
  net_checkout: { label: 'Net Check-Out', color: '#f59e0b' },
  net_open: { label: 'Net Opened', color: '#14b8a6' },
  net_close: { label: 'Net Closed', color: '#14b8a6' },
  net_traffic: { label: 'Traffic Passed', color: '#ef4444' },
  // Compensating entry written when Net Control's Undo reverses something
  // already logged. `ref` names the event it withdraws (withdrawing a
  // withdrawal reinstates the original). Never a form row of its own.
  net_withdrawn: { label: 'Net Entry Withdrawn', color: '#6b7280', internal: true },
  aprs_msg_sent: { label: 'APRS Msg Sent', color: '#22d3ee' },
  aprs_msg_rx: { label: 'APRS Msg Rcvd', color: '#3b82f6' },
  nws_alert: { label: 'NWS Alert', color: '#dc2626' },
  shelter_report: { label: 'Shelter Report', color: '#22c55e' },
  field_report: { label: 'Field Report', color: '#f472b6' },
  station_heard: { label: 'Station Heard', color: '#a855f7' },
  ics213_sent: { label: 'ICS 213 Sent', color: '#eab308' },
};

// ── In-memory state (mirrors localStorage) ──────────────────────────────────
let events = null; // lazy-loaded array, oldest first
let dedupeIndex = null; // Set of `${type}:${dedupeKey}`
const listeners = new Set();
let idCounter = 0;

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function load() {
  if (events) return events;
  events = [];
  dedupeIndex = new Set();
  const ls = safeStorage();
  if (ls) {
    try {
      const raw = ls.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) events = parsed.slice(-MAX_EVENTS);
      }
    } catch {
      /* corrupted store — start fresh */
    }
  }
  for (const ev of events) {
    if (ev.dedupeKey) dedupeIndex.add(`${ev.type}:${ev.dedupeKey}`);
  }
  return events;
}

function persist() {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    /* quota exceeded — drop oldest half and retry once */
    try {
      events = events.slice(-Math.floor(MAX_EVENTS / 2));
      ls.setItem(STORAGE_KEY, JSON.stringify(events));
    } catch {
      /* give up silently — log keeps working in memory */
    }
  }
}

function notify() {
  const snapshot = getEvents();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch {
      /* listener errors must not break recording */
    }
  }
}

/** Return a copy of all events, oldest first. */
export function getEvents() {
  return load().slice();
}

/**
 * Record an event.
 * @param {string} type - one of EVENT_TYPE_META keys
 * @param {object} data - { callsign, summary, details, ts, dedupeKey, ref }
 *   ts: optional epoch ms override (defaults to now)
 *   ref: optional id of another event this one refers to (net_withdrawn)
 *   dedupeKey: optional — if an event with the same type+dedupeKey already
 *   exists in the log, recording is skipped (returns null).
 * @returns {object|null} the stored event, or null when deduped
 */
export function recordEvent(type, data = {}) {
  load();
  const { callsign = '', summary = '', details = '', ts, dedupeKey, ref } = data;
  if (dedupeKey != null) {
    const key = `${type}:${dedupeKey}`;
    if (dedupeIndex.has(key)) return null;
    dedupeIndex.add(key);
  }
  const ev = {
    id: `${Date.now()}-${++idCounter}`,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    type,
    callsign: String(callsign || ''),
    summary: String(summary || ''),
    details: String(details || ''),
    ...(dedupeKey != null ? { dedupeKey: String(dedupeKey) } : {}),
    ...(ref != null ? { ref: String(ref) } : {}),
  };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  persist();
  notify();
  return ev;
}

/** Clear the entire log (UI calls this after confirmation). */
export function clearEvents() {
  load();
  events = [];
  dedupeIndex = new Set();
  persist();
  notify();
}

/**
 * Subscribe to log changes. Listener receives the full events array (copy).
 * @returns {Function} unsubscribe
 */
export function subscribeEvents(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Another tab wrote the log: drop the in-memory copy so the next read (and
 * the next recordEvent) starts from what is stored, instead of this tab
 * overwriting the other tab's entries with its older array.
 */
export function reloadFromStorage() {
  events = null;
  dedupeIndex = null;
  notify();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY || e.key === null) reloadFromStorage();
  });
}

// ── Withdrawn entries ───────────────────────────────────────────────────────
/**
 * Ids of events that have been withdrawn by a net_withdrawn entry. Entries
 * are applied in log order; withdrawing a withdrawal reinstates its target.
 */
export function withdrawnEventIds(evts) {
  const byId = new Map((evts || []).map((ev) => [ev.id, ev]));
  const out = new Set();
  for (const ev of (evts || []).slice().sort((a, b) => a.ts - b.ts)) {
    if (ev.type !== 'net_withdrawn' || !ev.ref) continue;
    const target = byId.get(ev.ref);
    if (target?.type === 'net_withdrawn') {
      if (target.ref) out.delete(target.ref);
    } else {
      out.add(ev.ref);
    }
  }
  return out;
}

/** The log without withdrawn entries and without the withdrawal records — what forms should use. */
export function activeEvents(evts) {
  const gone = withdrawnEventIds(evts);
  return (evts || []).filter((ev) => ev.type !== 'net_withdrawn' && !gone.has(ev.id));
}

/** Reset in-memory state (test helper — forces reload from localStorage). */
export function _resetForTests() {
  events = null;
  dedupeIndex = null;
  listeners.clear();
}

// ── Diff helper ─────────────────────────────────────────────────────────────
/**
 * Compute items newly appearing versus a previous key set.
 * @param {Set|null} prevKeys - previous snapshot's keys, or null on the very
 *   first snapshot (nothing is reported as added — baseline only).
 * @param {Array} items
 * @param {Function} keyFn - item → string key
 * @returns {{ added: Array, removed: string[], keys: Set }}
 */
export function diffAdded(prevKeys, items, keyFn) {
  const keys = new Set();
  const added = [];
  for (const item of items || []) {
    const k = keyFn(item);
    if (k == null) continue;
    keys.add(k);
    if (prevKeys && !prevKeys.has(k)) added.push(item);
  }
  const removed = [];
  if (prevKeys) {
    for (const k of prevKeys) {
      if (!keys.has(k)) removed.push(k);
    }
  }
  return { added, removed, keys };
}

// ── CSV export ──────────────────────────────────────────────────────────────
/** Escape a single CSV field per RFC 4180. */
export function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize events to CSV (oldest first).
 * Columns: Time (UTC), Type, Callsign, Summary, Details
 */
export function eventsToCSV(evts) {
  const rows = ['Time (UTC),Type,Callsign,Summary,Details'];
  for (const ev of evts || []) {
    const label = EVENT_TYPE_META[ev.type]?.label || ev.type;
    rows.push([new Date(ev.ts).toISOString(), label, ev.callsign, ev.summary, ev.details].map(csvEscape).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

// ── Print / PDF export ──────────────────────────────────────────────────────
function fmtUtc(ts) {
  return new Date(ts).toISOString().replace('T', ' ').substring(0, 19) + 'Z';
}

/**
 * Build a self-contained print-friendly HTML document for the event log.
 * The caller opens a window, document.write()s this, then calls print().
 * @param {object} opts - { events, callsign, location: {lat,lon}, grid }
 */
export function buildPrintHtml(opts = {}) {
  const { events: evts = [], callsign = '', location = null, grid = '' } = opts;
  const first = evts.length ? evts[0].ts : null;
  const last = evts.length ? evts[evts.length - 1].ts : null;
  const range = first != null ? `${fmtUtc(first)} — ${fmtUtc(last)}` : 'No events recorded';
  const loc =
    location && location.lat != null && location.lon != null
      ? `${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}${grid ? ` (${esc(grid)})` : ''}`
      : grid
        ? esc(grid)
        : 'Unknown';

  const rows = evts
    .map((ev) => {
      const label = EVENT_TYPE_META[ev.type]?.label || ev.type;
      return `<tr>
        <td class="mono">${fmtUtc(ev.ts)}</td>
        <td>${esc(label)}</td>
        <td class="mono">${esc(ev.callsign)}</td>
        <td>${esc(ev.summary)}${ev.details ? `<div class="detail">${esc(ev.details)}</div>` : ''}</td>
      </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>EmComm Event Log — ${esc(callsign || 'Operator')}</title>
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
  .detail { color: #555; font-size: 10px; margin-top: 2px; }
  @media print { body { margin: 8mm; } }
</style>
</head>
<body>
<h1>EmComm Operation Event Log</h1>
<div class="sub">After Action Review — generated ${fmtUtc(Date.now())} by OpenHamClock</div>
<table class="head">
  <tr><td class="k">Operator</td><td class="mono">${esc(callsign || 'N0CALL')}</td></tr>
  <tr><td class="k">Station location</td><td class="mono">${loc}</td></tr>
  <tr><td class="k">Period (UTC)</td><td class="mono">${range}</td></tr>
  <tr><td class="k">Events</td><td class="mono">${evts.length}</td></tr>
</table>
<table class="log">
  <thead><tr><th>Time (UTC)</th><th>Type</th><th>Callsign</th><th>Event</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
</body>
</html>`;
}
