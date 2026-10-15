/**
 * Tests for server/routes/push.js — Web Push endpoints and SWPC trigger.
 *
 * web-push is mocked via the ctx._webpush test-only injection hook (same
 * idiom as ctx._dxNewsFetchers in dxpeditions.js), so no real VAPID crypto
 * or network delivery happens. Persistence goes to a per-test temp file via
 * the PUSH_SUBSCRIPTIONS_FILE env override.
 *
 * Covers:
 *   - dormant mode: no VAPID keys → every endpoint 503s
 *   - subscribe: stores + persists, validates, dedupes, caps
 *   - unsubscribe: removes
 *   - test push: caller-only delivery, 410 prunes the stored subscription
 *   - SWPC trigger: new severe alert broadcasts once; dedupe survives a
 *     simulated restart (fresh module instance, same store file)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const route = require('./push.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeApp() {
  const handlers = {};
  return {
    get: (p, h) => {
      handlers[`GET ${p}`] = h;
    },
    post: (p, h) => {
      handlers[`POST ${p}`] = h;
    },
    handlers,
  };
}

async function callRoute(app, method, p, body) {
  const handler = app.handlers[`${method} ${p}`];
  if (!handler) throw new Error(`No handler for ${method} ${p}`);
  const req = { body };
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    set() {
      return this;
    },
  };
  await handler(req, res);
  return res;
}

function makeCtx(webpushMock) {
  return {
    ROOT_DIR: os.tmpdir(),
    logInfo: () => {},
    logWarn: () => {},
    logDebug: () => {},
    _webpush: webpushMock,
    // NOTE: no refreshSwpcAlerts / onSwpcAlertsRefreshed — keeps the module
    // from creating timers during tests; the trigger is exercised directly
    // via the returned _handleSwpcAlerts.
  };
}

function makeWebpushMock() {
  return {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({ statusCode: 201 }),
  };
}

function makeSub(n = 1) {
  return {
    endpoint: `https://push.example.com/sub/${n}`,
    expirationTime: null,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
  };
}

function severeAlert(serial = 1) {
  return {
    productId: 'ALTK07',
    serial,
    issueTime: new Date(Date.now() - 60 * 1000).toISOString(),
    type: 'ALERT',
    title: 'Geomagnetic K-index of 7',
    scale: { band: 'G', level: 3, text: 'G3 - Strong' },
  };
}

let storeFile;
const ENV_KEYS = [
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
  'PUSH_SUBSCRIPTIONS_FILE',
  'PUSH_LIGHTNING_BROADCAST',
];
const savedEnv = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  storeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ohc-push-test-')), 'push-subscriptions.json');
  process.env.PUSH_SUBSCRIPTIONS_FILE = storeFile;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(path.dirname(storeFile), { recursive: true, force: true });
});

function mountConfigured(webpushMock = makeWebpushMock()) {
  process.env.VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  const app = makeApp();
  const exports_ = route(app, makeCtx(webpushMock));
  return { app, exports_, webpushMock };
}

// ─── Dormant mode ─────────────────────────────────────────────────────────────

describe('dormant mode (no VAPID keys)', () => {
  it('returns 503 with configured:false from every endpoint', async () => {
    const app = makeApp();
    route(app, makeCtx(makeWebpushMock()));
    for (const [method, p] of [
      ['GET', '/api/push/vapid-key'],
      ['POST', '/api/push/subscribe'],
      ['POST', '/api/push/unsubscribe'],
      ['POST', '/api/push/test'],
      ['POST', '/api/push/lightning'],
    ]) {
      const res = await callRoute(app, method, p, {});
      expect(res.statusCode).toBe(503);
      expect(res.body.configured).toBe(false);
      expect(res.body.error).toMatch(/not configured/i);
    }
  });

  it('creates no store file while dormant', async () => {
    const app = makeApp();
    route(app, makeCtx(makeWebpushMock()));
    expect(fs.existsSync(storeFile)).toBe(false);
  });
});

// ─── Configured mode ──────────────────────────────────────────────────────────

describe('configured mode', () => {
  it('serves the VAPID public key', async () => {
    const { app } = mountConfigured();
    const res = await callRoute(app, 'GET', '/api/push/vapid-key');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ configured: true, publicKey: 'test-public-key', lightning: false });
  });

  it('subscribe stores and persists; invalid bodies are rejected', async () => {
    const { app } = mountConfigured();
    const ok = await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub() });
    expect(ok.statusCode).toBe(200);
    const persisted = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(Object.keys(persisted.subscriptions)).toEqual([makeSub().endpoint]);

    const bad = await callRoute(app, 'POST', '/api/push/subscribe', { subscription: { endpoint: 'nope' } });
    expect(bad.statusCode).toBe(400);
  });

  it('subscribe dedupes by endpoint', async () => {
    const { app, exports_ } = mountConfigured();
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub() });
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub() });
    expect(Object.keys(exports_._pushStore.subscriptions)).toHaveLength(1);
  });

  it('unsubscribe removes the stored subscription', async () => {
    const { app, exports_ } = mountConfigured();
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub() });
    const res = await callRoute(app, 'POST', '/api/push/unsubscribe', { endpoint: makeSub().endpoint });
    expect(res.body).toEqual({ ok: true, removed: true });
    expect(Object.keys(exports_._pushStore.subscriptions)).toHaveLength(0);
  });

  it('test push targets the caller subscription only', async () => {
    const { app, webpushMock } = mountConfigured();
    const res = await callRoute(app, 'POST', '/api/push/test', { subscription: makeSub() });
    expect(res.statusCode).toBe(200);
    expect(webpushMock.sendNotification).toHaveBeenCalledTimes(1);
    const [subArg, payloadArg] = webpushMock.sendNotification.mock.calls[0];
    expect(subArg.endpoint).toBe(makeSub().endpoint);
    expect(JSON.parse(payloadArg).tag).toBe('ohc-push-test');
  });

  it('test push handles delivery failure gracefully and prunes on 410', async () => {
    const webpushMock = makeWebpushMock();
    webpushMock.sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
    const { app, exports_ } = mountConfigured(webpushMock);
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub() });
    const res = await callRoute(app, 'POST', '/api/push/test', { subscription: makeSub() });
    expect(res.statusCode).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(Object.keys(exports_._pushStore.subscriptions)).toHaveLength(0);
  });

  it('test push reports non-gone failures as 502 without pruning', async () => {
    const webpushMock = makeWebpushMock();
    webpushMock.sendNotification.mockRejectedValue(Object.assign(new Error('nope'), { statusCode: 400 }));
    const { app, exports_ } = mountConfigured(webpushMock);
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub() });
    const res = await callRoute(app, 'POST', '/api/push/test', { subscription: makeSub() });
    expect(res.statusCode).toBe(502);
    expect(Object.keys(exports_._pushStore.subscriptions)).toHaveLength(1);
  });
});

// ─── SWPC trigger ─────────────────────────────────────────────────────────────

describe('SWPC severe alert trigger', () => {
  it('broadcasts a new severe alert to all subscriptions exactly once', async () => {
    const { app, exports_, webpushMock } = mountConfigured();
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub(1) });
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub(2) });

    await exports_._handleSwpcAlerts([severeAlert(42)]);
    expect(webpushMock.sendNotification).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(webpushMock.sendNotification.mock.calls[0][1]);
    expect(payload).toEqual({
      title: 'Space Weather: G3 - Strong',
      body: 'ALERT: Geomagnetic K-index of 7',
      tag: 'ohc-push-swpc',
    });

    // Same refresh cycle content again → no re-push
    await exports_._handleSwpcAlerts([severeAlert(42)]);
    expect(webpushMock.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('ignores sub-threshold alerts', async () => {
    const { app, exports_, webpushMock } = mountConfigured();
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub() });
    await exports_._handleSwpcAlerts([{ ...severeAlert(1), scale: { band: 'G', level: 1, text: 'G1 - Minor' } }]);
    expect(webpushMock.sendNotification).not.toHaveBeenCalled();
  });

  it('prunes subscriptions the push service reports gone during broadcast', async () => {
    const webpushMock = makeWebpushMock();
    webpushMock.sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
    const { app, exports_ } = mountConfigured(webpushMock);
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub() });
    await exports_._handleSwpcAlerts([severeAlert(7)]);
    expect(Object.keys(exports_._pushStore.subscriptions)).toHaveLength(0);
  });

  it('does not re-push a seen alert after a restart (dedupe keys persist)', async () => {
    const first = mountConfigured();
    await callRoute(first.app, 'POST', '/api/push/subscribe', { subscription: makeSub() });
    await first.exports_._handleSwpcAlerts([severeAlert(99)]);
    expect(first.webpushMock.sendNotification).toHaveBeenCalledTimes(1);

    // Simulated restart: fresh module instance loads the same store file.
    const second = mountConfigured();
    expect(Object.keys(second.exports_._pushStore.subscriptions)).toHaveLength(1);
    await second.exports_._handleSwpcAlerts([severeAlert(99)]);
    expect(second.webpushMock.sendNotification).not.toHaveBeenCalled();
  });
});

// ─── Lightning guard broadcast ────────────────────────────────────────────────

describe('lightning guard push', () => {
  it('is refused unless PUSH_LIGHTNING_BROADCAST is set', async () => {
    const { app, webpushMock } = mountConfigured();
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub(1) });
    const res = await callRoute(app, 'POST', '/api/push/lightning', { level: 'alarm', distanceKm: 12 });
    expect(res.statusCode).toBe(403);
    expect(res.body.enabled).toBe(false);
    expect(webpushMock.sendNotification).not.toHaveBeenCalled();
  });

  it('broadcasts a validated payload to every subscriber and throttles repeats', async () => {
    process.env.PUSH_LIGHTNING_BROADCAST = 'true';
    const { app, webpushMock } = mountConfigured();
    const key = await callRoute(app, 'GET', '/api/push/vapid-key');
    expect(key.body.lightning).toBe(true);
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub(1) });
    await callRoute(app, 'POST', '/api/push/subscribe', { subscription: makeSub(2) });

    const bad = await callRoute(app, 'POST', '/api/push/lightning', { level: 'storm' });
    expect(bad.statusCode).toBe(400);

    const res = await callRoute(app, 'POST', '/api/push/lightning', {
      level: 'alarm',
      distanceKm: 12.4,
      bearingDeg: 45,
      relay: true,
      title: 'ignored free text',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.sent).toBe(2);
    const payload = JSON.parse(webpushMock.sendNotification.mock.calls[0][1]);
    expect(payload).toEqual({
      title: 'Lightning ALARM',
      body: 'Nearest strike 12 km NE · antenna relay engaged',
      tag: 'ohc-lightning',
    });

    // Same level again straight away → skipped, nothing sent
    const again = await callRoute(app, 'POST', '/api/push/lightning', { level: 'alarm', distanceKm: 8 });
    expect(again.body.skipped).toBe(true);
    expect(webpushMock.sendNotification).toHaveBeenCalledTimes(2);
  });
});
