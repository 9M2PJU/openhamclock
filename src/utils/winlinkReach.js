/**
 * Reachable Winlink gateways — pure logic behind the Winlink panel's
 * "Reachable" view and the map layer's reachability colouring.
 *
 * The question answered: "which RMS gateways can I reach on HF right now?"
 * For every HF gateway within range we run ONE P.533 path prediction
 * (DE → gateway, current UTC hour, the gateway's own published
 * frequencies) and classify the result. Packet gateways on VHF/UHF are not
 * modelled — they are ranked by distance with a line-of-sight hint.
 *
 * Everything here is synchronous and side-effect free except runBatched,
 * which is a generic concurrency-limited async pool with cancellation.
 * The React side (useWinlinkReach.js) owns the engine, the cache and the
 * state; this file owns candidate selection, cache keys, scoring,
 * ranking, status thresholds and the Pat connect URL format.
 */
import { maidenheadToLatLon, calculateDistance, calculateBearing } from './geo.js';
import { P533_REF_SNR_DB } from './propagationAdjust.js';
import { winlinkModeFamily, winlinkModeLabel } from './winlinkModes.js';

// ── Tunables ───────────────────────────────────────────────────────────────

/** Default search radius for HF gateways. */
export const DEFAULT_RANGE_KM = 3000;
/** Range choices offered in the panel. */
export const RANGE_OPTIONS_KM = [500, 1000, 2000, 3000, 5000];
/** VHF/UHF packet gateways further away than this are not listed at all. */
export const PACKET_RANGE_KM = 300;
/** Hard cap on engine runs per refresh (browser WASM engine). */
export const MAX_PREDICTIONS_PER_REFRESH = 60;
/** Lower cap when the REST fallback is doing the work — it is a shared server. */
export const MAX_PREDICTIONS_REST = 20;
/** Parallel in-flight predictions (the worker is a singleton, this just pipelines). */
export const PREDICT_CONCURRENCY = 2;
/** Parallel in-flight REST fallback calls — the server allows 3 upstream; leave room. */
export const REST_CONCURRENCY = 1;
/** Distinct frequencies passed to one engine run for one gateway. */
export const MAX_FREQS_PER_JOB = 8;
/** Entries kept in the per-gateway+hour result cache. */
export const CACHE_MAX_ENTRIES = 1500;
/** Below 30 MHz is HF for our purposes (Winlink lists 60 m, MARS and 10 m channels too). */
export const HF_MAX_HZ = 30e6;

// ── Status thresholds ──────────────────────────────────────────────────────

/** Reliability (% of days the circuit meets the mode's SNR) for a Good chip. */
export const STATUS_GOOD_MIN_RELIABILITY = 50;
/** Reliability floor for Marginal; below this the median SNR margin can still rescue it. */
export const STATUS_MARGINAL_MIN_RELIABILITY = 20;
/** Median SNR margin (dB) that keeps a low-reliability path at Marginal instead of Closed. */
export const STATUS_MARGINAL_MIN_SNR_MARGIN = -6;

export const STATUS_ORDER = { good: 0, marginal: 1, closed: 2, unknown: 3 };

export const STATUS_COLORS = {
  good: '#22c55e',
  marginal: '#f59e0b',
  closed: '#ef4444',
  unknown: '#6b7280',
};

/**
 * Classify one predicted circuit.
 *   good      — reliability ≥ 50 %
 *   marginal  — reliability ≥ 20 %, or the median SNR is within 6 dB of what the mode needs
 *   closed    — everything else
 *   unknown   — no prediction (engine failed / not run)
 */
export function classifyStatus(reliability, snrMargin = null) {
  if (!Number.isFinite(reliability)) return 'unknown';
  if (reliability >= STATUS_GOOD_MIN_RELIABILITY) return 'good';
  if (reliability >= STATUS_MARGINAL_MIN_RELIABILITY) return 'marginal';
  if (Number.isFinite(snrMargin) && snrMargin >= STATUS_MARGINAL_MIN_SNR_MARGIN) return 'marginal';
  return 'closed';
}

// ── Mode → required SNR ────────────────────────────────────────────────────

/**
 * Approximate advantage (dB, in the engine's 3 kHz reference bandwidth) of
 * each Winlink mode family over SSB voice. These feed Path.SNRr the same way
 * modeRequiredSNR() does for FT8/CW in the VOACAP panel. They are working
 * figures, not vendor specs: ARQ modes negotiate their speed level down
 * before they give up, so "decodes at all" sits well below SSB readability.
 */
export const WINLINK_FAMILY_ADVANTAGE_DB = {
  pactor: 10,
  winmor: 10,
  ardop: 12,
  vara: 12,
  packet: 0,
};

/** Robust Packet (code 30) is a narrow, robust HF mode — closer to Pactor than to AX.25. */
const ROBUST_PACKET_CODE = 30;
const ROBUST_PACKET_ADVANTAGE_DB = 8;

/** Narrow-bandwidth variants buy a few more dB (ARDOP 500, VARA 500). */
const NARROW_VARIANT_BONUS_DB = 3;
const NARROW_VARIANT_CODES = new Set([41, 53]);

/** Required median SNR (dB) the engine should score a channel's mode against. */
export function winlinkRequiredSNR(modeInt) {
  const fam = winlinkModeFamily(modeInt);
  let adv = fam ? (WINLINK_FAMILY_ADVANTAGE_DB[fam.id] ?? 0) : 0;
  if (modeInt === ROBUST_PACKET_CODE) adv = ROBUST_PACKET_ADVANTAGE_DB;
  if (NARROW_VARIANT_CODES.has(modeInt)) adv += NARROW_VARIANT_BONUS_DB;
  return P533_REF_SNR_DB - adv;
}

/**
 * Closest conventional propagation mode for the REST fallback, whose
 * /api/propagation endpoint only knows the standard mode table.
 */
export function restFallbackMode(modeInt) {
  const fam = winlinkModeFamily(modeInt);
  if (!fam) return 'SSB';
  if (fam.id === 'ardop' || fam.id === 'vara') return 'PSK31';
  if (fam.id === 'pactor' || fam.id === 'winmor' || modeInt === ROBUST_PACKET_CODE) return 'CW';
  return 'SSB';
}

// ── Gateway shaping ────────────────────────────────────────────────────────

/** True for the integer mode codes that are packet-family (AX.25 / VARA FM / Robust Packet). */
export function isPacketMode(modeInt) {
  const fam = winlinkModeFamily(modeInt);
  return !!fam && fam.id === 'packet';
}

/** True for VARA FM / VARA FM WIDE — VHF/UHF VARA, modelled like packet. */
export function isVaraFm(modeInt) {
  return modeInt === 51 || modeInt === 52;
}

export function isHfFrequency(freqHz) {
  return Number.isFinite(freqHz) && freqHz > 0 && freqHz < HF_MAX_HZ;
}

/**
 * An HF-modelled channel: anything published below 30 MHz except VARA FM.
 * Robust Packet (code 30) and the odd HF AX.25 channel are HF circuits too,
 * so they go through the engine like Pactor/VARA.
 */
export function isHfChannel(channel) {
  if (!channel) return false;
  if (!isHfFrequency(channel.frequency)) return false;
  return !isVaraFm(channel.mode);
}

/** A VHF/UHF channel (≥ 30 MHz) — ranked by distance, never predicted. */
export function isVhfChannel(channel) {
  return !!channel && Number.isFinite(channel.frequency) && channel.frequency >= HF_MAX_HZ;
}

/**
 * Group raw channel rows (server proxy camelCase or rig-bridge PascalCase)
 * into one entry per callsign with a channels[] array. Rows without a
 * decodable grid square are dropped.
 */
export function aggregateGateways(rows) {
  const byCall = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const callsign = r.callsign || r.Callsign;
    const gridsquare = r.gridsquare || r.Gridsquare;
    if (!callsign || !gridsquare) continue;
    let entry = byCall.get(callsign);
    if (!entry) {
      const pos = maidenheadToLatLon(gridsquare);
      if (!pos) continue;
      entry = { callsign, gridsquare, lat: pos.lat, lon: pos.lon, channels: [] };
      byCall.set(callsign, entry);
    }
    const mode = Number(r.mode ?? r.Mode);
    entry.channels.push({
      frequency: Number(r.frequency ?? r.Frequency),
      mode: Number.isFinite(mode) ? mode : -1,
      modeLabel: winlinkModeLabel(mode),
      hours: r.hours ?? r.Hours ?? null,
      baud: r.baud ?? r.Baud ?? null,
      serviceCode: r.serviceCode || r.ServiceCode || 'PUBLIC',
    });
  }
  return [...byCall.values()];
}

const BAND_EDGES_MHZ = [
  ['160m', 1.8, 2.0],
  ['80m', 3.5, 4.0],
  ['60m', 5.25, 5.45],
  ['40m', 7.0, 7.3],
  ['30m', 10.1, 10.15],
  ['20m', 14.0, 14.35],
  ['17m', 18.068, 18.168],
  ['15m', 21.0, 21.45],
  ['12m', 24.89, 24.99],
  ['10m', 28.0, 29.7],
  ['6m', 50, 54],
  ['2m', 144, 148],
  ['1.25m', 219, 225],
  ['70cm', 420, 450],
];

/** Amateur band label for a frequency in Hz, or null outside the ham bands (MARS, 60 m variants…). */
export function freqHzToBand(freqHz) {
  const mhz = freqHz / 1e6;
  for (const [band, lo, hi] of BAND_EDGES_MHZ) {
    if (mhz >= lo && mhz <= hi) return band;
  }
  return null;
}

/**
 * Dial (VFO) frequency for a channel. Winlink publishes the audio CENTRE
 * frequency; HF sound-card and Pactor modes run USB with the suppressed
 * carrier 1.5 kHz below centre, which is the convention Pat's rmslist uses
 * for its dial column. VHF/UHF channels are FM — dial = published.
 */
export function dialFrequencyHz(channel) {
  if (!channel || !Number.isFinite(channel.frequency)) return null;
  if (!isHfFrequency(channel.frequency)) return channel.frequency;
  if (isVaraFm(channel.mode)) return channel.frequency;
  return channel.frequency - 1500;
}

/**
 * Pat connect URL for a gateway channel, in the scheme Pat's `connect`
 * command and rmslist output use: `<transport>:///<CALL>?freq=<dial kHz>`.
 * Returns null for mode codes current Pat has no transport for (WINMOR was
 * retired, Robust Packet needs a vendor modem setup).
 */
export function patConnectUrl(callsign, channel) {
  if (!callsign || !channel) return null;
  const call = String(callsign).toUpperCase();
  const fam = winlinkModeFamily(channel.mode);
  if (!fam) return null;
  const dial = dialFrequencyHz(channel);
  const freq = Number.isFinite(dial) ? `?freq=${(dial / 1000).toFixed(1)}` : '';
  if (isVaraFm(channel.mode)) return `varafm:///${call}`;
  if (channel.mode === ROBUST_PACKET_CODE) return null;
  switch (fam.id) {
    case 'packet':
      return `ax25:///${call}`;
    case 'pactor':
      return `pactor:///${call}${freq}`;
    case 'ardop':
      return `ardop:///${call}${freq}`;
    case 'vara':
      return `varahf:///${call}${freq}`;
    default:
      return null;
  }
}

/**
 * Rig mode to request when tuning to a channel. Winlink HF is always upper
 * sideband data regardless of band (the 7 MHz LSB convention is for voice);
 * VHF/UHF channels are FM.
 */
export function rigModeForChannel(channel) {
  if (!channel || !isHfFrequency(channel.frequency)) return 'FM';
  if (isVaraFm(channel.mode)) return 'FM';
  return 'DATA-USB';
}

/** Line-of-sight hint for a VHF/UHF packet gateway, by great-circle distance. */
export function losHint(distanceKm) {
  if (!Number.isFinite(distanceKm)) return 'unknown';
  if (distanceKm <= 40) return 'los';
  if (distanceKm <= 120) return 'extended';
  return 'beyond';
}

// ── Candidate selection ────────────────────────────────────────────────────

function roundMHz(freqHz) {
  return Math.round(freqHz / 1000) / 1000; // 1 kHz resolution, in MHz
}

/**
 * Pick which gateways to predict. Returns:
 *   hf      — gateways with at least one HF channel within rangeKm, nearest
 *             first, capped at maxPredictions JOBS. A job is one engine run:
 *             (gateway, requiredSNR) → its frequency list. Gateways whose HF
 *             channels all share a mode family need one job; a Pactor+VARA
 *             site needs two because Path.SNRr is per run.
 *   packet  — VHF/UHF (≥ 30 MHz: AX.25 packet, VARA FM) gateways within PACKET_RANGE_KM,
 *             nearest first, with a line-of-sight hint. Never predicted.
 *   truncated — HF gateways inside range that did not fit under the cap.
 */
export function selectCandidates(
  gateways,
  de,
  { rangeKm = DEFAULT_RANGE_KM, maxPredictions = MAX_PREDICTIONS_PER_REFRESH, maxFreqs = MAX_FREQS_PER_JOB } = {},
) {
  const out = { hf: [], packet: [], truncated: 0, totalJobs: 0 };
  if (!de || !Number.isFinite(de.lat) || !Number.isFinite(de.lon)) return out;

  const hf = [];
  const packet = [];
  for (const gw of gateways || []) {
    if (!gw || !Number.isFinite(gw.lat) || !Number.isFinite(gw.lon)) continue;
    const distanceKm = calculateDistance(de.lat, de.lon, gw.lat, gw.lon);
    const bearing = Math.round(calculateBearing(de.lat, de.lon, gw.lat, gw.lon));
    const hfChannels = (gw.channels || []).filter(isHfChannel);
    const packetChannels = (gw.channels || []).filter(isVhfChannel);

    if (hfChannels.length && distanceKm <= rangeKm) {
      // Group by required SNR so each engine run scores against one threshold.
      const bySnr = new Map();
      for (const c of hfChannels) {
        const snr = winlinkRequiredSNR(c.mode);
        if (!bySnr.has(snr)) bySnr.set(snr, { requiredSNR: snr, channels: [], freqsMHz: [] });
        const job = bySnr.get(snr);
        job.channels.push(c);
        const f = roundMHz(c.frequency);
        if (!job.freqsMHz.includes(f) && job.freqsMHz.length < maxFreqs) job.freqsMHz.push(f);
      }
      const jobs = [...bySnr.values()].map((j) => ({ ...j, freqsMHz: j.freqsMHz.slice().sort((a, b) => a - b) }));
      hf.push({ gateway: gw, callsign: gw.callsign, distanceKm, bearing, channels: hfChannels, jobs });
    }
    if (packetChannels.length && distanceKm <= PACKET_RANGE_KM) {
      packet.push({
        gateway: gw,
        callsign: gw.callsign,
        distanceKm,
        bearing,
        channels: packetChannels.slice().sort((a, b) => a.frequency - b.frequency),
        los: losHint(distanceKm),
      });
    }
  }

  hf.sort((a, b) => a.distanceKm - b.distanceKm);
  packet.sort((a, b) => a.distanceKm - b.distanceKm);

  // Cap by jobs, keeping whole gateways.
  let jobCount = 0;
  const kept = [];
  for (const c of hf) {
    if (jobCount + c.jobs.length > maxPredictions) break;
    jobCount += c.jobs.length;
    kept.push(c);
  }
  out.hf = kept;
  out.truncated = hf.length - kept.length;
  out.totalJobs = jobCount;
  out.packet = packet;
  return out;
}

// ── Cache keys & engine params ─────────────────────────────────────────────

/**
 * Cache key for one job. DE is rounded to 0.1° (~10 km, far below the
 * engine's resolution), SSN to the nearest 10 so a drifting daily index
 * does not invalidate everything each minute. Hour/month/year pin the run
 * to the display hour; power/antenna are the station settings that change
 * the circuit.
 */
export function cacheKey({ callsign, freqsMHz, requiredSNR, deLat, deLon, hour, month, year, ssn, power, antenna }) {
  const la = (Math.round(deLat * 10) / 10).toFixed(1);
  const lo = (Math.round(deLon * 10) / 10).toFixed(1);
  const s = Math.round((Number(ssn) || 0) / 10) * 10;
  const f = (freqsMHz || []).map((x) => x.toFixed(3)).join(',');
  return `${callsign}|${f}|${requiredSNR}|${la},${lo}|${year}-${month}-${hour}|${s}|${Number(power) || 100}|${antenna || 'isotropic'}`;
}

/** Hour key that changes once per UTC hour — the hook's recompute trigger. */
export function hourKeyFor(date = new Date()) {
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}T${date.getUTCHours()}`;
}

/**
 * Parameters for predictInWorker() for one job — the same call the
 * Prediction Check panel makes, with the gateway's own frequencies
 * instead of the fixed band list.
 */
export function buildPredictionParams(candidate, job, de, { hour, month, year, ssn, power, txGain }) {
  return {
    txLat: de.lat,
    txLon: de.lon,
    rxLat: candidate.gateway.lat,
    rxLon: candidate.gateway.lon,
    year,
    month,
    hour,
    ssn: Number.isFinite(ssn) ? ssn : 100,
    txPower: parseFloat(power) || 100,
    txGain: Number.isFinite(txGain) ? txGain : 0,
    requiredSNR: job.requiredSNR,
    frequencies: job.freqsMHz,
  };
}

// ── Scoring & ranking ──────────────────────────────────────────────────────

function nearestFreqResult(frequencies, mhz) {
  let best = null;
  let bestD = Infinity;
  for (const f of frequencies || []) {
    const d = Math.abs(f.freq - mhz);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return bestD <= 0.05 ? best : null;
}

/**
 * Attach engine output to each channel of a job.
 * @param {Array} channels      job.channels
 * @param {Array} frequencies   result.frequencies from the engine ({freq, snr, reliability})
 * @param {number} requiredSNR  the job's Path.SNRr
 * @returns {Array} scored channels: {...channel, band, dialHz, reliability, snr, snrMargin, status}
 */
export function scoreChannels(channels, frequencies, requiredSNR) {
  return (channels || []).map((c) => {
    const r = nearestFreqResult(frequencies, roundMHz(c.frequency));
    const reliability =
      r && Number.isFinite(r.reliability) ? Math.max(0, Math.min(99, Math.round(r.reliability))) : null;
    const snr = r && Number.isFinite(r.snr) ? Math.round(r.snr * 10) / 10 : null;
    const snrMargin = Number.isFinite(snr) ? Math.round((snr - requiredSNR) * 10) / 10 : null;
    return {
      ...c,
      band: freqHzToBand(c.frequency),
      dialHz: dialFrequencyHz(c),
      reliability,
      snr,
      snrMargin,
      status: classifyStatus(reliability, snrMargin),
    };
  });
}

/** Pick the best scored channel: highest reliability, SNR margin as tiebreak. */
export function bestChannel(scored) {
  let best = null;
  for (const c of scored || []) {
    if (!best) {
      best = c;
      continue;
    }
    const cr = c.reliability ?? -1;
    const br = best.reliability ?? -1;
    if (cr > br || (cr === br && (c.snrMargin ?? -Infinity) > (best.snrMargin ?? -Infinity))) best = c;
  }
  return best;
}

/**
 * Build one result row for a gateway from its scored channels.
 */
export function summarizeGateway(candidate, scoredChannels, { engine = 'wasm', updatedAt = Date.now() } = {}) {
  const channels = scoredChannels.slice().sort((a, b) => {
    const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (so !== 0) return so;
    return (b.reliability ?? -1) - (a.reliability ?? -1);
  });
  const best = bestChannel(channels);
  return {
    callsign: candidate.callsign,
    lat: candidate.gateway.lat,
    lon: candidate.gateway.lon,
    gridsquare: candidate.gateway.gridsquare,
    distanceKm: candidate.distanceKm,
    bearing: candidate.bearing,
    channels,
    best,
    status: best ? best.status : 'unknown',
    reliability: best ? best.reliability : null,
    snrMargin: best ? best.snrMargin : null,
    engine,
    updatedAt,
  };
}

/** Rank result rows: Good → Marginal → Closed → Unknown, then reliability desc, then nearest. */
export function rankGateways(rows) {
  return (rows || []).slice().sort((a, b) => {
    const so = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (so !== 0) return so;
    const rd = (b.reliability ?? -1) - (a.reliability ?? -1);
    if (rd !== 0) return rd;
    return a.distanceKm - b.distanceKm;
  });
}

/**
 * Compact per-callsign view for the map layer: { CALL: { status, reliability,
 * snrMargin, band, freqHz, kind } }. HF rows carry their predicted status;
 * VHF/UHF rows carry kind 'packet' and their line-of-sight hint.
 */
export function buildReachSnapshot(rows, packet) {
  const byCall = {};
  for (const r of rows || []) {
    byCall[r.callsign] = {
      kind: 'hf',
      status: r.status,
      reliability: r.reliability,
      snrMargin: r.snrMargin,
      band: r.best?.band ?? null,
      freqHz: r.best?.frequency ?? null,
      modeLabel: r.best?.modeLabel ?? null,
    };
  }
  for (const p of packet || []) {
    if (byCall[p.callsign]) continue; // an HF prediction says more than a distance
    byCall[p.callsign] = { kind: 'packet', status: 'unknown', los: p.los, distanceKm: p.distanceKm };
  }
  return byCall;
}

/**
 * Should the map draw this gateway under a reachability filter?
 *   'all'        — everything
 *   'reachable'  — HF predicted Good/Marginal, plus VHF/UHF within extended line of sight
 *   'good'       — HF predicted Good, plus VHF/UHF within line of sight
 */
export function passesReachFilter(entry, filter) {
  if (filter === 'all' || !filter) return true;
  if (!entry) return false;
  if (entry.kind === 'packet') return filter === 'good' ? entry.los === 'los' : entry.los !== 'beyond';
  if (filter === 'good') return entry.status === 'good';
  return entry.status === 'good' || entry.status === 'marginal';
}

// ── Concurrency-limited runner ─────────────────────────────────────────────

/**
 * Run `fn(item, index)` over `items` with at most `concurrency` in flight.
 * Never rejects: each slot of the returned array is { ok, value } or
 * { ok: false, error }. Stops scheduling once isCancelled() is true (in
 * flight calls finish but their results are discarded by the caller).
 * onProgress(done, total) fires after every settled item.
 */
export async function runBatched(items, fn, { concurrency = PREDICT_CONCURRENCY, onProgress, isCancelled } = {}) {
  const list = items || [];
  const results = new Array(list.length);
  let next = 0;
  let done = 0;
  const cancelled = () => (typeof isCancelled === 'function' ? isCancelled() : false);

  async function lane() {
    while (true) {
      if (cancelled()) return;
      const i = next++;
      if (i >= list.length) return;
      try {
        const value = await fn(list[i], i);
        results[i] = { ok: true, value };
      } catch (error) {
        results[i] = { ok: false, error };
      }
      done++;
      if (!cancelled() && typeof onProgress === 'function') onProgress(done, list.length);
    }
  }

  const lanes = [];
  for (let k = 0; k < Math.max(1, Math.min(concurrency, list.length)); k++) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

/** Insert into a bounded Map, evicting the oldest insertion when over `max`. */
export function cachePut(map, key, value, max = CACHE_MAX_ENTRIES) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  return map;
}

export default {
  DEFAULT_RANGE_KM,
  RANGE_OPTIONS_KM,
  PACKET_RANGE_KM,
  MAX_PREDICTIONS_PER_REFRESH,
  MAX_PREDICTIONS_REST,
  PREDICT_CONCURRENCY,
  REST_CONCURRENCY,
  STATUS_ORDER,
  STATUS_COLORS,
  classifyStatus,
  winlinkRequiredSNR,
  restFallbackMode,
  aggregateGateways,
  isHfChannel,
  isVhfChannel,
  isPacketMode,
  freqHzToBand,
  dialFrequencyHz,
  patConnectUrl,
  losHint,
  rigModeForChannel,
  buildReachSnapshot,
  passesReachFilter,
  selectCandidates,
  cacheKey,
  hourKeyFor,
  buildPredictionParams,
  scoreChannels,
  bestChannel,
  summarizeGateway,
  rankGateways,
  runBatched,
  cachePut,
};
