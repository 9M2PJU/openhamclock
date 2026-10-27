/**
 * Santa tracker — where the sleigh is on Christmas Eve.
 *
 * Christmas easter egg for the 3D globe (and a marker on the 2D map). Pure
 * functions only; the globe asks getSantaState(now) each frame.
 *
 * Route model (the classic NORAD shape): Santa launches from the North Pole
 * the moment it turns midnight on 25 December in the first time zone
 * (UTC+14, Kiritimati — 10:00 UTC on 24 December) and works westward one
 * time zone per hour, zig-zagging north and south through recognisable
 * cities in each zone, until the last stops in UTC-11 about 25 hours later.
 * Before launch and after the run he is parked at the Pole; outside
 * 24–25 December (UTC) he is not shown at all.
 *
 * Positions between stops are great-circle interpolated (slerp on unit
 * vectors), so the date-line crossing at the start is seamless.
 */

const START_HOUR_UTC = 10; // 24 Dec 10:00Z = 00:00 on 25 Dec at UTC+14
const KIDS_TOTAL = 2_200_000_000; // roughly the world's under-15s
const NORTH_POLE = { name: 'the North Pole', lat: 89.9, lon: 0 };

// [name, lat, lon, hours after launch]. Ordered by time. Hours follow civil
// midnight in each zone (t = 14 − UTC offset), with a spread inside each
// zone so the sleigh visits several cities rather than sitting on one.
// Southern-hemisphere DST (Sydney UTC+11, Santiago UTC-3, …) is baked in.
export const SANTA_STOPS = [
  ['Kiritimati', 1.87, -157.4, 0.0],
  ["Nuku'alofa", -21.1, -175.2, 1.0],
  ['Apia', -13.8, -171.8, 1.4],
  ['Auckland', -36.8, 174.8, 2.0],
  ['Suva', -18.1, 178.4, 2.4],
  ['Petropavlovsk', 53.0, 158.6, 2.7],
  ['Hobart', -42.9, 147.3, 3.0],
  ['Melbourne', -37.8, 145.0, 3.15],
  ['Sydney', -33.9, 151.2, 3.3],
  ['Nouméa', -22.3, 166.4, 3.5],
  ['Adelaide', -34.9, 138.6, 3.7],
  ['Brisbane', -27.5, 153.0, 4.0],
  ['Port Moresby', -9.4, 147.2, 4.3],
  ['Darwin', -12.5, 130.8, 4.5],
  ['Vladivostok', 43.1, 131.9, 4.7],
  ['Tokyo', 35.7, 139.7, 5.0],
  ['Seoul', 37.6, 127.0, 5.3],
  ['Pyongyang', 39.0, 125.8, 5.5],
  ['Perth', -31.9, 115.9, 6.0],
  ['Manila', 14.6, 121.0, 6.2],
  ['Beijing', 39.9, 116.4, 6.4],
  ['Shanghai', 31.2, 121.5, 6.5],
  ['Hong Kong', 22.3, 114.2, 6.65],
  ['Singapore', 1.35, 103.8, 6.8],
  ['Kuala Lumpur', 3.1, 101.7, 6.9],
  ['Jakarta', -6.2, 106.8, 7.0],
  ['Bangkok', 13.8, 100.5, 7.2],
  ['Hanoi', 21.0, 105.8, 7.4],
  ['Novosibirsk', 55.0, 82.9, 7.7],
  ['Dhaka', 23.8, 90.4, 8.0],
  ['Almaty', 43.2, 76.9, 8.3],
  ['New Delhi', 28.6, 77.2, 8.5],
  ['Mumbai', 19.1, 72.9, 8.7],
  ['Colombo', 6.9, 79.9, 8.85],
  ['Karachi', 24.9, 67.0, 9.0],
  ['Tashkent', 41.3, 69.2, 9.2],
  ['Malé', 4.2, 73.5, 9.4],
  ['Dubai', 25.2, 55.3, 10.0],
  ['Tbilisi', 41.7, 44.8, 10.2],
  ['Port Louis', -20.2, 57.5, 10.4],
  ['Tehran', 35.7, 51.4, 10.6],
  ['Moscow', 55.8, 37.6, 11.0],
  ['Riyadh', 24.7, 46.7, 11.2],
  ['Nairobi', -1.3, 36.8, 11.4],
  ['Antananarivo', -18.9, 47.5, 11.6],
  ['Istanbul', 41.0, 28.9, 11.8],
  ['Cairo', 30.0, 31.2, 12.0],
  ['Jerusalem', 31.8, 35.2, 12.1],
  ['Athens', 38.0, 23.7, 12.25],
  ['Kyiv', 50.5, 30.5, 12.35],
  ['Helsinki', 60.2, 24.9, 12.45],
  ['Johannesburg', -26.2, 28.0, 12.65],
  ['Cape Town', -33.9, 18.4, 12.85],
  ['Rome', 41.9, 12.5, 13.0],
  ['Vienna', 48.2, 16.4, 13.1],
  ['Berlin', 52.5, 13.4, 13.2],
  ['Stockholm', 59.3, 18.1, 13.3],
  ['Amsterdam', 52.4, 4.9, 13.4],
  ['Paris', 48.9, 2.35, 13.5],
  ['Madrid', 40.4, -3.7, 13.65],
  ['Lagos', 6.5, 3.4, 13.8],
  ['Kinshasa', -4.3, 15.3, 13.9],
  ['London', 51.5, -0.1, 14.0],
  ['Dublin', 53.3, -6.3, 14.2],
  ['Lisbon', 38.7, -9.1, 14.35],
  ['Reykjavík', 64.1, -21.9, 14.55],
  ['Accra', 5.6, -0.2, 14.75],
  ['Dakar', 14.7, -17.4, 14.9],
  ['Ponta Delgada', 37.7, -25.7, 15.1],
  ['Praia', 14.9, -23.5, 15.4],
  ['Nuuk', 64.2, -51.7, 16.0],
  ['Recife', -8.0, -34.9, 16.6],
  ['Rio de Janeiro', -22.9, -43.2, 17.0],
  ['São Paulo', -23.5, -46.6, 17.1],
  ['Buenos Aires', -34.6, -58.4, 17.3],
  ['Montevideo', -34.9, -56.2, 17.4],
  ["St. John's", 47.6, -52.7, 17.55],
  ['Brasília', -15.8, -47.9, 17.7],
  ['Santiago', -33.4, -70.7, 17.9],
  ['Caracas', 10.5, -66.9, 18.0],
  ['La Paz', -16.5, -68.1, 18.2],
  ['Halifax', 44.6, -63.6, 18.4],
  ['San Juan', 18.5, -66.1, 18.6],
  ['Santo Domingo', 18.5, -69.9, 18.75],
  ['Lima', -12.0, -77.0, 19.0],
  ['Bogotá', 4.7, -74.1, 19.2],
  ['Havana', 23.1, -82.4, 19.35],
  ['Miami', 25.8, -80.2, 19.45],
  ['Atlanta', 33.7, -84.4, 19.55],
  ['Washington', 38.9, -77.0, 19.65],
  ['New York', 40.7, -74.0, 19.75],
  ['Boston', 42.4, -71.1, 19.82],
  ['Montréal', 45.5, -73.6, 19.88],
  ['Toronto', 43.7, -79.4, 19.94],
  ['Detroit', 42.3, -83.0, 19.98],
  ['Mexico City', 19.4, -99.1, 20.0],
  ['Guatemala City', 14.6, -90.5, 20.15],
  ['Houston', 29.8, -95.4, 20.3],
  ['Dallas', 32.8, -96.8, 20.4],
  ['Chicago', 41.9, -87.6, 20.5],
  ['Minneapolis', 45.0, -93.3, 20.65],
  ['Winnipeg', 49.9, -97.1, 20.8],
  ['Albuquerque', 35.1, -106.6, 21.0],
  ['Denver', 39.7, -105.0, 21.15],
  ['Phoenix', 33.4, -112.1, 21.3],
  ['Salt Lake City', 40.8, -111.9, 21.45],
  ['Calgary', 51.0, -114.1, 21.65],
  ['Edmonton', 53.5, -113.5, 21.8],
  ['San Diego', 32.7, -117.2, 22.0],
  ['Los Angeles', 34.1, -118.2, 22.1],
  ['Las Vegas', 36.2, -115.1, 22.2],
  ['San Francisco', 37.8, -122.4, 22.35],
  ['Portland', 45.5, -122.7, 22.5],
  ['Seattle', 47.6, -122.3, 22.6],
  ['Vancouver', 49.3, -123.1, 22.7],
  ['Juneau', 58.3, -134.4, 23.0],
  ['Anchorage', 61.2, -149.9, 23.2],
  ['Fairbanks', 64.8, -147.7, 23.4],
  ['Honolulu', 21.3, -157.9, 24.0],
  ['Hilo', 19.7, -155.1, 24.2],
  ['Papeete', -17.5, -149.6, 24.5],
  ['Pago Pago', -14.3, -170.7, 25.0],
];

const LAST = SANTA_STOPS[SANTA_STOPS.length - 1];
export const FLIGHT_HOURS = LAST[3];
const HOME_HOURS = 1.5; // Pago Pago → North Pole

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function toVec(lat, lon) {
  const la = lat * D2R;
  const lo = lon * D2R;
  const c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}
function toLatLon(v) {
  const [x, y, z] = v;
  return { lat: Math.atan2(z, Math.hypot(x, y)) * R2D, lon: Math.atan2(y, x) * R2D };
}
/** Great-circle interpolation between two lat/lon points, f in [0,1]. */
export function slerpLatLon(a, b, f) {
  const va = toVec(a.lat, a.lon);
  const vb = toVec(b.lat, b.lon);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-6) return { lat: a.lat, lon: a.lon };
  const s = Math.sin(omega);
  const ka = Math.sin((1 - f) * omega) / s;
  const kb = Math.sin(f * omega) / s;
  return toLatLon([ka * va[0] + kb * vb[0], ka * va[1] + kb * vb[1], ka * va[2] + kb * vb[2]]);
}
/** Initial great-circle bearing from a to b, degrees clockwise from north. */
export function bearingDeg(a, b) {
  const la1 = a.lat * D2R;
  const la2 = b.lat * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Point `distDeg` degrees of arc from `a` along `bearing` (degrees from north). */
export function destinationPoint(a, bearing, distDeg) {
  const la1 = a.lat * D2R;
  const lo1 = a.lon * D2R;
  const br = bearing * D2R;
  const d = distDeg * D2R;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: la2 * R2D, lon: ((lo2 * R2D + 540) % 360) - 180 };
}

/** 24 Dec 10:00Z of the given (UTC) year, in ms. */
export function santaLaunchMs(year) {
  return Date.UTC(year, 11, 24, START_HOUR_UTC, 0, 0);
}

const stopObj = (s) => ({ name: s[0], lat: s[1], lon: s[2], hours: s[3] });

/**
 * Where Santa is at `nowMs`.
 * @returns {{
 *   visible: boolean,
 *   phase: 'hidden'|'pre'|'flight'|'home'|'post',
 *   lat: number, lon: number, heading: number,
 *   progress: number, delivered: number,
 *   lastStop: string, nextStop: string, launchMs: number
 * }}
 */
export function getSantaState(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const launchMs = santaLaunchMs(year);
  const base = {
    visible: false,
    phase: 'hidden',
    lat: NORTH_POLE.lat,
    lon: NORTH_POLE.lon,
    heading: 0,
    progress: 0,
    delivered: 0,
    lastStop: NORTH_POLE.name,
    nextStop: SANTA_STOPS[0][0],
    launchMs,
  };
  // Only 24 and 25 December (UTC) — a 48 h window that covers the whole run.
  if (month !== 11 || (day !== 24 && day !== 25)) return base;

  const hours = (nowMs - launchMs) / 3_600_000;
  if (hours < 0) {
    return { ...base, visible: true, phase: 'pre' };
  }
  if (hours >= FLIGHT_HOURS + HOME_HOURS) {
    return {
      ...base,
      visible: true,
      phase: 'post',
      progress: 1,
      delivered: KIDS_TOTAL,
      lastStop: LAST[0],
      nextStop: NORTH_POLE.name,
    };
  }
  const delivered = Math.round(Math.min(1, hours / FLIGHT_HOURS) * KIDS_TOTAL);
  if (hours >= FLIGHT_HOURS) {
    // Heading home
    const f = (hours - FLIGHT_HOURS) / HOME_HOURS;
    const a = stopObj(LAST);
    const p = slerpLatLon(a, NORTH_POLE, f);
    return {
      ...base,
      visible: true,
      phase: 'home',
      lat: p.lat,
      lon: p.lon,
      heading: bearingDeg(p, NORTH_POLE),
      progress: 1,
      delivered,
      lastStop: LAST[0],
      nextStop: NORTH_POLE.name,
    };
  }
  // In flight: find the segment
  let i = 0;
  while (i < SANTA_STOPS.length - 1 && SANTA_STOPS[i + 1][3] <= hours) i++;
  const from = hours < SANTA_STOPS[0][3] ? NORTH_POLE : stopObj(SANTA_STOPS[i]);
  const to = stopObj(SANTA_STOPS[Math.min(i + 1, SANTA_STOPS.length - 1)]);
  const t0 = from === NORTH_POLE ? 0 : from.hours;
  const t1 = to.hours;
  const f = t1 > t0 ? Math.min(1, Math.max(0, (hours - t0) / (t1 - t0))) : 1;
  const p = slerpLatLon(from, to, f);
  return {
    ...base,
    visible: true,
    phase: 'flight',
    lat: p.lat,
    lon: p.lon,
    heading: bearingDeg(p, to),
    progress: hours / FLIGHT_HOURS,
    delivered,
    lastStop: from.name,
    nextStop: to.name,
  };
}

/**
 * The clock the tracker runs on. Normally Date.now(); a `?santa=` URL
 * parameter (or localStorage `openhamclock_santaTime`) simulates a moment
 * so the easter egg can be demonstrated or verified any day of the year:
 *   ?santa=1                      → six hours into this year's run
 *   ?santa=2026-12-24T18:00:00Z   → that exact instant
 *   ?santa=off                    → clears a stored simulation
 * Returns { nowMs, simulated }. Offsets are applied relative to real time so
 * the simulated clock keeps ticking.
 */
let _simOffsetMs = null;
export function resolveSantaClock(realNowMs = Date.now()) {
  if (_simOffsetMs === null) {
    _simOffsetMs = 0;
    try {
      const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
      let raw = params.get('santa');
      if (raw === 'off') {
        localStorage.removeItem('openhamclock_santaTime');
        raw = null;
      } else if (raw) {
        localStorage.setItem('openhamclock_santaTime', raw);
      } else {
        raw = localStorage.getItem('openhamclock_santaTime');
      }
      if (raw) {
        const year = new Date(realNowMs).getUTCFullYear();
        const target = raw === '1' || raw === 'true' ? santaLaunchMs(year) + 6 * 3_600_000 : Date.parse(raw);
        if (Number.isFinite(target)) _simOffsetMs = target - realNowMs;
      }
    } catch {
      /* no window/localStorage (tests, SSR) */
    }
  }
  return { nowMs: realNowMs + _simOffsetMs, simulated: _simOffsetMs !== 0 };
}

/** Test hook: forget the cached simulation offset. */
export function _resetSantaClock() {
  _simOffsetMs = null;
}

export function formatPresents(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} billion`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} million`;
  return n.toLocaleString();
}
