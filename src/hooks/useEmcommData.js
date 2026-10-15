/**
 * useEmcommData Hook
 * Polls NWS Alerts, FEMA Shelters, and FEMA Disaster Declarations.
 * Zero API calls when not in EmComm layout.
 *
 * Offline: when a request fails, alerts and shelters fall back to the
 * newest last-known copy — the service worker's cached response or an
 * offline area pack snapshot (Settings → Map Layers → Offline map areas) —
 * and `asOf.alerts` / `asOf.shelters` carry its timestamp (null when live).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../utils/apiFetch';
import { fetchWithPackFallback } from '../utils/offlinePackStore.js';

const ALERTS_INTERVAL = 3 * 60 * 1000; // 3 min
const SHELTERS_INTERVAL = 5 * 60 * 1000; // 5 min
const DISASTERS_INTERVAL = 15 * 60 * 1000; // 15 min

export const useEmcommData = (options = {}) => {
  // includeDisasters: false skips FEMA declarations (and the reverse-geocode
  // they need) for callers that don't show them, e.g. the Mobile EmComm card.
  const { location, enabled = false, includeDisasters = true } = options;

  const [alerts, setAlerts] = useState([]);
  const [shelters, setShelters] = useState([]);
  const [disasters, setDisasters] = useState([]);
  const [loading, setLoading] = useState(false);
  // Timestamp of the last-known copy being shown per kind (null = live)
  const [asOf, setAsOf] = useState({ alerts: null, shelters: null });
  // When each kind last came back live — an older offline copy never
  // replaces newer live data that is already on screen.
  const liveAtRef = useRef({ alerts: 0, shelters: 0 });

  const locationRef = useRef(location);
  locationRef.current = location;
  const resolvedStateRef = useRef(null);

  // Reverse geocode lat/lon to state code via Nominatim
  const resolveState = useCallback(async (loc) => {
    if (loc.state || loc.lat == null || loc.lon == null) return loc;
    // Use cached result if location hasn't changed
    if (resolvedStateRef.current?.lat === loc.lat && resolvedStateRef.current?.lon === loc.lon) {
      return { ...loc, state: resolvedStateRef.current.state };
    }
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${loc.lat}&lon=${loc.lon}&format=json&zoom=5`,
        { headers: { 'User-Agent': 'OpenHamClock' } },
      );
      const data = await res.json();
      const iso = data?.address?.['ISO3166-2-lvl4']; // e.g., "US-CO"
      if (iso) {
        const state = iso.split('-')[1];
        resolvedStateRef.current = { lat: loc.lat, lon: loc.lon, state };
        return { ...loc, state };
      }
    } catch {
      // Silently fail — disasters panel just stays empty
    }
    return loc;
  }, []);

  // Live fetch with offline fallback; `apply` receives the array to show.
  const fetchKind = useCallback(async (kind, url, apply) => {
    const loc = locationRef.current;
    try {
      const r = await fetchWithPackFallback(apiFetch, url, { cache: 'no-store' }, { kind, lat: loc.lat, lon: loc.lon });
      if (!r || r.source === 'none') return;
      if (r.source === 'live') {
        liveAtRef.current[kind] = Date.now();
        apply(Array.isArray(r.data) ? r.data : []);
        setAsOf((prev) => (prev[kind] == null ? prev : { ...prev, [kind]: null }));
        return;
      }
      if ((r.fetchedAt || 0) <= liveAtRef.current[kind]) return;
      apply(Array.isArray(r.data) ? r.data : []);
      setAsOf((prev) => ({ ...prev, [kind]: r.fetchedAt || null }));
    } catch (err) {
      console.error(`[EmComm] ${kind} fetch error:`, err);
    }
  }, []);

  const fetchAlerts = useCallback(async () => {
    const loc = locationRef.current;
    if (loc?.lat == null || loc?.lon == null) return;
    await fetchKind('alerts', `/api/emcomm/alerts?lat=${loc.lat}&lon=${loc.lon}`, setAlerts);
  }, [fetchKind]);

  const fetchShelters = useCallback(async () => {
    const loc = locationRef.current;
    if (loc?.lat == null || loc?.lon == null) return;
    await fetchKind('shelters', `/api/emcomm/shelters?lat=${loc.lat}&lon=${loc.lon}&radius=200`, setShelters);
  }, [fetchKind]);

  const fetchDisasters = useCallback(async () => {
    const loc = locationRef.current;
    // Resolve state from lat/lon if not already set
    const resolved = await resolveState(loc || {});
    if (!resolved?.state) return;
    // Update ref so subsequent calls use cached state
    if (!locationRef.current?.state && resolved.state) {
      locationRef.current = { ...locationRef.current, state: resolved.state };
    }
    try {
      const res = await apiFetch(`/api/emcomm/disasters?state=${encodeURIComponent(resolved.state)}`, {
        cache: 'no-store',
      });
      if (res?.ok) {
        const data = await res.json();
        setDisasters(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('[EmComm] Disasters fetch error:', err);
    }
  }, [resolveState]);

  // Poll all endpoints at different intervals
  useEffect(() => {
    if (!enabled) {
      // Clear data when disabled
      setAlerts([]);
      setShelters([]);
      setDisasters([]);
      setAsOf({ alerts: null, shelters: null });
      liveAtRef.current = { alerts: 0, shelters: 0 };
      return;
    }

    setLoading(true);

    // Initial fetch
    Promise.all([fetchAlerts(), fetchShelters(), includeDisasters ? fetchDisasters() : null]).finally(() =>
      setLoading(false),
    );

    const alertsTimer = setInterval(fetchAlerts, ALERTS_INTERVAL);
    const sheltersTimer = setInterval(fetchShelters, SHELTERS_INTERVAL);
    const disastersTimer = includeDisasters ? setInterval(fetchDisasters, DISASTERS_INTERVAL) : null;

    return () => {
      clearInterval(alertsTimer);
      clearInterval(sheltersTimer);
      clearInterval(disastersTimer);
    };
  }, [enabled, includeDisasters, fetchAlerts, fetchShelters, fetchDisasters]);

  return { alerts, shelters, disasters, loading, asOf, state: resolvedStateRef.current?.state ?? null };
};
