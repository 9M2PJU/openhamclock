/**
 * OpenHamClock service worker — offline mode / PWA support.
 *
 * This is a hand-rolled, dependency-free worker. It is a static file copied
 * verbatim by Vite; versioning comes from the registration URL query param:
 *
 *   navigator.serviceWorker.register('/sw.js?v=<version>-<buildstamp>')
 *
 * The app injects <version>-<buildstamp> at build time (see vite.config.mjs
 * `define` + src/pwa/registerServiceWorker.js). A new build produces a new
 * registration URL, which the browser treats as a new worker: it installs in
 * the background, and the app shows an "Update ready — Reload" toast.
 *
 * Strategies (decision logic lives in sw-policy.js, unit-tested via
 * src/utils/swPolicy.js):
 *   - navigations:        network-first, fall back to the cached app shell
 *   - /assets/* + static: cache-first, cache-on-fetch (hashed, immutable)
 *   - GET /api/*:         network-first with cached fallback — online
 *                         behavior is unchanged, offline panels get their
 *                         last-known data (marked X-OHC-Stale: 1 so the UI
 *                         can say "as of"). SSE streams are never touched.
 *   - offline-pack tiles: cross-origin tiles from hosts whose terms allow
 *                         offline area packs — network when it works, the
 *                         operator's downloaded pack when it doesn't.
 *   - everything else:    bypassed (browser default), incl. cross-origin
 *
 * Escape hatch: loading the app with ?nosw unregisters this worker and
 * clears the versioned ohc-* caches (handled in
 * src/pwa/registerServiceWorker.js). Offline area packs are operator data
 * and are kept; delete them from the pack list.
 */
'use strict';

var RAW_VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';

// Same version token on the import keeps the policy file in lockstep with
// this worker across deploys (and past any HTTP cache).
importScripts('./sw-policy.js?v=' + encodeURIComponent(RAW_VERSION));

var POLICY = self.OHC_SW_POLICY;
var VERSION = POLICY.normalizeVersion(RAW_VERSION);
var CACHE = POLICY.cacheNames(VERSION);

/** Fixed cache key for the SPA shell — every navigation serves index.html. */
var SHELL_KEY = '/index.html';

// ── Install: precache the shell and the bundles it references ─────────────
// No build-time precache manifest: we fetch index.html and pull the
// /assets/* URLs out of it, so a single online visit is enough for the app
// to load offline afterwards. Lazily loaded chunks (3D globe, etc.) are
// picked up by the cache-on-fetch asset handler as they are used.
self.addEventListener('install', function (event) {
  event.waitUntil(
    (async function () {
      try {
        var cache = await caches.open(CACHE.app);
        var res = await fetch(SHELL_KEY, { cache: 'no-cache' });
        if (!res.ok) return;
        var html = await res.clone().text();
        await cache.put(SHELL_KEY, res);
        // Hashed bundles plus the self-hosted vendor files (Leaflet, fonts)
        // that index.html loads directly.
        var assetUrls = html.match(/\/(?:assets|vendor)\/[^"'\s>)]+/g) || [];
        var unique = Array.from(new Set(assetUrls));
        await Promise.all(
          unique.map(function (u) {
            return cache.add(u).catch(function () {});
          }),
        );
      } catch (e) {
        // Offline or transient failure during install — the runtime
        // handlers will populate the cache on the next online visit.
      }
    })(),
  );
});

// ── Activate: drop caches from other versions, take control ───────────────
self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      var names = await caches.keys();
      var stale = POLICY.staleCacheNames(names, VERSION);
      await Promise.all(
        stale.map(function (n) {
          return caches.delete(n);
        }),
      );
      await self.clients.claim();
    })(),
  );
});

// ── Messages: the update toast asks the waiting worker to take over ───────
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Fetch routing ─────────────────────────────────────────────────────────
self.addEventListener('fetch', function (event) {
  var req = event.request;
  var decision = POLICY.classifyRequest({
    url: req.url,
    method: req.method,
    mode: req.mode,
    origin: self.location.origin,
  });

  if (decision === 'navigation') {
    event.respondWith(handleNavigation(req));
  } else if (decision === 'asset') {
    event.respondWith(handleAsset(req));
  } else if (decision === 'api') {
    event.respondWith(handleApi(event, req));
  } else if (decision === 'tile') {
    event.respondWith(handleTile(event, req));
  }
  // 'bypass' → no respondWith: streaming (SSE), non-GET, cross-origin, and
  // anything unrecognized goes straight to the network untouched.
});

/** Navigations: network-first so online users always get the newest HTML
 *  (which references the newest hashed bundles); cached shell offline. */
async function handleNavigation(req) {
  try {
    var res = await fetch(req);
    if (res.ok) {
      var cache = await caches.open(CACHE.app);
      cache.put(SHELL_KEY, res.clone());
    }
    return res;
  } catch (e) {
    var cached = await caches.match(SHELL_KEY);
    if (cached) return cached;
    throw e;
  }
}

/** Static assets: cache-first (hashed filenames are immutable), cached on
 *  first fetch — no precache manifest needed. */
async function handleAsset(req) {
  var cached = await caches.match(req);
  if (cached) return cached;
  var res = await fetch(req);
  if (res.ok && res.status === 200 && res.type === 'basic') {
    var cache = await caches.open(CACHE.app);
    cache.put(req, res.clone());
  }
  return res;
}

/** GET /api/*: network-first with cached fallback. Online requests always
 *  hit the server (behavior unchanged); each good response refreshes the
 *  cache so offline panels show last-known data instead of hard errors. */
async function handleApi(event, req) {
  var cache = await caches.open(CACHE.api);
  try {
    var res = await fetch(req);
    if (
      POLICY.isCacheableApiResponse({
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
      })
    ) {
      await cache.put(req, res.clone());
      event.waitUntil(pruneApiCache(cache));
    }
    return res;
  } catch (e) {
    var cached = await cache.match(req);
    if (cached) return markStale(cached);
    return new Response(JSON.stringify({ error: 'offline', offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/** Re-wrap a cached API response with X-OHC-Stale: 1 so panels can show
 *  an "as of" time (the original Date header is kept). */
function markStale(cached) {
  try {
    var headers = new Headers(cached.headers);
    headers.set('X-OHC-Stale', '1');
    return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers: headers });
  } catch (e) {
    return cached;
  }
}

/** Offline area pack tiles. Online: the network answers, exactly as before
 *  the worker existed. When the network fails, the browser reports offline,
 *  or a request hangs past PACK_TILE_NETWORK_TIMEOUT_MS while a pack holds
 *  the tile, the pack copy is served and the page is told (for the subtle
 *  "offline tiles" badge on the map). Tiles are never written here —
 *  only the explicit "Download area" action fills the pack cache. */
async function handleTile(event, req) {
  var cached = null;
  try {
    var cache = await caches.open(POLICY.OFFLINE_PACK_CACHE);
    cached = await cache.match(req.url, { ignoreVary: true });
  } catch (e) {
    cached = null;
  }
  if (!cached) return fetch(req);

  if (self.navigator && self.navigator.onLine === false) {
    notifyPackTile(event);
    return cached;
  }

  var timer;
  var timeout = new Promise(function (resolve) {
    timer = setTimeout(function () {
      resolve(null);
    }, POLICY.PACK_TILE_NETWORK_TIMEOUT_MS);
  });
  try {
    var res = await Promise.race([fetch(req), timeout]);
    clearTimeout(timer);
    if (res && res.ok) return res;
  } catch (e) {
    clearTimeout(timer);
  }
  notifyPackTile(event);
  return cached;
}

/** Tell the page that tiles are coming from an offline pack — at most once
 *  every few seconds per client, not once per tile. */
var lastPackNotice = {};
function notifyPackTile(event) {
  var id = event.clientId || event.resultingClientId || '';
  var now = Date.now();
  if (lastPackNotice[id] && now - lastPackNotice[id] < 3000) return;
  lastPackNotice[id] = now;
  event.waitUntil(
    (async function () {
      try {
        var targets = id ? [await self.clients.get(id)] : await self.clients.matchAll({ type: 'window' });
        targets.forEach(function (c) {
          if (c) c.postMessage({ type: 'OHC_OFFLINE_PACK_TILE', at: now });
        });
      } catch (e) {
        // Best-effort UI hint.
      }
    })(),
  );
}

// ── Web Push: server-sent notifications (closed-browser alerts) ───────────
// The server (server/routes/push.js) sends a JSON payload:
//   { title, body, tag }
// Parsing is defensive — a malformed or empty payload still shows a generic
// notification, because Chrome punishes push events that show nothing.
self.addEventListener('push', function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    try {
      payload = { body: event.data.text() };
    } catch (e2) {
      payload = {};
    }
  }
  if (!payload || typeof payload !== 'object') payload = {};
  var title = typeof payload.title === 'string' && payload.title ? payload.title : 'OpenHamClock';
  var options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    tag: typeof payload.tag === 'string' && payload.tag ? payload.tag : 'ohc-push',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking the notification focuses an existing OpenHamClock tab/window if
// one is open, otherwise opens a fresh one.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    (async function () {
      var clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (var i = 0; i < clientList.length; i++) {
        if ('focus' in clientList[i]) {
          try {
            await clientList[i].focus();
            return;
          } catch (e) {
            // Fall through to the next client / openWindow.
          }
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow('/');
    })(),
  );
});

/** Keep the API cache bounded (oldest-first, cap in sw-policy.js). */
async function pruneApiCache(cache) {
  try {
    var keys = await cache.keys();
    var doomed = POLICY.keysToPrune(keys);
    await Promise.all(
      doomed.map(function (k) {
        return cache.delete(k);
      }),
    );
  } catch (e) {
    // Pruning is best-effort.
  }
}
