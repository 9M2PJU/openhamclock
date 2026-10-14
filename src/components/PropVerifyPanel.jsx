/**
 * PropVerifyPanel — "Prediction Check": what VOACAP predicts right now vs
 * what's actually being spotted (dockable panel `prop-verify`).
 *
 * Predicted side: the SAME browser P.533 WASM engine the VOACAP panel uses
 * (predictInWorker — the worker is a page singleton, so the module is
 * usually already warm), run for the current UTC hour from DE to one
 * representative gridpoint per continent, with the user's shared
 * mode/power/antenna config. Per band we keep the MAX across continents —
 * "should be open to somewhere". If the WASM bundle is unavailable
 * (self-hosted installs), it falls back to sampling the server's heuristic
 * /api/propagation/heatmap per band (EST badge).
 *
 * Observed side: live spots already streaming into the client — DX cluster
 * spots (which include RBN skimmer spots on nodes that carry them) plus
 * PSKReporter reports for the user's own station — counted per band over the
 * last 15 minutes when they involve DE's continent.
 *
 * The comparison is a HEURISTIC and the panel says so. All pure logic lives
 * in src/utils/propVerify.js.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { predictInWorker } from '../services/p533/predictInWorker.js';
import { useIBPMeasurements } from '../hooks/useIBPMeasurements.js';
import { measuredBandSummary } from '../utils/ibpMeasured.js';
import { ANTENNA_PROFILES, modeRequiredSNR } from '../utils/propagationAdjust.js';
import { getCallsignInfo } from '../utils/callsign.js';
import {
  VERIFY_BANDS,
  CONTINENT_POINTS,
  OBSERVED_WINDOW_MS,
  countObservedByBand,
  maxAcrossContinents,
  buildComparison,
  pickCellReliability,
  nearestContinent,
} from '../utils/propVerify.js';

const BAND_FREQ_MHZ = { '80m': 3.5, '40m': 7, '30m': 10, '20m': 14, '17m': 18, '15m': 21, '12m': 24, '10m': 28 };
const PREDICT_REFRESH_MS = 10 * 60 * 1000;
const OBSERVED_TICK_MS = 30 * 1000;

// Map a P.533 output frequency to the nearest verify band (±2 MHz, same
// tolerance as the propagation engine adapters).
function freqToVerifyBand(freq) {
  let best = null;
  let bestDist = Infinity;
  for (const [band, f] of Object.entries(BAND_FREQ_MHZ)) {
    const d = Math.abs(freq - f);
    if (d < bestDist) {
      bestDist = d;
      best = band;
    }
  }
  return bestDist < 2 ? best : null;
}

const VERDICT_STYLE = {
  agrees: { glyph: '≈', color: 'var(--accent-green)' },
  better: { glyph: '▲', color: 'var(--accent-cyan)' },
  worse: { glyph: '▼', color: 'var(--accent-amber)' },
  nodata: { glyph: '—', color: 'var(--text-muted)' },
};

export const PropVerifyPanel = ({
  deLocation,
  deCallsign,
  dxSpots = [],
  pskReporter,
  solarIndices,
  propConfig = {},
}) => {
  const { t } = useTranslation();

  const mode = propConfig.mode || 'SSB';
  const power = propConfig.power || 100;
  const antenna = propConfig.antenna || 'isotropic';
  const ssn = solarIndices?.data?.ssn?.current ?? 100;

  const [prediction, setPrediction] = useState(null); // { matrix, engine, hour }
  const [predError, setPredError] = useState(false);
  const runningRef = useRef(false);

  // ── Predicted side: DE → each continent's representative point, this hour ──
  useEffect(() => {
    if (!deLocation || !Number.isFinite(deLocation.lat)) return;
    let cancelled = false;

    const run = async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      const now = new Date();
      const hour = now.getUTCHours();
      try {
        // Primary: browser WASM P.533 — one call per continent for the current hour.
        const txGain = (ANTENNA_PROFILES[antenna] || ANTENNA_PROFILES.isotropic).gain;
        const requiredSNR = modeRequiredSNR(mode);
        const matrix = {};
        for (const [cont, pt] of Object.entries(CONTINENT_POINTS)) {
          const result = await predictInWorker({
            txLat: deLocation.lat,
            txLon: deLocation.lon,
            rxLat: pt.lat,
            rxLon: pt.lon,
            year: now.getUTCFullYear(),
            month: now.getUTCMonth() + 1,
            hour,
            ssn,
            txPower: parseFloat(power) || 100,
            txGain,
            requiredSNR,
          });
          if (cancelled) return;
          for (const f of result.frequencies || []) {
            const band = freqToVerifyBand(f.freq);
            if (!band) continue;
            if (!matrix[band]) matrix[band] = {};
            matrix[band][cont] = Math.max(0, Math.min(99, Math.round(f.reliability)));
          }
        }
        if (!cancelled) {
          setPrediction({ matrix, engine: 'wasm', hour });
          setPredError(false);
        }
      } catch (err) {
        // Fallback: sample the server's heuristic heatmap near each continent
        // point — coarse (20° grid), but keeps the panel alive for
        // self-hosters without the WASM bundle.
        console.warn('[PropVerify] WASM engine unavailable, sampling REST heatmap:', err.message);
        try {
          const matrix = {};
          for (const band of VERIFY_BANDS) {
            const params = new URLSearchParams({
              deLat: Math.round(deLocation.lat),
              deLon: Math.round(deLocation.lon),
              freq: BAND_FREQ_MHZ[band],
              grid: 20,
              mode,
              power,
              antenna,
            });
            const res = await fetch(`/api/propagation/heatmap?${params}`);
            if (cancelled) return;
            if (!res.ok) continue;
            const data = await res.json();
            matrix[band] = {};
            for (const [cont, pt] of Object.entries(CONTINENT_POINTS)) {
              const r = pickCellReliability(data.cells, pt.lat, pt.lon);
              if (r != null) matrix[band][cont] = r;
            }
          }
          if (!cancelled) {
            setPrediction(Object.keys(matrix).length ? { matrix, engine: 'est', hour } : null);
            setPredError(Object.keys(matrix).length === 0);
          }
        } catch (err2) {
          console.error('[PropVerify] Prediction fallback failed:', err2);
          if (!cancelled) setPredError(true);
        }
      } finally {
        runningRef.current = false;
      }
    };

    run();
    const interval = setInterval(run, PREDICT_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [deLocation?.lat, deLocation?.lon, mode, power, antenna, ssn]);

  // ── Observed side: 15-min spot counts, re-evaluated every 30 s ──
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNowTick(Date.now()), OBSERVED_TICK_MS);
    return () => clearInterval(iv);
  }, []);

  const deContinent = useMemo(() => {
    const fromCall = getCallsignInfo(deCallsign)?.continent;
    if (fromCall) return fromCall;
    return deLocation ? nearestContinent(deLocation.lat, deLocation.lon) : 'NA';
  }, [deCallsign, deLocation?.lat, deLocation?.lon]);

  const { counts, totalSpots } = useMemo(() => {
    const pskSpots = [...(pskReporter?.txReports || []), ...(pskReporter?.rxReports || [])].map((r) => ({
      band: r.band,
      timestamp: r.timestamp,
      involvesDe: true, // PSKReporter reports are already filtered to the user's station
    }));
    const all = [...dxSpots, ...pskSpots];
    const c = countObservedByBand(all, { deContinent, now: nowTick });
    return { counts: c, totalSpots: Object.values(c).reduce((s, n) => s + n, 0) };
  }, [dxSpots, pskReporter?.txReports, pskReporter?.rxReports, deContinent, nowTick]);

  // ── Third source: measured IBP beacon SNR from a KiwiSDR beacon monitor ──
  // (Rig Bridge plugin; empty unless the user enabled it in Settings → Rig
  // Bridge). Best SNR per band in the last 20 min, normalized to 0–99.
  const ibpMeasured = useIBPMeasurements();
  const beaconsByBand = useMemo(
    () => (ibpMeasured.measurements.length ? measuredBandSummary(ibpMeasured.measurements, { now: nowTick }) : null),
    [ibpMeasured.measurements, nowTick],
  );
  const hasBeacons = !!beaconsByBand && Object.keys(beaconsByBand).length > 0;

  const rows = useMemo(
    () => buildComparison(maxAcrossContinents(prediction?.matrix), counts, beaconsByBand),
    [prediction, counts, beaconsByBand],
  );

  const verdictLabel = (key) =>
    ({
      agrees: t('propVerify.agrees', { defaultValue: 'agrees' }),
      better: t('propVerify.better', { defaultValue: 'better' }),
      worse: t('propVerify.worse', { defaultValue: 'worse' }),
      nodata: t('propVerify.nodata', { defaultValue: 'no data' }),
    })[key] || key;

  return (
    <div className="panel" style={{ padding: '8px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          marginBottom: '6px',
          fontSize: '11px',
          color: 'var(--accent-primary)',
          fontWeight: '700',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <span>🎯 {t('propVerify.title', { defaultValue: 'PREDICTION CHECK' })}</span>
        <span style={{ fontSize: '9px', fontWeight: '400', color: 'var(--text-muted)' }}>
          {deContinent} · {mode} {power >= 1000 ? `${power / 1000}kW` : `${power}W`}
          {prediction?.engine && (
            <span
              title={
                prediction.engine === 'wasm'
                  ? t('propVerify.engineWasm', { defaultValue: 'ITU-R P.533-14, computed in your browser' })
                  : t('propVerify.engineEst', { defaultValue: 'Solar-indices estimation (WASM engine unavailable)' })
              }
              style={{
                marginLeft: '4px',
                border: `1px solid ${prediction.engine === 'wasm' ? 'var(--accent-cyan)' : 'var(--accent-amber)'}`,
                color: prediction.engine === 'wasm' ? 'var(--accent-cyan)' : 'var(--accent-amber)',
                borderRadius: '3px',
                padding: '0 3px',
                fontWeight: '600',
              }}
            >
              {prediction.engine.toUpperCase()}
            </span>
          )}
        </span>
      </div>

      {/* Column legend */}
      <div style={{ display: 'flex', gap: '10px', fontSize: '9px', color: 'var(--text-muted)', marginBottom: '4px' }}>
        <span>
          <span style={{ color: 'var(--accent-cyan)' }}>▬</span>{' '}
          {t('propVerify.legendPredicted', { defaultValue: 'predicted (best continent)' })}
        </span>
        <span>
          <span style={{ color: 'var(--accent-green)' }}>▬</span>{' '}
          {t('propVerify.legendObserved', { defaultValue: 'observed (15-min spots)' })}
        </span>
        {hasBeacons && (
          <span>
            <span style={{ color: 'var(--accent-amber)' }}>▬</span>{' '}
            {t('propVerify.legendBeacons', { defaultValue: 'beacons (measured SNR, 20 min)' })}
          </span>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {!prediction && !predError ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '10px', padding: '10px 4px' }}>
            {t('propVerify.loading', { defaultValue: 'Running P.533 predictions per continent…' })}
          </div>
        ) : (
          rows.map((row) => {
            const vs = VERDICT_STYLE[row.verdict] || VERDICT_STYLE.nodata;
            return (
              <div
                key={row.band}
                title={
                  row.predicted != null
                    ? `${row.band}: ${t('propVerify.rowTooltip', {
                        defaultValue: 'predicted {{pred}}% · {{count}} spots in 15 min',
                        pred: row.predicted,
                        count: row.count,
                      })}`
                    : undefined
                }
                style={{
                  display: 'grid',
                  gridTemplateColumns: '30px 1fr 30px 62px',
                  gap: '6px',
                  alignItems: 'center',
                  padding: '2px 0',
                  borderBottom: '1px solid var(--border-color)',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)' }}>
                  {row.band}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span
                    style={{
                      position: 'relative',
                      height: '5px',
                      background: 'var(--bg-tertiary)',
                      borderRadius: '2px',
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        inset: '0 auto 0 0',
                        width: `${row.predicted ?? 0}%`,
                        background: 'var(--accent-cyan)',
                        borderRadius: '2px',
                        opacity: 0.85,
                      }}
                    />
                  </span>
                  <span
                    style={{
                      position: 'relative',
                      height: '5px',
                      background: 'var(--bg-tertiary)',
                      borderRadius: '2px',
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        inset: '0 auto 0 0',
                        width: `${row.observed}%`,
                        background: 'var(--accent-green)',
                        borderRadius: '2px',
                        opacity: 0.85,
                      }}
                    />
                  </span>
                  {row.beacon && (
                    <span
                      title={t('propVerify.beaconTooltip', {
                        defaultValue:
                          'KiwiSDR beacon monitor: best {{snr}} dB SNR on {{band}} in the last 20 min → {{verdict}}',
                        snr: row.beacon.maxSnr >= 0 ? `+${row.beacon.maxSnr}` : row.beacon.maxSnr,
                        band: row.band,
                        verdict: verdictLabel(row.beacon.verdict),
                      })}
                      style={{
                        position: 'relative',
                        height: '5px',
                        background: 'var(--bg-tertiary)',
                        borderRadius: '2px',
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          inset: '0 auto 0 0',
                          width: `${row.beacon.score}%`,
                          background: 'var(--accent-amber)',
                          borderRadius: '2px',
                          opacity: 0.85,
                        }}
                      />
                    </span>
                  )}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '9px',
                    color: 'var(--text-muted)',
                    textAlign: 'right',
                  }}
                >
                  {row.count}✦
                </span>
                <span
                  style={{
                    fontSize: '9px',
                    fontFamily: 'var(--font-mono)',
                    color: vs.color,
                    border: `1px solid ${vs.color}`,
                    borderRadius: '3px',
                    padding: '0 4px',
                    textAlign: 'center',
                    opacity: row.verdict === 'nodata' ? 0.6 : 1,
                  }}
                >
                  {vs.glyph} {verdictLabel(row.verdict)}
                </span>
              </div>
            );
          })
        )}
        {predError && (
          <div style={{ color: 'var(--accent-amber)', fontSize: '9px', padding: '4px' }}>
            {t('propVerify.predError', {
              defaultValue: 'Prediction engine unavailable — showing observed activity only.',
            })}
          </div>
        )}
      </div>

      <div
        style={{
          borderTop: '1px solid var(--border-color)',
          fontSize: '9px',
          color: 'var(--text-muted)',
          paddingTop: '3px',
          lineHeight: 1.4,
        }}
      >
        {t('propVerify.footnote', {
          defaultValue:
            'Heuristic: spot counts measure operator activity, not path reliability — a quiet band is not a wrong model. {{n}} spots in window.',
          n: totalSpots,
        })}
      </div>
    </div>
  );
};

export default PropVerifyPanel;
