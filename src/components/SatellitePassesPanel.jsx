/**
 * SatellitePassesPanel — upcoming passes for every tracked satellite over
 * the DE station, computed locally with the same Orbit propagator the
 * satellite layer uses. Recomputed every 30 minutes (and when the tracked
 * list changes); countdowns tick locally between recomputes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Orbit from '../utils/orbit.js';
import { displayNowMs, subscribeDisplayTime } from '../utils/displayTime.js';

const RECOMPUTE_MS = 30 * 60 * 1000;
const WINDOW_HOURS = 24;
const MAX_ROWS = 30;
const MAX_PASSES_PER_SAT = 6;

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

function countdown(ms) {
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function computePasses(sats, groundStation, minElevation, nowMs = displayNowMs()) {
  const start = new Date(nowMs - 30 * 60 * 1000); // catch in-progress passes
  const end = new Date(nowMs + WINDOW_HOURS * 3600 * 1000);
  const passes = [];
  for (const sat of sats) {
    if (!sat?.omm) continue;
    try {
      const orbit = new Orbit(sat.name, sat.omm);
      const satPasses = orbit.computePassesElevation(groundStation, start, end, minElevation, MAX_PASSES_PER_SAT);
      for (const p of satPasses) passes.push(p);
    } catch {
      // bad/stale OMM for one bird shouldn't empty the whole table
    }
  }
  const now = nowMs;
  return passes
    .filter((p) => p.end > now)
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_ROWS);
}

export const SatellitePassesPanel = ({ satellites, config }) => {
  // "now" is the display time, so a time shift re-plans the pass list.
  const [now, setNow] = useState(() => displayNowMs());
  const [passTick, setPassTick] = useState(0);
  const satsRef = useRef([]);
  satsRef.current = satellites?.data || [];

  useEffect(() => {
    const id = setInterval(() => setNow(displayNowMs()), 15_000);
    const recompute = setInterval(() => setPassTick((t) => t + 1), RECOMPUTE_MS);
    const unsub = subscribeDisplayTime(() => {
      setNow(displayNowMs());
      setPassTick((t) => t + 1);
    });
    return () => {
      clearInterval(id);
      clearInterval(recompute);
      unsub();
    };
  }, []);

  const lat = config?.location?.lat ?? 0;
  const lon = config?.location?.lon ?? 0;
  const height = config?.location?.stationAlt ?? 100;
  const minElev = config?.satellite?.minElev ?? 5;

  // Key on WHICH satellites have orbital data — not on the 5-second
  // position refresh — so the (expensive) propagation runs only when the
  // tracked list or station actually changes, or on the 30-min tick.
  const trackedKey = (satellites?.data || [])
    .filter((s) => s.omm)
    .map((s) => s.name)
    .sort()
    .join(',');

  const passes = useMemo(
    () => computePasses(satsRef.current, { latitude: lat, longitude: lon, height }, minElev),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trackedKey, passTick, lat, lon, height, minElev],
  );

  const upcoming = passes.filter((p) => p.end > now);

  return (
    <div className="panel" style={{ padding: '8px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          marginBottom: '6px',
          fontSize: '11px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          color: 'var(--accent-primary)',
          fontWeight: '700',
        }}
      >
        <span>SATELLITE PASSES</span>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '9px' }}>
          next {WINDOW_HOURS}h · el ≥ {minElev}°
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
        {satellites?.loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '10px' }}>
            <div className="loading-spinner" />
          </div>
        ) : upcoming.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '10px', fontSize: '11px' }}>
            {trackedKey
              ? 'No passes in the next 24 hours'
              : 'No satellites tracked — pick some in Settings → Satellites'}
          </div>
        ) : (
          upcoming.map((pass) => {
            const live = pass.start <= now && now <= pass.end;
            return (
              <div
                key={`${pass.name}-${pass.start}`}
                style={{
                  padding: '5px 6px',
                  marginBottom: '3px',
                  borderRadius: '4px',
                  background: live ? 'rgba(74, 222, 128, 0.12)' : 'rgba(255,255,255,0.03)',
                  border: live ? '1px solid rgba(74, 222, 128, 0.4)' : '1px solid transparent',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: live ? '#4ade80' : 'var(--text-primary)', fontWeight: 600 }}>
                    {live && (
                      <span style={{ fontSize: '8px', animation: 'pulse 1.5s infinite', marginRight: '4px' }}>●</span>
                    )}
                    {pass.name}
                  </span>
                  <span style={{ color: live ? '#4ade80' : 'var(--accent-cyan)', fontWeight: 600 }}>
                    {live ? `LOS in ${countdown(pass.end - now)}` : countdown(pass.start - now)}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginTop: '2px',
                    color: 'var(--text-muted)',
                  }}
                >
                  <span>
                    {fmtTime(pass.start)}–{fmtTime(pass.end)} · {Math.round(pass.duration / 60000)} min
                  </span>
                  <span>
                    {compass(pass.azimuthStart)}→{compass(pass.azimuthEnd)} · max{' '}
                    <span
                      style={{
                        color:
                          pass.maxElevation >= 60
                            ? '#4ade80'
                            : pass.maxElevation >= 30
                              ? '#fbbf24'
                              : 'var(--text-secondary)',
                        fontWeight: 600,
                      }}
                    >
                      {Math.round(pass.maxElevation)}°
                    </span>
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default SatellitePassesPanel;
