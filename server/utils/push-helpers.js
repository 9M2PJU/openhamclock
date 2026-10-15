'use strict';
/**
 * Pure helpers for the Web Push feature (server/routes/push.js).
 *
 * Everything here is side-effect free and unit-tested in
 * server/utils/pushHelpers.test.js — the route module owns I/O (persistence,
 * webpush delivery, timers) and delegates the decisions to these functions.
 *
 * Store shape (persisted as JSON, see push.js):
 *   {
 *     subscriptions: { [endpoint]: { subscription, addedAt } },
 *     pushedAlerts:  { [productId:serial]: pushedAtMs }
 *   }
 */

/** Same threshold as the in-app severe-alert feed (App.jsx severeSwpcAlerts). */
const MIN_PUSH_SCALE_LEVEL = 2;

/** Never push alerts older than this — keeps a cold-start (empty dedupe file)
 *  from spamming every subscriber with hours-old products. */
const MAX_PUSH_ALERT_AGE_MS = 60 * 60 * 1000; // 1 hour

/** How long pushed-alert dedupe keys are kept before pruning. */
const PUSHED_KEY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Hard cap on stored subscriptions. */
const MAX_SUBSCRIPTIONS = 10000;

/** Minimal structural validation of a PushSubscription.toJSON() payload. */
function isValidSubscription(sub) {
  return !!(
    sub &&
    typeof sub === 'object' &&
    typeof sub.endpoint === 'string' &&
    /^https:\/\//.test(sub.endpoint) &&
    sub.endpoint.length <= 2048 &&
    sub.keys &&
    typeof sub.keys.p256dh === 'string' &&
    typeof sub.keys.auth === 'string'
  );
}

/**
 * Add (or refresh) a subscription in the store, deduped by endpoint.
 * Returns { ok: true } or { ok: false, reason: 'invalid' | 'full' }.
 */
function addSubscription(store, sub, max = MAX_SUBSCRIPTIONS, now = Date.now()) {
  if (!isValidSubscription(sub)) return { ok: false, reason: 'invalid' };
  const exists = Object.prototype.hasOwnProperty.call(store.subscriptions, sub.endpoint);
  if (!exists && Object.keys(store.subscriptions).length >= max) return { ok: false, reason: 'full' };
  store.subscriptions[sub.endpoint] = {
    subscription: { endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: sub.keys },
    addedAt: exists ? store.subscriptions[sub.endpoint].addedAt : now,
  };
  return { ok: true };
}

/** Remove a subscription by endpoint. Returns true when one was removed. */
function removeSubscription(store, endpoint) {
  if (typeof endpoint !== 'string' || !Object.prototype.hasOwnProperty.call(store.subscriptions, endpoint)) {
    return false;
  }
  delete store.subscriptions[endpoint];
  return true;
}

/** Stable dedupe key for a parsed SWPC alert (product code + serial). */
function alertDedupeKey(alert) {
  return `${alert?.productId ?? 'unknown'}:${alert?.serial ?? 'unknown'}`;
}

/**
 * Filter a parsed SWPC alert array down to the alerts that should be pushed
 * now: NOAA scale level >= MIN_PUSH_SCALE_LEVEL, recent (MAX_PUSH_ALERT_AGE_MS)
 * and not already recorded in pushedKeys. Does NOT mutate pushedKeys.
 */
function selectNewSevereAlerts(alerts, pushedKeys, now = Date.now()) {
  if (!Array.isArray(alerts)) return [];
  return alerts.filter((a) => {
    if ((a?.scale?.level ?? 0) < MIN_PUSH_SCALE_LEVEL) return false;
    const issued = a.issueTime ? Date.parse(a.issueTime) : NaN;
    if (!Number.isFinite(issued) || now - issued > MAX_PUSH_ALERT_AGE_MS) return false;
    return !Object.prototype.hasOwnProperty.call(pushedKeys, alertDedupeKey(a));
  });
}

/**
 * Drop dedupe keys older than PUSHED_KEY_RETENTION_MS.
 * Mutates pushedKeys; returns the number of keys removed.
 */
function prunePushedKeys(pushedKeys, now = Date.now()) {
  let removed = 0;
  for (const [key, ts] of Object.entries(pushedKeys)) {
    if (!Number.isFinite(ts) || now - ts > PUSHED_KEY_RETENTION_MS) {
      delete pushedKeys[key];
      removed += 1;
    }
  }
  return removed;
}

/**
 * Build the JSON payload the service worker `push` handler displays for a
 * severe SWPC alert. Shape mirrors showAlertNotification options.
 */
function buildSwpcPushPayload(alert) {
  const scaleText = alert?.scale?.text || '';
  const title = scaleText ? `Space Weather: ${scaleText}` : 'Space Weather Alert';
  const parts = [];
  if (alert?.type && alert.type !== 'MESSAGE') parts.push(alert.type);
  if (alert?.title) parts.push(alert.title);
  let body = parts.join(': ');
  if (body.length > 140) body = `${body.slice(0, 137)}…`;
  return { title, body, tag: 'ohc-push-swpc' };
}

// ── Lightning guard (station-broadcast push) ────────────────────────────────
const LIGHTNING_PUSH_LEVELS = ['warn', 'alarm', 'clear'];
const LIGHTNING_PUSH_MIN_GAP_MS = 20 * 1000; // any two lightning pushes
const LIGHTNING_PUSH_REPEAT_MS = 10 * 60 * 1000; // the same level again
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Build the push payload for a lightning guard transition from the
 * browser's report. Only validated numbers and a fixed level vocabulary
 * reach the text — nothing free-form from the request is echoed.
 * Returns null for an invalid report.
 */
function buildLightningPushPayload(report) {
  const r = report && typeof report === 'object' ? report : {};
  if (!LIGHTNING_PUSH_LEVELS.includes(r.level)) return null;
  const title =
    r.level === 'alarm' ? 'Lightning ALARM' : r.level === 'warn' ? 'Lightning warning' : 'Lightning all clear';
  const parts = [];
  const km = Number(r.distanceKm);
  if (
    r.level !== 'clear' &&
    r.distanceKm !== null &&
    r.distanceKm !== '' &&
    Number.isFinite(km) &&
    km >= 0 &&
    km <= 2000
  ) {
    const imperial = r.imperial === true;
    const v = imperial ? km * 0.621371 : km;
    const brg = Number(r.bearingDeg);
    const dir =
      r.bearingDeg != null && Number.isFinite(brg)
        ? ` ${CARDINALS[Math.round((((brg % 360) + 360) % 360) / 45) % 8]}`
        : '';
    parts.push(`Nearest strike ${v < 10 ? v.toFixed(1) : Math.round(v)} ${imperial ? 'mi' : 'km'}${dir}`);
  }
  if (r.level === 'clear') parts.push('No strikes nearby for the all-clear time');
  if (r.relay === true) parts.push('antenna relay engaged');
  else if (r.relay === false && r.level === 'clear') parts.push('antenna relay released');
  return { title, body: parts.join(' · '), tag: 'ohc-lightning' };
}

/**
 * Throttle for lightning pushes: never two within LIGHTNING_PUSH_MIN_GAP_MS,
 * and the same level is not repeated within LIGHTNING_PUSH_REPEAT_MS (a
 * flapping browser or several displays reporting the same storm).
 */
function shouldPushLightning(last, level, now = Date.now()) {
  if (!last || !last.at) return true;
  if (now - last.at < LIGHTNING_PUSH_MIN_GAP_MS) return false;
  if (last.level === level && now - last.at < LIGHTNING_PUSH_REPEAT_MS) return false;
  return true;
}

module.exports = {
  MIN_PUSH_SCALE_LEVEL,
  MAX_PUSH_ALERT_AGE_MS,
  PUSHED_KEY_RETENTION_MS,
  MAX_SUBSCRIPTIONS,
  isValidSubscription,
  addSubscription,
  removeSubscription,
  alertDedupeKey,
  selectNewSevereAlerts,
  prunePushedKeys,
  buildSwpcPushPayload,
  LIGHTNING_PUSH_MIN_GAP_MS,
  LIGHTNING_PUSH_REPEAT_MS,
  buildLightningPushPayload,
  shouldPushLightning,
};
