'use strict';
/**
 * Shared incident API — one EmComm operating picture for several operators
 * and sites. See docs/API.md#shared-incident-api.
 *
 *   Any browser ──POST─▶ /api/incident                 create → { id, joinKey }
 *   Any browser ──POST─▶ /api/incident/:id/join        (key) → full state
 *   Any browser ──POST─▶ /api/incident/:id/leave       (key)
 *   Any browser ──GET──▶ /api/incident/:id?since=N     (key) → changes after seq N
 *   Any browser ──POST─▶ /api/incident/:id/sync        (key) roster / events / reports / board
 *   Any browser ──SSE──▶ /api/incident/:id/stream      (key) snapshot, then live changes
 *   Local only  ──GET──▶ /api/incident/list            enumerate (disabled when OHC_HOSTED)
 *
 * Authorization: the join key handed out once at creation. The server keeps
 * only a salted hash and compares in constant time
 * (server/utils/incidentAuth.js). The key travels as `X-Incident-Key`, a body
 * `key`, or `?key=` (EventSource cannot set headers).
 *
 * State lives in server/utils/incidentStore.js (pure, bounded, idempotent
 * merge by stable ids). This module owns transport and persistence: a JSON
 * file under the data dir (same writable-path waterfall as group-logs.json),
 * written debounced and atomically, so a restart does not lose an activation.
 * Idle incidents expire after 7 days.
 *
 * Hosted (OHC_HOSTED): ids are random and unguessable as everywhere, listing
 * is disabled, a wrong id and a wrong key get the same 403, and the caps are
 * tighter (incidents, records, streams, creates per IP).
 */

const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { getClientIP } = require('../utils/helpers');
const { createIncidentStore, IncidentError } = require('../utils/incidentStore');
const { normaliseToken, isValidIncidentId } = require('../utils/incidentAuth');

module.exports = function (app, ctx) {
  const { ROOT_DIR, logInfo, logWarn, logDebug, writeLimiter, requireWriteAuth } = ctx;

  const IS_HOSTED = process.env.OHC_HOSTED === '1' || process.env.OHC_HOSTED === 'true';
  const store = createIncidentStore({ hosted: IS_HOSTED });

  const MAX_STREAMS_PER_INCIDENT = IS_HOSTED ? 25 : 50;
  const MAX_STREAMS_TOTAL = IS_HOSTED ? 300 : 200;
  const MAX_SSE_PER_IP = parseInt(process.env.INCIDENT_MAX_SSE_PER_IP || '20', 10); // an EOC may sit behind one NAT
  const MAX_CREATES_PER_IP_HOUR = IS_HOSTED ? 3 : 20;
  const MAX_CREATE_IPS = 5000;
  const KEEPALIVE_MS = 25 * 1000;
  const PRESENCE_SWEEP_MS = 30 * 1000;

  // Tolerate a mounted ctx without the shared limiters (tests, embedding).
  const passthrough = (req, res, next) => next();
  const createLimiter = writeLimiter || passthrough;
  const listAuth = requireWriteAuth || passthrough;

  // Every open EmComm browser syncs on change (debounced client-side), and
  // several browsers at one site share a public IP — looser than writeLimiter.
  const syncLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many incident updates' },
    keyGenerator: getClientIP,
  });

  // ─── Persistence ─────────────────────────────────────────────────────────
  const INCIDENT_FILE = (() => {
    const candidates = [
      process.env.INCIDENT_FILE,
      '/data/incidents.json',
      path.join(ROOT_DIR || process.cwd(), 'data', 'incidents.json'),
      '/tmp/openhamclock-incidents.json',
    ];
    for (const p of candidates) {
      if (!p) continue;
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.accessSync(path.dirname(p), fs.constants.W_OK);
        return p;
      } catch {
        continue;
      }
    }
    return '/tmp/openhamclock-incidents.json';
  })();

  try {
    const loaded = store.hydrate(JSON.parse(fs.readFileSync(INCIDENT_FILE, 'utf8')));
    const expired = store.expire();
    if (loaded) logInfo?.(`[Incident] Loaded ${loaded - expired} incident(s) from ${INCIDENT_FILE}`);
  } catch {
    /* file absent on first run — normal */
  }

  let saveTimer = null;
  function saveNow() {
    try {
      const tmp = `${INCIDENT_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store.serialise()), 'utf8');
      fs.renameSync(tmp, INCIDENT_FILE);
    } catch (err) {
      logWarn?.(`[Incident] Could not persist incidents: ${err.message}`);
    }
  }
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, 2000);
    saveTimer.unref?.();
  }

  // ─── SSE fan-out ─────────────────────────────────────────────────────────
  const streams = new Map(); // incident id → Set<{ res, clientId, ip }>
  const sseByIp = new Map();
  const lastPresence = new Map(); // incident id → participant count last broadcast
  let streamTotal = 0;

  function writeEvent(res, event, data, id) {
    try {
      res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
      return true;
    } catch {
      return false;
    }
  }

  function broadcast(id, event, data, seq) {
    const set = streams.get(id);
    if (!set) return 0;
    let sent = 0;
    for (const s of set) if (writeEvent(s.res, event, data, seq)) sent++;
    return sent;
  }

  function broadcastPresence(id, force = false) {
    if (!store.has(id)) return;
    const n = store.meta(id).participants;
    if (!force && lastPresence.get(id) === n) return;
    lastPresence.set(id, n);
    broadcast(id, 'presence', { participants: n });
  }

  const sweepTimer = setInterval(() => {
    for (const id of streams.keys()) broadcastPresence(id);
    for (const id of lastPresence.keys()) if (!streams.has(id)) lastPresence.delete(id);
  }, PRESENCE_SWEEP_MS);
  sweepTimer.unref?.();

  const cleanupTimer = setInterval(
    () => {
      const before = new Set(streams.keys());
      const dropped = store.expire();
      for (const id of before) {
        if (store.has(id)) continue;
        broadcast(id, 'expired', { id });
        for (const s of streams.get(id) || []) {
          try {
            s.res.end();
          } catch {
            /* already closed */
          }
        }
      }
      for (const [ip, entry] of createsByIp)
        if (Date.now() - entry.windowStart > 60 * 60 * 1000) createsByIp.delete(ip);
      if (dropped) logInfo?.(`[Incident] Expired ${dropped} idle incident(s)`);
      scheduleSave(); // also persists participant-driven lastActivity
    },
    60 * 60 * 1000,
  );
  cleanupTimer.unref?.();

  // ─── Helpers ─────────────────────────────────────────────────────────────
  const noCache = (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  function extractKey(req) {
    const h = req.headers?.['x-incident-key'];
    if (typeof h === 'string' && h.trim()) return h.trim();
    const b = req.body?.key;
    if (typeof b === 'string' && b.trim()) return b.trim();
    const q = req.query?.key;
    if (typeof q === 'string' && q.trim()) return q.trim();
    return '';
  }

  const clientIdOf = (req) => String(req.body?.clientId ?? req.query?.clientId ?? '').substring(0, 40);

  /** → normalised incident id when the key opens it; otherwise sends the error and returns null. */
  function authIncident(req, res) {
    const id = normaliseToken(req.params.id);
    const ok = isValidIncidentId(id) && store.verify(id, extractKey(req));
    if (ok) return id;
    if (!IS_HOSTED && isValidIncidentId(id) && !store.has(id)) {
      res.status(404).json({ error: 'Unknown or expired incident' });
    } else {
      // Hosted: one answer for "no such id" and "wrong key" — ids cannot be probed.
      res.status(403).json({ error: 'Incident id or join key is wrong' });
    }
    return null;
  }

  function sendError(res, err) {
    if (err instanceof IncidentError) return res.status(err.status).json({ error: err.message });
    logWarn?.(`[Incident] ${err?.message || err}`);
    return res.status(500).json({ error: 'Incident request failed' });
  }

  const createsByIp = new Map(); // ip → { count, windowStart }
  function allowCreate(ip) {
    const now = Date.now();
    const entry = createsByIp.get(ip);
    if (!entry || now - entry.windowStart > 60 * 60 * 1000) {
      if (createsByIp.size >= MAX_CREATE_IPS) createsByIp.delete(createsByIp.keys().next().value);
      createsByIp.set(ip, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= MAX_CREATES_PER_IP_HOUR;
  }

  // ─── Routes ──────────────────────────────────────────────────────────────

  // Discovery: what this server allows.
  app.get('/api/incident', (req, res) => {
    noCache(res);
    res.json({
      hosted: IS_HOSTED,
      listing: !IS_HOSTED,
      incidents: IS_HOSTED ? undefined : store.size,
      limits: {
        roster: store.limits.maxRoster,
        events: store.limits.maxEvents,
        reports: store.limits.maxReports,
        idleDays: 7,
      },
    });
  });

  // Local installs only: list incidents (never keys) so an operator can find
  // the one they meant to rejoin. Disabled on the hosted site.
  app.get('/api/incident/list', listAuth, (req, res) => {
    noCache(res);
    if (IS_HOSTED) return res.status(403).json({ error: 'Incident listing is disabled on this server' });
    res.json({
      incidents: store.list().map((m) => ({
        id: m.id,
        name: m.board?.name || '',
        createdAt: m.createdAt,
        lastActivity: m.lastActivity,
        participants: m.participants,
        counts: m.counts,
      })),
    });
  });

  app.post('/api/incident', createLimiter, (req, res) => {
    noCache(res);
    if (!allowCreate(getClientIP(req))) {
      return res.status(429).json({ error: 'Too many incidents created from this address' });
    }
    try {
      const body = req.body || {};
      const { incident, joinKey } = store.create({
        name: body.name,
        ic: body.ic,
        netFreq: body.netFreq,
        notes: body.notes,
      });
      store.touchParticipant(incident.id, clientIdOf(req), body.call);
      scheduleSave();
      logInfo?.(`[Incident] ${incident.id} created${incident.board.name ? ` ("${incident.board.name}")` : ''}`);
      res.json({ ok: true, id: incident.id, joinKey, incident: store.snapshot(incident.id, 0) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // writeLimiter here as well: join is where a key would be guessed.
  app.post('/api/incident/:id/join', createLimiter, (req, res) => {
    noCache(res);
    const id = authIncident(req, res);
    if (!id) return;
    try {
      store.touchParticipant(id, clientIdOf(req), req.body?.call);
      broadcastPresence(id);
      res.json({ ok: true, id, incident: store.snapshot(id, 0) });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/incident/:id/leave', syncLimiter, (req, res) => {
    noCache(res);
    const id = authIncident(req, res);
    if (!id) return;
    const participants = store.removeParticipant(id, clientIdOf(req));
    broadcastPresence(id);
    res.json({ ok: true, participants });
  });

  app.get('/api/incident/:id', (req, res) => {
    noCache(res);
    const id = authIncident(req, res);
    if (!id) return;
    try {
      const cid = clientIdOf(req);
      if (cid) store.touchParticipant(id, cid, req.query?.call);
      const since = Math.max(0, parseInt(req.query.since, 10) || 0);
      res.json(store.snapshot(id, since));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/incident/:id/sync', syncLimiter, (req, res) => {
    noCache(res);
    const id = authIncident(req, res);
    if (!id) return;
    try {
      const body = req.body || {};
      const cid = clientIdOf(req);
      if (cid) store.touchParticipant(id, cid, body.call);
      const result = store.apply(
        id,
        { roster: body.roster, events: body.events, reports: body.reports, board: body.board },
        { site: body.site },
      );
      if (result.changed) {
        broadcast(id, 'change', { seq: result.seq, ...result.changes }, result.seq);
        scheduleSave();
      }
      broadcastPresence(id);
      res.json({
        ok: true,
        seq: result.seq,
        accepted: {
          roster: result.changes.roster.length,
          events: result.changes.events.length,
          reports: result.changes.reports.length,
          board: !!result.changes.board,
        },
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/incident/:id/stream', (req, res) => {
    const id = authIncident(req, res);
    if (!id) return;

    const ip = getClientIP(req);
    const perIp = sseByIp.get(ip) || 0;
    const set = streams.get(id) || new Set();
    if (perIp >= MAX_SSE_PER_IP) return res.status(429).json({ error: 'Too many open streams from this address' });
    if (set.size >= MAX_STREAMS_PER_INCIDENT || streamTotal >= MAX_STREAMS_TOTAL) {
      return res.status(503).json({ error: 'Too many listeners on this incident — fall back to polling' });
    }

    // Resume point: EventSource sends Last-Event-ID on its own reconnects.
    const lastId = parseInt(req.headers?.['last-event-id'], 10);
    const since = Number.isFinite(lastId) ? lastId : Math.max(0, parseInt(req.query.since, 10) || 0);
    const clientId = clientIdOf(req);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Content-Encoding': 'identity',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const entry = { res, clientId, ip };
    set.add(entry);
    streams.set(id, set);
    streamTotal++;
    sseByIp.set(ip, perIp + 1);

    if (clientId) store.touchParticipant(id, clientId, req.query?.call);
    const snap = store.snapshot(id, since);
    writeEvent(res, 'snapshot', snap, snap.seq);
    broadcastPresence(id, true);

    const keepalive = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
        if (typeof res.flush === 'function') res.flush();
        if (clientId && store.has(id)) store.touchParticipant(id, clientId);
      } catch {
        clearInterval(keepalive);
      }
    }, KEEPALIVE_MS);
    keepalive.unref?.();

    req.on('close', () => {
      clearInterval(keepalive);
      const s = streams.get(id);
      if (s) {
        s.delete(entry);
        if (s.size === 0) streams.delete(id);
      }
      streamTotal = Math.max(0, streamTotal - 1);
      const n = sseByIp.get(ip) || 1;
      if (n <= 1) sseByIp.delete(ip);
      else sseByIp.set(ip, n - 1);
      logDebug?.(`[Incident] stream closed for ${id}`);
    });
  });

  logInfo?.(`[Incident] Shared incident API ready (hosted=${IS_HOSTED}, file=${INCIDENT_FILE})`);

  return { incidentStore: store, flushIncidents: saveNow };
};
