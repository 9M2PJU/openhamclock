/**
 * bandOpeningScope — pick which server-reported openings this station is
 * told about (#1191).
 *
 * The server payload carries two lists over the same spot streams:
 *   openings       — per (band × DX continent → spotter continent)
 *   zone_openings  — per (band × DX continent → spotter CQ zone)
 *
 * A continent is too coarse for the operator: "EU → NA open" is true for the
 * East Coast and useless on the West Coast. So the default scope is the
 * operator's own CQ zone, falling back to their continent when the zone is
 * unknown, and to the worldwide continent list when neither is known.
 */

export const SCOPE_MY_ZONE = 'my-zone';
export const SCOPE_MY_CONTINENT = 'my-continent';
export const SCOPE_WORLDWIDE = 'worldwide';

/** Stable key for an opening episode, zone- or continent-keyed. */
export function openingKey(o) {
  const to = o?.to_zone != null ? `Z${o.to_zone}` : o?.to_continent || '';
  return `${o?.band || ''}|${o?.from_continent || ''}|${to}`;
}

/** Valid CQ zone number (1–40) or null. */
export function normalizeZone(value) {
  const z = Number(value);
  return Number.isInteger(z) && z >= 1 && z <= 40 ? z : null;
}

/**
 * @param {object} payload — /api/band-openings response
 * @param {{ scope?: string, myZone?: number|null, myContinent?: string|null }} opts
 * @returns {{ items: object[], effectiveScope: string }}
 *   items — the openings to alert on; effectiveScope — what was actually
 *   applied after fallbacks (for the settings UI to explain itself).
 */
export function selectBandOpenings(payload, { scope = SCOPE_MY_ZONE, myZone = null, myContinent = null } = {}) {
  const openings = Array.isArray(payload?.openings) ? payload.openings : [];
  const zoneOpenings = Array.isArray(payload?.zone_openings) ? payload.zone_openings : [];
  const zone = normalizeZone(myZone);
  const cont = typeof myContinent === 'string' && myContinent ? myContinent.toUpperCase() : null;

  let effective = scope;
  if (effective === SCOPE_MY_ZONE && zone == null) effective = SCOPE_MY_CONTINENT;
  if (effective === SCOPE_MY_CONTINENT && !cont) effective = SCOPE_WORLDWIDE;

  if (effective === SCOPE_MY_ZONE) {
    return { items: zoneOpenings.filter((o) => o && Number(o.to_zone) === zone), effectiveScope: effective };
  }
  if (effective === SCOPE_MY_CONTINENT) {
    return {
      items: openings.filter((o) => o && String(o.to_continent).toUpperCase() === cont),
      effectiveScope: effective,
    };
  }
  return { items: openings.filter(Boolean), effectiveScope: SCOPE_WORLDWIDE };
}
