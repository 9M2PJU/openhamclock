/**
 * Prediction-vs-Reality helpers — pure comparison logic behind
 * PropVerifyPanel ("Prediction Check").
 *
 * Predicted side: per-band P.533 reliability from DE to one representative
 * gridpoint per continent (same engine + inputs as the VOACAP panel), taken
 * as the MAX across continents — "the model says this band should be open to
 * SOMEWHERE". Observed side: live spots involving DE's continent in the last
 * 15 minutes, per band, normalized so OBSERVED_CAP spots ≈ full activity.
 *
 * This whole comparison is a HEURISTIC. Spot counts measure where operators
 * are, not path reliability; a quiet band on a Tuesday morning is not model
 * error. The verdict thresholds are deliberately wide (±25 points) and the
 * panel says so in its footnote.
 */
import { getBandFromFreq, getCallsignInfo } from './callsign.js';
import { calculateDistance } from './geo.js';

/** HF bands compared, low → high (matches the VOACAP panel's band list). */
export const VERIFY_BANDS = ['80m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];

/**
 * One representative gridpoint per continent — roughly the ham-population
 * centroid, good enough for a continent-coarse comparison.
 */
export const CONTINENT_POINTS = {
  NA: { lat: 39, lon: -98 },
  SA: { lat: -15, lon: -55 },
  EU: { lat: 50, lon: 10 },
  AF: { lat: 5, lon: 20 },
  AS: { lat: 35, lon: 105 },
  OC: { lat: -25, lon: 135 },
};

/** Spots in a 15-min window that count as "fully active" for a band. */
export const OBSERVED_CAP = 15;

/** Verdict tolerance in reliability points (predicted and observed are both 0-99). */
export const VERDICT_TOLERANCE = 25;

export const OBSERVED_WINDOW_MS = 15 * 60 * 1000;

/** Continent whose representative point is nearest to a lat/lon (fallback when DE has no callsign). */
export function nearestContinent(lat, lon) {
  let best = 'NA';
  let bestDist = Infinity;
  for (const [cont, p] of Object.entries(CONTINENT_POINTS)) {
    const d = calculateDistance(lat, lon, p.lat, p.lon);
    if (d < bestDist) {
      bestDist = d;
      best = cont;
    }
  }
  return best;
}

/**
 * Count spots per band that involve DE's continent within the window.
 *
 * Accepted spot shapes (superset of the cluster + PSKReporter feeds):
 *   { freq | band, timestamp, spotter?, call?, involvesDe? }
 * `involvesDe: true` short-circuits the continent check — PSKReporter
 * reports are already filtered to the user's own station, so both sides of
 * every report involve DE by construction.
 *
 * @returns {Object} { band: count } for every VERIFY_BANDS entry
 */
export function countObservedByBand(spots, { deContinent, now = Date.now(), windowMs = OBSERVED_WINDOW_MS } = {}) {
  const counts = {};
  for (const b of VERIFY_BANDS) counts[b] = 0;
  if (!Array.isArray(spots)) return counts;

  const cutoff = now - windowMs;
  for (const spot of spots) {
    if (!spot) continue;
    if (!Number.isFinite(spot.timestamp) || spot.timestamp < cutoff || spot.timestamp > now + 60_000) continue;

    const band = VERIFY_BANDS.includes(spot.band) ? spot.band : getBandFromFreq(spot.freq);
    if (!VERIFY_BANDS.includes(band)) continue;

    let involves = spot.involvesDe === true;
    if (!involves && deContinent) {
      const sCont = spot.spotter ? getCallsignInfo(spot.spotter)?.continent : null;
      const dCont = spot.call ? getCallsignInfo(spot.call)?.continent : null;
      involves = sCont === deContinent || dCont === deContinent;
    }
    if (involves) counts[band]++;
  }
  return counts;
}

/** Normalize a spot count to the same 0-99 scale as P.533 reliability. */
export function observedScore(count, cap = OBSERVED_CAP) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(99, Math.round((count / cap) * 99));
}

/**
 * Collapse a { band: { continent: reliability } } matrix to the per-band max —
 * a band is "predicted open" if it is open to any continent.
 */
export function maxAcrossContinents(matrix) {
  const out = {};
  if (!matrix) return out;
  for (const [band, byCont] of Object.entries(matrix)) {
    let max = null;
    for (const rel of Object.values(byCont || {})) {
      if (Number.isFinite(rel)) max = max == null ? rel : Math.max(max, rel);
    }
    out[band] = max;
  }
  return out;
}

/**
 * Verdict for one band. Deliberately generous thresholds — see file header.
 *   'nodata'  — no prediction available for this band
 *   'agrees'  — |observed − predicted| ≤ tolerance, or both flat-out closed
 *   'better'  — observed activity beats the prediction by > tolerance
 *   'worse'   — band is predicted open but nobody's being heard
 */
export function verdictFor(predicted, count, { cap = OBSERVED_CAP, tolerance = VERDICT_TOLERANCE } = {}) {
  if (!Number.isFinite(predicted)) return 'nodata';
  const obs = observedScore(count, cap);
  if (predicted < 15 && count === 0) return 'agrees'; // both say closed
  const diff = obs - predicted;
  if (diff > tolerance) return 'better';
  if (diff < -tolerance) return 'worse';
  return 'agrees';
}

/**
 * Verdict for an already-normalized 0-99 observed score (third source:
 * measured beacon SNR from a KiwiSDR beacon monitor, see ibpMeasured.js).
 * Same tolerance as verdictFor; "both closed" is score < 15 (≈ SNR ≤ −4 dB).
 */
export function verdictForScore(predicted, score, { tolerance = VERDICT_TOLERANCE } = {}) {
  if (!Number.isFinite(predicted) || !Number.isFinite(score)) return 'nodata';
  if (predicted < 15 && score < 15) return 'agrees';
  const diff = score - predicted;
  if (diff > tolerance) return 'better';
  if (diff < -tolerance) return 'worse';
  return 'agrees';
}

/**
 * Assemble the panel's row model.
 *
 * @param {Object} predictedByBand  { band: reliability|null } (already maxed across continents)
 * @param {Object} counts           { band: spotCount }
 * @param {Object} [beaconsByBand]  { band: { maxSnr, score, n } } from measuredBandSummary — optional
 *                                  third source; rows get `beacon: { maxSnr, score, n, verdict }` or null
 * @returns {Array<{band, predicted, count, observed, verdict, beacon}>} in VERIFY_BANDS order
 */
export function buildComparison(predictedByBand = {}, counts = {}, beaconsByBand = null) {
  return VERIFY_BANDS.map((band) => {
    const predicted = Number.isFinite(predictedByBand[band]) ? predictedByBand[band] : null;
    const count = counts[band] ?? 0;
    const b = beaconsByBand && beaconsByBand[band];
    const beacon =
      b && Number.isFinite(b.score)
        ? { maxSnr: b.maxSnr, score: b.score, n: b.n ?? 0, verdict: verdictForScore(predicted, b.score) }
        : null;
    return {
      band,
      predicted,
      count,
      observed: observedScore(count),
      verdict: verdictFor(predicted, count),
      beacon,
    };
  });
}

/**
 * Reliability of the heatmap cell nearest a target point — used by the REST
 * fallback when the browser WASM engine is unavailable. Cells are
 * { lat, lon, r }; nearest is by degree distance with longitude wrap.
 */
export function pickCellReliability(cells, lat, lon) {
  if (!Array.isArray(cells) || cells.length === 0) return null;
  let best = null;
  let bestD = Infinity;
  for (const c of cells) {
    const dLat = c.lat - lat;
    let dLon = Math.abs(c.lon - lon) % 360;
    if (dLon > 180) dLon = 360 - dLon;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return Number.isFinite(best?.r) ? best.r : null;
}

export default {
  VERIFY_BANDS,
  CONTINENT_POINTS,
  OBSERVED_CAP,
  OBSERVED_WINDOW_MS,
  VERDICT_TOLERANCE,
  nearestContinent,
  countObservedByBand,
  observedScore,
  maxAcrossContinents,
  verdictFor,
  verdictForScore,
  buildComparison,
  pickCellReliability,
};
