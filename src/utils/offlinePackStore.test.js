import { describe, it, expect, vi } from 'vitest';
import {
  runPackDownload,
  deletePack,
  listPacks,
  fetchWithPackFallback,
  readApiResponse,
  snapshotRequests,
  MANIFEST_URL,
  dataUrl,
} from './offlinePackStore.js';
import { bboxAroundPoint, countTiles, buildTileUrl, enumerateTiles } from './offlineTiles.js';

const TEMPLATE = 'https://tiles.example/{z}/{y}/{x}';

/** Minimal Cache Storage stand-in keyed by URL string. */
function fakeCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (url) => (m.has(String(url)) ? m.get(String(url)).clone() : undefined),
      put: async (url, res) => {
        m.set(String(url), res);
      },
      delete: async (url) => m.delete(String(url)),
      keys: async () => [...m.keys()].map((url) => ({ url })),
    };
  };
  return { open, stores };
}

const tileResponse = (bytes = 100) =>
  new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes) },
  });

const jsonRes = (obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });

/** fetch stub: tiles → 100-byte JPEG; API → small JSON payloads. */
function fakeFetch({ missing = new Set() } = {}) {
  return vi.fn(async (url) => {
    if (url.startsWith('https://tiles.example/')) {
      if (missing.has(url)) return new Response('nope', { status: 404, headers: { 'Content-Type': 'text/html' } });
      return tileResponse(100);
    }
    if (url.startsWith('/api/emcomm/alerts')) return jsonRes([{ id: 'a1' }]);
    if (url.startsWith('/api/emcomm/shelters')) return jsonRes([{ id: 's1' }, { id: 's2' }]);
    if (url.startsWith('/api/repeaters')) return jsonRes({ repeaters: [{ callsign: 'W0X', lat: 40, lon: -105 }] });
    return new Response('?', { status: 404 });
  });
}

const area = bboxAroundPoint(40.015, -105.27, 10);
const baseOpts = (over = {}) => ({
  name: 'Test',
  styleId: 'usgsTopo',
  styleName: 'USGS Topo',
  urlTemplate: TEMPLATE,
  subdomains: 'abc',
  bbox: area,
  minZoom: 8,
  maxZoom: 10,
  center: { lat: 40.015, lon: -105.27 },
  delayMs: 0,
  concurrency: 2,
  ...over,
});

describe('runPackDownload', () => {
  it('fetches every tile, snapshots EmComm data, and saves a manifest', async () => {
    const cachesImpl = fakeCaches();
    const fetchImpl = fakeFetch();
    const progress = [];
    const m = await runPackDownload(baseOpts({ cachesImpl, fetchImpl, onProgress: (p) => progress.push(p) }));
    const total = countTiles(area, 8, 10);
    expect(m.tileCount).toBe(total);
    expect(m.bytes).toBe(total * 100);
    expect(m.data.alerts).toMatchObject({ count: 1 });
    expect(m.data.shelters).toMatchObject({ count: 2 });
    expect(m.data.repeaters).toMatchObject({ count: 1 });
    expect(progress[progress.length - 1]).toMatchObject({ done: total, total });
    const store = cachesImpl.stores.get('ohc-offline-packs');
    expect(store.has(MANIFEST_URL)).toBe(true);
    expect(store.has(dataUrl(m.id, 'alerts'))).toBe(true);
    for (const t of enumerateTiles(area, 8, 10)) expect(store.has(buildTileUrl(TEMPLATE, t))).toBe(true);
    const listed = await listPacks({ cachesImpl });
    expect(listed.map((p) => p.id)).toEqual([m.id]);
    // Tile requests are CORS without credentials (needed for <img crossorigin>)
    const tileCall = fetchImpl.mock.calls.find(([u]) => u.startsWith('https://tiles.example/'));
    expect(tileCall[1]).toMatchObject({ mode: 'cors', credentials: 'omit' });
  });

  it('does not refetch tiles an earlier pack already holds', async () => {
    const cachesImpl = fakeCaches();
    await runPackDownload(baseOpts({ cachesImpl, fetchImpl: fakeFetch(), maxZoom: 9 }));
    const fetchImpl = fakeFetch();
    const m = await runPackDownload(baseOpts({ cachesImpl, fetchImpl }));
    const tileFetches = fetchImpl.mock.calls.filter(([u]) => u.startsWith('https://tiles.example/')).length;
    expect(tileFetches).toBe(countTiles(area, 10, 10));
    expect(m.bytes).toBe(countTiles(area, 8, 10) * 100); // shared tiles still count toward this pack
  });

  it('counts missing tiles as failed without caching error pages', async () => {
    const cachesImpl = fakeCaches();
    const first = buildTileUrl(TEMPLATE, enumerateTiles(area, 8, 8).next().value);
    const m = await runPackDownload(baseOpts({ cachesImpl, fetchImpl: fakeFetch({ missing: new Set([first]) }) }));
    expect(m.failedCount).toBe(1);
    expect(cachesImpl.stores.get('ohc-offline-packs').has(first)).toBe(false);
  });

  it('cancel rolls back the tiles it fetched and saves nothing', async () => {
    const cachesImpl = fakeCaches();
    const controller = new AbortController();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      if (++n === 3) controller.abort();
      return tileResponse(100);
    });
    const result = await runPackDownload(baseOpts({ cachesImpl, fetchImpl, signal: controller.signal }));
    expect(result).toBeNull();
    const store = cachesImpl.stores.get('ohc-offline-packs');
    expect([...store.keys()].filter((k) => k.startsWith('https://tiles.example/'))).toEqual([]);
    expect(store.has(MANIFEST_URL)).toBe(false);
  });
});

describe('deletePack', () => {
  it('keeps tiles another pack still covers, drops the rest', async () => {
    const cachesImpl = fakeCaches();
    const small = await runPackDownload(baseOpts({ cachesImpl, fetchImpl: fakeFetch(), maxZoom: 9, name: 'small' }));
    const big = await runPackDownload(baseOpts({ cachesImpl, fetchImpl: fakeFetch(), name: 'big' }));
    await deletePack(big.id, { cachesImpl });
    const store = cachesImpl.stores.get('ohc-offline-packs');
    for (const t of enumerateTiles(area, 8, 9)) expect(store.has(buildTileUrl(TEMPLATE, t))).toBe(true);
    for (const t of enumerateTiles(area, 10, 10)) expect(store.has(buildTileUrl(TEMPLATE, t))).toBe(false);
    expect(store.has(dataUrl(big.id, 'alerts'))).toBe(false);
    expect((await listPacks({ cachesImpl })).map((p) => p.id)).toEqual([small.id]);

    await deletePack(small.id, { cachesImpl });
    expect([...store.keys()]).toEqual([MANIFEST_URL]);
  });
});

describe('API fallback helpers', () => {
  it('readApiResponse flags worker-cached copies with their Date', async () => {
    const live = await readApiResponse(jsonRes([1]));
    expect(live).toEqual({ ok: true, data: [1], staleAt: null });
    const date = 'Thu, 15 Oct 2026 14:32:00 GMT';
    const stale = await readApiResponse(jsonRes([2], { 'X-OHC-Stale': '1', Date: date }));
    expect(stale).toEqual({ ok: true, data: [2], staleAt: Date.parse(date) });
    expect(await readApiResponse(new Response('{}', { status: 503 }))).toEqual({ ok: false });
    expect(await readApiResponse(null)).toEqual({ ok: false });
  });

  it('fetchWithPackFallback returns live data, null during backoff, and none when offline with nothing stored', async () => {
    const loc = { kind: 'alerts', lat: 1, lon: 2 };
    expect(await fetchWithPackFallback(async () => jsonRes([1]), '/x', {}, loc)).toEqual({ source: 'live', data: [1] });
    expect(await fetchWithPackFallback(async () => null, '/x', {}, loc)).toBeNull();
    const offline = await fetchWithPackFallback(
      async () => {
        throw new TypeError('Failed to fetch');
      },
      '/x',
      {},
      loc,
    );
    expect(offline).toEqual({ source: 'none' });
    const stale = await fetchWithPackFallback(
      async () => jsonRes([3], { 'X-OHC-Stale': '1', Date: 'Thu, 15 Oct 2026 14:32:00 GMT' }),
      '/x',
      {},
      loc,
    );
    expect(stale).toMatchObject({ source: 'cache', data: [3] });
  });

  it('snapshots the same URLs the EmComm panels request', () => {
    const r = snapshotRequests(40.015, -105.27);
    expect(r.alerts).toBe('/api/emcomm/alerts?lat=40.015&lon=-105.27');
    expect(r.shelters).toBe('/api/emcomm/shelters?lat=40.015&lon=-105.27&radius=200');
    expect(r.repeaters).toMatch(/^\/api\/repeaters\?lat=40.015&lon=-105.27&radius=200/);
  });
});
