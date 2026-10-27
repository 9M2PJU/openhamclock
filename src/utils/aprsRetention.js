/**
 * aprsRetention — client-side dwell and persistence for APRS stations (#1190).
 *
 * The server keeps stations for APRS_MAX_AGE_MINUTES (default 60) and RF
 * stations heard through a local TNC never touch the server at all, so a
 * page refresh used to wipe every RF symbol off the map. Emergency operators
 * need those to survive a refresh and to linger for hours, not one.
 *
 * This module holds the pure pieces: the dwell option list, pruning, merging
 * server snapshots into a retained map, and the localStorage round-trip.
 * The hook (useAPRS) wires them to React state.
 */

export const DWELL_KEY = 'openhamclock_aprsDwellMinutes';
export const CLEARED_AT_KEY = 'openhamclock_aprsClearedAt';
export const RF_STORE_KEY = 'openhamclock_aprsRfStations';
export const NET_STORE_KEY = 'openhamclock_aprsNetStations';

/** Minutes a station stays after it was last heard. 30 min → 12 h. */
export const DWELL_OPTIONS_MINUTES = [30, 60, 90, 120, 180, 240, 300, 360, 480, 720];
export const DEFAULT_DWELL_MINUTES = 60;

/** Hard cap per retained store so a wide APRS-IS filter cannot fill localStorage. */
export const MAX_RETAINED = 2000;

/** Stable key for a station record (full SSID when present). */
export const stationKey = (s) => s?.ssid ?? s?.source ?? s?.call ?? null;

/** Epoch ms the station was last heard, or 0 when unknown. */
export const stationTime = (s) => {
  const ts = Number(s?.timestamp);
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
};

export function readDwellMinutes(storage = globalThis.localStorage) {
  try {
    const v = Number(storage?.getItem(DWELL_KEY));
    return DWELL_OPTIONS_MINUTES.includes(v) ? v : DEFAULT_DWELL_MINUTES;
  } catch {
    return DEFAULT_DWELL_MINUTES;
  }
}

export function writeDwellMinutes(minutes, storage = globalThis.localStorage) {
  try {
    storage?.setItem(DWELL_KEY, String(minutes));
  } catch {
    /* storage unavailable */
  }
}

export function readClearedAt(storage = globalThis.localStorage) {
  try {
    const v = Number(storage?.getItem(CLEARED_AT_KEY));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

export function writeClearedAt(ms, storage = globalThis.localStorage) {
  try {
    storage?.setItem(CLEARED_AT_KEY, String(ms));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Drop stations last heard before `now - dwellMs`, or at/before `clearedAt`
 * (the operator's last "clear" — anything older than that stays gone until a
 * fresh beacon arrives). Returns the same Map instance when nothing changed
 * so React state consumers can skip a re-render.
 */
export function pruneStations(map, { dwellMs, now = Date.now(), clearedAt = 0 }) {
  const cutoff = Math.max(now - dwellMs, clearedAt);
  let changed = false;
  const next = new Map();
  for (const [key, st] of map) {
    if (stationTime(st) <= cutoff) {
      changed = true;
      continue;
    }
    next.set(key, st);
  }
  return changed ? next : map;
}

/**
 * Fold a server snapshot into the retained map. A station already retained
 * is replaced only when the snapshot's copy is at least as fresh; stations
 * heard at/before `clearedAt` are ignored so a clear sticks. Returns the same
 * Map instance when nothing changed.
 */
export function mergeStations(map, list, { clearedAt = 0 } = {}) {
  if (!Array.isArray(list) || list.length === 0) return map;
  let next = null;
  for (const st of list) {
    const key = stationKey(st);
    if (!key) continue;
    const t = stationTime(st);
    if (t <= clearedAt) continue;
    const prev = map.get(key);
    if (prev && stationTime(prev) > t) continue;
    if (prev && stationTime(prev) === t && prev === st) continue;
    if (!next) next = new Map(map);
    next.set(key, st);
  }
  return next || map;
}

/** Keep the newest `cap` stations (by last-heard time). */
export function capStations(map, cap = MAX_RETAINED) {
  if (map.size <= cap) return map;
  const sorted = [...map.entries()].sort((a, b) => stationTime(b[1]) - stationTime(a[1]));
  return new Map(sorted.slice(0, cap));
}

/** Load a retained store, pruned to the current dwell / clear point. */
export function loadStations(key, opts, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const map = new Map();
    for (const st of parsed) {
      const k = stationKey(st);
      if (k && st && typeof st === 'object') map.set(k, st);
    }
    return pruneStations(map, opts);
  } catch {
    return new Map();
  }
}

/** Persist a retained store (capped). Silently no-ops when storage is unavailable or full. */
export function saveStations(key, map, storage = globalThis.localStorage) {
  try {
    const capped = capStations(map);
    if (capped.size === 0) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify([...capped.values()]));
  } catch {
    /* quota exceeded or storage unavailable — in-memory state still works */
  }
}
