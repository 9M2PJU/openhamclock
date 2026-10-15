/**
 * Tests for aprsMessageSend — the shared client path to POST /api/aprs/message.
 */
import { describe, it, expect, vi } from 'vitest';
import { sendAprsMessage, sendAprsParts } from './aprsMessageSend.js';

const okRes = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
const errRes = (status, error) => ({ ok: false, status, json: async () => ({ error }) });

describe('sendAprsMessage', () => {
  it('posts the addressee (upper-cased) and text to the server', async () => {
    const fetchImpl = vi.fn(async () => okRes());
    const r = await sendAprsMessage({ to: 'ke8plm-9', message: ' Hello ' }, fetchImpl);
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/aprs/message');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ to: 'KE8PLM-9', message: 'Hello' });
  });

  it('refuses blank or over-length messages without calling the server', async () => {
    const fetchImpl = vi.fn(async () => okRes());
    expect((await sendAprsMessage({ to: '', message: 'x' }, fetchImpl)).ok).toBe(false);
    expect((await sendAprsMessage({ to: 'K0CJH', message: '  ' }, fetchImpl)).ok).toBe(false);
    expect((await sendAprsMessage({ to: 'K0CJH', message: 'x'.repeat(68) }, fetchImpl)).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces the server error (e.g. no TNC) and network failures', async () => {
    const noTnc = vi.fn(async () => errRes(503, 'APRS TNC not available'));
    expect(await sendAprsMessage({ to: 'K0CJH', message: 'hi' }, noTnc)).toEqual({
      ok: false,
      error: 'APRS TNC not available',
    });
    const offline = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    expect(await sendAprsMessage({ to: 'K0CJH', message: 'hi' }, offline)).toEqual({
      ok: false,
      error: 'Failed to fetch',
    });
  });
});

describe('sendAprsParts', () => {
  it('sends every part in order', async () => {
    const fetchImpl = vi.fn(async () => okRes());
    const r = await sendAprsParts('N0EOC', ['1/2 first', '2/2 second'], fetchImpl);
    expect(r).toEqual({ sent: 2, total: 2 });
    expect(fetchImpl.mock.calls.map((c) => JSON.parse(c[1].body).message)).toEqual(['1/2 first', '2/2 second']);
  });

  it('stops at the first failure and reports how many went out', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okRes())
      .mockResolvedValueOnce(errRes(503, 'TNC gone'))
      .mockResolvedValue(okRes());
    const r = await sendAprsParts('N0EOC', ['1/3 a', '2/3 b', '3/3 c'], fetchImpl);
    expect(r).toEqual({ sent: 1, total: 3, error: 'TNC gone' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
