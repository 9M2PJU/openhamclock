/**
 * useWinlinkReach — "which Winlink gateways can I reach on HF right now?"
 *
 * Runs one ITU-R P.533 path prediction per nearby HF gateway (DE → gateway,
 * display-time UTC hour, the gateway's own published frequencies) through
 * the same browser WASM engine the VOACAP and Prediction Check panels use
 * (predictInWorker — a page-singleton Web Worker, so the UI thread never
 * blocks). When the WASM bundle is unavailable it falls back to the
 * server's /api/propagation point-to-point estimate, serially and with a
 * lower cap so a self-hosted server is not hammered.
 *
 * Results are cached per gateway + frequency set + hour + station settings
 * in a module-level Map that survives panel remounts; a refresh only runs
 * the jobs that are not already cached. Recomputes when DE, the display
 * hour, the range, power/antenna or the sunspot bucket change.
 *
 * The ranked result is broadcast on window as WINLINK_REACH_EVENT so the
 * Winlink Gateways map layer can colour / filter its markers by predicted
 * status without prop plumbing (same pattern as `mapdata:*`).
 *
 * Pure logic (candidate selection, cache keys, scoring, ranking, batching)
 * lives in utils/winlinkReach.js.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { predictInWorker } from '../services/p533/predictInWorker.js';
import { ANTENNA_PROFILES } from '../utils/propagationAdjust.js';
import { apiFetch } from '../utils/apiFetch.js';
import { displayNow } from '../utils/displayTime.js';
import useDisplayTime from './app/useDisplayTime.js';
import {
  DEFAULT_RANGE_KM,
  MAX_PREDICTIONS_PER_REFRESH,
  MAX_PREDICTIONS_REST,
  PREDICT_CONCURRENCY,
  REST_CONCURRENCY,
  aggregateGateways,
  buildPredictionParams,
  buildReachSnapshot,
  cacheKey,
  cachePut,
  freqHzToBand,
  hourKeyFor,
  rankGateways,
  restFallbackMode,
  runBatched,
  scoreChannels,
  selectCandidates,
  summarizeGateway,
} from '../utils/winlinkReach.js';

export const WINLINK_REACH_EVENT = 'winlink:reach';

const GATEWAY_REFRESH_MS = 60 * 60 * 1000; // matches the server's 1 h gateway cache
const HOUR_TICK_MS = 60 * 1000;
const BROADCAST_DEBOUNCE_MS = 1000;

// ── Module-level state shared by every mount ──────────────────────────────
const resultCache = new Map();
let wasmUnavailable = false;
let lastSnapshot = { enabled: false };
let restChain = Promise.resolve();

/** Latest broadcast — lets a map layer that mounts later pick up the current state. */
export function getWinlinkReachSnapshot() {
  return lastSnapshot;
}

function broadcast(detail) {
  lastSnapshot = detail;
  try {
    window.dispatchEvent(new CustomEvent(WINLINK_REACH_EVENT, { detail }));
  } catch {
    /* no window (tests) */
  }
}

/** Serialize REST fallback calls — one in flight at a time across all mounts. */
function serialRest(fn) {
  const p = restChain.then(fn, fn);
  restChain = p.catch(() => {});
  return p;
}

async function fetchGatewayRows() {
  // Server proxy first (shared 1 h cache), then the local rig-bridge plugin —
  // the same order useWinlink's gateway search uses.
  for (const url of ['/api/winlink/gateways', '/winlink/gateways']) {
    try {
      const res = await apiFetch(url);
      if (!res || !res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data?.gateways;
      if (Array.isArray(list) && list.length) return list;
    } catch {
      /* try the next source */
    }
  }
  return null;
}

async function restPredict(cand, job, de, power, antenna) {
  return serialRest(async () => {
    const params = new URLSearchParams({
      deLat: de.lat.toFixed(2),
      deLon: de.lon.toFixed(2),
      dxLat: cand.gateway.lat.toFixed(2),
      dxLon: cand.gateway.lon.toFixed(2),
      mode: restFallbackMode(job.channels[0]?.mode),
      power: String(power),
      antenna,
    });
    const res = await apiFetch(`/api/propagation?${params}`);
    if (!res) throw new Error('rate limited');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const byBand = {};
    for (const b of data.currentBands || []) {
      if (Number.isFinite(b.reliability)) byBand[b.band] = b.reliability;
    }
    const frequencies = [];
    for (const c of job.channels) {
      const rel = byBand[freqHzToBand(c.frequency)];
      if (Number.isFinite(rel)) frequencies.push({ freq: Math.round(c.frequency / 1000) / 1000, reliability: rel });
    }
    return {
      scored: scoreChannels(job.channels, frequencies, job.requiredSNR),
      engine: /P\.533/.test(data.model || '') ? 'server' : 'est',
      updatedAt: Date.now(),
    };
  });
}

/**
 * @param {Object}  opts
 * @param {boolean} opts.active       run predictions (the Reachable view is on)
 * @param {Object}  opts.deLocation   { lat, lon }
 * @param {number}  [opts.rangeKm]    HF search radius
 * @param {Object}  [opts.propConfig] config.propagation — power + antenna feed the engine
 * @param {number}  [opts.ssn]        current sunspot number
 */
export function useWinlinkReach({ active, deLocation, rangeKm = DEFAULT_RANGE_KM, propConfig, ssn }) {
  const [rawRows, setRawRows] = useState(null);
  const [listError, setListError] = useState(false);
  const [state, setState] = useState({
    rows: [],
    packet: [],
    truncated: 0,
    progress: { done: 0, total: 0 },
    running: false,
    hour: null,
    updatedAt: null,
  });
  const { offsetMs } = useDisplayTime();
  const [hourKey, setHourKey] = useState(() => hourKeyFor(displayNow()));
  const [nonce, setNonce] = useState(0);
  const genRef = useRef(0);
  const forceRef = useRef(false);

  // Gateway list — fetched while active, refreshed hourly.
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    const load = async () => {
      const list = await fetchGatewayRows();
      if (!alive) return;
      if (list) {
        setRawRows(list);
        setListError(false);
      } else {
        setListError(true);
      }
    };
    load();
    const id = setInterval(load, GATEWAY_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);

  // Hour key follows the display time (time shift) and rolls over each UTC hour.
  useEffect(() => {
    if (!active) return undefined;
    const tick = () => setHourKey(hourKeyFor(displayNow()));
    tick();
    const id = setInterval(tick, HOUR_TICK_MS);
    return () => clearInterval(id);
  }, [active, offsetMs]);

  const gateways = useMemo(() => aggregateGateways(rawRows || []), [rawRows]);

  const deLat = deLocation?.lat;
  const deLon = deLocation?.lon;
  const power = parseFloat(propConfig?.power) || 100;
  const antenna = propConfig?.antenna || 'isotropic';
  const ssnBucket = Math.round((Number.isFinite(Number(ssn)) ? Number(ssn) : 100) / 10) * 10;

  useEffect(() => {
    if (!active || !gateways.length || !Number.isFinite(deLat) || !Number.isFinite(deLon)) return undefined;
    const gen = ++genRef.current;
    const isCancelled = () => gen !== genRef.current;
    const force = forceRef.current;
    forceRef.current = false;

    const now = displayNow();
    const hour = now.getUTCHours();
    const month = now.getUTCMonth() + 1;
    const year = now.getUTCFullYear();
    const de = { lat: deLat, lon: deLon };
    const txGain = (ANTENNA_PROFILES[antenna] || ANTENNA_PROFILES.isotropic).gain;
    const restOnly = wasmUnavailable;
    const sel = selectCandidates(gateways, de, {
      rangeKm,
      maxPredictions: restOnly ? MAX_PREDICTIONS_REST : MAX_PREDICTIONS_PER_REFRESH,
    });
    const ctx = { hour, month, year, ssn: ssnBucket, power, txGain };

    const local = new Map();
    const pending = [];
    for (const cand of sel.hf) {
      for (const job of cand.jobs) {
        job.key = cacheKey({
          callsign: cand.callsign,
          freqsMHz: job.freqsMHz,
          requiredSNR: job.requiredSNR,
          deLat,
          deLon,
          hour,
          month,
          year,
          ssn: ssnBucket,
          power,
          antenna,
        });
        const hit = force ? null : resultCache.get(job.key);
        if (hit) local.set(job.key, hit);
        else pending.push({ cand, job });
      }
    }

    const compose = () =>
      rankGateways(
        sel.hf.map((cand) => {
          let scored = [];
          let engine = null;
          let updatedAt = null;
          let isPending = false;
          for (const job of cand.jobs) {
            const r = local.get(job.key);
            if (r) {
              scored = scored.concat(r.scored);
              engine = engine || r.engine;
              updatedAt = Math.max(updatedAt || 0, r.updatedAt);
            } else {
              scored = scored.concat(scoreChannels(job.channels, [], job.requiredSNR));
              isPending = true;
            }
          }
          const row = summarizeGateway(cand, scored, { engine, updatedAt });
          row.pending = isPending;
          return row;
        }),
      );

    setState({
      rows: compose(),
      packet: sel.packet,
      truncated: sel.truncated,
      progress: { done: 0, total: pending.length },
      running: pending.length > 0,
      hour,
      updatedAt: pending.length ? null : Date.now(),
    });
    if (!pending.length) return undefined;

    let restUsed = 0;
    const runJob = async ({ cand, job }) => {
      let entry = null;
      if (!wasmUnavailable) {
        try {
          const result = await predictInWorker(buildPredictionParams(cand, job, de, ctx));
          entry = {
            scored: scoreChannels(job.channels, result.frequencies, job.requiredSNR),
            engine: 'wasm',
            updatedAt: Date.now(),
          };
        } catch (err) {
          wasmUnavailable = true;
          console.warn('[WinlinkReach] WASM engine unavailable, using the server estimate:', err.message);
        }
      }
      if (!entry) {
        if (restUsed >= MAX_PREDICTIONS_REST) return null;
        restUsed++;
        entry = await restPredict(cand, job, de, power, antenna);
      }
      if (entry) {
        cachePut(resultCache, job.key, entry);
        if (!isCancelled()) local.set(job.key, entry);
      }
      return entry;
    };

    runBatched(pending, runJob, {
      concurrency: restOnly ? REST_CONCURRENCY : PREDICT_CONCURRENCY,
      isCancelled,
      onProgress: (done, total) => {
        setState((prev) => ({ ...prev, rows: compose(), progress: { done, total } }));
      },
    }).then(() => {
      if (isCancelled()) return;
      setState((prev) => ({ ...prev, rows: compose(), running: false, updatedAt: Date.now() }));
    });

    return () => {
      genRef.current++; // invalidate the in-flight run
    };
  }, [active, gateways, deLat, deLon, rangeKm, power, antenna, ssnBucket, hourKey, nonce]);

  // Broadcast to the map layer when the ranked result changes. Debounced:
  // the layer rebuilds every marker on each broadcast, so per-job progress
  // ticks are coalesced into one redraw.
  useEffect(() => {
    if (!active) return undefined;
    const id = setTimeout(() => {
      broadcast({
        enabled: true,
        hour: state.hour,
        rangeKm,
        byCall: buildReachSnapshot(state.rows, state.packet),
      });
    }, BROADCAST_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [active, state.rows, state.packet, state.hour, rangeKm]);
  useEffect(() => {
    if (!active) broadcast({ enabled: false });
  }, [active]);
  useEffect(() => () => broadcast({ enabled: false }), []);

  const refresh = useCallback(() => {
    forceRef.current = true;
    setNonce((n) => n + 1);
  }, []);

  const engine = useMemo(() => {
    const engines = new Set(state.rows.map((r) => r.engine).filter(Boolean));
    if (engines.has('wasm')) return 'wasm';
    if (engines.has('server')) return 'server';
    if (engines.has('est')) return 'est';
    return null;
  }, [state.rows]);

  return {
    ...state,
    engine,
    gatewayCount: gateways.length,
    listLoaded: rawRows != null,
    listError,
    hasDe: Number.isFinite(deLat) && Number.isFinite(deLon),
    timeShifted: offsetMs !== 0,
    refresh,
  };
}

/** Test hook: clear the module-level cache and engine flag. */
export function __resetWinlinkReachForTests() {
  resultCache.clear();
  wasmUnavailable = false;
  lastSnapshot = { enabled: false };
  restChain = Promise.resolve();
}

export default useWinlinkReach;
