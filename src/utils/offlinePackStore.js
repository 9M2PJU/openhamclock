/**
 * Offline area packs — storage and download engine (browser side).
 *
 * Everything lives in one Cache Storage cache, OFFLINE_PACK_CACHE
 * ('ohc-offline-packs', defined in public/sw-policy.js and kept across
 * deploys and the ?nosw sweep):
 *   - tile responses, keyed by the exact URL Leaflet requests, so the
 *     service worker can answer the map's own requests from the pack
 *   - the manifest list at MANIFEST_URL
 *   - per-pack EmComm data snapshots at dataUrl(packId, kind)
 *
 * The download runs in the page (not the worker) through a module-level
 * manager, so it keeps going when Settings closes and every view of the
 * control (Settings, EmComm rail) shows the same progress. It is polite on
 * purpose: a few requests at a time with a pause between them, tiles a
 * previous pack already holds are not fetched again, and a server that
 * starts refusing (429/503) gets a long pause, then the download stops.
 * Browsers do not let pages set User-Agent, so pacing is the courtesy we
 * can offer.
 *
 * Pure math and manifest logic are in offlineTiles.js and
 * offlinePackManifest.js; this file is the thin I/O layer around them.
 */
import { OFFLINE_PACK_CACHE } from './swPolicy.js';
import { enumerateTiles, countTiles, buildTileUrl } from './offlineTiles.js';
import {
  createPackManifest,
  parseManifestList,
  upsertPack,
  removePackById,
  pickPackForLocation,
  tileSharedWithOtherPacks,
  chooseOfflineSource,
  SNAPSHOT_REPEATER_RADIUS_KM,
  DEFAULT_BUDGET_MB,
  BUDGET_OPTIONS_MB,
} from './offlinePackManifest.js';

export const MANIFEST_URL = '/__ohc-offline-packs/manifest.json';
export const dataUrl = (packId, kind) => `/__ohc-offline-packs/${encodeURIComponent(packId)}/${kind}.json`;

/** Fired on window whenever the pack list changes (download, delete). */
export const PACKS_CHANGED_EVENT = 'ohc:offline-packs-changed';

const BUDGET_KEY = 'openhamclock_offlinePackBudgetMB';

export const DOWNLOAD_CONCURRENCY = 3;
export const DOWNLOAD_DELAY_MS = 120;
const BACKOFF_MS = 10000;
const MAX_CONSECUTIVE_FAILURES = 25;

/** Cache API needs a secure context (https or localhost). */
export function offlinePacksSupported() {
  return typeof window !== 'undefined' && !!window.isSecureContext && typeof caches !== 'undefined';
}

/** True when a service worker controls the page, i.e. packs will be served. */
export function packServingActive() {
  return typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;
}

export function getBudgetMB() {
  try {
    const v = Number(localStorage.getItem(BUDGET_KEY));
    return BUDGET_OPTIONS_MB.includes(v) ? v : DEFAULT_BUDGET_MB;
  } catch {
    return DEFAULT_BUDGET_MB;
  }
}

export function setBudgetMB(mb) {
  try {
    localStorage.setItem(BUDGET_KEY, String(mb));
  } catch {
    /* storage unavailable — default budget applies */
  }
}

const openCache = (cachesImpl = globalThis.caches) => cachesImpl.open(OFFLINE_PACK_CACHE);

const jsonResponse = (obj) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });

function announceChange() {
  try {
    window.dispatchEvent(new CustomEvent(PACKS_CHANGED_EVENT));
  } catch {
    /* non-browser */
  }
}

export async function listPacks({ cachesImpl } = {}) {
  if (!cachesImpl && !offlinePacksSupported()) return [];
  try {
    const cache = await openCache(cachesImpl);
    const res = await cache.match(MANIFEST_URL);
    if (!res) return [];
    return parseManifestList(await res.text());
  } catch {
    return [];
  }
}

async function savePacks(cache, list) {
  await cache.put(MANIFEST_URL, jsonResponse({ packs: list }));
}

/** Origin storage usage/quota and whether storage is persistent. */
export async function storageStatus() {
  const out = { usage: null, quota: null, persisted: null };
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      out.usage = e.usage ?? null;
      out.quota = e.quota ?? null;
    }
    if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted();
  } catch {
    /* unsupported */
  }
  return out;
}

/** Ask the browser not to evict our storage under pressure (best-effort). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* unsupported */
  }
  return false;
}

// ── EmComm data snapshot ───────────────────────────────────────────────────

/** Endpoints snapshotted with a pack — the same ones the EmComm layout and
 *  Repeaters panel poll, so the URLs (and the SW API cache) line up. */
export function snapshotRequests(lat, lon) {
  return {
    alerts: `/api/emcomm/alerts?lat=${lat}&lon=${lon}`,
    shelters: `/api/emcomm/shelters?lat=${lat}&lon=${lon}&radius=200`,
    repeaters: `/api/repeaters?lat=${lat}&lon=${lon}&radius=${SNAPSHOT_REPEATER_RADIUS_KM}&limit=200`,
  };
}

const countOf = (kind, data) =>
  kind === 'repeaters'
    ? Array.isArray(data?.repeaters)
      ? data.repeaters.length
      : 0
    : Array.isArray(data)
      ? data.length
      : 0;

/**
 * Fetch and store the EmComm data for a pack. Returns the manifest `data`
 * summary { kind: { fetchedAt, count } } for the kinds that succeeded.
 * A response the service worker served from its cache (X-OHC-Stale) keeps
 * its original Date as fetchedAt rather than pretending to be fresh.
 */
export async function snapshotPackData(packId, center, { fetchImpl = fetch, cachesImpl } = {}) {
  const summary = {};
  if (!center) return summary;
  const cache = await openCache(cachesImpl);
  const reqs = snapshotRequests(center.lat, center.lon);
  for (const [kind, url] of Object.entries(reqs)) {
    try {
      const res = await fetchImpl(url, { cache: 'no-store' });
      if (!res?.ok) continue;
      const data = await res.json();
      let fetchedAt = Date.now();
      if (res.headers?.get?.('x-ohc-stale')) {
        const d = Date.parse(res.headers.get('date') || '');
        if (Number.isFinite(d)) fetchedAt = d;
      }
      await cache.put(dataUrl(packId, kind), jsonResponse({ fetchedAt, center, data }));
      summary[kind] = { fetchedAt, count: countOf(kind, data) };
    } catch {
      /* this kind stays without a snapshot */
    }
  }
  return summary;
}

/** Re-take a pack's data snapshot (button in the pack list). */
export async function refreshPackData(packId) {
  const cache = await openCache();
  const list = await listPacks();
  const pack = list.find((m) => m.id === packId);
  if (!pack) return null;
  const data = await snapshotPackData(packId, pack.center);
  const updated = { ...pack, data: { ...pack.data, ...data } };
  await savePacks(cache, upsertPack(list, updated));
  announceChange();
  return updated;
}

/**
 * Last-known data of one kind for a location from the newest covering pack:
 * { data, fetchedAt, center, packName } or null.
 */
export async function loadPackSnapshot(lat, lon, kind) {
  if (!offlinePacksSupported() || lat == null || lon == null) return null;
  try {
    const list = await listPacks();
    const pack = pickPackForLocation(list, lat, lon, kind);
    if (!pack) return null;
    const cache = await openCache();
    const res = await cache.match(dataUrl(pack.id, kind));
    if (!res) return null;
    const body = await res.json();
    return { data: body.data, fetchedAt: body.fetchedAt, center: body.center, packName: pack.name };
  } catch {
    return null;
  }
}

/**
 * Interpret a live API response for offline display: returns
 * { ok: true, data, staleAt } where staleAt is the original Date of a
 * service-worker cached copy (null for a live answer), or { ok: false }
 * when the request failed / came back as the worker's offline 503.
 */
export async function readApiResponse(res) {
  if (!res) return { ok: false };
  if (!res.ok) return { ok: false };
  const data = await res.json();
  let staleAt = null;
  if (res.headers?.get?.('x-ohc-stale')) {
    const d = Date.parse(res.headers.get('date') || '');
    staleAt = Number.isFinite(d) ? d : 0;
  }
  return { ok: true, data, staleAt };
}

/**
 * Fetch an EmComm endpoint, falling back to last-known data when offline.
 *
 * Returns null while apiFetch is in a 429 backoff (leave state alone), or
 *   { source: 'live', data }                       — fresh from the server
 *   { source: 'cache' | 'pack', data, fetchedAt }  — last-known copy: the
 *       service worker's cached response or an offline pack snapshot,
 *       whichever is newer
 *   { source: 'none' }                             — failed, nothing stored
 */
export async function fetchWithPackFallback(fetcher, url, init, { kind, lat, lon }) {
  let stale = null;
  try {
    const res = await fetcher(url, init);
    if (res === null) return null;
    const r = await readApiResponse(res);
    if (r.ok && r.staleAt == null) return { source: 'live', data: r.data };
    if (r.ok) stale = { data: r.data, fetchedAt: r.staleAt };
  } catch {
    /* network down — fall through to the offline copies */
  }
  const pack = await loadPackSnapshot(lat, lon, kind);
  const chosen = chooseOfflineSource(stale, pack);
  return chosen || { source: 'none' };
}

// ── Delete ────────────────────────────────────────────────────────────────

/** Delete a pack: its manifest entry, its data snapshot, and every tile no
 *  other pack still needs. */
export async function deletePack(packId, { cachesImpl } = {}) {
  const cache = await openCache(cachesImpl);
  const list = await listPacks({ cachesImpl });
  const pack = list.find((m) => m.id === packId);
  if (!pack) return list;
  const remaining = removePackById(list, packId);
  // Manifest first: if the tab closes mid-delete the pack is already gone
  // from the list; orphaned tiles are harmless and swept on the next delete.
  await savePacks(cache, remaining);
  for (const kind of ['alerts', 'shelters', 'repeaters']) {
    await cache.delete(dataUrl(packId, kind)).catch(() => {});
  }
  for (const tile of enumerateTiles(pack.bbox, pack.minZoom, pack.maxZoom)) {
    if (tileSharedWithOtherPacks(tile, pack, remaining)) continue;
    await cache.delete(buildTileUrl(pack.urlTemplate, tile, { subdomains: pack.subdomains })).catch(() => {});
  }
  // Last pack gone: clear anything an interrupted download or delete left.
  if (remaining.length === 0) await clearAllButManifest(cache);
  announceChange();
  return remaining;
}

async function clearAllButManifest(cache) {
  try {
    const keys = await cache.keys();
    for (const req of keys) {
      if (!req.url.endsWith(MANIFEST_URL)) await cache.delete(req);
    }
  } catch {
    /* best-effort */
  }
}

// ── Download manager ──────────────────────────────────────────────────────

const IDLE = { status: 'idle', done: 0, total: 0, bytes: 0, failed: 0, skipped: 0, name: '', error: null };
let state = IDLE;
let controller = null;
const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch {
      /* listener errors never stop a download */
    }
  });
}

export const getDownloadState = () => state;

export function subscribeDownload(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function cancelPackDownload() {
  if (controller) controller.abort();
}

/** Clear a finished/failed/cancelled status back to idle. */
export function resetDownloadState() {
  if (state.status !== 'running') setState(IDLE);
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

const sizeOf = async (res) => {
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > 0) return len;
  try {
    return (await res.blob()).size;
  } catch {
    return 0;
  }
};

/**
 * Download every tile of an area into the pack cache, then snapshot the
 * EmComm data and save the manifest. Resolves to the manifest, or null when
 * cancelled (tiles fetched for a cancelled pack are removed again unless
 * another pack uses them). Dependencies are injectable for tests.
 *
 * @param {object} o
 *   name, styleId, styleName, urlTemplate, subdomains, lang, retina,
 *   bbox, minZoom, maxZoom, center, radiusKm, dataCenter
 *   onProgress({ done, total, bytes, failed, skipped })
 *   signal (AbortSignal), fetchImpl, cachesImpl, concurrency, delayMs
 */
export async function runPackDownload(o) {
  const {
    fetchImpl = fetch,
    cachesImpl,
    concurrency = DOWNLOAD_CONCURRENCY,
    delayMs = DOWNLOAD_DELAY_MS,
    signal,
    onProgress = () => {},
  } = o;
  const cache = await openCache(cachesImpl);
  const existing = await listPacks({ cachesImpl });
  const total = countTiles(o.bbox, o.minZoom, o.maxZoom);
  const urlOpts = { subdomains: o.subdomains, lang: o.lang, retina: o.retina };
  const iter = enumerateTiles(o.bbox, o.minZoom, o.maxZoom);
  const fetched = [];
  let done = 0;
  let bytes = 0;
  let failed = 0;
  let skipped = 0;
  let consecutiveFailures = 0;
  let fatal = null;

  const report = () => onProgress({ done, total, bytes, failed, skipped });

  const fetchTile = async (url) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchImpl(url, { mode: 'cors', credentials: 'omit', signal });
      if (res.ok && String(res.headers.get('content-type') || '').startsWith('image/')) return res;
      if (res.status === 429 || res.status === 503) {
        await sleep(BACKOFF_MS, signal);
        continue;
      }
      return null; // 404 / non-image: nothing to cache at this tile
    }
    return null;
  };

  const worker = async () => {
    for (;;) {
      if (signal?.aborted || fatal) return;
      const next = iter.next();
      if (next.done) return;
      const url = buildTileUrl(o.urlTemplate, next.value, urlOpts);
      try {
        const have = await cache.match(url);
        if (have) {
          // Read first, then add: `bytes += await …` would read `bytes`
          // before the await and lose other workers' increments.
          const size = await sizeOf(have);
          bytes += size;
          skipped++;
        } else {
          const res = await fetchTile(url);
          if (res) {
            await cache.put(url, res.clone());
            fetched.push({ url, tile: next.value });
            const size = await sizeOf(res);
            bytes += size;
            consecutiveFailures = 0;
          } else {
            failed++;
          }
          await sleep(delayMs, signal);
        }
      } catch (err) {
        if (signal?.aborted) return;
        if (err?.name === 'QuotaExceededError') {
          fatal = 'quota';
          return;
        }
        failed++;
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          fatal = 'network';
          return;
        }
        await sleep(delayMs * 4, signal);
      }
      done++;
      report();
    }
  };

  report();
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  if (signal?.aborted || fatal) {
    // Roll back: drop tiles this run fetched that no saved pack covers.
    const partial = { id: '__partial__', urlTemplate: o.urlTemplate };
    for (const { url, tile } of fetched) {
      if (!tileSharedWithOtherPacks(tile, partial, existing)) await cache.delete(url).catch(() => {});
    }
    if (fatal) {
      const err = new Error(fatal === 'quota' ? 'Storage is full' : 'Tile server not responding');
      err.code = fatal;
      throw err;
    }
    return null;
  }

  const manifest = createPackManifest({
    name: o.name,
    styleId: o.styleId,
    styleName: o.styleName,
    urlTemplate: o.urlTemplate,
    subdomains: o.subdomains,
    bbox: o.bbox,
    minZoom: o.minZoom,
    maxZoom: o.maxZoom,
    center: o.center,
    radiusKm: o.radiusKm,
    tileCount: total - failed,
    failedCount: failed,
    bytes,
  });
  manifest.data = await snapshotPackData(manifest.id, o.dataCenter || manifest.center, { fetchImpl, cachesImpl });
  await savePacks(cache, upsertPack(await listPacks({ cachesImpl }), manifest));
  return manifest;
}

/** Start a download through the shared manager (one at a time). */
export async function startPackDownload(opts) {
  if (state.status === 'running') return null;
  controller = new AbortController();
  setState({ ...IDLE, status: 'running', name: opts.name, total: countTiles(opts.bbox, opts.minZoom, opts.maxZoom) });
  await requestPersistence();
  try {
    const manifest = await runPackDownload({
      ...opts,
      signal: controller.signal,
      onProgress: (p) => setState(p),
    });
    setState({ status: manifest ? 'done' : 'cancelled' });
    announceChange();
    return manifest;
  } catch (err) {
    setState({ status: 'error', error: err?.code || 'error' });
    announceChange();
    return null;
  } finally {
    controller = null;
  }
}
