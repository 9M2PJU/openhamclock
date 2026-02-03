/**
 * Geographic Calculation Utilities
 * Grid squares, bearings, distances, sun/moon positions
 */

/**
 * Calculate Maidenhead grid square from coordinates
 */
export const calculateGridSquare = (lat, lon) => {
  const lonNorm = lon + 180;
  const latNorm = lat + 90;
  const field1 = String.fromCharCode(65 + Math.floor(lonNorm / 20));
  const field2 = String.fromCharCode(65 + Math.floor(latNorm / 10));
  const square1 = Math.floor((lonNorm % 20) / 2);
  const square2 = Math.floor(latNorm % 10);
  const subsq1 = String.fromCharCode(97 + Math.floor((lonNorm % 2) * 12));
  const subsq2 = String.fromCharCode(97 + Math.floor((latNorm % 1) * 24));
  return `${field1}${field2}${square1}${square2}${subsq1}${subsq2}`;
};

/**
 * Calculate bearing between two points
 */
export const calculateBearing = (lat1, lon1, lat2, lon2) => {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

/**
 * Calculate distance between two points in km
 */
export const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

/**
 * Get subsolar point (position where sun is directly overhead)
 */
export const getSunPosition = (date) => {
  const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
  const declination = -23.45 * Math.cos((360/365) * (dayOfYear + 10) * Math.PI / 180);
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60;
  const longitude = (12 - hours) * 15;
  return { lat: declination, lon: longitude };
};

/**
 * Calculate sublunar point (position where moon is directly overhead)
 */
export const getMoonPosition = (date) => {
  // Julian date calculation
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525; // Julian centuries from J2000
  
  // Moon's mean longitude
  const L0 = (218.316 + 481267.8813 * T) % 360;
  
  // Moon's mean anomaly
  const M = (134.963 + 477198.8676 * T) % 360;
  const MRad = M * Math.PI / 180;
  
  // Moon's mean elongation
  const D = (297.850 + 445267.1115 * T) % 360;
  const DRad = D * Math.PI / 180;
  
  // Sun's mean anomaly
  const Ms = (357.529 + 35999.0503 * T) % 360;
  const MsRad = Ms * Math.PI / 180;
  
  // Moon's argument of latitude
  const F = (93.272 + 483202.0175 * T) % 360;
  const FRad = F * Math.PI / 180;
  
  // Longitude corrections (simplified)
  const dL = 6.289 * Math.sin(MRad)
           + 1.274 * Math.sin(2 * DRad - MRad)
           + 0.658 * Math.sin(2 * DRad)
           + 0.214 * Math.sin(2 * MRad)
           - 0.186 * Math.sin(MsRad)
           - 0.114 * Math.sin(2 * FRad);
  
  // Moon's ecliptic longitude
  const moonLon = ((L0 + dL) % 360 + 360) % 360;
  
  // Moon's ecliptic latitude (simplified)
  const moonLat = 5.128 * Math.sin(FRad)
                + 0.281 * Math.sin(MRad + FRad)
                + 0.278 * Math.sin(MRad - FRad);
  
  // Convert ecliptic to equatorial coordinates
  const obliquity = 23.439 - 0.0000004 * (JD - 2451545.0);
  const oblRad = obliquity * Math.PI / 180;
  const moonLonRad = moonLon * Math.PI / 180;
  const moonLatRad = moonLat * Math.PI / 180;
  
  // Right ascension
  const RA = Math.atan2(
    Math.sin(moonLonRad) * Math.cos(oblRad) - Math.tan(moonLatRad) * Math.sin(oblRad),
    Math.cos(moonLonRad)
  ) * 180 / Math.PI;
  
  // Declination
  const dec = Math.asin(
    Math.sin(moonLatRad) * Math.cos(oblRad) + 
    Math.cos(moonLatRad) * Math.sin(oblRad) * Math.sin(moonLonRad)
  ) * 180 / Math.PI;
  
  // Greenwich Mean Sidereal Time
  const GMST = (280.46061837 + 360.98564736629 * (JD - 2451545.0)) % 360;
  
  // Sublunar point longitude
  const sublunarLon = ((RA - GMST) % 360 + 540) % 360 - 180;
  
  return { lat: dec, lon: sublunarLon };
};

/**
 * Calculate moon phase (0-1, 0=new, 0.5=full)
 */
export const getMoonPhase = (date) => {
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  const D = (297.850 + 445267.1115 * T) % 360; // Mean elongation
  // Phase angle (simplified)
  const phase = ((D + 180) % 360) / 360;
  return phase;
};

/**
 * Get moon phase emoji
 */
export const getMoonPhaseEmoji = (phase) => {
  if (phase < 0.0625) return '🌑'; // New moon
  if (phase < 0.1875) return '🌒'; // Waxing crescent
  if (phase < 0.3125) return '🌓'; // First quarter
  if (phase < 0.4375) return '🌔'; // Waxing gibbous
  if (phase < 0.5625) return '🌕'; // Full moon
  if (phase < 0.6875) return '🌖'; // Waning gibbous
  if (phase < 0.8125) return '🌗'; // Last quarter
  if (phase < 0.9375) return '🌘'; // Waning crescent
  return '🌑'; // New moon
};

/**
 * Calculate sunrise and sunset times
 */
export const calculateSunTimes = (lat, lon, date) => {
  const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
  const declination = -23.45 * Math.cos((360/365) * (dayOfYear + 10) * Math.PI / 180);
  const latRad = lat * Math.PI / 180;
  const decRad = declination * Math.PI / 180;
  const cosHA = -Math.tan(latRad) * Math.tan(decRad);
  
  if (cosHA > 1) return { sunrise: 'Polar night', sunset: '' };
  if (cosHA < -1) return { sunrise: 'Midnight sun', sunset: '' };
  
  const ha = Math.acos(cosHA) * 180 / Math.PI;
  const noon = 12 - lon / 15;
  const fmt = (h) => {
    const hr = Math.floor(((h % 24) + 24) % 24);
    const mn = Math.round((h - Math.floor(h)) * 60);
    return `${hr.toString().padStart(2,'0')}:${mn.toString().padStart(2,'0')}`;
  };
  return { sunrise: fmt(noon - ha/15), sunset: fmt(noon + ha/15) };
};

/**
 * Calculate great circle path points for Leaflet
 * Handles antimeridian crossing by returning multiple segments
 */
export const getGreatCirclePoints = (lat1, lon1, lat2, lon2, n = 100) => {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  
  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);
  
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ1-φ2)/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin((λ1-λ2)/2)**2
  ));
  
  // If distance is essentially zero, return just the two points
  if (d < 0.0001) {
    return [[lat1, lon1], [lat2, lon2]];
  }
  
  const rawPoints = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1-f)*d) / Math.sin(d);
    const B = Math.sin(f*d) / Math.sin(d);
    const x = A*Math.cos(φ1)*Math.cos(λ1) + B*Math.cos(φ2)*Math.cos(λ2);
    const y = A*Math.cos(φ1)*Math.sin(λ1) + B*Math.cos(φ2)*Math.sin(λ2);
    const z = A*Math.sin(φ1) + B*Math.sin(φ2);
    rawPoints.push([toDeg(Math.atan2(z, Math.sqrt(x*x+y*y))), toDeg(Math.atan2(y, x))]);
  }
  
  // Unwrap longitudes to be continuous (no jumps > 180°)
  // This lets Leaflet draw smoothly across the antimeridian and world copies
  for (let i = 1; i < rawPoints.length; i++) {
    while (rawPoints[i][1] - rawPoints[i-1][1] > 180) rawPoints[i][1] -= 360;
    while (rawPoints[i][1] - rawPoints[i-1][1] < -180) rawPoints[i][1] += 360;
  }
  
  return rawPoints;
};

export default {
  calculateGridSquare,
  calculateBearing,
  calculateDistance,
  getSunPosition,
  getMoonPosition,
  getMoonPhase,
  getMoonPhaseEmoji,
  calculateSunTimes,
  getGreatCirclePoints
};
