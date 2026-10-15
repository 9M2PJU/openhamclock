/**
 * Runs the real public/sw.js in a stub worker scope to check the offline
 * area pack tile route and the stale marker on API fallbacks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '../../public/sw-policy.js';

const SW_SOURCE = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');
const TILE = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/9/193/106';
const ORIGIN = 'https://openhamclock.com';

function loadWorker({ fetchImpl, packTiles = {}, apiCache = {}, onLine = true }) {
  const listeners = {};
  const posted = [];
  const stores = {
    'ohc-offline-packs': new Map(Object.entries(packTiles)),
  };
  const caches = {
    open: async (name) => {
      if (!stores[name]) stores[name] = new Map(name.endsWith('-api') ? Object.entries(apiCache) : []);
      const m = stores[name];
      return {
        match: async (key) => {
          const k = typeof key === 'string' ? key : key.url;
          return m.has(k) ? m.get(k).clone() : undefined;
        },
        put: async (key, res) => m.set(typeof key === 'string' ? key : key.url, res),
        add: async (url) => m.set(url, await fetchImpl(url)),
        keys: async () => [...m.keys()],
        delete: async (k) => m.delete(k),
      };
    },
    match: async () => undefined,
    keys: async () => Object.keys(stores),
  };
  const client = { postMessage: (msg) => posted.push(msg) };
  const self = {
    location: { href: `${ORIGIN}/sw.js?v=test`, origin: ORIGIN },
    navigator: { onLine },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    clients: { get: async () => client, matchAll: async () => [client], claim: async () => {} },
    registration: {},
    OHC_SW_POLICY: globalThis.OHC_SW_POLICY,
  };
  const run = new Function('self', 'importScripts', 'caches', 'fetch', SW_SOURCE);
  run(self, () => {}, caches, fetchImpl);

  const dispatchFetch = async (request) => {
    let responded = null;
    const waits = [];
    const event = {
      request: { method: 'GET', mode: 'cors', ...request },
      clientId: 'c1',
      respondWith: (p) => {
        responded = p;
      },
      waitUntil: (p) => waits.push(p),
    };
    listeners.fetch(event);
    const res = responded ? await responded : undefined;
    await Promise.all(waits);
    return res;
  };
  const dispatchInstall = async () => {
    const waits = [];
    listeners.install({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { dispatchFetch, dispatchInstall, posted, stores };
}

const img = (body = 'pack') => new Response(body, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });

describe('service worker: offline pack tiles', () => {
  beforeEach(() => vi.useRealTimers());

  it('goes to the network when no pack holds the tile', async () => {
    const fetchImpl = vi.fn(async () => img('net'));
    const { dispatchFetch, posted } = loadWorker({ fetchImpl });
    const res = await dispatchFetch({ url: TILE });
    expect(await res.text()).toBe('net');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([]);
  });

  it('prefers the network when it works, even with a pack copy', async () => {
    const fetchImpl = vi.fn(async () => img('net'));
    const { dispatchFetch, posted } = loadWorker({ fetchImpl, packTiles: { [TILE]: img('pack') } });
    expect(await (await dispatchFetch({ url: TILE })).text()).toBe('net');
    expect(posted).toEqual([]);
  });

  it('serves the pack copy when the network fails and tells the page', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { dispatchFetch, posted } = loadWorker({ fetchImpl, packTiles: { [TILE]: img('pack') } });
    expect(await (await dispatchFetch({ url: TILE })).text()).toBe('pack');
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('OHC_OFFLINE_PACK_TILE');
  });

  it('serves the pack copy without touching the network when the browser is offline', async () => {
    const fetchImpl = vi.fn();
    const { dispatchFetch } = loadWorker({ fetchImpl, onLine: false, packTiles: { [TILE]: img('pack') } });
    expect(await (await dispatchFetch({ url: TILE })).text()).toBe('pack');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to the pack copy on an error status', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 502 }));
    const { dispatchFetch } = loadWorker({ fetchImpl, packTiles: { [TILE]: img('pack') } });
    expect(await (await dispatchFetch({ url: TILE })).text()).toBe('pack');
  });

  it('leaves other cross-origin tile servers alone', async () => {
    const fetchImpl = vi.fn();
    const { dispatchFetch } = loadWorker({ fetchImpl });
    const res = await dispatchFetch({ url: 'https://tile.openstreetmap.org/1/0/0.png' });
    expect(res).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('service worker: API fallback is marked stale', () => {
  it('adds X-OHC-Stale and keeps the original Date', async () => {
    const url = `${ORIGIN}/api/emcomm/alerts?lat=1&lon=2`;
    const cached = new Response('[1]', {
      status: 200,
      headers: { 'Content-Type': 'application/json', Date: 'Thu, 15 Oct 2026 14:32:00 GMT' },
    });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { dispatchFetch } = loadWorker({ fetchImpl, apiCache: { [url]: cached } });
    const res = await dispatchFetch({ url, mode: 'same-origin' });
    expect(res.headers.get('x-ohc-stale')).toBe('1');
    expect(res.headers.get('date')).toBe('Thu, 15 Oct 2026 14:32:00 GMT');
    expect(await res.json()).toEqual([1]);
  });
});

describe('service worker: install precache', () => {
  it('precaches the self-hosted Leaflet and fonts along with the bundles', async () => {
    const html =
      '<link rel="stylesheet" href="/vendor/leaflet/leaflet.css" /><script src="/vendor/leaflet/leaflet.js"></script>' +
      '<script type="module" src="/assets/index-abc.js"></script>';
    const fetchImpl = vi.fn(async (url) =>
      url === '/index.html' ? new Response(html, { headers: { 'Content-Type': 'text/html' } }) : new Response('x'),
    );
    const { dispatchInstall, stores } = loadWorker({ fetchImpl });
    await dispatchInstall();
    const app = stores['ohc-test-app'];
    expect([...app.keys()].sort()).toEqual([
      '/assets/index-abc.js',
      '/index.html',
      '/vendor/leaflet/leaflet.css',
      '/vendor/leaflet/leaflet.js',
    ]);
  });
});
