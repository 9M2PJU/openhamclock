/**
 * Tests for server/routes/incident.js — shared incident API transport:
 * key auth, hosted opacity, SSE fan-out and resume, persistence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohc-incident-'));
process.env.INCIDENT_FILE = path.join(tmpDir, 'incidents.json');

const route = require('./incident.js');

const makeApp = () => {
  const handlers = {};
  const record =
    (method) =>
    (p, ...fns) =>
      (handlers[`${method} ${p}`] = fns[fns.length - 1]);
  return { handlers, app: { get: record('GET'), post: record('POST') } };
};

const ctx = { ROOT_DIR: tmpDir, logInfo: () => {}, logWarn: () => {}, logDebug: () => {} };

const makeRes = () => {
  const res = {
    code: 200,
    body: undefined,
    headers: {},
    chunks: [],
    ended: false,
    setHeader: (k, v) => (res.headers[k] = v),
    status: (c) => {
      res.code = c;
      return res;
    },
    json: (b) => {
      res.body = b;
      return res;
    },
    writeHead: (c, h) => {
      res.code = c;
      Object.assign(res.headers, h);
    },
    flushHeaders: () => {},
    write: (chunk) => res.chunks.push(chunk),
    end: () => (res.ended = true),
  };
  return res;
};

const makeReq = ({ params = {}, body = {}, query = {}, headers = {}, ip = '10.0.0.1' } = {}) => {
  const listeners = {};
  return {
    params,
    body,
    query,
    headers,
    ip,
    on: (ev, fn) => (listeners[ev] = fn),
    emit: (ev) => listeners[ev]?.(),
  };
};

/** Parse SSE chunks into [{ id, event, data }]. */
const sseEvents = (res) =>
  res.chunks
    .filter((c) => !c.startsWith(':'))
    .map((c) => {
      const out = {};
      for (const line of c.trim().split('\n')) {
        const [k, ...rest] = line.split(': ');
        out[k] = rest.join(': ');
      }
      return { id: out.id ? Number(out.id) : undefined, event: out.event, data: JSON.parse(out.data) };
    });

const call = (h, key, opts) => {
  const req = makeReq(opts);
  const res = makeRes();
  h[key](req, res);
  return { req, res };
};

describe('incident routes', () => {
  let h;
  const savedHosted = process.env.OHC_HOSTED;

  const mount = () => {
    const { app, handlers } = makeApp();
    const exp = route(app, ctx);
    h = handlers;
    return exp;
  };

  beforeEach(() => {
    delete process.env.OHC_HOSTED;
    try {
      fs.unlinkSync(process.env.INCIDENT_FILE);
    } catch {}
    mount();
  });

  afterEach(() => {
    if (savedHosted === undefined) delete process.env.OHC_HOSTED;
    else process.env.OHC_HOSTED = savedHosted;
  });

  const create = (body = {}) =>
    call(h, 'POST /api/incident', { body: { name: 'Flood', ic: 'K0CJH', clientId: 'c1', ...body } }).res.body;

  it('creates an incident and returns the id and join key once', () => {
    const out = create();
    expect(out.ok).toBe(true);
    expect(out.id).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(out.joinKey).toHaveLength(16);
    expect(out.incident.board.name).toBe('Flood');
    expect(out.incident.participants).toBe(1);
  });

  it('joins with the key, rejects a wrong key (403) and an unknown id (404 locally)', () => {
    const { id, joinKey } = create();
    const ok = call(h, 'POST /api/incident/:id/join', { params: { id }, body: { key: joinKey, clientId: 'c2' } });
    expect(ok.res.body.ok).toBe(true);
    expect(ok.res.body.incident.participants).toBe(2);

    const bad = call(h, 'POST /api/incident/:id/join', { params: { id }, body: { key: 'NOPE' } });
    expect(bad.res.code).toBe(403);

    const unknown = call(h, 'POST /api/incident/:id/join', { params: { id: 'ABCDEFGH' }, body: { key: joinKey } });
    expect(unknown.res.code).toBe(404);
  });

  it('requires the key for reads and accepts it as header, body or query', () => {
    const { id, joinKey } = create();
    expect(call(h, 'GET /api/incident/:id', { params: { id } }).res.code).toBe(403);
    const viaHeader = call(h, 'GET /api/incident/:id', { params: { id }, headers: { 'x-incident-key': joinKey } });
    expect(viaHeader.res.code).toBe(200);
    expect(viaHeader.res.headers['Cache-Control']).toMatch(/no-store/);
    expect(call(h, 'GET /api/incident/:id', { params: { id }, query: { key: joinKey } }).res.code).toBe(200);
  });

  it('syncs records, fans changes out to every stream, and skips no-op writes', () => {
    const { id, joinKey } = create();
    const a = call(h, 'GET /api/incident/:id/stream', { params: { id }, query: { key: joinKey, clientId: 'c1' } });
    const b = call(h, 'GET /api/incident/:id/stream', { params: { id }, query: { key: joinKey, clientId: 'c2' } });
    expect(a.res.headers['Content-Type']).toBe('text/event-stream');
    expect(sseEvents(a.res)[0].event).toBe('snapshot');

    const sync = call(h, 'POST /api/incident/:id/sync', {
      params: { id },
      body: {
        key: joinKey,
        clientId: 'c1',
        site: 'EOC',
        roster: [{ call: 'W1AW', netName: 'ARES' }],
        events: [{ id: 'e1', type: 'net_checkin', callsign: 'W1AW', summary: 'in' }],
      },
    });
    expect(sync.res.body.accepted).toEqual({ roster: 1, events: 1, reports: 0, board: false });

    for (const s of [a, b]) {
      const change = sseEvents(s.res).find((e) => e.event === 'change');
      expect(change.data.events[0]).toMatchObject({ id: 'e1', site: 'EOC' });
      expect(change.id).toBe(sync.res.body.seq);
    }

    const before = b.res.chunks.length;
    const again = call(h, 'POST /api/incident/:id/sync', {
      params: { id },
      body: { key: joinKey, events: [{ id: 'e1', type: 'net_checkin', callsign: 'W1AW', summary: 'in' }] },
    });
    expect(again.res.body.accepted.events).toBe(0);
    expect(
      sseEvents(b.res)
        .slice(before)
        .filter((e) => e.event === 'change'),
    ).toHaveLength(0);
    a.req.emit('close');
    b.req.emit('close');
  });

  it('resumes a stream from Last-Event-ID with only the missed records', () => {
    const { id, joinKey } = create();
    const first = call(h, 'POST /api/incident/:id/sync', {
      params: { id },
      body: { key: joinKey, events: [{ id: 'e1', type: 'incident_note', summary: 'one' }] },
    }).res.body.seq;
    call(h, 'POST /api/incident/:id/sync', {
      params: { id },
      body: { key: joinKey, events: [{ id: 'e2', type: 'incident_note', summary: 'two' }] },
    });
    const s = call(h, 'GET /api/incident/:id/stream', {
      params: { id },
      query: { key: joinKey },
      headers: { 'last-event-id': String(first) },
    });
    const snap = sseEvents(s.res)[0];
    expect(snap.event).toBe('snapshot');
    expect(snap.data.events.map((e) => e.id)).toEqual(['e2']);
    s.req.emit('close');
  });

  it('refuses the stream without the key', () => {
    const { id } = create();
    const s = call(h, 'GET /api/incident/:id/stream', { params: { id }, query: {} });
    expect(s.res.code).toBe(403);
    expect(s.res.chunks).toHaveLength(0);
  });

  it('leave drops the participant and tells the other streams', () => {
    const { id, joinKey } = create();
    call(h, 'POST /api/incident/:id/join', { params: { id }, body: { key: joinKey, clientId: 'c2' } });
    const s = call(h, 'GET /api/incident/:id/stream', { params: { id }, query: { key: joinKey, clientId: 'c1' } });
    const out = call(h, 'POST /api/incident/:id/leave', { params: { id }, body: { key: joinKey, clientId: 'c2' } });
    expect(out.res.body.participants).toBe(1);
    const presence = sseEvents(s.res).filter((e) => e.event === 'presence');
    expect(presence[presence.length - 1].data.participants).toBe(1);
    s.req.emit('close');
  });

  it('lists incidents locally without exposing keys', () => {
    const { id, joinKey } = create();
    const list = call(h, 'GET /api/incident/list').res.body;
    expect(list.incidents.map((i) => i.id)).toContain(id);
    expect(JSON.stringify(list)).not.toContain(joinKey);
  });

  it('reloads a persisted incident with its key still valid', () => {
    const first = mount();
    const { id, joinKey } = create();
    call(h, 'POST /api/incident/:id/sync', {
      params: { id },
      body: { key: joinKey, events: [{ id: 'e1', type: 'incident_note', summary: 'kept' }] },
    });
    first.flushIncidents();
    expect(fs.readFileSync(process.env.INCIDENT_FILE, 'utf8')).not.toContain(joinKey); // only the salted hash
    mount(); // simulated restart
    const got = call(h, 'GET /api/incident/:id', { params: { id }, query: { key: joinKey } });
    expect(got.res.code).toBe(200);
    expect(got.res.body.events.map((e) => e.id)).toEqual(['e1']);
  });

  describe('hosted', () => {
    beforeEach(() => {
      process.env.OHC_HOSTED = '1';
      try {
        fs.unlinkSync(process.env.INCIDENT_FILE);
      } catch {}
      mount();
    });

    it('answers an unknown id and a wrong key identically and disables listing', () => {
      const { id, joinKey } = create();
      const wrongKey = call(h, 'POST /api/incident/:id/join', { params: { id }, body: { key: 'X' } }).res;
      const unknownId = call(h, 'POST /api/incident/:id/join', {
        params: { id: 'ABCDEFGH' },
        body: { key: joinKey },
      }).res;
      expect(wrongKey.code).toBe(403);
      expect(unknownId.code).toBe(403);
      expect(unknownId.body).toEqual(wrongKey.body);
      expect(call(h, 'GET /api/incident/list').res.code).toBe(403);
      expect(call(h, 'GET /api/incident').res.body).toMatchObject({ hosted: true, listing: false });
    });

    it('caps incident creation per address', () => {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push(call(h, 'POST /api/incident', { body: {}, ip: '9.9.9.9' }).res.code);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    });
  });
});
