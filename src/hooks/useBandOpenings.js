/**
 * useBandOpenings Hook
 * Polls GET /api/band-openings (server-side surge detection over the RBN and
 * DX-cluster spot streams — see server/routes/band-openings.js) every 75 s.
 *
 * Returns:
 *   data       — the raw payload { generated_at, warming, openings, zone_openings, … }
 *   alertItems — the openings relevant to this station (see the alert scope,
 *                #1191), shaped for the audio-alert engine
 *   scope      — the scope actually applied after fallbacks
 *   zone       — the CQ zone used for 'my-zone' (override or callsign-derived)
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import { useVisibilityRefresh } from './useVisibilityRefresh';
import { apiFetch } from '../utils/apiFetch';
import { selectBandOpenings, openingKey, normalizeZone } from '../utils/bandOpeningScope';
import { getAlertSettings, ALERT_SETTINGS_EVENT, DEFAULT_BAND_OPENING_SCOPE } from '../utils/audioAlerts';

const POLL_INTERVAL_MS = 75 * 1000; // between the server's 60 s recompute and 90 s

/** Band Openings alert scope + zone override, re-read whenever settings are saved. */
function readScopeSettings() {
  const conf = getAlertSettings()['band-openings'] || {};
  return { scope: conf.scope || DEFAULT_BAND_OPENING_SCOPE, zoneOverride: normalizeZone(conf.zoneOverride) };
}

/**
 * @param {{ myZone?: number|null, myContinent?: string|null }} [station]
 *   the operator's CQ zone / continent (from their callsign). The alert
 *   scope (#1191) narrows the server's worldwide list to what is relevant
 *   here: my zone (default), my continent, or everything.
 */
export const useBandOpenings = ({ myZone = null, myContinent = null } = {}) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scopeSettings, setScopeSettings] = useState(readScopeSettings);
  const fetchRef = useRef(null);
  // openingKey → hour bucket when this client first observed the episode
  const firstSeenRef = useRef(new Map());

  useEffect(() => {
    const fetchOpenings = async () => {
      try {
        const res = await apiFetch('/api/band-openings', { cache: 'no-store' });
        if (res?.ok) setData(await res.json());
      } catch (err) {
        console.error('Band openings error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchOpenings();
    fetchRef.current = fetchOpenings;
    const interval = setInterval(fetchOpenings, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  useVisibilityRefresh(() => fetchRef.current?.(), POLL_INTERVAL_MS);

  // Scope changes in Settings take effect on the next render, not the next poll.
  useEffect(() => {
    const onChange = () => setScopeSettings(readScopeSettings());
    window.addEventListener(ALERT_SETTINGS_EVENT, onChange);
    return () => window.removeEventListener(ALERT_SETTINGS_EVENT, onChange);
  }, []);

  const zone = scopeSettings.zoneOverride ?? normalizeZone(myZone);
  const { items: scoped, effectiveScope } = useMemo(
    () => selectBandOpenings(data, { scope: scopeSettings.scope, myZone: zone, myContinent }),
    [data, scopeSettings.scope, zone, myContinent],
  );

  // Shape for the audio-alert engine. Each live episode carries the hour
  // bucket in which this client FIRST saw it, so the alert item key
  // (band+from+to+firstSeenHour) stays stable for the episode's whole
  // lifetime — one alert per opening, no re-alerts as the state machine
  // moves opening → active → closing. Suppressed while the baseline warms.
  const alertItems = useMemo(() => {
    if (!data || data.warming) return [];
    const generatedMs = Date.parse(data.generated_at || '') || Date.now();
    const hourBucket = Math.floor(generatedMs / (60 * 60 * 1000));
    const live = new Set();
    const items = [];
    for (const o of scoped) {
      if (!o?.band) continue;
      const key = openingKey(o);
      live.add(key);
      if (!firstSeenRef.current.has(key)) firstSeenRef.current.set(key, hourBucket);
      // Every live state is kept (closing included) so brief
      // opening↔closing flapping never re-alerts.
      items.push({ ...o, firstSeenHour: firstSeenRef.current.get(key) });
    }
    // Episodes that left the list entirely (past the closing linger, or
    // scoped out) can re-alert if they surge again later.
    for (const key of firstSeenRef.current.keys()) {
      if (!live.has(key)) firstSeenRef.current.delete(key);
    }
    return items;
  }, [data, scoped]);

  return { data, alertItems, loading, scope: effectiveScope, zone };
};

export default useBandOpenings;
