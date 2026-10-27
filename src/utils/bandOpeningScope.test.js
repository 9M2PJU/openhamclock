import { describe, it, expect } from 'vitest';
import {
  selectBandOpenings,
  openingKey,
  normalizeZone,
  SCOPE_MY_ZONE,
  SCOPE_MY_CONTINENT,
  SCOPE_WORLDWIDE,
} from './bandOpeningScope.js';

const payload = {
  openings: [
    { band: '20m', from_continent: 'EU', to_continent: 'NA', shortCount: 12 },
    { band: '15m', from_continent: 'AS', to_continent: 'EU', shortCount: 7 },
  ],
  zone_openings: [
    { band: '20m', from_continent: 'EU', to_zone: 5, shortCount: 9 },
    { band: '20m', from_continent: 'EU', to_zone: 3, shortCount: 6 },
    { band: '15m', from_continent: 'AS', to_zone: 14, shortCount: 5 },
  ],
};

describe('bandOpeningScope', () => {
  it('my-zone returns only zone openings heard in my zone', () => {
    const { items, effectiveScope } = selectBandOpenings(payload, {
      scope: SCOPE_MY_ZONE,
      myZone: 3,
      myContinent: 'NA',
    });
    expect(effectiveScope).toBe(SCOPE_MY_ZONE);
    expect(items).toEqual([{ band: '20m', from_continent: 'EU', to_zone: 3, shortCount: 6 }]);
  });

  it('falls back to my continent when the zone is unknown', () => {
    const { items, effectiveScope } = selectBandOpenings(payload, {
      scope: SCOPE_MY_ZONE,
      myZone: null,
      myContinent: 'na',
    });
    expect(effectiveScope).toBe(SCOPE_MY_CONTINENT);
    expect(items.map((o) => o.band)).toEqual(['20m']);
  });

  it('falls back to worldwide when neither zone nor continent is known', () => {
    const { items, effectiveScope } = selectBandOpenings(payload, { scope: SCOPE_MY_ZONE });
    expect(effectiveScope).toBe(SCOPE_WORLDWIDE);
    expect(items).toHaveLength(2);
  });

  it('worldwide ignores station info and returns the continent list', () => {
    const { items } = selectBandOpenings(payload, { scope: SCOPE_WORLDWIDE, myZone: 3, myContinent: 'NA' });
    expect(items).toHaveLength(2);
  });

  it('my-zone with a zone nobody is hearing yields nothing (no fallback to continent)', () => {
    const { items, effectiveScope } = selectBandOpenings(payload, {
      scope: SCOPE_MY_ZONE,
      myZone: 30,
      myContinent: 'OC',
    });
    expect(effectiveScope).toBe(SCOPE_MY_ZONE);
    expect(items).toEqual([]);
  });

  it('tolerates a payload without zone_openings (older server)', () => {
    const { items, effectiveScope } = selectBandOpenings(
      { openings: payload.openings },
      { scope: SCOPE_MY_ZONE, myZone: 3, myContinent: 'NA' },
    );
    expect(effectiveScope).toBe(SCOPE_MY_ZONE);
    expect(items).toEqual([]);
    expect(selectBandOpenings(null, { scope: SCOPE_WORLDWIDE }).items).toEqual([]);
  });

  it('openingKey distinguishes zone and continent episodes', () => {
    expect(openingKey({ band: '20m', from_continent: 'EU', to_zone: 3 })).toBe('20m|EU|Z3');
    expect(openingKey({ band: '20m', from_continent: 'EU', to_continent: 'NA' })).toBe('20m|EU|NA');
  });

  it('normalizeZone accepts 1–40 only', () => {
    expect(normalizeZone('4')).toBe(4);
    expect(normalizeZone(40)).toBe(40);
    expect(normalizeZone(0)).toBeNull();
    expect(normalizeZone(41)).toBeNull();
    expect(normalizeZone('x')).toBeNull();
    expect(normalizeZone(null)).toBeNull();
  });
});
