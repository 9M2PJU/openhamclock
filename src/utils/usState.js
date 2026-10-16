/**
 * US state for a coordinate — FEMA disaster declarations are listed per
 * state. Reverse-geocodes through Nominatim (OpenStreetMap), one request per
 * location, remembered in memory. Used live by the EmComm layout and once,
 * at download time, by offline area packs (so the declarations can be
 * saved with the area while the internet is still up).
 */

const memo = new Map();

const key = (lat, lon) => `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;

/** "US-CO" → "CO"; anything else (outside the US, junk) → null. */
export function stateFromIso(iso) {
  const m = /^US-([A-Z]{2})$/.exec(String(iso || ''));
  return m ? m[1] : null;
}

/**
 * Two-letter state code for lat/lon, or null (outside the US, offline,
 * lookup failed). Never throws.
 */
export async function resolveUsState(lat, lon, fetchImpl = fetch) {
  if (lat == null || lon == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  const k = key(lat, lon);
  if (memo.has(k)) return memo.get(k);
  try {
    const res = await fetchImpl(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=5`,
      { headers: { 'User-Agent': 'OpenHamClock' } },
    );
    if (!res?.ok) return null;
    const data = await res.json();
    const state = stateFromIso(data?.address?.['ISO3166-2-lvl4']);
    memo.set(k, state);
    return state;
  } catch {
    return null; // not remembered — try again next time
  }
}

/** Test hook. */
export function _clearUsStateMemo() {
  memo.clear();
}
