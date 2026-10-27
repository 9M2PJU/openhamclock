/**
 * Continent resolution for amateur radio callsigns.
 *
 * Preferred path: the cty.dat lookup (src/server/ctydat.js → lookupCall),
 * which is synchronous once the CTY database has loaded and returns the
 * authoritative DXCC continent (`cont`) for a call.
 *
 * Fallback path: coarseContinentForCall — a small longest-prefix-match table
 * covering the common ITU allocations. It is deliberately coarse (no exotic
 * exceptions) and exists so continent-pair analysis still works before the
 * CTY database has been fetched (network fetch at boot) or if it fails.
 *
 * Continent codes match cty.dat: NA, SA, EU, AF, AS, OC, AN.
 */

// Longest-prefix-match table. Keys are callsign prefixes (1–3 chars); the
// longest matching key wins, so 'KH6' beats 'K'. Covers the prefixes that
// produce the overwhelming majority of cluster/RBN traffic.
const COARSE_PREFIX_CONTINENTS = {
  // ── North America ──
  K: 'NA',
  W: 'NA',
  N: 'NA',
  AA: 'NA',
  AB: 'NA',
  AC: 'NA',
  AD: 'NA',
  AE: 'NA',
  AF: 'NA',
  AG: 'NA',
  AH: 'OC', // Pacific US territories (KH-like)
  AI: 'NA',
  AJ: 'NA',
  AK: 'NA',
  AL: 'NA', // Alaska
  KH: 'OC', // Hawaii / US Pacific
  KL: 'NA', // Alaska
  KP: 'NA', // Puerto Rico / USVI
  NH: 'OC',
  WH: 'OC',
  VE: 'NA',
  VA: 'NA',
  VY: 'NA',
  VO: 'NA', // Canada
  XE: 'NA',
  XF: 'NA', // Mexico
  CM: 'NA',
  CO: 'NA', // Cuba
  C6: 'NA', // Bahamas
  '6Y': 'NA', // Jamaica
  HH: 'NA', // Haiti
  HI: 'NA', // Dominican Republic
  TI: 'NA', // Costa Rica
  TG: 'NA', // Guatemala
  YS: 'NA', // El Salvador
  HR: 'NA', // Honduras
  HP: 'NA', // Panama
  YN: 'NA', // Nicaragua
  V3: 'NA', // Belize
  ZF: 'NA', // Cayman
  VP9: 'NA', // Bermuda
  OX: 'NA', // Greenland
  FM: 'NA', // Martinique
  FJ: 'NA',
  FS: 'NA', // St Barts / St Martin
  '8P': 'NA', // Barbados
  J3: 'NA',
  J6: 'NA',
  J7: 'NA',
  J8: 'NA', // Windward Islands
  V4: 'NA',
  V2: 'NA', // St Kitts, Antigua

  // ── South America ──
  PY: 'SA',
  PP: 'SA',
  PQ: 'SA',
  PR: 'SA',
  PS: 'SA',
  PT: 'SA',
  PU: 'SA',
  PV: 'SA',
  PW: 'SA',
  PX: 'SA', // Brazil
  ZP: 'SA', // Paraguay
  ZV: 'SA',
  ZW: 'SA',
  ZX: 'SA',
  ZY: 'SA',
  ZZ: 'SA', // Brazil special
  LU: 'SA',
  LO: 'SA',
  LP: 'SA',
  LQ: 'SA',
  LR: 'SA',
  LS: 'SA',
  LT: 'SA',
  LV: 'SA',
  LW: 'SA', // Argentina
  CE: 'SA',
  CA: 'SA',
  CB: 'SA',
  CC: 'SA',
  CD: 'SA',
  XQ: 'SA',
  XR: 'SA', // Chile
  HK: 'SA',
  HJ: 'SA', // Colombia
  HC: 'SA',
  HD: 'SA', // Ecuador
  OA: 'SA',
  OB: 'SA',
  OC: 'SA', // Peru
  CX: 'SA',
  CV: 'SA', // Uruguay
  YV: 'SA',
  YW: 'SA',
  YX: 'SA',
  YY: 'SA',
  '4M': 'SA', // Venezuela
  CP: 'SA', // Bolivia
  PZ: 'SA', // Suriname
  '9Y': 'SA',
  '9Z': 'SA', // Trinidad & Tobago
  FY: 'SA', // French Guiana
  '8R': 'SA', // Guyana

  // ── Europe ──
  G: 'EU',
  M: 'EU',
  2: 'EU', // UK
  EI: 'EU',
  EJ: 'EU', // Ireland
  F: 'EU', // France
  D: 'EU', // Germany (DA–DR); D2/D4 (Africa) override below
  D2: 'AF', // Angola
  D3: 'AF', // Angola
  D4: 'AF', // Cape Verde
  D6: 'AF', // Comoros (Indian Ocean, AF per DXCC)
  DU: 'OC', // Philippines (DXCC: Oceania)
  DV: 'OC',
  DW: 'OC',
  DX: 'OC',
  DY: 'OC',
  DZ: 'OC',
  I: 'EU', // Italy
  EA: 'EU',
  EB: 'EU',
  EC: 'EU',
  ED: 'EU',
  EE: 'EU',
  EF: 'EU',
  EG: 'EU',
  EH: 'EU', // Spain
  EA8: 'AF',
  EA9: 'AF', // Canaries / Ceuta & Melilla
  CT: 'EU', // Portugal
  CT3: 'AF', // Madeira
  CU: 'EU', // Azores
  ON: 'EU',
  OO: 'EU',
  OP: 'EU',
  OQ: 'EU',
  OR: 'EU',
  OS: 'EU',
  OT: 'EU', // Belgium
  PA: 'EU',
  PB: 'EU',
  PC: 'EU',
  PD: 'EU',
  PE: 'EU',
  PF: 'EU',
  PG: 'EU',
  PH: 'EU',
  PI: 'EU', // Netherlands
  OZ: 'EU',
  OU: 'EU',
  OV: 'EU', // Denmark
  LA: 'EU',
  LB: 'EU',
  LC: 'EU',
  LG: 'EU',
  LN: 'EU', // Norway
  SM: 'EU',
  SA: 'EU',
  SB: 'EU',
  SC: 'EU',
  SD: 'EU',
  SE: 'EU',
  SF: 'EU',
  SG: 'EU',
  SH: 'EU',
  SI: 'EU',
  SJ: 'EU',
  SK: 'EU',
  SL: 'EU', // Sweden
  OH: 'EU',
  OF: 'EU',
  OG: 'EU',
  OI: 'EU', // Finland
  OJ0: 'EU', // Market Reef
  ES: 'EU', // Estonia
  YL: 'EU', // Latvia
  LY: 'EU', // Lithuania
  SP: 'EU',
  SN: 'EU',
  SO: 'EU',
  SQ: 'EU',
  SR: 'EU', // Poland
  OK: 'EU',
  OL: 'EU', // Czechia
  OM: 'EU', // Slovakia
  HA: 'EU',
  HG: 'EU', // Hungary
  OE: 'EU', // Austria
  HB: 'EU', // Switzerland / Liechtenstein
  S5: 'EU', // Slovenia
  '9A': 'EU', // Croatia
  E7: 'EU', // Bosnia
  YU: 'EU',
  YT: 'EU', // Serbia
  '4O': 'EU', // Montenegro
  Z3: 'EU',
  Z6: 'EU', // N. Macedonia / Kosovo
  ZA: 'EU', // Albania
  SV: 'EU',
  SW: 'EU',
  SX: 'EU',
  SY: 'EU',
  SZ: 'EU', // Greece
  LZ: 'EU', // Bulgaria
  YO: 'EU',
  YP: 'EU',
  YQ: 'EU',
  YR: 'EU', // Romania
  ER: 'EU', // Moldova
  UR: 'EU',
  US: 'EU',
  UT: 'EU',
  UU: 'EU',
  UV: 'EU',
  UW: 'EU',
  UX: 'EU',
  UY: 'EU',
  UZ: 'EU',
  EM: 'EU',
  EN: 'EU',
  EO: 'EU', // Ukraine
  EU: 'EU',
  EV: 'EU',
  EW: 'EU', // Belarus
  R: 'EU',
  UA: 'EU',
  UB: 'EU',
  UC: 'EU',
  UD: 'EU',
  UE: 'EU',
  UF: 'EU',
  UG: 'EU',
  UH: 'EU',
  UI: 'EU', // European Russia (coarse)
  R8: 'AS',
  R9: 'AS',
  R0: 'AS',
  UA8: 'AS',
  UA9: 'AS',
  UA0: 'AS', // Asiatic Russia
  TF: 'EU', // Iceland
  OY: 'EU', // Faroes
  TK: 'EU', // Corsica
  '9H': 'EU', // Malta
  T7: 'EU', // San Marino
  HV: 'EU', // Vatican
  C3: 'EU', // Andorra
  '3A': 'EU', // Monaco
  LX: 'EU', // Luxembourg
  E4: 'AS', // Palestine
  TA: 'AS', // Turkey (DXCC: Asia)
  YM: 'AS',

  // ── Africa ──
  ZS: 'AF',
  ZR: 'AF',
  ZT: 'AF',
  ZU: 'AF', // South Africa
  '5Z': 'AF',
  '5Y': 'AF', // Kenya
  '5H': 'AF',
  '5I': 'AF', // Tanzania
  '5X': 'AF', // Uganda
  SU: 'AF', // Egypt
  CN: 'AF', // Morocco
  '7X': 'AF', // Algeria
  '3V': 'AF', // Tunisia
  '5A': 'AF', // Libya
  '6W': 'AF', // Senegal
  TR: 'AF', // Gabon
  '9J': 'AF', // Zambia
  Z2: 'AF', // Zimbabwe
  '5N': 'AF', // Nigeria
  ET: 'AF', // Ethiopia
  ST: 'AF', // Sudan
  C5: 'AF', // Gambia
  '3B': 'AF', // Mauritius
  FR: 'AF', // Réunion
  FH: 'AF', // Mayotte
  V5: 'AF', // Namibia
  A2: 'AF', // Botswana
  '7Q': 'AF', // Malawi
  '9X': 'AF', // Rwanda
  '5R': 'AF', // Madagascar
  TU: 'AF', // Côte d'Ivoire
  EL: 'AF', // Liberia
  '9G': 'AF', // Ghana
  TZ: 'AF', // Mali
  XT: 'AF', // Burkina Faso
  TN: 'AF', // Congo
  '9Q': 'AF', // DR Congo
  S7: 'AF', // Seychelles
  '9U': 'AF', // Burundi
  C9: 'AF', // Mozambique
  '7P': 'AF', // Lesotho
  '3DA': 'AF', // Eswatini
  ZD: 'AF', // St Helena etc.
  IG9: 'AF', // African Italy
  IH9: 'AF',

  // ── Asia ──
  JA: 'AS',
  JE: 'AS',
  JF: 'AS',
  JG: 'AS',
  JH: 'AS',
  JI: 'AS',
  JJ: 'AS',
  JK: 'AS',
  JL: 'AS',
  JM: 'AS',
  JN: 'AS',
  JO: 'AS',
  JP: 'AS',
  JQ: 'AS',
  JR: 'AS',
  JS: 'AS',
  '7J': 'AS',
  '7K': 'AS',
  '7L': 'AS',
  '7M': 'AS',
  '7N': 'AS',
  '8J': 'AS',
  '8N': 'AS', // Japan
  HL: 'AS',
  DS: 'AS',
  DT: 'AS',
  '6K': 'AS',
  '6L': 'AS', // South Korea
  B: 'AS', // China
  BV: 'AS',
  BX: 'AS', // Taiwan
  VR: 'AS', // Hong Kong
  XX9: 'AS', // Macau
  VU: 'AS',
  AT: 'AS', // India
  '4S': 'AS', // Sri Lanka
  S2: 'AS', // Bangladesh
  AP: 'AS', // Pakistan
  '9N': 'AS', // Nepal
  A5: 'AS', // Bhutan
  HS: 'AS',
  E2: 'AS', // Thailand
  XV: 'AS',
  '3W': 'AS', // Vietnam
  XU: 'AS', // Cambodia
  XW: 'AS', // Laos
  XZ: 'AS', // Myanmar
  '9V': 'AS', // Singapore
  '9M': 'AS', // Malaysia (West; East is coarse-AS too)
  '4X': 'AS',
  '4Z': 'AS', // Israel
  JY: 'AS', // Jordan
  OD: 'AS', // Lebanon
  YK: 'AS', // Syria
  YI: 'AS', // Iraq
  HZ: 'AS',
  '7Z': 'AS',
  '8Z': 'AS', // Saudi Arabia
  A4: 'AS', // Oman
  A6: 'AS', // UAE
  A7: 'AS', // Qatar
  A9: 'AS', // Bahrain
  '9K': 'AS', // Kuwait
  '7O': 'AS', // Yemen
  EP: 'AS',
  EQ: 'AS', // Iran
  YA: 'AS',
  T6: 'AS', // Afghanistan
  UN: 'AS',
  UP: 'AS',
  UQ: 'AS', // Kazakhstan
  EX: 'AS', // Kyrgyzstan
  EY: 'AS', // Tajikistan
  EZ: 'AS', // Turkmenistan
  UK: 'AS', // Uzbekistan
  '4J': 'AS',
  '4K': 'AS', // Azerbaijan
  EK: 'AS', // Armenia (DXCC: Asia)
  '4L': 'AS', // Georgia (DXCC: Asia)
  JT: 'AS',
  JU: 'AS',
  JV: 'AS', // Mongolia
  P5: 'AS', // North Korea
  '9V1': 'AS',

  // ── Oceania ──
  VK: 'OC',
  AX: 'OC', // Australia
  ZL: 'OC',
  ZM: 'OC', // New Zealand
  YB: 'OC',
  YC: 'OC',
  YD: 'OC',
  YE: 'OC',
  YF: 'OC',
  YG: 'OC',
  YH: 'OC',
  '7A': 'OC',
  '8A': 'OC', // Indonesia (DXCC: Oceania)
  P2: 'OC', // Papua New Guinea
  FK: 'OC', // New Caledonia
  FO: 'OC', // French Polynesia
  FW: 'OC', // Wallis & Futuna
  '3D2': 'OC', // Fiji
  '5W': 'OC', // Samoa
  A3: 'OC', // Tonga
  T2: 'OC', // Tuvalu
  T3: 'OC', // Kiribati
  V6: 'OC', // Micronesia
  V7: 'OC', // Marshall Is.
  V8: 'OC', // Brunei (DXCC: Oceania)
  YJ: 'OC', // Vanuatu
  H4: 'OC', // Solomon Is.
  T8: 'OC', // Palau
  E5: 'OC', // Cook Is.
  ZK: 'OC',
  E6: 'OC', // Niue
  C2: 'OC', // Nauru
  T30: 'OC',
  KG6: 'OC',

  // ── Antarctica ──
  KC4: 'AN',
  RI1AN: 'AN',
  '8J1RL': 'AN',
};

// Precompute the longest key length so the matcher knows where to start.
const MAX_PREFIX_LEN = Math.max(...Object.keys(COARSE_PREFIX_CONTINENTS).map((k) => k.length));

/**
 * Strip a callsign down to the part that determines its DXCC prefix.
 * Handles compound calls the same way ctydat.lookupCall does (coarsely):
 *   DL/W1ABC → DL, W1ABC/P → W1ABC, VK2IO/P → VK2IO, W1ABC/7 → W1ABC.
 */
function extractPrefixPart(call) {
  const upper = String(call || '')
    .toUpperCase()
    .replace(/[^A-Z0-9/]/g, '');
  if (!upper) return '';
  if (!upper.includes('/')) return upper;
  const parts = upper.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const suffixes = ['P', 'M', 'MM', 'AM', 'QRP', 'A', 'B', 'LH', 'R'];
  const [a, b] = parts;
  if (suffixes.includes(b) || /^\d$/.test(b)) return a; // W1ABC/P, W1ABC/7
  if (a.length <= 4 && b.length > 4) return a; // DL/W1ABC
  if (b.length <= 4 && a.length > 4) return b; // W1ABC/DL
  return a;
}

/**
 * Coarse prefix → continent mapping. Returns 'NA'|'SA'|'EU'|'AF'|'AS'|'OC'|'AN'
 * or null when the prefix is unknown. Pure and synchronous.
 */
function coarseContinentForCall(call) {
  const base = extractPrefixPart(call);
  if (!base) return null;
  const maxLen = Math.min(base.length, MAX_PREFIX_LEN);
  for (let len = maxLen; len >= 1; len--) {
    const hit = COARSE_PREFIX_CONTINENTS[base.substring(0, len)];
    if (hit) return hit;
  }
  return null;
}

const VALID_CONTINENTS = new Set(['NA', 'SA', 'EU', 'AF', 'AS', 'OC', 'AN']);

/**
 * Resolve a callsign's continent.
 *
 * @param {string} call — the callsign (compound calls OK)
 * @param {function|null} ctyLookup — optional synchronous cty.dat lookup
 *   (src/server/ctydat.js lookupCall). Preferred when it yields a valid
 *   continent; the coarse table is the fallback.
 * @returns {'NA'|'SA'|'EU'|'AF'|'AS'|'OC'|'AN'|null}
 */
function continentForCall(call, ctyLookup) {
  if (typeof ctyLookup === 'function') {
    try {
      const entity = ctyLookup(call);
      const cont = entity && typeof entity.cont === 'string' ? entity.cont.toUpperCase() : null;
      if (cont && VALID_CONTINENTS.has(cont)) return cont;
    } catch {
      /* fall through to coarse mapping */
    }
  }
  return coarseContinentForCall(call);
}

/**
 * Resolve a callsign to its CQ zone (1–40) via the cty.dat lookup. There is
 * no coarse fallback — zones are too fine for a prefix table — so callers
 * must tolerate null (the spot simply does not count toward zone-level
 * analysis).
 *
 * @param {string} call
 * @param {function|null} ctyLookup — synchronous cty.dat lookup
 * @returns {number|null}
 */
function zoneForCall(call, ctyLookup) {
  if (!call || typeof ctyLookup !== 'function') return null;
  try {
    const entity = ctyLookup(call);
    const zone = Number(entity?.cq);
    return Number.isInteger(zone) && zone >= 1 && zone <= 40 ? zone : null;
  } catch {
    return null;
  }
}

module.exports = {
  continentForCall,
  coarseContinentForCall,
  zoneForCall,
  extractPrefixPart,
  COARSE_PREFIX_CONTINENTS,
};
