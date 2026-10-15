/**
 * incidentStore — the state model behind /api/incident/*.
 *
 * A shared incident is one operating picture that several browsers (and
 * several sites) append to: a net roster, an event log, field and shelter
 * reports, and a small free-text board (incident name, IC, net frequency,
 * notes). Every record carries a stable id chosen by the client, so a retry,
 * a reconnect or two browsers observing the same real-world event never
 * produce duplicates — merging is idempotent:
 *
 *   roster   keyed by callsign; newest `updatedAt` wins (check-out is a
 *            `checkedOut: true` update, never a delete, so late joiners see it)
 *   events   keyed by id, and additionally by `type:dedupeKey` when present
 *   reports  keyed by id
 *   board    whole-object, newest `updatedAt` wins
 *
 * Each accepted change bumps the incident's monotonic `seq` and stamps the
 * record, so `snapshot(id, since)` returns exactly what changed after a
 * cursor and the SSE stream can resume from a Last-Event-ID.
 *
 * Everything is bounded: incidents, records per collection, participants.
 * Caps drop the oldest records; idle incidents expire after `idleMs`. The
 * hosted multi-user deployment gets tighter caps. The store is pure (no I/O,
 * injectable clock) — the route owns persistence and transport.
 */

const { makeIncidentId, makeJoinKey, hashJoinKey, verifyJoinKey, normaliseToken } = require('./incidentAuth');

const DAY = 24 * 60 * 60 * 1000;

const LIMITS = {
  local: { maxIncidents: 500, maxRoster: 300, maxEvents: 2000, maxReports: 500, maxParticipants: 100 },
  hosted: { maxIncidents: 50, maxRoster: 100, maxEvents: 500, maxReports: 200, maxParticipants: 50 },
};

const STR_MAX = 80;
const TEXT_MAX = 500;
const NOTES_MAX = 2000;
const ID_MAX = 64;
const MAX_TOKENS = 20;
const MAX_EXTRA_KEYS = 20;
const MAX_BATCH = 200; // records per collection per apply()
const PARTICIPANT_TTL = 150 * 1000; // counted as present while heard within this window
const EVICT_GRACE = 60 * 60 * 1000; // at the cap, an incident idle this long with nobody present may be evicted

const EVENT_TYPES = new Set([
  'net_checkin',
  'net_checkout',
  'aprs_msg_sent',
  'aprs_msg_rx',
  'nws_alert',
  'shelter_report',
  'field_report',
  'station_heard',
  'incident_note',
]);
const REPORT_KINDS = new Set(['field', 'shelter']);

class IncidentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cleanStr = (v, max = STR_MAX) => (v == null ? '' : String(v).trim().substring(0, max));
const cleanCoord = (v, limit) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};
const cleanTs = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback);
const normCall = (v) => cleanStr(v, 20).toUpperCase();

const TOKEN_TYPES = new Set(['capacity', 'critical', 'status', 'need', 'quantity', 'text']);

/** Resource tokens as the APRS parser produces them: { key, type, current?, max?, value? }. */
function cleanTokens(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw.slice(0, MAX_TOKENS)) {
    if (!t || typeof t !== 'object') continue;
    const key = cleanStr(t.key, 20);
    if (!key) continue;
    const tok = { key, type: TOKEN_TYPES.has(t.type) ? t.type : 'text' };
    if (Number.isFinite(t.current)) tok.current = t.current;
    if (Number.isFinite(t.max)) tok.max = t.max;
    if (Number.isFinite(t.value)) tok.value = t.value;
    else if (t.value != null) tok.value = cleanStr(t.value, 40);
    out.push(tok);
  }
  return out;
}

function cleanExtra(raw) {
  const extra = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return extra;
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (count >= MAX_EXTRA_KEYS) break;
    const key = cleanStr(k, 64);
    if (!key) continue;
    extra[key] = cleanStr(v, STR_MAX);
    count++;
  }
  return extra;
}

function sanitiseRoster(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const call = normCall(raw.call);
  if (!call) return null;
  return {
    call,
    netName: cleanStr(raw.netName, 40),
    status: cleanStr(raw.status, STR_MAX) || 'Checked in',
    checkinTime: cleanTs(raw.checkinTime, now),
    lastHeard: cleanTs(raw.lastHeard, now),
    lat: cleanCoord(raw.lat, 90),
    lon: cleanCoord(raw.lon, 180),
    tokens: cleanTokens(raw.tokens),
    source: cleanStr(raw.source, 20) || 'incident',
    site: cleanStr(raw.site, 40),
    checkedOut: raw.checkedOut === true,
    updatedAt: cleanTs(raw.updatedAt, now),
  };
}

function sanitiseEvent(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanStr(raw.id, ID_MAX);
  const type = cleanStr(raw.type, 32);
  if (!id || !EVENT_TYPES.has(type)) return null;
  const ev = {
    id,
    ts: cleanTs(raw.ts, now),
    type,
    callsign: cleanStr(raw.callsign, 20).toUpperCase(),
    summary: cleanStr(raw.summary, 200),
    details: cleanStr(raw.details, TEXT_MAX),
    site: cleanStr(raw.site, 40),
  };
  if (raw.dedupeKey != null && raw.dedupeKey !== '') ev.dedupeKey = cleanStr(raw.dedupeKey, 120);
  return ev;
}

function sanitiseReport(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanStr(raw.id, ID_MAX);
  const kind = cleanStr(raw.kind, 10);
  if (!id || !REPORT_KINDS.has(kind)) return null;
  const callsign = normCall(raw.callsign);
  const formType = cleanStr(raw.formType, STR_MAX);
  const text = cleanStr(raw.text, TEXT_MAX);
  if (!callsign && !formType && !text) return null;
  return {
    id,
    kind,
    callsign,
    formType,
    text,
    lat: cleanCoord(raw.lat, 90),
    lon: cleanCoord(raw.lon, 180),
    timestamp: cleanTs(raw.timestamp, now),
    tokens: cleanTokens(raw.tokens),
    extra: cleanExtra(raw.extra),
    site: cleanStr(raw.site, 40),
  };
}

function sanitiseBoard(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    name: cleanStr(raw.name, STR_MAX),
    ic: cleanStr(raw.ic, STR_MAX),
    netFreq: cleanStr(raw.netFreq, 40),
    notes: cleanStr(raw.notes, NOTES_MAX),
    updatedAt: cleanTs(raw.updatedAt, now),
  };
}

// Sanitised records are built with a fixed key order, so a plain stringify
// of the copies (minus bookkeeping fields) is a stable equality check.
const sameRecord = (a, b, skip) => {
  const strip = (o) => {
    const c = { ...o };
    for (const k of skip) delete c[k];
    return JSON.stringify(c);
  };
  return strip(a) === strip(b);
};

/**
 * @param {object} [opts]
 * @param {boolean} [opts.hosted] - tighter caps for the shared multi-user deployment
 * @param {number} [opts.idleMs] - incidents with no activity for this long expire (default 7 days)
 * @param {Function} [opts.now] - clock (tests)
 * @param {object} [opts.limits] - override any LIMITS field
 */
function createIncidentStore(opts = {}) {
  const hosted = !!opts.hosted;
  const limits = { ...(hosted ? LIMITS.hosted : LIMITS.local), ...(opts.limits || {}) };
  const idleMs = opts.idleMs ?? 7 * DAY;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  const incidents = new Map(); // id → incident
  const DUMMY_AUTH = hashJoinKey(makeJoinKey());

  const touch = (inc) => {
    inc.lastActivity = now();
  };

  const rebuildDedupe = (inc) => {
    inc.eventDedupe = new Set();
    for (const ev of inc.events.values()) if (ev.dedupeKey) inc.eventDedupe.add(`${ev.type}:${ev.dedupeKey}`);
  };

  /** Keep a Map at or under `max` entries by dropping the "oldest" per `orderKey`. */
  const capMap = (map, max, orderKey) => {
    if (map.size <= max) return;
    const victims = [...map.values()].sort((a, b) => a[orderKey] - b[orderKey]).slice(0, map.size - max);
    for (const v of victims) map.delete(v.id ?? v.call);
  };

  const capRoster = (inc) => {
    if (inc.roster.size <= limits.maxRoster) return;
    // Checked-out operators go first, then the longest-unheard.
    const victims = [...inc.roster.values()]
      .sort((a, b) => (a.checkedOut === b.checkedOut ? a.updatedAt - b.updatedAt : a.checkedOut ? -1 : 1))
      .slice(0, inc.roster.size - limits.maxRoster);
    for (const v of victims) inc.roster.delete(v.call);
  };

  function meta(inc) {
    return {
      id: inc.id,
      createdAt: inc.createdAt,
      lastActivity: inc.lastActivity,
      seq: inc.seq,
      board: inc.board,
      participants: participantCount(inc),
      counts: {
        roster: [...inc.roster.values()].filter((r) => !r.checkedOut).length,
        events: inc.events.size,
        reports: inc.reports.size,
      },
    };
  }

  function participantCount(inc) {
    const cutoff = now() - PARTICIPANT_TTL;
    let n = 0;
    for (const p of inc.participants.values()) if (p.lastSeen >= cutoff) n++;
    return n;
  }

  function mustGet(id) {
    const inc = incidents.get(normaliseToken(id));
    if (!inc) throw new IncidentError(404, 'Unknown or expired incident');
    return inc;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * At the cap, make room by dropping the longest-idle incident that nobody
   * is attending and that has been quiet for EVICT_GRACE — so a burst of
   * abandoned creates cannot lock real activations out until the 7-day expiry.
   */
  function evictOneIdle() {
    const cutoff = now() - EVICT_GRACE;
    let victim = null;
    for (const inc of incidents.values()) {
      if (inc.lastActivity >= cutoff || participantCount(inc) > 0) continue;
      if (!victim || inc.lastActivity < victim.lastActivity) victim = inc;
    }
    if (victim) incidents.delete(victim.id);
    return victim ? victim.id : null;
  }

  function create(input = {}) {
    if (incidents.size >= limits.maxIncidents) evictOneIdle();
    if (incidents.size >= limits.maxIncidents) throw new IncidentError(503, 'Incident limit reached, try again later');
    let id = makeIncidentId();
    for (let i = 0; i < 20 && incidents.has(id); i++) id = makeIncidentId();
    if (incidents.has(id)) throw new IncidentError(500, 'Could not allocate an incident id');
    const joinKey = makeJoinKey();
    const t = now();
    const board = sanitiseBoard(input, t) || sanitiseBoard({}, t);
    const inc = {
      id,
      createdAt: t,
      lastActivity: t,
      seq: 1,
      auth: hashJoinKey(joinKey),
      board: { ...board, updatedAt: t, seq: 1 },
      roster: new Map(),
      events: new Map(),
      reports: new Map(),
      eventDedupe: new Set(),
      participants: new Map(),
    };
    incidents.set(id, inc);
    return { incident: meta(inc), joinKey };
  }

  /** @returns {object|null} the incident when the key matches; null otherwise (404 vs 403 is the caller's call) */
  function verify(id, key) {
    const inc = incidents.get(normaliseToken(id));
    if (!inc) {
      // Same work as a real check, so response time does not reveal whether an id exists.
      verifyJoinKey(key, DUMMY_AUTH.salt, DUMMY_AUTH.hash);
      return null;
    }
    return verifyJoinKey(key, inc.auth.salt, inc.auth.hash) ? inc : null;
  }

  const has = (id) => incidents.has(normaliseToken(id));
  const get = (id) => incidents.get(normaliseToken(id)) || null;

  function list() {
    return [...incidents.values()].map(meta).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  function touchParticipant(id, clientId, call) {
    const inc = mustGet(id);
    const cid = cleanStr(clientId, 40);
    if (!cid) return participantCount(inc);
    const existing = inc.participants.get(cid);
    inc.participants.set(cid, { clientId: cid, call: normCall(call) || existing?.call || '', lastSeen: now() });
    touch(inc); // someone attending keeps the incident alive
    if (inc.participants.size > limits.maxParticipants) {
      const oldest = [...inc.participants.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      inc.participants.delete(oldest.clientId);
    }
    return participantCount(inc);
  }

  function removeParticipant(id, clientId) {
    const inc = incidents.get(normaliseToken(id));
    if (!inc) return 0;
    inc.participants.delete(cleanStr(clientId, 40));
    return participantCount(inc);
  }

  /**
   * Merge a batch of client records. Returns only what actually changed, each
   * record stamped with its new seq, so the caller can fan it out verbatim.
   */
  function apply(id, batch = {}, origin = {}) {
    const inc = mustGet(id);
    const t = now();
    const site = cleanStr(origin.site, 40);
    const changes = { roster: [], events: [], reports: [], board: null };
    const withSite = (rec) => (site && !rec.site ? { ...rec, site } : rec);

    for (const raw of (Array.isArray(batch.roster) ? batch.roster : []).slice(0, MAX_BATCH)) {
      const entry = sanitiseRoster(raw, t);
      if (!entry) continue;
      const existing = inc.roster.get(entry.call);
      if (existing) {
        if (entry.updatedAt < existing.updatedAt) continue;
        if (sameRecord(existing, entry, ['seq', 'updatedAt'])) continue;
      }
      const rec = { ...withSite(entry), seq: ++inc.seq };
      inc.roster.set(rec.call, rec);
      changes.roster.push(rec);
    }
    capRoster(inc);

    for (const raw of (Array.isArray(batch.events) ? batch.events : []).slice(0, MAX_BATCH)) {
      const ev = sanitiseEvent(raw, t);
      if (!ev || inc.events.has(ev.id)) continue;
      const dk = ev.dedupeKey ? `${ev.type}:${ev.dedupeKey}` : null;
      if (dk && inc.eventDedupe.has(dk)) continue;
      const rec = { ...withSite(ev), seq: ++inc.seq };
      inc.events.set(rec.id, rec);
      if (dk) inc.eventDedupe.add(dk);
      changes.events.push(rec);
    }
    if (inc.events.size > limits.maxEvents) {
      capMap(inc.events, limits.maxEvents, 'ts');
      rebuildDedupe(inc);
    }

    for (const raw of (Array.isArray(batch.reports) ? batch.reports : []).slice(0, MAX_BATCH)) {
      const r = sanitiseReport(raw, t);
      if (!r || inc.reports.has(r.id)) continue;
      const rec = { ...withSite(r), seq: ++inc.seq };
      inc.reports.set(rec.id, rec);
      changes.reports.push(rec);
    }
    capMap(inc.reports, limits.maxReports, 'timestamp');

    const board = sanitiseBoard(batch.board, t);
    if (board && board.updatedAt > (inc.board.updatedAt || 0)) {
      if (!sameRecord(inc.board, board, ['seq', 'updatedAt'])) {
        inc.board = { ...board, seq: ++inc.seq };
        changes.board = inc.board;
      } else {
        inc.board.updatedAt = board.updatedAt;
      }
    }

    const changed = changes.roster.length || changes.events.length || changes.reports.length || changes.board;
    if (changed) touch(inc);
    return { seq: inc.seq, changed: !!changed, changes };
  }

  /** Full state, or only records stamped after `since`. */
  function snapshot(id, since = 0) {
    const inc = mustGet(id);
    const after = (rec) => rec.seq > since;
    return {
      ...meta(inc),
      since,
      board: inc.board.seq > since ? inc.board : null,
      roster: [...inc.roster.values()].filter(after),
      events: [...inc.events.values()].filter(after).sort((a, b) => a.ts - b.ts),
      reports: [...inc.reports.values()].filter(after),
    };
  }

  function expire(at = now()) {
    const cutoff = at - idleMs;
    let dropped = 0;
    for (const [id, inc] of incidents) {
      if (inc.lastActivity < cutoff) {
        incidents.delete(id);
        dropped++;
      }
    }
    return dropped;
  }

  const remove = (id) => incidents.delete(normaliseToken(id));

  /** Plain JSON for the persistence file (participants are ephemeral and skipped). */
  function serialise() {
    return [...incidents.values()].map((inc) => ({
      id: inc.id,
      createdAt: inc.createdAt,
      lastActivity: inc.lastActivity,
      seq: inc.seq,
      auth: inc.auth,
      board: inc.board,
      roster: [...inc.roster.values()],
      events: [...inc.events.values()],
      reports: [...inc.reports.values()],
    }));
  }

  /** Load what serialise() wrote; malformed entries are skipped, caps re-applied. */
  function hydrate(data) {
    if (!Array.isArray(data)) return 0;
    let loaded = 0;
    for (const raw of data) {
      if (incidents.size >= limits.maxIncidents) break;
      if (!raw || typeof raw.id !== 'string' || !raw.auth?.salt || !raw.auth?.hash) continue;
      const t = now();
      const inc = {
        id: raw.id,
        createdAt: cleanTs(raw.createdAt, t),
        lastActivity: cleanTs(raw.lastActivity, t),
        seq: Number.isFinite(raw.seq) ? raw.seq : 1,
        auth: { salt: String(raw.auth.salt), hash: String(raw.auth.hash) },
        board: { ...(sanitiseBoard(raw.board, t) || sanitiseBoard({}, t)), seq: raw.board?.seq || 1 },
        roster: new Map(),
        events: new Map(),
        reports: new Map(),
        eventDedupe: new Set(),
        participants: new Map(),
      };
      for (const r of Array.isArray(raw.roster) ? raw.roster : []) {
        const e = sanitiseRoster(r, t);
        if (e) inc.roster.set(e.call, { ...e, seq: r.seq || 0 });
      }
      for (const r of Array.isArray(raw.events) ? raw.events : []) {
        const e = sanitiseEvent(r, t);
        if (e && !inc.events.has(e.id)) inc.events.set(e.id, { ...e, seq: r.seq || 0 });
      }
      for (const r of Array.isArray(raw.reports) ? raw.reports : []) {
        const e = sanitiseReport(r, t);
        if (e && !inc.reports.has(e.id)) inc.reports.set(e.id, { ...e, seq: r.seq || 0 });
      }
      capRoster(inc);
      capMap(inc.events, limits.maxEvents, 'ts');
      capMap(inc.reports, limits.maxReports, 'timestamp');
      rebuildDedupe(inc);
      incidents.set(inc.id, inc);
      loaded++;
    }
    return loaded;
  }

  return {
    limits,
    hosted,
    create,
    verify,
    has,
    get,
    list,
    meta: (id) => meta(mustGet(id)),
    touchParticipant,
    removeParticipant,
    apply,
    snapshot,
    expire,
    remove,
    serialise,
    hydrate,
    get size() {
      return incidents.size;
    },
  };
}

module.exports = {
  createIncidentStore,
  IncidentError,
  LIMITS,
  EVENT_TYPES,
  REPORT_KINDS,
  PARTICIPANT_TTL,
  sanitiseRoster,
  sanitiseEvent,
  sanitiseReport,
  sanitiseBoard,
};
