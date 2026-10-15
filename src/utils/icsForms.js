/**
 * icsForms — data model, row builders, CSV and print-HTML for the ICS Forms
 * panel (EmComm layout operations rail + dockable `ics-forms`).
 *
 * Four standard incident forms are generated from what the app already
 * records, so the paperwork an EOC or served agency asks for at the end of
 * a shift is a print dialog away instead of a transcription job:
 *
 *   ICS 309  Communications Log   — rows from the EmComm event log
 *   ICS 214  Activity Log         — rows imported from the event log, plus
 *                                    free-text rows typed by the operator
 *   ICS 213  General Message      — composed here; optionally sent as one
 *                                    or more 67-character APRS messages
 *   ICS 205  Incident Radio Communications Plan — channels picked from the
 *                                    Repeaters panel and the Net Schedule,
 *                                    plus manually added simplex rows
 *
 * Block numbering and column headings follow the published forms (the
 * ICS 309 is the 8-block communications-unit layout with FROM/TO call
 * sign and message-number columns; 213, 214 and 205 follow the FEMA
 * ICS Forms Booklet). All times are UTC and shown in 24-hour HHMM form —
 * EmComm logs are kept in UTC so stations in different zones agree.
 *
 * Everything here is pure (no DOM, no React): the panel keeps a draft
 * object (persisted in localStorage under ICS_DRAFTS_KEY) and calls these
 * helpers to derive rows, CSV and the print document.
 */
import { esc } from './escapeHtml.js';
import { EVENT_TYPE_META, csvEscape, activeEvents } from './emcommEventLog.js';
import { parseNetFrequency } from './netControl.js';

export const ICS_DRAFTS_KEY = 'openhamclock_icsForms';
/** Maximum APRS message text length (bytes after the addressee field). */
export const APRS_MSG_MAX = 67;
/** Rows per printed page, chosen so a page of each form fits US Letter/A4. */
export const ICS309_ROWS_PER_PAGE = 28;
export const ICS214_ROWS_PER_PAGE = 24;
export const ICS205_ROWS_PER_PAGE = 16;

export const ICS_FORM_IDS = ['309', '214', '213', '205'];
export const ICS_FORM_TITLES = {
  309: 'ICS 309 Communications Log',
  214: 'ICS 214 Activity Log',
  213: 'ICS 213 General Message',
  205: 'ICS 205 Incident Radio Communications Plan',
};

// ── UTC time helpers ────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' (UTC). */
export function utcDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 'HHMM' 24-hour (UTC). */
export function utcTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
}

/** 'YYYY-MM-DD HHMM' (UTC). */
export function utcDateTime(ts) {
  const d = utcDate(ts);
  return d ? `${d} ${utcTime(ts)}` : '';
}

/**
 * Value for an <input type="datetime-local"> holding a UTC wall time:
 * 'YYYY-MM-DDTHH:MM'. We deliberately treat the input as UTC (the label
 * says so) rather than browser-local time.
 */
export function toInputDateTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${utcDate(ts)}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** Parse 'YYYY-MM-DDTHH:MM' (or with seconds) as UTC → epoch ms, or null. */
export function fromInputDateTime(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(str || '').trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  return Number.isFinite(ms) ? ms : null;
}

/** 'YYYY-MM-DDTHH:MM' → 'YYYY-MM-DD HHMM' for printing; passes through other text. */
export function inputToPrintDateTime(str) {
  const ms = fromInputDateTime(str);
  return ms == null ? String(str || '') : utcDateTime(ms);
}

// ── Drafts (persisted form state) ───────────────────────────────────────────
let idCounter = 0;
/** Unique-enough id for editable rows. */
export function newRowId() {
  return `${Date.now().toString(36)}-${(++idCounter).toString(36)}`;
}

/**
 * Fresh draft set. `header` is shared by every form (incident name,
 * operational period, who prepared it) so the operator types it once.
 */
export function defaultDrafts(now = Date.now()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return {
    header: {
      incidentName: '',
      periodFrom: toInputDateTime(start.getTime()),
      periodTo: toInputDateTime(now),
      preparedBy: '',
      preparedCall: '',
    },
    ics309: {
      netName: '',
      operatorName: '',
      operatorCall: '',
      types: [...ICS309_DEFAULT_TYPES],
    },
    ics214: {
      name: '',
      icsPosition: '',
      homeAgency: '',
      resources: [],
      rows: [],
    },
    ics213: {
      to: '',
      toCall: '',
      from: '',
      subject: '',
      dateTime: toInputDateTime(now),
      message: '',
      approvedBy: '',
      approvedPosition: '',
      reply: '',
      repliedBy: '',
      repliedDateTime: '',
    },
    ics205: {
      rows: [],
      specialInstructions: '',
    },
  };
}

/** Deep-ish merge of a stored draft over the defaults (tolerates old shapes). */
export function mergeDrafts(stored, now = Date.now()) {
  const base = defaultDrafts(now);
  if (!stored || typeof stored !== 'object') return base;
  const out = {};
  for (const key of Object.keys(base)) {
    const s = stored[key];
    out[key] = s && typeof s === 'object' ? { ...base[key], ...s } : base[key];
  }
  if (!Array.isArray(out.ics214.resources)) out.ics214.resources = [];
  if (!Array.isArray(out.ics214.rows)) out.ics214.rows = [];
  if (!Array.isArray(out.ics205.rows)) out.ics205.rows = [];
  if (!Array.isArray(out.ics309.types)) out.ics309.types = [...ICS309_DEFAULT_TYPES];
  return out;
}

export function loadDrafts(now = Date.now()) {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(ICS_DRAFTS_KEY) : null;
    return mergeDrafts(raw ? JSON.parse(raw) : null, now);
  } catch {
    return defaultDrafts(now);
  }
}

export function saveDrafts(drafts) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(ICS_DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* quota / private mode — the draft lives on in memory */
  }
}

// ── Event-log range filter ──────────────────────────────────────────────────
/**
 * Events inside [from, to] (epoch ms, either may be null = open-ended),
 * oldest first.
 */
export function eventsInRange(events, { from = null, to = null } = {}) {
  // Entries withdrawn by Net Control's Undo (and the withdrawal records
  // themselves) never reach a form.
  return activeEvents(events)
    .filter((ev) => Number.isFinite(ev?.ts) && (from == null || ev.ts >= from) && (to == null || ev.ts <= to))
    .slice()
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Range from the shared header's operational period (UTC inputs). The inputs
 * have minute resolution, so the end is inclusive of its whole minute.
 */
export function headerRange(header) {
  const to = fromInputDateTime(header?.periodTo);
  return { from: fromInputDateTime(header?.periodFrom), to: to == null ? null : to + 59999 };
}

// ── ICS 309 Communications Log ──────────────────────────────────────────────
/**
 * Event types that are message traffic and belong on a Comm Log by default.
 * NWS alerts and first-heard stations are situational awareness rather than
 * traffic handled by the operator, so they are opt-in.
 */
export const ICS309_DEFAULT_TYPES = [
  'net_checkin',
  'net_checkout',
  'net_traffic',
  'aprs_msg_sent',
  'aprs_msg_rx',
  'ics213_sent',
  'shelter_report',
  'field_report',
];

const MSG_TO_RE = /\bto\s+(\S+)\s*$/i;

/**
 * One ICS 309 row per event. The log's FROM/TO columns are filled from what
 * each event type knows:
 *   aprs_msg_sent  from = our call, to = addressee (parsed from the summary)
 *   aprs_msg_rx    from = sender, to = addressee (bulletin → "Bulletin: …")
 *   net_checkin/out, shelter_report, field_report, station_heard
 *                  from = the station, to = our call (operatorCall)
 *   nws_alert      from = "NWS", to = our call
 * `message` is the summary plus details so nothing in the log is lost.
 */
export function ics309RowsFromEvents(events, { from = null, to = null, operatorCall = '', types = null } = {}) {
  const me = String(operatorCall || '').toUpperCase();
  const allow = Array.isArray(types) ? new Set(types) : null;
  return eventsInRange(events, { from, to })
    .filter((ev) => !allow || allow.has(ev.type))
    .map((ev) => {
      const label = EVENT_TYPE_META[ev.type]?.label || ev.type;
      let rowFrom = String(ev.callsign || '').toUpperCase();
      let rowTo = me;
      let message = ev.summary || '';
      const details = ev.details || '';
      if (ev.type === 'aprs_msg_sent') {
        const m = MSG_TO_RE.exec(ev.summary || '');
        rowTo = m ? m[1].toUpperCase() : '';
        message = details || ev.summary || '';
      } else if (ev.type === 'ics213_sent') {
        // summary: "ICS 213 to <CALL>: <subject>"; details: the text sent
        const m = /\bto\s+([^\s:]+)/i.exec(ev.summary || '');
        rowTo = m ? m[1].toUpperCase() : '';
        message = `ICS 213 — ${details || ev.summary || ''}`;
      } else if (ev.type === 'aprs_msg_rx') {
        const m = MSG_TO_RE.exec(ev.summary || '');
        rowTo = m ? m[1].toUpperCase() : me;
        const bulletin = /^bulletin/i.test(ev.summary || '');
        message = `${bulletin ? 'Bulletin: ' : ''}${details || ev.summary || ''}`;
      } else if (ev.type === 'nws_alert') {
        rowFrom = rowFrom || 'NWS';
        message = `${label}: ${ev.summary || ''}${details ? ` — ${details}` : ''}`;
      } else {
        message = `${ev.summary || label}${details ? ` — ${details}` : ''}`;
      }
      return {
        id: ev.id,
        ts: ev.ts,
        date: utcDate(ev.ts),
        time: utcTime(ev.ts),
        from: rowFrom,
        fromMsg: '',
        to: rowTo,
        toMsg: '',
        message,
        type: ev.type,
      };
    });
}

/** CSV for the ICS 309: a short identification block, then the log table. */
export function ics309Csv(drafts, rows) {
  const h = drafts.header || {};
  const f = drafts.ics309 || {};
  const lines = [
    ['Form', 'ICS 309 Communications Log'].map(csvEscape).join(','),
    ['1. Incident Name', h.incidentName || ''].map(csvEscape).join(','),
    ['2. Operational Period (UTC)', `${inputToPrintDateTime(h.periodFrom)} to ${inputToPrintDateTime(h.periodTo)}`]
      .map(csvEscape)
      .join(','),
    ['3. Radio Net Name / Position', f.netName || ''].map(csvEscape).join(','),
    ['4. Radio Operator', [f.operatorName, f.operatorCall].filter(Boolean).join(' ')].map(csvEscape).join(','),
    ['6. Prepared By', [h.preparedBy, h.preparedCall].filter(Boolean).join(' ')].map(csvEscape).join(','),
    ['7. Date & Time Prepared (UTC)', utcDateTime(Date.now())].map(csvEscape).join(','),
    '',
    'Date (UTC),Time (24:00),From Call Sign/ID,From Msg #,To Call Sign/ID,To Msg #,Message',
  ];
  for (const r of rows || []) {
    lines.push([r.date, r.time, r.from, r.fromMsg, r.to, r.toMsg, r.message].map(csvEscape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ── ICS 214 Activity Log ────────────────────────────────────────────────────
/** Editable activity rows derived from the event log (block 7). */
export function ics214RowsFromEvents(events, { from = null, to = null } = {}) {
  return eventsInRange(events, { from, to }).map((ev) => {
    const label = EVENT_TYPE_META[ev.type]?.label || ev.type;
    const who = ev.callsign ? `${String(ev.callsign).toUpperCase()}: ` : '';
    const details = ev.details ? ` — ${ev.details}` : '';
    return {
      id: `ev-${ev.id}`,
      dateTime: toInputDateTime(ev.ts),
      text: `${label}. ${who}${ev.summary || ''}${details}`.trim(),
      source: 'event',
    };
  });
}

/** Blank manual activity row (block 7), stamped now. */
export function newIcs214Row(now = Date.now()) {
  return { id: newRowId(), dateTime: toInputDateTime(now), text: '', source: 'manual' };
}

/**
 * Merge event-derived rows into existing rows: rows already imported (same
 * id) are left alone so the operator's edits survive a re-import; new
 * events are appended and the list is re-sorted by time.
 */
export function mergeIcs214Rows(existing, imported) {
  const have = new Set((existing || []).map((r) => r.id));
  const out = [...(existing || [])];
  for (const r of imported || []) if (!have.has(r.id)) out.push(r);
  return sortRowsByDateTime(out);
}

export function sortRowsByDateTime(rows) {
  return (rows || [])
    .slice()
    .sort((a, b) => (fromInputDateTime(a.dateTime) ?? Infinity) - (fromInputDateTime(b.dateTime) ?? Infinity));
}

export function newIcs214Resource() {
  return { id: newRowId(), name: '', position: '', agency: '' };
}

// ── ICS 213 General Message → APRS ──────────────────────────────────────────
/** The text that goes on the air: "Subject: message" (subject optional). */
export function ics213AprsText(form) {
  const subject = String(form?.subject || '').trim();
  const message = String(form?.message || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!message) return subject;
  return subject ? `${subject}: ${message}` : message;
}

/**
 * Split text into APRS-sized parts. A single part is sent as-is. Longer
 * text becomes numbered parts — "1/3 …", "2/3 …" — each ≤ `max` characters
 * including its prefix, split on word boundaries where possible (a word
 * longer than a whole part is hard-cut). Returns [] for blank text.
 */
export function splitForAprs(text, max = APRS_MSG_MAX) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  const chunk = (budget) => {
    const parts = [];
    let rest = clean;
    while (rest.length) {
      if (rest.length <= budget) {
        parts.push(rest);
        break;
      }
      let cut = rest.lastIndexOf(' ', budget);
      if (cut < Math.floor(budget / 2)) cut = budget; // no usable space — hard cut
      parts.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    return parts;
  };

  // The "i/N " prefix length depends on N, which depends on the prefix
  // length. Iterate until the count is stable (converges in ≤ 3 passes).
  let n = chunk(max - 4).length; // assume "9/9 " (4 chars) to start
  for (let pass = 0; pass < 4; pass++) {
    const prefixLen = `${n}/${n} `.length;
    const parts = chunk(max - prefixLen);
    if (parts.length === n) {
      return parts.map((p, i) => `${i + 1}/${n} ${p}`);
    }
    n = parts.length;
  }
  const prefixLen = `${n}/${n} `.length;
  const parts = chunk(max - prefixLen);
  return parts.map((p, i) => `${i + 1}/${parts.length} ${p}`);
}

// ── ICS 205 Incident Radio Communications Plan ──────────────────────────────
/** Mode code for block 4: A = analog, D = digital, M = mixed. */
export function ics205ModeCode(mode) {
  const m = String(mode || '')
    .trim()
    .toUpperCase();
  if (!m) return 'A';
  if (
    /MIXED|\bM\b/.test(m) ||
    (m.includes('/') && /FM|ANALOG/.test(m) && /DMR|D-?STAR|YSF|C4FM|P25|NXDN|DIGITAL/.test(m))
  )
    return 'M';
  if (/DMR|D-?STAR|YSF|FUSION|C4FM|P25|NXDN|DIGITAL|DATA|FT8|FT4|JS8|PACKET|APRS|M17|TETRA/.test(m)) return 'D';
  return 'A';
}

/** Frequency as printed on the plan: MHz with 4 decimals, trailing zeros trimmed to at least 3. */
export function formatPlanFreq(mhz) {
  const n = Number(mhz);
  if (!Number.isFinite(n) || n <= 0) return '';
  const s = n.toFixed(4);
  return s.endsWith('0') ? s.slice(0, -1) : s;
}

/** Blank editable channel row (block 4). */
export function newIcs205Row(partial = {}) {
  return {
    id: newRowId(),
    zone: '',
    ch: '',
    function: '',
    name: '',
    assignment: '',
    rxFreq: '',
    rxNW: 'N',
    rxTone: '',
    txFreq: '',
    txNW: 'N',
    txTone: '',
    mode: 'A',
    remarks: '',
    source: 'manual',
    ...partial,
  };
}

/**
 * Row from a Repeaters panel entry ({ callsign, mhz, offsetMhz, tone, mode,
 * city, group }). The repeater's output is what the radio receives, so RX
 * is the listed frequency and TX is output + offset; the listed tone is the
 * uplink (TX) tone.
 */
export function ics205RowFromRepeater(r) {
  const out = Number(r?.mhz);
  const offset = Number(r?.offsetMhz) || 0;
  return newIcs205Row({
    function: 'Repeater',
    name: String(r?.callsign || '').toUpperCase(),
    rxFreq: formatPlanFreq(out),
    txFreq: formatPlanFreq(out + offset),
    txTone: String(r?.tone || ''),
    mode: ics205ModeCode(r?.mode),
    remarks: [r?.city, r?.group].filter(Boolean).join(' · '),
    source: 'repeater',
  });
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Row from a Net Schedule entry ({ name, freq_mhz, mode, day, time_utc, notes }). */
export function ics205RowFromNet(net) {
  const freq = formatPlanFreq(net?.freq_mhz);
  const day = net?.day === 'daily' ? 'Daily' : DAY_SHORT[Number(net?.day)] || '';
  const when = [day, net?.time_utc ? `${net.time_utc}Z` : ''].filter(Boolean).join(' ');
  return newIcs205Row({
    function: 'Net',
    name: String(net?.name || ''),
    assignment: 'All stations',
    rxFreq: freq,
    txFreq: freq,
    mode: ics205ModeCode(net?.mode),
    remarks: [when, net?.mode || '', net?.notes || ''].filter(Boolean).join(' · '),
    source: 'net',
  });
}

/**
 * Row from the voice net running in Net Control (its roster snapshot:
 * { net, ncs, frequency (free text), freqMhz?, mode? }). The frequency text
 * is read for an offset and tone ("146.940 − PL 100.0"): RX is the listed
 * frequency, TX the listed frequency plus the offset, the tone goes on TX.
 */
export function ics205RowFromVoiceNet(snapshot) {
  const parsed = parseNetFrequency(snapshot?.frequency) || {};
  const rx = Number(snapshot?.freqMhz) > 0 ? Number(snapshot.freqMhz) : parsed.mhz;
  const tx = parsed.mhz != null && parsed.mhz === rx ? parsed.txMhz : rx;
  return newIcs205Row({
    function: 'Net',
    name: String(snapshot?.net || ''),
    assignment: 'All stations',
    rxFreq: formatPlanFreq(rx),
    txFreq: formatPlanFreq(tx),
    txTone: parsed.tone || '',
    mode: ics205ModeCode(snapshot?.mode || parsed.mode),
    remarks: [snapshot?.ncs ? `NCS ${snapshot.ncs}` : '', snapshot?.frequency || ''].filter(Boolean).join(' · '),
    source: 'net-control',
  });
}

/** Manually added simplex channel: RX = TX, no tone. */
export function newSimplexRow({ name = '', mhz = '', func = 'Simplex' } = {}) {
  const freq = formatPlanFreq(mhz);
  return newIcs205Row({ function: func, name, rxFreq: freq, txFreq: freq, source: 'manual' });
}

/** Fill blank "Ch #" cells with their 1-based position (operator entries win). */
export function numberChannels(rows) {
  return (rows || []).map((r, i) => (String(r.ch || '').trim() ? r : { ...r, ch: String(i + 1) }));
}

// ── Print HTML ──────────────────────────────────────────────────────────────
const pages = (rows, perPage) => {
  const out = [];
  const list = rows && rows.length ? rows : [];
  for (let i = 0; i < Math.max(1, Math.ceil(list.length / perPage)); i++)
    out.push(list.slice(i * perPage, (i + 1) * perPage));
  return out;
};

const blankRows = (count, cols) =>
  Array.from({ length: count }, () => `<tr class="blank">${'<td>&nbsp;</td>'.repeat(cols)}</tr>`).join('');

const cell = (label, value, extra = '') =>
  `<div class="ics-cell${extra ? ` ${extra}` : ''}"><div class="ics-label">${esc(label)}</div><div class="ics-value">${esc(value || '')}&nbsp;</div></div>`;

const nameCall = (name, call) => [name, call].filter(Boolean).join(' ');

/**
 * ICS 309 Communications Log. One printed page per ICS309_ROWS_PER_PAGE rows,
 * header repeated, "Page n of N" in block 8.
 */
export function buildIcs309Html(drafts, rows, { now = Date.now() } = {}) {
  const h = drafts.header || {};
  const f = drafts.ics309 || {};
  const period = `From: ${inputToPrintDateTime(h.periodFrom)}  To: ${inputToPrintDateTime(h.periodTo)}`;
  const pageList = pages(rows, ICS309_ROWS_PER_PAGE);
  return pageList
    .map((pageRows, pi) => {
      const body = pageRows
        .map(
          (r) =>
            `<tr><td class="mono">${esc(r.time)}</td><td class="mono">${esc(r.from)}</td><td class="mono">${esc(r.fromMsg)}</td><td class="mono">${esc(r.to)}</td><td class="mono">${esc(r.toMsg)}</td><td>${esc(r.message)}</td></tr>`,
        )
        .join('');
      const fill = pi === pageList.length - 1 ? blankRows(Math.max(0, ICS309_ROWS_PER_PAGE - pageRows.length), 6) : '';
      return `<section class="ics-form ics-309">
<header class="ics-head">
  <div class="ics-title"><strong>COMM Log</strong><br>ICS 309</div>
  ${cell('1. Incident Name and Activation Number', h.incidentName, 'grow')}
  ${cell('2. Operational Period (Date/Time, UTC)', period, 'grow')}
</header>
<div class="ics-row">
  ${cell('3. Radio Net Name (for NCS) or Position/Tactical Call', f.netName, 'grow')}
  ${cell('4. Radio Operator (Name, Call Sign)', nameCall(f.operatorName, f.operatorCall), 'grow')}
</div>
<div class="ics-section">5. COMMUNICATIONS LOG</div>
<table class="ics-table">
<thead>
  <tr><th rowspan="2" class="w-time">Time<br>(24:00)</th><th colspan="2">FROM</th><th colspan="2">TO</th><th rowspan="2">Message</th></tr>
  <tr><th class="w-call">Call Sign/ID</th><th class="w-msg">Msg #</th><th class="w-call">Call Sign/ID</th><th class="w-msg">Msg #</th></tr>
</thead>
<tbody>${body}${fill}</tbody>
</table>
<footer class="ics-row">
  ${cell('6. Prepared By (Name, Call Sign)', nameCall(h.preparedBy, h.preparedCall), 'grow')}
  ${cell('7. Date & Time Prepared (UTC)', utcDateTime(now), 'grow')}
  ${cell('8.', `Page ${pi + 1} of ${pageList.length}`)}
</footer>
</section>`;
    })
    .join('');
}

/** ICS 214 Activity Log (FEMA blocks 1–8), paged on block 7. */
export function buildIcs214Html(drafts, { now = Date.now() } = {}) {
  const h = drafts.header || {};
  const f = drafts.ics214 || {};
  const rows = sortRowsByDateTime(f.rows || []);
  const pageList = pages(rows, ICS214_ROWS_PER_PAGE);
  const resources = (f.resources || []).filter((r) => r.name || r.position || r.agency);
  const resRows =
    resources
      .map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.position)}</td><td>${esc(r.agency)}</td></tr>`)
      .join('') + blankRows(Math.max(0, 3 - resources.length), 3);
  return pageList
    .map((pageRows, pi) => {
      const body = pageRows
        .map((r) => `<tr><td class="mono">${esc(inputToPrintDateTime(r.dateTime))}</td><td>${esc(r.text)}</td></tr>`)
        .join('');
      const fill = pi === pageList.length - 1 ? blankRows(Math.max(0, ICS214_ROWS_PER_PAGE - pageRows.length), 2) : '';
      return `<section class="ics-form ics-214">
<header class="ics-head">
  <div class="ics-title"><strong>ACTIVITY LOG</strong><br>(ICS 214)</div>
  ${cell('1. Incident Name', h.incidentName, 'grow')}
  ${cell('2. Operational Period (UTC)', `Date/Time From: ${inputToPrintDateTime(h.periodFrom)}  Date/Time To: ${inputToPrintDateTime(h.periodTo)}`, 'grow')}
</header>
<div class="ics-row">
  ${cell('3. Name', f.name, 'grow')}
  ${cell('4. ICS Position', f.icsPosition, 'grow')}
  ${cell('5. Home Agency (and Unit)', f.homeAgency, 'grow')}
</div>
<div class="ics-section">6. Resources Assigned</div>
<table class="ics-table">
<thead><tr><th>Name</th><th>ICS Position</th><th>Home Agency (and Unit)</th></tr></thead>
<tbody>${resRows}</tbody>
</table>
<div class="ics-section">7. Activity Log</div>
<table class="ics-table">
<thead><tr><th class="w-datetime">Date/Time (UTC)</th><th>Notable Activities</th></tr></thead>
<tbody>${body}${fill}</tbody>
</table>
<footer class="ics-row">
  ${cell('8. Prepared by: Name/Position/Title', nameCall(h.preparedBy, h.preparedCall), 'grow')}
  ${cell('Signature', '', 'grow sig')}
  ${cell('Date/Time (UTC)', utcDateTime(now))}
  ${cell('', `Page ${pi + 1} of ${pageList.length}`)}
</footer>
<div class="ics-foot">ICS 214, Page ${pi + 1}</div>
</section>`;
    })
    .join('');
}

/** ICS 213 General Message (FEMA blocks 1–10), one page. */
export function buildIcs213Html(drafts) {
  const h = drafts.header || {};
  const f = drafts.ics213 || {};
  const when = fromInputDateTime(f.dateTime);
  const date = when == null ? '' : utcDate(when);
  const time = when == null ? '' : utcTime(when);
  return `<section class="ics-form ics-213">
<header class="ics-head">
  <div class="ics-title"><strong>GENERAL MESSAGE</strong><br>(ICS 213)</div>
  ${cell('1. Incident Name (Optional)', h.incidentName, 'grow')}
</header>
<div class="ics-row">${cell('2. To (Name and Position)', f.toCall ? `${f.to || ''} (${f.toCall})`.trim() : f.to, 'grow')}</div>
<div class="ics-row">${cell('3. From (Name and Position)', f.from, 'grow')}</div>
<div class="ics-row">
  ${cell('4. Subject', f.subject, 'grow')}
  ${cell('5. Date (UTC)', date)}
  ${cell('6. Time (UTC)', time)}
</div>
<div class="ics-row"><div class="ics-cell grow tall"><div class="ics-label">7. Message</div><div class="ics-value pre">${esc(f.message || '')}&nbsp;</div></div></div>
<div class="ics-row">
  ${cell('8. Approved by: Name', f.approvedBy, 'grow')}
  ${cell('Signature', '', 'grow sig')}
  ${cell('Position/Title', f.approvedPosition, 'grow')}
</div>
<div class="ics-row"><div class="ics-cell grow tall"><div class="ics-label">9. Reply</div><div class="ics-value pre">${esc(f.reply || '')}&nbsp;</div></div></div>
<div class="ics-row">
  ${cell('10. Replied by: Name/Position/Title', f.repliedBy, 'grow')}
  ${cell('Signature', '', 'grow sig')}
  ${cell('Date/Time (UTC)', inputToPrintDateTime(f.repliedDateTime))}
</div>
<div class="ics-foot">ICS 213</div>
</section>`;
}

/** ICS 205 Incident Radio Communications Plan (FEMA blocks 1–6), paged on block 4. */
export function buildIcs205Html(drafts, { now = Date.now() } = {}) {
  const h = drafts.header || {};
  const f = drafts.ics205 || {};
  const rows = numberChannels(f.rows || []);
  const pageList = pages(rows, ICS205_ROWS_PER_PAGE);
  return pageList
    .map((pageRows, pi) => {
      const body = pageRows
        .map(
          (r) =>
            `<tr><td>${esc(r.zone)}</td><td>${esc(r.ch)}</td><td>${esc(r.function)}</td><td>${esc(r.name)}</td><td>${esc(r.assignment)}</td><td class="mono">${esc(r.rxFreq)}${r.rxFreq ? ` ${esc(r.rxNW || 'N')}` : ''}</td><td class="mono">${esc(r.rxTone)}</td><td class="mono">${esc(r.txFreq)}${r.txFreq ? ` ${esc(r.txNW || 'N')}` : ''}</td><td class="mono">${esc(r.txTone)}</td><td>${esc(r.mode)}</td><td>${esc(r.remarks)}</td></tr>`,
        )
        .join('');
      const fill = pi === pageList.length - 1 ? blankRows(Math.max(0, ICS205_ROWS_PER_PAGE - pageRows.length), 11) : '';
      return `<section class="ics-form ics-205 landscape">
<header class="ics-head">
  <div class="ics-title"><strong>INCIDENT RADIO COMMUNICATIONS PLAN</strong><br>(ICS 205)</div>
  ${cell('1. Incident Name', h.incidentName, 'grow')}
  ${cell('2. Date/Time Prepared (UTC)', utcDateTime(now))}
  ${cell('3. Operational Period (UTC)', `Date/Time From: ${inputToPrintDateTime(h.periodFrom)}  Date/Time To: ${inputToPrintDateTime(h.periodTo)}`, 'grow')}
</header>
<div class="ics-section">4. Basic Radio Channel Use</div>
<table class="ics-table ics-205-table">
<thead><tr>
  <th>Zone Grp.</th><th>Ch #</th><th>Function</th><th>Channel Name/Trunked Radio System Talkgroup</th><th>Assignment</th>
  <th>RX Freq N or W</th><th>RX Tone/NAC</th><th>TX Freq N or W</th><th>TX Tone/NAC</th><th>Mode (A, D, or M)</th><th>Remarks</th>
</tr></thead>
<tbody>${body}${fill}</tbody>
</table>
<div class="ics-row"><div class="ics-cell grow tall"><div class="ics-label">5. Special Instructions</div><div class="ics-value pre">${esc(f.specialInstructions || '')}&nbsp;</div></div></div>
<footer class="ics-row">
  ${cell('6. Prepared by (Communications Unit Leader): Name', nameCall(h.preparedBy, h.preparedCall), 'grow')}
  ${cell('Signature', '', 'grow sig')}
  ${cell('Date/Time (UTC)', utcDateTime(now))}
  ${cell('', `Page ${pi + 1} of ${pageList.length}`)}
</footer>
<div class="ics-foot">ICS 205</div>
</section>`;
    })
    .join('');
}

/** Build the print HTML for any form id. */
export function buildIcsHtml(formId, drafts, { events = [], now = Date.now() } = {}) {
  switch (String(formId)) {
    case '309': {
      const rows = ics309RowsFromEvents(events, {
        ...headerRange(drafts.header),
        operatorCall: drafts.ics309?.operatorCall,
        types: drafts.ics309?.types,
      });
      return buildIcs309Html(drafts, rows, { now });
    }
    case '214':
      return buildIcs214Html(drafts, { now });
    case '213':
      return buildIcs213Html(drafts);
    case '205':
      return buildIcs205Html(drafts, { now });
    default:
      return '';
  }
}
