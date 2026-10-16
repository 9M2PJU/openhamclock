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

describe('APRS net roster addresses (#1237, #1238, #1239)', () => {
  let app;
  beforeAll(() => {
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
  afterAll(() => vi.useRealTimers());

  const rf = (source, info) => call(app.routes['POST /api/aprs/local'], { body: { packets: [{ source, info }] } });
  const roster = () => call(app.routes['GET /api/aprs/net']).payload.roster;

  it('records the address each check-in went to, one entry per address', () => {
    rf('KE8PLM-9', ':EMCOMM   :CQ OHNET at home{01');
    rf('KE8PLM-9', ':W8ROC    :CQ HAMCO at station 1{02');
    rf('N8TAG-7', ':W8ROC    :CQ HAMCO{03');
    const r = roster();
    expect(r.map((op) => `${op.alias}|${op.call}|${op.netName}`).sort()).toEqual([
      'EMCOMM|KE8PLM-9|OHNET',
      'W8ROC|KE8PLM-9|HAMCO',
      'W8ROC|N8TAG-7|HAMCO',
    ]);
  });

  it('a check-out to one address leaves the other', () => {
    rf('KE8PLM-9', ':W8ROC    :U HAMCO{04');
    expect(
      roster()
        .filter((op) => op.call === 'KE8PLM-9')
        .map((op) => op.alias),
    ).toEqual(['EMCOMM']);
  });

  it('removing by address takes only that entry; without one, every entry for the call', () => {
    const out = app.routes['POST /api/aprs/net/checkout'];
    rf('KE8PLM-9', ':W8ROC    :CQ HAMCO{05');
    expect(call(out, { body: { callsign: 'ke8plm-9', alias: 'w8roc' } }).payload).toEqual({ ok: true, removed: 1 });
    expect(roster().some((op) => op.call === 'KE8PLM-9' && op.alias === 'W8ROC')).toBe(false);
    rf('KE8PLM-9', ':W8ROC    :CQ HAMCO{06');
    expect(call(out, { body: { callsign: 'KE8PLM-9' } }).payload.removed).toBe(2);
    expect(roster().some((op) => op.call === 'KE8PLM-9')).toBe(false);
  });

  it('manual check-ins default to EMCOMM and reject a bad address', () => {
    const inn = app.routes['POST /api/aprs/net/checkin'];
    call(inn, { body: { callsign: 'w1aw', netName: 'ARES' } });
    expect(roster().find((op) => op.call === 'W1AW').alias).toBe('EMCOMM');
    expect(call(inn, { body: { callsign: 'W1AW', netName: 'ARES', alias: 'not valid!' } }).statusCode).toBe(400);
  });
});
