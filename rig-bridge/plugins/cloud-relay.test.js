/**
 * Cloud relay — NBEMS over the relay: fldigi status / receive text / forms go
 * up as `pluginEvents`, and 'fldigi' commands run against the local plugin
 * routes with the browser's own API token, answering with a result event.
 * Real loopback HTTP servers stand in for the hosted OHC and the local bridge.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import EventEmitter from 'events';
import http from 'http';
import relay from './cloud-relay.js';

const servers = [];
const listen = (handler) =>
  new Promise((resolve) => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    s.close();
  }
});

const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });

async function setup({ relayFldigi } = {}) {
  const pushes = [];
  const hostedPort = await listen(async (req, res) => {
    if (req.url.startsWith('/api/rig-bridge/relay/state')) {
      pushes.push(JSON.parse(await readBody(req)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.url.startsWith('/api/rig-bridge/relay/commands')) return; // hold the long-poll open
    res.writeHead(200);
    res.end('{}');
  });
  const local = [];
  const bridgePort = await listen(async (req, res) => {
    const body = await readBody(req);
    local.push({ url: req.url, token: req.headers['x-rigbridge-token'], body: JSON.parse(body || '{}') });
    if (req.headers['x-rigbridge-token'] !== 'browser-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"Unauthorized"}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"success":true,"id":7,"queued":1}');
  });
  const bus = new EventEmitter();
  const config = {
    port: bridgePort,
    apiToken: 'relay-side-token',
    cloudRelay: { url: `http://127.0.0.1:${hostedPort}`, apiKey: 'k', session: 's1', pushInterval: 60000, relayFldigi },
  };
  const inst = relay.create(config, { state: {}, pluginBus: bus });
  inst.connect();
  return { inst, bus, pushes, local };
}

describe('cloud relay — fldigi', () => {
  it('pushes fldigi status, accumulated RX text and forms as plugin events', async () => {
    const { inst, bus, pushes } = await setup();
    bus.emit('fldigi', { connected: true, mode: 'BPSK31' });
    bus.emit('fldigi', { connected: true, mode: 'MT63-2KL' }); // only the latest status is sent
    bus.emit('fldigi-rx', { text: 'CQ ' });
    bus.emit('fldigi-rx', { text: 'de N8TAG' });
    bus.emit('nbems-form', { id: 'f1', formType: 'ICS-213 (NBEMS)', fields: { mg: 'big' } });
    await vi.waitFor(() => expect(pushes.length).toBeGreaterThan(0), { timeout: 3000 });
    const ev = pushes.flatMap((p) => p.pluginEvents || []);
    expect(ev).toEqual([
      { event: 'fldigi', source: 'fldigi', data: { connected: true, mode: 'MT63-2KL' } },
      { event: 'fldigi-rx', source: 'fldigi', data: { text: 'CQ de N8TAG', reset: false } },
      { event: 'nbems-form', source: 'fldigi', data: { id: 'f1', formType: 'ICS-213 (NBEMS)' } },
    ]);
    inst.disconnect();
  });

  it('runs a relayed send with the browser’s token and reports the result', async () => {
    const { inst, bus, local } = await setup();
    const results = [];
    bus.on('fldigi-cmd-result', (r) => results.push(r));
    inst._executeCommand({
      type: 'fldigi',
      payload: { action: 'send', body: { text: 'QST' }, token: 'browser-token', requestId: 'r-1' },
    });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(local[0]).toEqual({ url: '/api/fldigi/send', token: 'browser-token', body: { text: 'QST' } });
    expect(results[0]).toMatchObject({ requestId: 'r-1', ok: true, status: 200, id: 7 });
    inst.disconnect();
  });

  it('never substitutes the relay’s own token: a missing or wrong token is refused locally', async () => {
    const { inst, bus, local } = await setup();
    const results = [];
    bus.on('fldigi-cmd-result', (r) => results.push(r));
    inst._executeCommand({ type: 'fldigi', payload: { action: 'abort', requestId: 'r-2' } });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(local[0].token).toBe('');
    expect(results[0]).toMatchObject({ requestId: 'r-2', ok: false, status: 401, error: 'Unauthorized' });
    inst.disconnect();
  });

  it('rejects unknown actions and honours relayFldigi: false', async () => {
    const a = await setup();
    const r1 = [];
    a.bus.on('fldigi-cmd-result', (r) => r1.push(r));
    a.inst._executeCommand({ type: 'fldigi', payload: { action: '../config', requestId: 'x' } });
    expect(r1[0]).toMatchObject({ ok: false, status: 400 });
    expect(a.local).toHaveLength(0);
    a.inst.disconnect();

    const b = await setup({ relayFldigi: false });
    const r2 = [];
    b.bus.on('fldigi-cmd-result', (r) => r2.push(r));
    b.inst._executeCommand({ type: 'fldigi', payload: { action: 'send', requestId: 'y', token: 'browser-token' } });
    expect(r2[0]).toMatchObject({ ok: false, status: 403 });
    b.bus.emit('fldigi', { connected: true });
    await new Promise((r) => setTimeout(r, 400));
    expect(b.pushes.flatMap((p) => p.pluginEvents || []).filter((e) => e.event === 'fldigi')).toEqual([]);
    b.inst.disconnect();
  });
});
