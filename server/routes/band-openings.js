/**
 * Band-opening detection routes.
 *
 * GET /api/band-openings — per (band × continent-pair) activity surges,
 * computed from the spot streams the server already holds in memory.
 * A second tracker keys the same spots by (band × DX-continent → spotter
 * CQ zone) and is served as `zone_openings` (#1191): a continent is too
 * coarse for the operator — "EU → NA open" is true for the East Coast and
 * useless on the West Coast. Clients pick the zone list for their own zone.
 *
 *   • RBN telnet stream  — ctx.rbnSpotsByDX (exported by routes/rbn.js;
 *     fills autonomously, ~30 min retention)
 *   • DX cluster paths   — ctx.dxSpotPathsCacheByKey (exported by
 *     routes/dxcluster.js; populated while clients poll /api/dxpaths,
 *     ~1 h accumulator)
 *
 * Both caches are read-only here — this module never mutates them. A 60 s
 * background sampler ingests snapshots into the analysis tracker (which
 * dedupes on stable spot ids), so short-retention caches still build up the
 * 3 h baseline. Analysis itself is pure: server/utils/bandOpenings.js.
 *
 * Continents come from the synchronous cty.dat lookup with a coarse
 * prefix-table fallback (server/utils/continent.js) — never the async,
 * quota-bound QRZ/HamQTH chain.
 */

const { createBandOpeningTracker } = require('../utils/bandOpenings');
const { continentForCall, zoneForCall } = require('../utils/continent');
const { getBandFromHz } = require('../utils/grid');

let ctyLookupCall = null;
try {
  ({ lookupCall: ctyLookupCall } = require('../../src/server/ctydat.js'));
} catch {
  /* cty module unavailable — coarse prefix fallback still works */
}

const SAMPLE_INTERVAL_MS = 60 * 1000; // ingest + recompute cadence (and response cache TTL)
const BASELINE_WINDOW_MS = 3 * 60 * 60 * 1000;
const CONTINENT_CACHE_MAX = 20000;

module.exports = function (app, ctx) {
  const { logDebug, logErrorOnce } = ctx;

  const tracker = createBandOpeningTracker();
  // Zone-level twin. The tracker treats its "continent" fields as opaque
  // region labels, so the spotter side is fed as `Z<zone>` and mapped back
  // to a numeric `to_zone` in the payload. Same thresholds as the continent
  // tracker for now — per-zone volume is lower, so this is the conservative
  // choice until real data says the floor can come down.
  const zoneTracker = createBandOpeningTracker();
  const startedAt = Date.now();

  // Region lookups are cheap but not free (longest-prefix scans); the same
  // calls repeat constantly in spot traffic, so memoize.
  const regionCache = new Map(); // call → { cont, zone }
  function regionFor(call) {
    if (!call) return { cont: null, zone: null };
    const upper = String(call).toUpperCase();
    const hit = regionCache.get(upper);
    if (hit) return hit;
    const region = { cont: continentForCall(upper, ctyLookupCall), zone: zoneForCall(upper, ctyLookupCall) };
    if (regionCache.size >= CONTINENT_CACHE_MAX) {
      const oldest = regionCache.keys().next().value;
      if (oldest !== undefined) regionCache.delete(oldest);
    }
    regionCache.set(upper, region);
    return region;
  }
  const contFor = (call) => regionFor(call).cont;
  const zoneLabel = (call) => {
    const z = regionFor(call).zone;
    return z == null ? null : `Z${z}`;
  };

  // Snapshot the in-memory spot stores into the tracker's spot shape.
  // fromContinent = DX (transmitting) station, toContinent = spotter/skimmer.
  // Returns both shapes: `spots` keyed to the spotter's continent and
  // `zoneSpots` keyed to the spotter's CQ zone (skipped when unknown).
  function collectSpots() {
    const out = [];
    const zoneOut = [];
    const push = (id, call, band, dxCall, spotterCall, timestamp) => {
      const fromContinent = contFor(dxCall);
      out.push({ id, call, band, fromContinent, toContinent: contFor(spotterCall), timestamp });
      const toZone = zoneLabel(spotterCall);
      if (toZone) zoneOut.push({ id, call, band, fromContinent, toContinent: toZone, timestamp });
    };

    // RBN telnet stream — Map<dxCall, spot[]>
    const rbnMap = ctx.rbnSpotsByDX;
    if (rbnMap instanceof Map) {
      for (const [dxCall, spots] of rbnMap) {
        if (!Array.isArray(spots)) continue;
        for (const s of spots) {
          push(
            `rbn|${s.callsign}|${dxCall}|${s.frequency}|${s.timestampMs}`,
            dxCall,
            s.band,
            dxCall,
            s.callsign,
            s.timestampMs,
          );
        }
      }
    }

    // DX cluster path accumulator — Map<cacheKey, { allPaths, paths }>
    const pathsByKey = ctx.dxSpotPathsCacheByKey;
    if (pathsByKey instanceof Map) {
      for (const cache of pathsByKey.values()) {
        const paths = cache?.allPaths || cache?.paths;
        if (!Array.isArray(paths)) continue;
        for (const p of paths) {
          const freqMHz = parseFloat(p.freq);
          if (!Number.isFinite(freqMHz) || freqMHz <= 0) continue;
          push(
            `dxc|${p.id || `${p.dxCall}|${p.spotter}|${p.freq}|${p.timestamp}`}`,
            p.dxCall,
            getBandFromHz(freqMHz * 1e6),
            p.dxCall,
            p.spotter,
            p.timestamp,
          );
        }
      }
    }

    return { spots: out, zoneSpots: zoneOut };
  }

  // Zone tracker results carry the spotter side as the opaque `Z<n>` label;
  // present it as a numeric `to_zone`.
  function toZonePayload(entry) {
    const { to_continent, ...rest } = entry;
    return { ...rest, to_zone: Number(String(to_continent).slice(1)) };
  }

  let cachedPayload = null;
  let lastComputedAt = 0;

  function recompute(now = Date.now()) {
    try {
      const { spots, zoneSpots } = collectSpots();
      const accepted = tracker.ingest(spots, now);
      zoneTracker.ingest(zoneSpots, now);
      const openings = tracker.analyze(now);
      const zoneOpenings = zoneTracker.analyze(now).map(toZonePayload);
      const uptimeMs = now - startedAt;
      // Warming until we either have 3 h of uptime or the observed spot
      // history already spans the full baseline window (cluster paths can
      // carry timestamps older than the process).
      const warming = uptimeMs < BASELINE_WINDOW_MS && !tracker.hasFullBaseline(now);
      const s = tracker.stats();
      const zs = zoneTracker.stats();
      cachedPayload = {
        generated_at: new Date(now).toISOString(),
        warming,
        baseline_coverage_seconds: Math.round(tracker.dataSpanMs(now) / 1000),
        tracked: { pairs: s.keys, spots: s.spots, zone_pairs: zs.keys, zone_spots: zs.spots },
        openings,
        zone_openings: zoneOpenings,
      };
      lastComputedAt = now;
      if (accepted > 0 || openings.length > 0 || zoneOpenings.length > 0) {
        logDebug(
          `[BandOpenings] +${accepted} spots, ${s.keys} pairs / ${zs.keys} zone pairs, ${openings.length} openings / ${zoneOpenings.length} zone openings`,
        );
      }
    } catch (err) {
      logErrorOnce('BandOpenings', err.message);
    }
    return cachedPayload;
  }

  // Background sampler: keeps ingesting even when nobody polls the endpoint,
  // so the 3 h baseline survives the RBN cache's 30 min retention.
  const sampler = setInterval(() => recompute(), SAMPLE_INTERVAL_MS);
  if (sampler.unref) sampler.unref();
  // First sample shortly after boot (give RBN telnet a moment to authenticate).
  const primer = setTimeout(() => recompute(), 15 * 1000);
  if (primer.unref) primer.unref();

  app.get('/api/band-openings', (req, res) => {
    const now = Date.now();
    // Recomputed at most every SAMPLE_INTERVAL_MS; the background sampler
    // normally keeps this fresh, so requests just serve the cached payload.
    if (!cachedPayload || now - lastComputedAt >= SAMPLE_INTERVAL_MS) {
      recompute(now);
    }
    res.set('Cache-Control', 'no-store');
    res.json(
      cachedPayload || {
        generated_at: new Date(now).toISOString(),
        warming: true,
        baseline_coverage_seconds: 0,
        tracked: { pairs: 0, spots: 0, zone_pairs: 0, zone_spots: 0 },
        openings: [],
        zone_openings: [],
      },
    );
  });

  return { bandOpeningTracker: tracker, bandOpeningZoneTracker: zoneTracker };
};
