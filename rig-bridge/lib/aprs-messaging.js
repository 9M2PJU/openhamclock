'use strict';
/**
 * APRS message acknowledgements (#1244, #1247).
 *
 * Outgoing (#1247): a message to a callsign is sent with a message id and
 * re-sent on a doubling interval (30 s, 60 s, 120 s …) until the addressee
 * acks (or rejects) it or `maxTries` transmissions have gone out — what
 * Yaesu radios and aprs.fi do. Messages to an alias, a group or a bulletin
 * (EMCOMM, BLN1, W8ROC-net aliases) can never be acked, so they go out once
 * without an id, as before.
 *
 * Incoming (#1244): a message addressed to this station's exact
 * callsign-SSID that carries an id is acked, every copy (the sender keeps
 * retrying until one of our acks gets through).
 *
 * Settings are read on every call, so the Rig Bridge settings page applies
 * them without a restart. Timers and the clock are injectable for tests.
 */

const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 8 * 60 * 1000;
const KEEP_DONE_MS = 60 * 60 * 1000; // finished messages stay listed for an hour
const MAX_TRACKED = 100;

// A callsign (optionally with SSID): 1–2 chars, a digit, 1–4 letters.
const CALLSIGN_RE = /^[A-Z0-9]{1,2}[0-9][A-Z]{1,4}(-[0-9]{1,2})?$/;

const norm = (c) =>
  String(c || '')
    .trim()
    .toUpperCase()
    .replace(/-0$/, '');

/**
 * Parse the info field of an APRS message frame (":ADDRESSEE:text{id").
 * @returns {null | { to, text, msgId, ack, rej }} ack/rej hold the acked id
 */
function parseMessageInfo(info) {
  if (typeof info !== 'string' || info.charAt(0) !== ':' || info.charAt(10) !== ':') return null;
  const to = info.slice(1, 10).trim().toUpperCase();
  let body = info.slice(11);
  // Trailing CR/space some radios leave after the id (#1212)
  body = body.replace(/[\s\x00-\x1f\x7f]+$/, '');
  const ackMatch = body.match(/^(ack|rej)([A-Za-z0-9]{1,5})(?:\}.*)?$/);
  if (ackMatch) {
    return {
      to,
      text: '',
      msgId: null,
      ack: ackMatch[1] === 'ack' ? ackMatch[2] : null,
      rej: ackMatch[1] === 'rej' ? ackMatch[2] : null,
    };
  }
  // "{id" or the APRS 1.2 reply-ack "{MM}AA"
  const idMatch = body.match(/\{([A-Za-z0-9]{1,5})(?:\}[A-Za-z0-9]{0,2})?$/);
  const msgId = idMatch ? idMatch[1] : null;
  const text = (idMatch ? body.slice(0, idMatch.index) : body).trim();
  return { to, text, msgId, ack: null, rej: null };
}

/**
 * @param {object} deps
 * @param {(to, text, msgId|null) => boolean} deps.transmit  send one message frame
 * @param {(to, msgId) => boolean} deps.transmitAck
 * @param {() => string} deps.myCall      this station's callsign-SSID, live
 * @param {() => object} deps.settings    live aprs config: autoAck, messageRetry, messageMaxTries
 * @param {(status) => void} [deps.emit]  outgoing message state changes
 */
function createMessenger({
  transmit,
  transmitAck,
  myCall,
  settings,
  emit = () => {},
  now = Date.now,
  timers = { setTimeout, clearTimeout },
}) {
  const outgoing = new Map(); // msgId → record
  let nextId = 1 + Math.floor(Math.random() * 900); // distinct ids across restarts

  const cfg = () => {
    const s = settings() || {};
    const tries = parseInt(s.messageMaxTries, 10);
    return {
      autoAck: s.autoAck !== false,
      retry: s.messageRetry !== false,
      maxTries: Number.isFinite(tries) ? Math.min(10, Math.max(1, tries)) : 6,
    };
  };

  const view = (r) => ({
    msgId: r.msgId,
    to: r.to,
    text: r.text,
    state: r.state,
    tries: r.tries,
    maxTries: r.maxTries,
    sentAt: r.sentAt,
    updatedAt: r.updatedAt,
  });
  const publish = (r) => {
    r.updatedAt = now();
    try {
      emit(view(r));
    } catch (e) {}
  };

  function prune() {
    const cutoff = now() - KEEP_DONE_MS;
    for (const [id, r] of outgoing) {
      if (r.state !== 'pending' && r.updatedAt < cutoff) outgoing.delete(id);
    }
    while (outgoing.size > MAX_TRACKED) {
      const [oldestId, oldest] = outgoing.entries().next().value;
      if (oldest.timer) timers.clearTimeout(oldest.timer);
      outgoing.delete(oldestId);
    }
  }

  function newId() {
    // Never reuse an id that is still pending
    for (let i = 0; i < 1000; i++) {
      const id = String(nextId);
      nextId = nextId >= 99999 ? 1 : nextId + 1;
      if (!outgoing.has(id)) return id;
    }
    return String(nextId);
  }

  function scheduleRetry(r) {
    const delay = Math.min(RETRY_BASE_MS * 2 ** (r.tries - 1), RETRY_MAX_MS);
    r.timer = timers.setTimeout(() => {
      r.timer = null;
      if (r.state !== 'pending') return;
      if (r.tries >= r.maxTries) {
        r.state = 'expired'; // every try went out, no ack came back
        publish(r);
        return;
      }
      r.tries++;
      transmit(r.to, r.text, r.msgId);
      publish(r);
      scheduleRetry(r);
    }, delay);
  }

  /**
   * Send a message. Returns { ok, msgId, ackRequested }.
   * ok is false when the first transmission could not be made (TNC down).
   */
  function send(to, text) {
    const addressee = norm(to);
    const { retry, maxTries } = cfg();
    const wantAck = retry && CALLSIGN_RE.test(addressee);
    if (!wantAck) {
      return { ok: transmit(addressee, text, null), msgId: null, ackRequested: false };
    }
    const msgId = newId();
    if (!transmit(addressee, text, msgId)) return { ok: false, msgId: null, ackRequested: false };
    const r = { msgId, to: addressee, text, state: 'pending', tries: 1, maxTries, sentAt: now(), timer: null };
    outgoing.set(msgId, r);
    prune();
    publish(r);
    if (maxTries > 1) scheduleRetry(r);
    else {
      // One try only: still wait one interval for a late ack before giving up
      r.timer = timers.setTimeout(() => {
        r.timer = null;
        if (r.state === 'pending') {
          r.state = 'expired';
          publish(r);
        }
      }, RETRY_BASE_MS);
    }
    return { ok: true, msgId, ackRequested: true };
  }

  /** Handle a received frame. Returns what it did, for logging/tests. */
  function handleIncoming(source, info) {
    const m = parseMessageInfo(info);
    if (!m) return null;
    const from = norm(source);
    const me = norm(myCall());
    if (!me || norm(m.to) !== me || from === me) return null;

    const doneId = m.ack || m.rej;
    if (doneId) {
      const r = outgoing.get(doneId);
      if (r && r.to === from && r.state === 'pending') {
        if (r.timer) timers.clearTimeout(r.timer);
        r.timer = null;
        r.state = m.ack ? 'acked' : 'rejected';
        publish(r);
        return { type: r.state, msgId: doneId };
      }
      return { type: 'ack-unmatched', msgId: doneId };
    }

    if (m.msgId && cfg().autoAck) {
      transmitAck(from, m.msgId);
      return { type: 'acked-incoming', msgId: m.msgId, from };
    }
    return { type: 'message', msgId: m.msgId };
  }

  function list() {
    prune();
    return [...outgoing.values()].map(view).reverse();
  }

  function stop() {
    for (const r of outgoing.values()) if (r.timer) timers.clearTimeout(r.timer);
    outgoing.clear();
  }

  return { send, handleIncoming, list, stop };
}

module.exports = { createMessenger, parseMessageInfo, CALLSIGN_RE, RETRY_BASE_MS };
