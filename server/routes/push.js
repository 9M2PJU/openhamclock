'use strict';
/**
 * Web Push routes — TRUE closed-browser notifications via VAPID.
 *
 * v1 scope: server-pushed BROADCAST-class events only. The single event
 * source is NOAA SWPC space weather alerts at scale level >= 2 (the same
 * threshold the in-app severe-alert feed uses), plus a caller-scoped test
 * push. Per-user watchlist evaluation server-side is deliberately out of
 * scope — that's the phase-2 path (see the comment on broadcast()).
 *
 * Dormant by default: unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set
 * (see .env.example — `npx web-push generate-vapid-keys`), every endpoint
 * returns 503 and no timers, files, or upstream traffic are created. Zero
 * behavior change for existing installs.
 *
 * Subscriptions persist to a JSON file (same writable-path waterfall as
 * relay-tokens.json in rig-bridge.js), capped, pruned when the push service
 * answers 404/410. Pushed-alert dedupe keys persist alongside so server
 * restarts don't re-push the same product/serial.
 *
 * Endpoints:
 *   GET  /api/push/vapid-key    → { configured, publicKey }
 *   POST /api/push/subscribe    { subscription } → store it
 *   POST /api/push/unsubscribe  { endpoint }     → drop it
 *   POST /api/push/test         { subscription } → send a test push to the
 *                               caller's own subscription only
 *   POST /api/push/lightning    { level, distanceKm, bearingDeg, imperial, relay }
 *                               → broadcast a lightning guard transition to
 *                               every subscription. Opt-in per server with
 *                               PUSH_LIGHTNING_BROADCAST=true (403 otherwise):
 *                               it is meant for a station's own server, where
 *                               the subscribers are the operator's devices.
 */

const fs = require('fs');
const path = require('path');
const helpers = require('../utils/push-helpers');

module.exports = function (app, ctx) {
  const { ROOT_DIR, logInfo, logWarn, logDebug } = ctx;

  const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();
  // Contact URI push services may use to reach the operator (mailto: or https:).
  const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:admin@example.com').trim();
  // Lightning guard pushes go to EVERY subscriber, so they are off unless the
  // operator says this server is theirs alone.
  const LIGHTNING_PUSH = /^(1|true|yes|on)$/i.test((process.env.PUSH_LIGHTNING_BROADCAST || '').trim());

  // ── Dormant mode: no keys → every endpoint 503s and nothing else runs ────
  let webpush = null;
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    try {
      webpush = ctx._webpush || require('web-push'); // ctx._webpush: test-only injection hook
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    } catch (err) {
      webpush = null;
      logWarn(`[Push] VAPID keys rejected (${err.message}) — Web Push disabled`);
    }
  }

  if (!webpush) {
    const dormant = (req, res) =>
      res.status(503).json({
        configured: false,
        error:
          'Web Push is not configured on this server. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (npx web-push generate-vapid-keys) to enable it.',
      });
    app.get('/api/push/vapid-key', dormant);
    app.post('/api/push/subscribe', dormant);
    app.post('/api/push/unsubscribe', dormant);
    app.post('/api/push/test', dormant);
    app.post('/api/push/lightning', dormant);
    return {};
  }

  // ── Persistence (relay-tokens.json waterfall pattern) ────────────────────
  const PUSH_STORE_FILE = (() => {
    const candidates = [
      process.env.PUSH_SUBSCRIPTIONS_FILE,
      '/data/push-subscriptions.json',
      path.join(ROOT_DIR, 'data', 'push-subscriptions.json'),
      '/tmp/openhamclock-push-subscriptions.json',
    ];
    for (const p of candidates) {
      if (!p) continue;
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        return p;
      } catch {
        continue;
      }
    }
    return '/tmp/openhamclock-push-subscriptions.json';
  })();

  const store = { subscriptions: {}, pushedAlerts: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(PUSH_STORE_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const entry of Object.values(raw.subscriptions || {})) {
        if (entry?.subscription)
          helpers.addSubscription(store, entry.subscription, helpers.MAX_SUBSCRIPTIONS, entry.addedAt ?? Date.now());
      }
      for (const [k, ts] of Object.entries(raw.pushedAlerts || {})) {
        if (Number.isFinite(ts)) store.pushedAlerts[k] = ts;
      }
    }
    logInfo(`[Push] Loaded ${Object.keys(store.subscriptions).length} subscription(s) from ${PUSH_STORE_FILE}`);
  } catch {
    /* file absent on first run — normal */
  }

  function saveStore() {
    try {
      fs.writeFileSync(PUSH_STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (err) {
      logWarn(`[Push] Could not persist subscriptions: ${err.message}`);
    }
  }

  // ── Delivery ─────────────────────────────────────────────────────────────
  const SEND_OPTIONS = { TTL: 6 * 60 * 60 }; // severe space weather stays relevant for hours

  /** Send one payload to one stored subscription. Returns { ok, statusCode, gone }. */
  async function sendTo(subscription, payloadJson) {
    try {
      await webpush.sendNotification(subscription, payloadJson, SEND_OPTIONS);
      return { ok: true };
    } catch (err) {
      const statusCode = err?.statusCode ?? 0;
      return { ok: false, statusCode, gone: statusCode === 404 || statusCode === 410 };
    }
  }

  /**
   * Broadcast a payload to every stored subscription, pruning the ones the
   * push service reports as gone (404/410).
   *
   * v1: broadcast-class only — every subscriber gets the same payload.
   * Phase 2: evaluate per-user watchlists server-side and target pushes per
   * subscription (needs per-subscription preferences stored alongside).
   */
  async function broadcast(payload) {
    const payloadJson = JSON.stringify(payload);
    const entries = Object.values(store.subscriptions);
    const CONCURRENCY = 25;
    let sent = 0;
    const gone = [];
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((e) => sendTo(e.subscription, payloadJson)));
      results.forEach((r, idx) => {
        if (r.ok) sent += 1;
        else if (r.gone) gone.push(batch[idx].subscription.endpoint);
      });
    }
    if (gone.length) {
      gone.forEach((endpoint) => helpers.removeSubscription(store, endpoint));
      saveStore();
    }
    logInfo(`[Push] Broadcast "${payload.title}" — ${sent}/${entries.length} delivered, ${gone.length} pruned`);
    return { sent, total: entries.length, pruned: gone.length };
  }

  // ── SWPC trigger ─────────────────────────────────────────────────────────
  // Evaluate every fresh SWPC alert refresh for new severe (scale >= 2)
  // products. Dedupe keys are recorded BEFORE delivery so an overlapping
  // refresh can't double-push, and persisted so restarts don't re-push.
  async function handleSwpcAlerts(alerts) {
    const now = Date.now();
    const pruned = helpers.prunePushedKeys(store.pushedAlerts, now);
    const fresh = helpers.selectNewSevereAlerts(alerts, store.pushedAlerts, now);
    if (fresh.length === 0) {
      if (pruned > 0) saveStore();
      return;
    }
    for (const alert of fresh) store.pushedAlerts[helpers.alertDedupeKey(alert)] = now;
    saveStore();
    for (const alert of fresh) {
      const payload = helpers.buildSwpcPushPayload(alert);
      logDebug(`[Push] New severe SWPC alert ${helpers.alertDedupeKey(alert)} → broadcasting`);
      await broadcast(payload);
    }
  }

  if (typeof ctx.onSwpcAlertsRefreshed === 'function') {
    ctx.onSwpcAlertsRefreshed((alerts) => {
      handleSwpcAlerts(alerts).catch((err) => logWarn(`[Push] SWPC broadcast failed: ${err.message}`));
    });
  }

  // Keep the SWPC cache turning over even with no browser connected — that is
  // the entire point of closed-browser push. refreshSwpcAlerts() is
  // cache-aware (5 min TTL), so this adds no upstream traffic beyond what an
  // open tab already causes.
  if (typeof ctx.refreshSwpcAlerts === 'function') {
    const SWPC_POLL_MS = 5 * 60 * 1000;
    const kick = () => ctx.refreshSwpcAlerts().catch(() => {});
    const interval = setInterval(kick, SWPC_POLL_MS);
    interval.unref?.();
    const boot = setTimeout(kick, 15000); // first poll shortly after boot, off the startup path
    boot.unref?.();
  }

  // ── Endpoints ────────────────────────────────────────────────────────────
  app.get('/api/push/vapid-key', (req, res) => {
    res.json({ configured: true, publicKey: VAPID_PUBLIC_KEY, lightning: LIGHTNING_PUSH });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const sub = req.body?.subscription || req.body;
    const result = helpers.addSubscription(store, sub);
    if (!result.ok) {
      if (result.reason === 'full') return res.status(507).json({ error: 'Subscription limit reached' });
      return res.status(400).json({ error: 'Invalid push subscription' });
    }
    saveStore();
    logDebug(`[Push] Subscribed (${Object.keys(store.subscriptions).length} total)`);
    res.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const endpoint = req.body?.endpoint || req.body?.subscription?.endpoint;
    const removed = helpers.removeSubscription(store, endpoint);
    if (removed) saveStore();
    res.json({ ok: true, removed });
  });

  // Test push — delivered to the CALLER'S subscription only (echoed in body),
  // never broadcast. Lets the Settings card verify the full path end-to-end.
  app.post('/api/push/test', async (req, res) => {
    const sub = req.body?.subscription || req.body;
    if (!helpers.isValidSubscription(sub)) {
      return res.status(400).json({ error: 'Invalid push subscription' });
    }
    const payload = {
      title: 'OpenHamClock test push',
      body: 'Web Push is working — severe space weather alerts will arrive like this.',
      tag: 'ohc-push-test',
    };
    const result = await sendTo(sub, JSON.stringify(payload));
    if (result.ok) return res.json({ ok: true });
    if (result.gone) {
      if (helpers.removeSubscription(store, sub.endpoint)) saveStore();
      return res.status(410).json({ ok: false, error: 'Subscription expired — re-subscribe and try again' });
    }
    res
      .status(502)
      .json({ ok: false, error: `Push service rejected the request (${result.statusCode || 'network error'})` });
  });

  // Lightning guard transition from a browser → every subscriber (opt-in).
  let lastLightningPush = null;
  app.post('/api/push/lightning', async (req, res) => {
    if (!LIGHTNING_PUSH) {
      return res.status(403).json({
        ok: false,
        enabled: false,
        error: 'Lightning push is not enabled on this server (set PUSH_LIGHTNING_BROADCAST=true).',
      });
    }
    const payload = helpers.buildLightningPushPayload(req.body);
    if (!payload) return res.status(400).json({ ok: false, error: 'Invalid lightning report' });
    const now = Date.now();
    if (!helpers.shouldPushLightning(lastLightningPush, req.body.level, now)) {
      return res.json({ ok: true, skipped: true });
    }
    lastLightningPush = { at: now, level: req.body.level };
    const result = await broadcast(payload);
    res.json({ ok: true, ...result });
  });

  return { _pushStore: store, _broadcast: broadcast, _handleSwpcAlerts: handleSwpcAlerts };
};
