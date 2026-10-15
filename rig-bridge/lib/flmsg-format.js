'use strict';
/**
 * flmsg-format.js — read and write NBEMS flmsg form files.
 *
 * flmsg stores every form as a small text file:
 *
 *   <flmsg>4.0.23
 *   :hdr_fm:21 KE8PLM 20261015143200
 *   :hdr_ed:21 KE8PLM 20261015143200
 *   <ics213>
 *   :to:14 Logistics Chief
 *   :fm:16 Shelter 3 Manager
 *   :sb:13 Cots required
 *   :mg:41 Need 40 cots at Lincoln HS
 *   by 1800 local.
 *   ...
 *
 * Each field is `:tag:` + the value's length in bytes + one space + the value
 * + a newline. Because the length is explicit, values may contain newlines.
 * Empty fields are omitted. The `<form>` line names the form (ics213,
 * radiogram, plaintext, ics205, ...).
 *
 * Over the air, flmsg sends that file inside a WRAP envelope so the receiving
 * station can verify it arrived intact:
 *
 *   [WRAP:beg][WRAP:lf][WRAP:fn name.213]<flmsg>...[WRAP:chksum 1A2B][WRAP:end]
 *
 * The checksum is a CRC-16 (init 0xFFFF, reflected polynomial 0xA001) printed
 * as four uppercase hex digits, computed over everything from `[WRAP:beg]` up
 * to the `[WRAP:chksum` marker.
 *
 * Pure module (no fs, no network) so it can be unit-tested and shared.
 */

const crypto = require('crypto');
const { gridToLatLon } = require('./wsjtx-enrich');

// ── Form catalogue ──────────────────────────────────────────────────────────

/** Display names for the form tags flmsg writes. Unknown tags fall back to upper case. */
const FORM_NAMES = {
  ics203: 'ICS-203',
  ics205: 'ICS-205',
  ics205a: 'ICS-205A',
  ics206: 'ICS-206',
  ics213: 'ICS-213',
  ics214: 'ICS-214',
  ics216: 'ICS-216',
  ics309: 'ICS-309',
  hics203: 'HICS-203',
  hics206: 'HICS-206',
  hics213: 'HICS-213',
  hics214: 'HICS-214',
  radiogram: 'Radiogram',
  plaintext: 'Plain Text',
  blankform: 'Blank Form',
  csvform: 'CSV Form',
  customform: 'Custom Form',
  iaru: 'IARU Message',
};

/** ICS-213 General Message — friendly field name → flmsg tag. */
const ICS213_TAGS = {
  incident: 'inc',
  to: 'to',
  toPosition: 'p1',
  from: 'fm',
  fromPosition: 'p2',
  subject: 'sb',
  date: 'd1',
  time: 't1',
  message: 'mg',
  approvedBy: 's1',
  approvedPosition: 'p3',
  reply: 'rp',
  replyDate: 'd2',
  replyTime: 't2',
  repliedBy: 's2',
  repliedPosition: 'p4',
};

/** Radiogram — friendly field name → flmsg tag. */
const RADIOGRAM_TAGS = {
  number: 'nbr',
  precedence: 'prec',
  handling: 'hx',
  stationOfOrigin: 'sta',
  check: 'ck',
  placeOfOrigin: 'org',
  timeFiled: 't1',
  dateFiled: 'd1',
  to: 'to',
  phone: 'tel',
  message: 'msg',
  signature: 'sig',
};

// ── Field-level encoding ────────────────────────────────────────────────────

/** One field line, flmsg style. Empty values produce nothing. */
function lineout(tag, value) {
  if (value == null) return '';
  const v = String(value);
  if (v === '') return '';
  return `:${tag}:${Buffer.byteLength(v, 'utf8')} ${v}\n`;
}

const FIELD_HEAD = /^:([A-Za-z0-9_]+):(\d+) /;
const FORM_LINE = /^<([A-Za-z0-9_]+)>([^\n]*)$/;

/**
 * Parse an flmsg file body. Tolerant: when a declared length does not land on
 * a line end (hand-edited file, CRLF conversion, truncated transfer) the value
 * runs to the next line that starts a new field or form instead.
 *
 * @param {string} text
 * @returns {{ version: string|null, form: string|null, header: object, fields: object }}
 */
function parseFlmsg(text) {
  const out = { version: null, form: null, header: {}, fields: {} };
  if (typeof text !== 'string') return out;
  let s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  s = s.replace(/\r\n/g, '\n');

  let i = 0;
  while (i < s.length) {
    // Skip blank lines between entries
    if (s[i] === '\n') {
      i++;
      continue;
    }
    const lineEnd = s.indexOf('\n', i) === -1 ? s.length : s.indexOf('\n', i);
    const line = s.slice(i, lineEnd);

    const form = line.match(FORM_LINE);
    if (form) {
      const tag = form[1].toLowerCase();
      if (tag === 'flmsg') out.version = form[2].trim() || null;
      else if (!out.form) out.form = tag;
      i = lineEnd + 1;
      continue;
    }

    const head = line.match(FIELD_HEAD);
    if (!head) {
      // Stray text outside any field — skip the line
      i = lineEnd + 1;
      continue;
    }
    const tag = head[1];
    const declared = parseInt(head[2], 10);
    const valueStart = i + head[0].length;

    // Take `declared` bytes (not characters) from valueStart.
    const restBuf = Buffer.from(s.slice(valueStart), 'utf8');
    let value = restBuf.subarray(0, declared).toString('utf8');
    let next = valueStart + value.length;
    const exact = declared <= restBuf.length && (next >= s.length || s[next] === '\n');
    if (!exact) {
      // Fallback: value runs until the next line that looks like a field or form
      const re = /\n(?=:[A-Za-z0-9_]+:\d+ |<[A-Za-z0-9_]+>)/g;
      re.lastIndex = valueStart;
      const m = re.exec(s);
      next = m ? m.index : s.length;
      value = s.slice(valueStart, next).replace(/\n+$/, '');
    }
    if (out.form) out.fields[tag] = value;
    else out.header[tag] = value;
    i = next + 1;
  }
  return out;
}

/**
 * Serialise a form to flmsg's file format.
 * @param {object} doc
 * @param {string} doc.form            form tag, e.g. 'ics213'
 * @param {object} doc.fields          tag → value (written in insertion order)
 * @param {string} [doc.call]          originating callsign for the header
 * @param {Date|number} [doc.when]     header timestamp (default now)
 * @param {string} [doc.version]       flmsg version string to claim
 */
function serializeFlmsg({ form, fields, call = '', when = Date.now(), version = '4.0.23' }) {
  const stamp = flmsgStamp(when);
  const hdr = call ? `${String(call).toUpperCase()} ${stamp}` : stamp;
  let out = `<flmsg>${version}\n`;
  out += lineout('hdr_fm', hdr);
  out += lineout('hdr_ed', hdr);
  out += `<${form}>\n`;
  for (const [tag, value] of Object.entries(fields || {})) out += lineout(tag, value);
  return out;
}

/** YYYYMMDDhhmmss in UTC, as flmsg writes in its header lines. */
function flmsgStamp(when) {
  const d = new Date(typeof when === 'number' ? when : (when?.getTime?.() ?? Date.now()));
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** Friendly ICS-213 object → flmsg tag map (only non-empty fields). */
function ics213ToFields(input = {}) {
  const fields = {};
  for (const [name, tag] of Object.entries(ICS213_TAGS)) {
    const v = input[name];
    if (v != null && String(v).trim() !== '') fields[tag] = String(v);
  }
  return fields;
}

/** flmsg tag map → friendly object for a known form. */
function fieldsToFriendly(form, fields) {
  const table = form === 'ics213' || form === 'hics213' ? ICS213_TAGS : form === 'radiogram' ? RADIOGRAM_TAGS : null;
  if (!table) return { ...fields };
  const out = {};
  const known = new Set();
  for (const [name, tag] of Object.entries(table)) {
    if (fields[tag] != null) out[name] = fields[tag];
    known.add(tag);
  }
  for (const [tag, v] of Object.entries(fields)) if (!known.has(tag)) out[tag] = v;
  return out;
}

/**
 * Build a complete ICS-213 flmsg file.
 * @param {object} input  { to, toPosition, from, fromPosition, subject, date,
 *                          time, message, approvedBy, approvedPosition, incident }
 * @param {object} [opts] { call, when }
 */
function buildIcs213(input, opts = {}) {
  const when = opts.when ?? Date.now();
  const d = new Date(when);
  const p = (n) => String(n).padStart(2, '0');
  const filled = {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`,
    ...input,
  };
  return serializeFlmsg({ form: 'ics213', fields: ics213ToFields(filled), call: opts.call || '', when });
}

// ── WRAP envelope + CRC-16 ──────────────────────────────────────────────────

const WRAP_BEG = '[WRAP:beg]';
const WRAP_LF = '[WRAP:lf]';
const WRAP_CRLF = '[WRAP:crlf]';
const WRAP_FN = '[WRAP:fn ';
const WRAP_CHKSUM = '[WRAP:chksum ';
const WRAP_END = '[WRAP:end]';

/** CRC-16, init 0xFFFF, reflected poly 0xA001, over the UTF-8 bytes. Returns 'XXXX'. */
function crc16(str) {
  let crc = 0xffff;
  for (const byte of Buffer.from(String(str), 'utf8')) {
    crc ^= byte;
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Wrap file content for transmission. */
function wrapFlmsg(content, filename) {
  const fn = String(filename || 'message.213').replace(/[\]\r\n]/g, '_');
  const body = `${WRAP_BEG}${WRAP_LF}${WRAP_FN}${fn}]${content}`;
  return `${body}${WRAP_CHKSUM}${crc16(body)}]${WRAP_END}`;
}

/** True when the text contains a WRAP envelope. */
function isWrapped(text) {
  return typeof text === 'string' && text.includes(WRAP_BEG) && text.includes(WRAP_END);
}

/**
 * Strip a WRAP envelope.
 * @returns {{ filename: string|null, content: string, checksum: string|null, checksumOk: boolean|null, compressed: boolean }|null}
 *   null when no envelope is present.
 */
function unwrapFlmsg(text) {
  if (!isWrapped(text)) return null;
  const beg = text.indexOf(WRAP_BEG);
  const end = text.indexOf(WRAP_END, beg);
  const ck = text.lastIndexOf(WRAP_CHKSUM, end);
  let pos = beg + WRAP_BEG.length;
  if (text.startsWith(WRAP_LF, pos)) pos += WRAP_LF.length;
  else if (text.startsWith(WRAP_CRLF, pos)) pos += WRAP_CRLF.length;
  let filename = null;
  if (text.startsWith(WRAP_FN, pos)) {
    const close = text.indexOf(']', pos);
    filename = text.slice(pos + WRAP_FN.length, close).trim() || null;
    pos = close + 1;
  }
  const contentEnd = ck > pos ? ck : end;
  const content = text.slice(pos, contentEnd);
  let checksum = null;
  let checksumOk = null;
  if (ck > pos) {
    checksum = text
      .slice(ck + WRAP_CHKSUM.length, text.indexOf(']', ck))
      .trim()
      .toUpperCase();
    // Primary: envelope + content. Accept a content-only checksum too.
    checksumOk = crc16(text.slice(beg, ck)) === checksum || crc16(content) === checksum;
  }
  return { filename, content, checksum, checksumOk, compressed: content.includes('[b64:start]') };
}

// ── Locations inside free text ──────────────────────────────────────────────

/**
 * Find a position written into a form's text. Recognised:
 *   "LAT 39.0997 LON -94.5786", "Lat: 39.1N Long: 94.6W"
 *   "GRID EM29qb", "Locator: EM29", "MH EM29qb"
 *   a bare decimal pair with 3+ decimals: "39.0997, -94.5786"
 * @returns {{ lat: number, lon: number, source: string }|null}
 */
function findLocation(text) {
  if (!text) return null;
  const s = String(text);
  const valid = (lat, lon) =>
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  let m = s.match(
    /\bLAT(?:ITUDE)?\s*[:=]?\s*(-?\d{1,2}(?:\.\d+)?)\s*([NS])?[\s,;/]+LON(?:G(?:ITUDE)?)?\s*[:=]?\s*(-?\d{1,3}(?:\.\d+)?)\s*([EW])?/i,
  );
  if (m) {
    let lat = parseFloat(m[1]);
    let lon = parseFloat(m[3]);
    if (m[2] && m[2].toUpperCase() === 'S') lat = -Math.abs(lat);
    if (m[4] && m[4].toUpperCase() === 'W') lon = -Math.abs(lon);
    if (valid(lat, lon)) return { lat, lon, source: 'latlon' };
  }
  m = s.match(/\b(?:GRID|LOCATOR|LOC|MH)\s*[:=]?\s*([A-R]{2}\d{2}(?:[A-X]{2})?)\b/i);
  if (m) {
    const ll = gridToLatLon(m[1]);
    if (ll && valid(ll.lat, ll.lon)) return { lat: ll.lat, lon: ll.lon, source: 'grid' };
  }
  m = s.match(/(-?\d{1,2}\.\d{3,})\s*[,/ ]\s*(-?\d{1,3}\.\d{3,})/);
  if (m) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (valid(lat, lon)) return { lat, lon, source: 'decimal' };
  }
  return null;
}

// ── Timestamps ──────────────────────────────────────────────────────────────

/** flmsg header value "CALL YYYYMMDDhhmmss" → { call, time (ms) }. */
function parseHeaderStamp(value) {
  if (!value) return { call: '', time: null };
  const m = String(value)
    .trim()
    .match(/^(?:(\S+)\s+)?(\d{14})$/);
  if (!m) return { call: String(value).trim().split(/\s+/)[0] || '', time: null };
  const [, call = '', st] = m;
  const t = Date.UTC(
    +st.slice(0, 4),
    +st.slice(4, 6) - 1,
    +st.slice(6, 8),
    +st.slice(8, 10),
    +st.slice(10, 12),
    +st.slice(12, 14),
  );
  return { call, time: Number.isFinite(t) ? t : null };
}

/**
 * Form date + time → epoch ms. Dates: YYYY-MM-DD, YYYY/MM/DD, MM/DD/YY(YY),
 * or anything Date.parse accepts. Times: "1432", "14:32", optional "Z"
 * (UTC) or "L" (local) suffix; no suffix = local.
 */
function parseFormDateTime(date, time) {
  if (!date) return null;
  const ds = String(date).trim();
  let y;
  let mo;
  let d;
  let m = ds.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) [, y, mo, d] = m.map(Number);
  else if ((m = ds.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) {
    mo = +m[1];
    d = +m[2];
    y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  } else {
    const t = Date.parse(ds);
    if (!Number.isFinite(t)) return null;
    const dt = new Date(t);
    y = dt.getFullYear();
    mo = dt.getMonth() + 1;
    d = dt.getDate();
  }
  let hh = 0;
  let mm = 0;
  let utc = false;
  const tm = String(time || '')
    .trim()
    .match(/^(\d{1,2}):?(\d{2})\s*([ZzLl])?/);
  if (tm) {
    hh = +tm[1];
    mm = +tm[2];
    utc = /z/i.test(tm[3] || '');
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const t = utc ? Date.UTC(y, mo - 1, d, hh, mm) : new Date(y, mo - 1, d, hh, mm).getTime();
  return Number.isFinite(t) ? t : null;
}

// ── Field-report conversion ─────────────────────────────────────────────────

const TEXT_TAGS = ['mg', 'msg', 'message', 'txt'];

/**
 * Turn file text (plain flmsg or WRAP-enveloped) into a field-report record
 * for the OpenHamClock server, or null when it is not an flmsg form.
 * @param {string} text
 * @param {object} [meta] { file, mtimeMs }
 */
function formToFieldReport(text, meta = {}) {
  const wrapped = unwrapFlmsg(text);
  if (wrapped && wrapped.compressed) return { error: 'compressed', filename: wrapped.filename };
  const body = wrapped ? wrapped.content : text;
  const doc = parseFlmsg(body);
  if (!doc.form) return null;

  const f = doc.fields;
  const hdr = parseHeaderStamp(doc.header.hdr_fm || doc.header.hdr_ed);
  const name = FORM_NAMES[doc.form] || doc.form.toUpperCase();
  const friendly = fieldsToFriendly(doc.form, f);

  let callsign = hdr.call;
  let text1 = '';
  let timestamp = null;
  const extra = {};

  if (doc.form === 'ics213' || doc.form === 'hics213') {
    text1 = [f.sb, f.mg].filter(Boolean).join(' — ');
    timestamp = parseFormDateTime(f.d1, f.t1);
    for (const k of [
      'incident',
      'to',
      'toPosition',
      'from',
      'fromPosition',
      'subject',
      'approvedBy',
      'approvedPosition',
      'reply',
    ]) {
      if (friendly[k]) extra[k] = friendly[k];
    }
  } else if (doc.form === 'radiogram') {
    callsign = f.sta || callsign;
    text1 = f.msg || '';
    timestamp = parseFormDateTime(f.d1, f.t1);
    for (const k of ['number', 'precedence', 'handling', 'check', 'placeOfOrigin', 'to', 'signature']) {
      if (friendly[k]) extra[k] = friendly[k];
    }
  } else {
    const tag = TEXT_TAGS.find((t) => f[t]);
    text1 = tag ? f[tag] : '';
    if (f.sb && text1) text1 = `${f.sb} — ${text1}`;
    else if (f.sb) text1 = f.sb;
    let n = 0;
    for (const [k, v] of Object.entries(f)) {
      if (k === tag || n >= 20) continue;
      extra[k] = String(v).slice(0, 200);
      n++;
    }
  }

  const loc = findLocation([text1, ...Object.values(f)].join('\n'));
  if (wrapped) extra.checksum = wrapped.checksumOk === false ? 'MISMATCH' : wrapped.checksumOk ? 'OK' : 'none';
  if (meta.file) extra.file = String(meta.file).split(/[\\/]/).pop();

  return {
    id: crypto
      .createHash('sha1')
      .update(`flmsg\u0000${body.replace(/\r\n/g, '\n')}`, 'utf8')
      .digest('hex'),
    callsign: String(callsign || '').toUpperCase(),
    formType: `${name} (NBEMS)`,
    form: doc.form,
    lat: loc ? loc.lat : null,
    lon: loc ? loc.lon : null,
    timestamp: timestamp ?? hdr.time ?? (Number.isFinite(meta.mtimeMs) ? meta.mtimeMs : null),
    text: text1,
    extra,
    fields: friendly,
  };
}

module.exports = {
  FORM_NAMES,
  ICS213_TAGS,
  RADIOGRAM_TAGS,
  lineout,
  parseFlmsg,
  serializeFlmsg,
  flmsgStamp,
  ics213ToFields,
  fieldsToFriendly,
  buildIcs213,
  crc16,
  wrapFlmsg,
  unwrapFlmsg,
  isWrapped,
  findLocation,
  parseHeaderStamp,
  parseFormDateTime,
  formToFieldReport,
};
