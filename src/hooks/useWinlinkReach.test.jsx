/**
 * useWinlinkReach — Vitest + React 18
 *
 * Engine and network are mocked: predictInWorker returns a canned P.533
 * result, apiFetch serves a small gateway list. Covers ranking, the
 * per-gateway+hour cache (a remount does not re-run the engine), the REST
 * fallback when the WASM engine fails, and the map-layer broadcast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const mocks = vi.hoisted(() => ({ fetch: null, predict: null }));
vi.mock('../utils/apiFetch.js', () => ({
  apiFetch: (...args) => mocks.fetch(...args),
}));
vi.mock('../services/p533/predictInWorker.js', () => ({
  predictInWorker: (...args) => mocks.predict(...args),
}));

import { useWinlinkReach, WINLINK_REACH_EVENT, __resetWinlinkReachForTests } from './useWinlinkReach.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const GATEWAYS = [
  { callsign: 'K0NEAR', gridsquare: 'DM79', frequency: 7101200, mode: 50, serviceCode: 'PUBLIC' },
  { callsign: 'K0NEAR', gridsquare: 'DM79', frequency: 145050000, mode: 0, serviceCode: 'PUBLIC' },
  { callsign: 'W1AW-10', gridsquare: 'FN31', frequency: 14108500, mode: 43, serviceCode: 'PUBLIC' },
  { callsign: 'JA1FAR', gridsquare: 'PM95', frequency: 7101200, mode: 50, serviceCode: 'PUBLIC' },
];

const DE = { lat: 39.75, lon: -104.99 };
const PROP = { mode: 'SSB', power: 100, antenna: 'dipole' };

let root;
let container;
let latest;

function Harness(props) {
  latest = useWinlinkReach(props);
  return null;
}

function mount(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Harness active deLocation={DE} propConfig={PROP} ssn={120} {...props} />);
  });
}

function unmount() {
  act(() => root.unmount());
  container.remove();
}

const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

beforeEach(() => {
  __resetWinlinkReachForTests();
  mocks.fetch = vi.fn(async (url) => {
    if (url === '/api/winlink/gateways') {
      return { ok: true, status: 200, json: async () => ({ gateways: GATEWAYS }) };
    }
    if (url.startsWith('/api/propagation?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'Built-in estimation',
          currentBands: [
            { band: '40m', reliability: 35 },
            { band: '20m', reliability: 70 },
          ],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  // 40 m strong from Denver to anywhere, 20 m weak.
  mocks.predict = vi.fn(async (params) => ({
    frequencies: params.frequencies.map((f) =>
      f < 10 ? { freq: f, snr: 12, reliability: 85 } : { freq: f, snr: -2, reliability: 10 },
    ),
  }));
});

afterEach(() => {
  if (root) unmount();
  root = null;
});

describe('useWinlinkReach', () => {
  it('predicts HF gateways in range and ranks them by status', async () => {
    mount();
    await settle();
    expect(latest.running).toBe(false);
    // JA1FAR is out of the default 3,000 km range; the 2 m port is not predicted.
    expect(mocks.predict).toHaveBeenCalledTimes(2);
    expect(latest.rows.map((r) => r.callsign)).toEqual(['K0NEAR', 'W1AW-10']);
    expect(latest.rows[0]).toMatchObject({ status: 'good', reliability: 85, engine: 'wasm' });
    expect(latest.rows[1].status).toBe('marginal'); // 10 % but within 6 dB of ARDOP's need
    expect(latest.packet.map((p) => p.callsign)).toEqual(['K0NEAR']);
    expect(latest.progress).toEqual({ done: 2, total: 2 });
    expect(latest.engine).toBe('wasm');

    // Station power/antenna reach the engine.
    const params = mocks.predict.mock.calls[0][0];
    expect(params.txPower).toBe(100);
    expect(params.txGain).toBeCloseTo(2.15);
  });

  it('serves a remount from the per-gateway+hour cache', async () => {
    mount();
    await settle();
    expect(mocks.predict).toHaveBeenCalledTimes(2);
    unmount();
    mount();
    await settle();
    expect(mocks.predict).toHaveBeenCalledTimes(2);
    expect(latest.rows[0].status).toBe('good');
  });

  it('recomputes when station settings change', async () => {
    mount();
    await settle();
    act(() => {
      root.render(<Harness active deLocation={DE} propConfig={{ ...PROP, power: 500 }} ssn={120} />);
    });
    await settle();
    expect(mocks.predict).toHaveBeenCalledTimes(4);
  });

  it('falls back to the server estimate when the WASM engine fails', async () => {
    mocks.predict = vi.fn(async () => {
      throw new Error('no wasm');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount();
    await settle();
    warn.mockRestore();
    const restCalls = mocks.fetch.mock.calls.filter(([u]) => u.startsWith('/api/propagation?'));
    expect(restCalls.length).toBe(2);
    expect(latest.engine).toBe('est');
    const w1 = latest.rows.find((r) => r.callsign === 'W1AW-10');
    expect(w1).toMatchObject({ status: 'good', reliability: 70, snrMargin: null });
  });

  it('broadcasts the result for the map layer and withdraws it on unmount', async () => {
    vi.useFakeTimers();
    const seen = [];
    const onReach = (e) => seen.push(e.detail);
    window.addEventListener(WINLINK_REACH_EVENT, onReach);
    try {
      mount();
      await settle();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      const last = seen.filter((d) => d.enabled).at(-1);
      expect(last.byCall['K0NEAR']).toMatchObject({ kind: 'hf', status: 'good' });
      unmount();
      root = null;
      expect(seen.at(-1)).toEqual({ enabled: false });
    } finally {
      window.removeEventListener(WINLINK_REACH_EVENT, onReach);
      vi.useRealTimers();
    }
  });

  it('stays idle when inactive or without a station location', async () => {
    mount({ active: false });
    await settle();
    expect(mocks.fetch).not.toHaveBeenCalled();
    unmount();
    mount({ deLocation: null });
    await settle();
    expect(mocks.predict).not.toHaveBeenCalled();
    expect(latest.hasDe).toBe(false);
  });
});
