/**
 * Tests for server/routes/aprs.js — APRS telemetry store.
 *
 * Regression: the telemetryData / telemetryDefs maps and their size limits
 * were lost in a refactor while every use survived, so each T# frame threw a
 * ReferenceError (swallowed by parseAprsTelemetry's try/catch) and
 * GET /api/aprs/telemetry 500'd. Caught by ESLint no-undef.
 *
 * The route module is mounted on a minimal fake Express app; handlers are
 * invoked directly with stub req/res objects. No network: APRS_ENABLED is
 * unset, so no APRS-IS socket is opened.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mountAprs = require('./aprs.js');

function makeApp() {
  const routes = {};
  const register =
    (method) =>
    (path, ...handlers) => {
      routes[`${method} ${path}`] = handlers[handlers.length - 1];
    };
  return { routes, get: register('GET'), post: register('POST') };
}

function call(handler, { body = {}, query = {} } = {}) {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      payload = data;
      return res;
    },
  };
  handler({ body, query }, res);
  return { statusCode, payload };
}

describe('APRS telemetry', () => {
  let app;

  beforeAll(() => {
    // The module starts a cleanup setInterval on mount; keep it off the real clock.
    vi.useFakeTimers();
    app = makeApp();
    const noop = () => {};
    mountAprs(app, {
      CONFIG: {},
      APP_VERSION: 'test',
      logDebug: noop,
      logInfo: noop,
      logWarn: noop,
      logErrorOnce: noop,
    });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('stores T# frames from a local TNC and serves them with PARM labels', () => {
    const local = app.routes['POST /api/aprs/local'];
    const telemetry = app.routes['GET /api/aprs/telemetry'];

    const post = call(local, {
      body: {
        packets: [
          { source: 'N0CALL-11', destination: 'APRS', info: 'T#005,199,000,255,073,123,01101001' },
          { source: 'N0CALL-11', destination: 'APRS', info: ':N0CALL-11:PARM.Battery,Btemp,ATemp,Pres,Alt' },
        ],
      },
    });
    expect(post.statusCode).toBe(200);

    const one = call(telemetry, { query: { callsign: 'n0call' } });
    expect(one.statusCode).toBe(200);
    expect(one.payload).toMatchObject({
      call: 'N0CALL',
      seq: '005',
      values: [199, 0, 255, 73, 123],
      bits: '01101001',
      source: 'local-tnc',
      params: ['Battery', 'Btemp', 'ATemp', 'Pres', 'Alt'],
    });
    expect(one.payload.history).toHaveLength(1);

    const all = call(telemetry);
    expect(all.payload.count).toBe(1);
  });

  it('reports unknown callsigns instead of throwing', () => {
    const telemetry = app.routes['GET /api/aprs/telemetry'];
    const res = call(telemetry, { query: { callsign: 'NOBODY' } });
    expect(res.payload).toEqual({ error: 'No telemetry for this callsign' });
  });
});

describe('APRS net roster boot id and generation', () => {
  const mount = () => {
    const app = makeApp();
    const noop = () => {};
    mountAprs(app, {
      CONFIG: {},
      APP_VERSION: 'test',
      logDebug: noop,
      logInfo: noop,
      logWarn: noop,
      logErrorOnce: noop,
    });
    return app;
  };

  beforeAll(() => vi.useFakeTimers());
  afterAll(() => vi.useRealTimers());

  it('bumps the generation on check-in and check-out and keeps the boot id', () => {
    const app = mount();
    const r0 = call(app.routes['GET /api/aprs/net']).payload;
    expect(r0.bootId).toMatch(/^[0-9a-f]{16}$/);
    call(app.routes['POST /api/aprs/net/checkin'], { body: { callsign: 'W1AW', netName: 'ARES' } });
    const r1 = call(app.routes['GET /api/aprs/net']).payload;
    expect(r1.generation).toBe(r0.generation + 1);
    call(app.routes['POST /api/aprs/net/checkout'], { body: { callsign: 'W1AW' } });
    call(app.routes['POST /api/aprs/net/checkout'], { body: { callsign: 'NOBODY' } }); // no change
    const r2 = call(app.routes['GET /api/aprs/net']).payload;
    expect(r2.generation).toBe(r1.generation + 1);
    expect(r2.bootId).toBe(r0.bootId);
  });

  it('a restart (new mount) gets a new boot id', () => {
    const a = call(mount().routes['GET /api/aprs/net']).payload.bootId;
    const b = call(mount().routes['GET /api/aprs/net']).payload.bootId;
    expect(a).not.toBe(b);
  });
});
