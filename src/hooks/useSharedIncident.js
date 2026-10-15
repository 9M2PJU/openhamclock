/**
 * useSharedIncident — keeps the EmComm layout in step with a shared incident
 * (server/routes/incident.js) while this browser has joined one.
 *
 * Owns the whole sync loop:
 *   - session (id, join key, site label) persisted in localStorage, resumed
 *     on reload; an invite link (`/#incident=ID&key=KEY`) pre-fills Join
 *   - an EventSource per incident: a snapshot on connect, then live changes;
 *     the browser's own reconnects resume from Last-Event-ID, and a refused
 *     stream falls back to polling GET ?since= while it retries with backoff
 *   - mirroring what this browser observes (its server's net roster, event
 *     log entries recorded after joining, field and shelter reports) into an
 *     outbox that is flushed to POST /sync, debounced; the outbox persists,
 *     survives being offline, and is flushed again on reconnect
 *   - merge by stable ids (src/utils/incidentSync.js), so nothing duplicates
 *     however often a record is replayed
 *
 * When no incident is joined it does nothing and the layout keeps its
 * local-only behaviour (localStorage event log, this server's roster).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeEvents, getEvents, recordEvent } from '../utils/emcommEventLog.js';
import {
  SESSION_KEY,
  OUTBOX_KEY,
  CACHE_KEY,
  CLIENT_ID_KEY,
  emptyIncidentState,
  applyIncidentDelta,
  incidentEventList,
  stateForCache,
  diffRosterForPush,
  rosterEntryForPush,
  fieldReportForPush,
  shelterReportForPush,
  eventForPush,
  emptyOutbox,
  queueOutbox,
  outboxBatch,
  outboxSize,
  ackOutbox,
  buildJoinUrl,
  parseJoinUrl,
  normaliseCode,
  makeClientId,
} from '../utils/incidentSync.js';

const FLUSH_DEBOUNCE_MS = 1000;
const RETRY_MS = [2000, 5000, 10000, 30000, 60000];
const POLL_FALLBACK_MS = 10000;
const CACHE_WRITE_MS = 2000;

const readJson = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key, value) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — the session still works for this page load */
  }
};

function getClientId() {
  let id = null;
  try {
    id = localStorage.getItem(CLIENT_ID_KEY);
  } catch {
    /* ignore */
  }
  if (!id) {
    id = makeClientId();
    try {
      localStorage.setItem(CLIENT_ID_KEY, id);
    } catch {
      /* ignore */
    }
  }
  return id;
}

async function api(path, { method = 'GET', key, body } = {}) {
  const res = await fetch(`/api/incident${path}`, {
    method,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Incident-Key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const goneMessage = (status) =>
  status === 404 ? 'This incident no longer exists on the server' : 'The incident id or join key was not accepted';

/**
 * @param {object} opts
 * @param {string} opts.callsign      this station (attribution, presence)
 * @param {Array}  opts.localRoster   /api/aprs/net roster from this server
 * @param {Array}  opts.fieldReports  /api/emcomm/field-reports rows from this server
 * @param {Array}  opts.shelterReports /api/aprs/shelters reports from this server
 */
export function useSharedIncident({ callsign = '', localRoster, fieldReports, shelterReports } = {}) {
  const [session, setSession] = useState(() => readJson(SESSION_KEY, null));
  const [state, setState] = useState(() => {
    const s = readJson(SESSION_KEY, null);
    const cached = readJson(CACHE_KEY, null);
    return s && cached && cached.id === s.id && cached.state ? cached.state : emptyIncidentState();
  });
  const [status, setStatus] = useState(() => (readJson(SESSION_KEY, null) ? 'connecting' : 'idle'));
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(() => outboxSize(readJson(OUTBOX_KEY, null)));
  const [invite, setInvite] = useState(null);

  const clientId = useMemo(getClientId, []);
  const outboxRef = useRef(readJson(OUTBOX_KEY, null) || emptyOutbox());
  const stateRef = useRef(state);
  const sessionRef = useRef(session);
  const callsignRef = useRef(callsign);
  stateRef.current = state;
  sessionRef.current = session;
  callsignRef.current = callsign;

  const flushTimerRef = useRef(null);
  const retryTimerRef = useRef(null);
  const retryAttemptRef = useRef(0);
  const inFlightRef = useRef(false);
  const goneRef = useRef(false);
  const rosterPrevRef = useRef(null);
  const pushedEventsRef = useRef(new Set());
  const pushedReportsRef = useRef(new Set());
  const flushRef = useRef(null);

  // ── Outbox ────────────────────────────────────────────────────────────────
  const saveOutbox = useCallback(() => {
    const size = outboxSize(outboxRef.current);
    writeJson(OUTBOX_KEY, size ? outboxRef.current : null);
    setPending(size);
  }, []);

  const scheduleFlush = useCallback((delay = FLUSH_DEBOUNCE_MS) => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushRef.current?.();
    }, delay);
  }, []);

  const enqueue = useCallback(
    (items) => {
      outboxRef.current = queueOutbox(outboxRef.current, items);
      saveOutbox();
      scheduleFlush();
    },
    [saveOutbox, scheduleFlush],
  );

  const markGone = useCallback((message) => {
    goneRef.current = true;
    setStatus('error');
    setError(message);
  }, []);

  flushRef.current = async () => {
    const s = sessionRef.current;
    if (!s || inFlightRef.current || goneRef.current) return;
    const batch = outboxBatch(outboxRef.current);
    if (!batch) return;
    inFlightRef.current = true;
    try {
      const res = await api(`/${encodeURIComponent(s.id)}/sync`, {
        method: 'POST',
        key: s.key,
        body: { clientId, call: callsignRef.current, site: s.site || '', ...batch },
      });
      if (sessionRef.current?.id !== s.id) return; // left or switched while in flight
      if (res.ok) {
        outboxRef.current = ackOutbox(outboxRef.current, batch);
        saveOutbox();
        retryAttemptRef.current = 0;
        if (outboxSize(outboxRef.current)) scheduleFlush();
      } else if (res.status === 403 || res.status === 404) {
        markGone(goneMessage(res.status));
      } else {
        throw new Error(res.data?.error || `HTTP ${res.status}`);
      }
    } catch {
      // Offline or server busy: keep everything, try again with backoff.
      const delay = RETRY_MS[Math.min(retryAttemptRef.current++, RETRY_MS.length - 1)];
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => flushRef.current?.(), delay);
    } finally {
      inFlightRef.current = false;
    }
  };

  // ── Invite link (#incident=…&key=…) ───────────────────────────────────────
  useEffect(() => {
    const parsed = parseJoinUrl(typeof window !== 'undefined' ? window.location.hash : '');
    if (!parsed) return;
    try {
      // Take the key out of the address bar (and so out of history and screenshots).
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      /* ignore */
    }
    if (sessionRef.current?.id !== parsed.id) setInvite(parsed);
  }, []);

  // ── Live stream ───────────────────────────────────────────────────────────
  const sessionId = session?.id || null;
  const sessionKey = session?.key || null;
  useEffect(() => {
    if (!sessionId || !sessionKey) return undefined;
    goneRef.current = false;
    let closed = false;
    let es = null;
    let reconnectTimer = null;
    let attempt = 0;

    const apply = (data) => setState((s) => applyIncidentDelta(s, data));
    const parse = (e) => {
      try {
        return JSON.parse(e.data);
      } catch {
        return null;
      }
    };

    const open = () => {
      if (closed || goneRef.current) return;
      if (typeof EventSource === 'undefined') {
        probe();
        return;
      }
      const qs = new URLSearchParams({ key: sessionKey, clientId, since: String(stateRef.current.seq || 0) });
      if (callsignRef.current) qs.set('call', callsignRef.current);
      es = new EventSource(`/api/incident/${encodeURIComponent(sessionId)}/stream?${qs}`);
      es.addEventListener('snapshot', (e) => {
        const d = parse(e);
        if (d) apply(d);
        attempt = 0;
        setStatus('live');
        setError(null);
        flushRef.current?.(); // anything buffered while we were away
      });
      es.addEventListener('change', (e) => {
        const d = parse(e);
        if (d) apply(d);
      });
      es.addEventListener('presence', (e) => {
        const d = parse(e);
        if (d && Number.isFinite(d.participants)) setState((s) => ({ ...s, participants: d.participants }));
      });
      es.addEventListener('expired', () => {
        markGone('This incident expired on the server');
        es?.close();
      });
      es.onerror = () => {
        if (closed) return;
        if (es && es.readyState === 2 /* CLOSED: refused, not a dropped line */) {
          es = null;
          probe();
        } else {
          setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'connecting');
        }
      };
    };

    // The stream was refused or is unavailable: find out why, poll once, retry later.
    const probe = async () => {
      let delay = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)];
      try {
        const qs = new URLSearchParams({ since: String(stateRef.current.seq || 0), clientId });
        const res = await api(`/${encodeURIComponent(sessionId)}?${qs}`, { key: sessionKey });
        if (closed) return;
        if (res.status === 403 || res.status === 404) {
          markGone(goneMessage(res.status));
          return;
        }
        if (res.ok) {
          apply(res.data);
          setStatus('live');
          setError(null);
          flushRef.current?.();
          delay = Math.min(delay, POLL_FALLBACK_MS); // too many listeners: keep polling
        } else {
          setStatus('connecting');
        }
      } catch {
        if (!closed) setStatus('offline');
      }
      if (!closed && !goneRef.current) reconnectTimer = setTimeout(open, delay);
    };

    const onOnline = () => {
      flushRef.current?.();
      if (!es && !closed) {
        clearTimeout(reconnectTimer);
        open();
      }
    };
    const onOffline = () => setStatus('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    setStatus('connecting');
    open();
    return () => {
      closed = true;
      es?.close();
      clearTimeout(reconnectTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [sessionId, sessionKey, clientId, markGone]);

  // Flush/retry timers die with the component.
  useEffect(
    () => () => {
      clearTimeout(flushTimerRef.current);
      clearTimeout(retryTimerRef.current);
      flushTimerRef.current = null;
    },
    [],
  );

  // Cache the shared picture so a reload with no connection still shows it.
  useEffect(() => {
    if (!sessionId) return undefined;
    const t = setTimeout(() => writeJson(CACHE_KEY, { id: sessionId, state: stateForCache(state) }), CACHE_WRITE_MS);
    return () => clearTimeout(t);
  }, [sessionId, state]);

  // ── Mirroring: what this browser sees → the incident ─────────────────────
  // Event log: entries recorded after joining (ts may be older — recordedAt is not).
  useEffect(() => {
    if (!sessionId) return undefined;
    const pushNew = (events) => {
      if (!sessionRef.current) return; // left: later entries stay local
      const joinedAt = sessionRef.current.joinedAt || 0;
      const known = stateRef.current.events || {};
      const fresh = [];
      for (const ev of events || []) {
        if ((ev.recordedAt || 0) < joinedAt || known[ev.id] || pushedEventsRef.current.has(ev.id)) continue;
        pushedEventsRef.current.add(ev.id);
        fresh.push(eventForPush(ev));
      }
      if (fresh.length) enqueue({ events: fresh });
    };
    pushNew(getEvents());
    return subscribeEvents(pushNew);
  }, [sessionId, enqueue]);

  // Net roster from this server: check-ins, status changes, check-outs.
  useEffect(() => {
    if (!sessionId || !Array.isArray(localRoster)) return;
    const { push, next } = diffRosterForPush(rosterPrevRef.current, localRoster, stateRef.current, Date.now());
    rosterPrevRef.current = next;
    if (push.length) enqueue({ roster: push });
  }, [sessionId, localRoster, enqueue]);

  // Field and shelter reports from this server.
  useEffect(() => {
    if (!sessionId) return;
    const known = stateRef.current.reports || {};
    const fresh = [
      ...(fieldReports || []).map(fieldReportForPush),
      ...(shelterReports || []).filter((s) => s?.from).map(shelterReportForPush),
    ].filter((r) => !known[r.id] && !pushedReportsRef.current.has(r.id));
    if (!fresh.length) return;
    for (const r of fresh) pushedReportsRef.current.add(r.id);
    enqueue({ reports: fresh });
  }, [sessionId, fieldReports, shelterReports, enqueue]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const adopt = useCallback(
    (id, key, site, snapshot) => {
      const prev = sessionRef.current;
      if (!prev || prev.id !== id) {
        outboxRef.current = emptyOutbox(); // a different incident: drop the other one's buffer
        saveOutbox();
      }
      const next = { id, key, site: String(site || '').trim(), joinedAt: Date.now() };
      writeJson(SESSION_KEY, next);
      rosterPrevRef.current = null;
      pushedEventsRef.current = new Set();
      pushedReportsRef.current = new Set();
      goneRef.current = false;
      sessionRef.current = next;
      setSession(next);
      setState(applyIncidentDelta(emptyIncidentState(), snapshot));
      setError(null);
      setInvite(null);
      setStatus('connecting');
      recordEvent('incident_note', {
        callsign: callsignRef.current || '',
        summary: `Joined incident ${snapshot?.board?.name || id}`,
        details: next.site ? `Site: ${next.site}` : '',
      });
    },
    [saveOutbox],
  );

  const create = useCallback(
    async ({ name, ic, netFreq, notes, site } = {}) => {
      const res = await api('', {
        method: 'POST',
        body: { name, ic, netFreq, notes, clientId, call: callsignRef.current },
      });
      if (!res.ok) throw new Error(res.data?.error || `HTTP ${res.status}`);
      adopt(res.data.id, res.data.joinKey, site, res.data.incident);
      return res.data;
    },
    [adopt, clientId],
  );

  const join = useCallback(
    async (rawId, rawKey, site) => {
      const id = normaliseCode(rawId);
      const key = normaliseCode(rawKey);
      if (!id || !key) throw new Error('Enter the incident id and join key');
      const res = await api(`/${encodeURIComponent(id)}/join`, {
        method: 'POST',
        key,
        body: { clientId, call: callsignRef.current },
      });
      if (!res.ok) throw new Error(res.data?.error || `HTTP ${res.status}`);
      adopt(id, key, site, res.data.incident);
      return res.data;
    },
    [adopt, clientId],
  );

  const leave = useCallback(async () => {
    const s = sessionRef.current;
    sessionRef.current = null;
    writeJson(SESSION_KEY, null);
    writeJson(CACHE_KEY, null);
    outboxRef.current = emptyOutbox();
    saveOutbox();
    clearTimeout(flushTimerRef.current);
    clearTimeout(retryTimerRef.current);
    flushTimerRef.current = null;
    rosterPrevRef.current = null;
    setSession(null);
    setState(emptyIncidentState());
    setStatus('idle');
    setError(null);
    if (!s) return;
    recordEvent('incident_note', { callsign: callsignRef.current || '', summary: `Left incident ${s.id}` });
    try {
      await api(`/${encodeURIComponent(s.id)}/leave`, { method: 'POST', key: s.key, body: { clientId } });
    } catch {
      /* presence times out on its own */
    }
  }, [clientId, saveOutbox]);

  const updateBoard = useCallback(
    (board) => {
      const now = Date.now();
      const next = {
        name: board?.name || '',
        ic: board?.ic || '',
        netFreq: board?.netFreq || '',
        notes: board?.notes || '',
        updatedAt: now,
      };
      setState((s) => ({ ...s, board: { ...(s.board || {}), ...next } }));
      enqueue({ board: next });
      recordEvent('incident_note', {
        callsign: callsignRef.current || '',
        summary: 'Incident board updated',
        details: [next.name, next.ic && `IC ${next.ic}`, next.netFreq && `Net ${next.netFreq}`]
          .filter(Boolean)
          .join(' · '),
      });
    },
    [enqueue],
  );

  /** Manual (voice / in-person) check-in straight into the shared roster. */
  const checkIn = useCallback(
    ({ call, status: opStatus, netName } = {}) => {
      const c = String(call || '')
        .trim()
        .toUpperCase();
      if (!c) return;
      const now = Date.now();
      const entry = rosterEntryForPush(
        {
          call: c,
          netName: netName || stateRef.current.board?.name || '',
          status: String(opStatus || '').trim() || 'Checked in',
          checkinTime: now,
          lastHeard: now,
          source: 'manual',
        },
        now,
      );
      setState((s) => applyIncidentDelta(s, { roster: [entry] }));
      enqueue({ roster: [entry] });
      recordEvent('net_checkin', {
        callsign: c,
        summary: `Checked into ${entry.netName || 'net'}`,
        details: entry.status !== 'Checked in' ? entry.status : '',
        ts: now,
        dedupeKey: `${c}-${now}`,
      });
    },
    [enqueue],
  );

  const checkOut = useCallback(
    (call, known) => {
      const c = String(call || '')
        .trim()
        .toUpperCase();
      if (!c) return;
      const now = Date.now();
      const base = stateRef.current.roster?.[c] || known || { call: c };
      const entry = {
        ...rosterEntryForPush({ ...base, call: c }, now),
        status: 'Checked out',
        checkedOut: true,
      };
      setState((s) => applyIncidentDelta(s, { roster: [entry] }));
      enqueue({ roster: [entry] });
      recordEvent('net_checkout', {
        callsign: c,
        summary: 'Checked out of net',
        dedupeKey: `${c}-${base.checkinTime || now}-out`,
      });
    },
    [enqueue],
  );

  const stateEvents = state.events;
  const events = useMemo(() => incidentEventList({ events: stateEvents }), [stateEvents]);
  const joinUrl = useMemo(
    () =>
      session && typeof window !== 'undefined' ? buildJoinUrl(window.location.origin, session.id, session.key) : '',
    [session],
  );

  return {
    joined: !!session,
    session,
    status,
    error,
    pending,
    participants: state.participants || 0,
    board: state.board,
    state,
    events,
    joinUrl,
    invite,
    clearInvite: () => setInvite(null),
    create,
    join,
    leave,
    updateBoard,
    checkIn,
    checkOut,
  };
}

export default useSharedIncident;
