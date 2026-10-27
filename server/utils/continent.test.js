import { describe, expect, it } from 'vitest';
import { continentForCall, coarseContinentForCall, zoneForCall, extractPrefixPart } from './continent.js';

describe('extractPrefixPart', () => {
  it('passes through simple calls', () => {
    expect(extractPrefixPart('W1AW')).toBe('W1AW');
    expect(extractPrefixPart('vk2io')).toBe('VK2IO');
  });

  it('strips portable/mobile suffixes', () => {
    expect(extractPrefixPart('VK2IO/P')).toBe('VK2IO');
    expect(extractPrefixPart('W1ABC/M')).toBe('W1ABC');
    expect(extractPrefixPart('W1ABC/QRP')).toBe('W1ABC');
  });

  it('strips call-area digit suffixes', () => {
    expect(extractPrefixPart('W1ABC/7')).toBe('W1ABC');
  });

  it('uses the visiting prefix for prefix/call compounds', () => {
    expect(extractPrefixPart('DL/W1ABC')).toBe('DL');
    expect(extractPrefixPart('W1ABC/DL')).toBe('DL');
  });

  it('handles empty/garbage input', () => {
    expect(extractPrefixPart('')).toBe('');
    expect(extractPrefixPart(null)).toBe('');
    expect(extractPrefixPart('//')).toBe('');
  });
});

describe('coarseContinentForCall', () => {
  it('maps common North American prefixes', () => {
    expect(coarseContinentForCall('W1AW')).toBe('NA');
    expect(coarseContinentForCall('K0CJH')).toBe('NA');
    expect(coarseContinentForCall('N2EHL')).toBe('NA');
    expect(coarseContinentForCall('VE3ABC')).toBe('NA');
    expect(coarseContinentForCall('XE1ABC')).toBe('NA');
  });

  it('maps US Pacific and Alaska overrides over the bare K/W match', () => {
    expect(coarseContinentForCall('KH6ABC')).toBe('OC'); // Hawaii
    expect(coarseContinentForCall('KL7AA')).toBe('NA'); // Alaska
    expect(coarseContinentForCall('KP4XX')).toBe('NA'); // Puerto Rico
  });

  it('maps European prefixes', () => {
    expect(coarseContinentForCall('G4ABC')).toBe('EU');
    expect(coarseContinentForCall('DL1ABC')).toBe('EU');
    expect(coarseContinentForCall('F5XYZ')).toBe('EU');
    expect(coarseContinentForCall('SP9ABC')).toBe('EU');
    expect(coarseContinentForCall('EA3ABC')).toBe('EU');
  });

  it('maps African overrides inside otherwise-European blocks', () => {
    expect(coarseContinentForCall('EA8XX')).toBe('AF'); // Canary Islands
    expect(coarseContinentForCall('CT3AB')).toBe('AF'); // Madeira
    expect(coarseContinentForCall('D44AB')).toBe('AF'); // Cape Verde vs German D-block
  });

  it('maps Asian prefixes including Asiatic Russia', () => {
    expect(coarseContinentForCall('JA1ABC')).toBe('AS');
    expect(coarseContinentForCall('HL2ABC')).toBe('AS');
    expect(coarseContinentForCall('BY1AB')).toBe('AS');
    expect(coarseContinentForCall('UA9XX')).toBe('AS');
    expect(coarseContinentForCall('UA3XX')).toBe('EU'); // European Russia
  });

  it('maps Oceania, South America, Africa', () => {
    expect(coarseContinentForCall('VK2IO')).toBe('OC');
    expect(coarseContinentForCall('ZL1AB')).toBe('OC');
    expect(coarseContinentForCall('DU1AB')).toBe('OC'); // Philippines is DXCC Oceania
    expect(coarseContinentForCall('PY2XX')).toBe('SA');
    expect(coarseContinentForCall('LU5AB')).toBe('SA');
    expect(coarseContinentForCall('ZS6X')).toBe('AF');
    expect(coarseContinentForCall('5Z4AB')).toBe('AF');
  });

  it('resolves compound calls to the operating location', () => {
    expect(coarseContinentForCall('VK2IO/P')).toBe('OC');
    expect(coarseContinentForCall('DL/W1ABC')).toBe('EU'); // visiting Germany
    expect(coarseContinentForCall('W1ABC/7')).toBe('NA');
  });

  it('returns null for unknown prefixes', () => {
    expect(coarseContinentForCall('QQ0QQ')).toBeNull();
    expect(coarseContinentForCall('')).toBeNull();
  });
});

describe('continentForCall', () => {
  it('prefers the cty lookup when it yields a valid continent', () => {
    const ctyLookup = () => ({ cont: 'AF' });
    // Coarse table says NA for W1AW; cty (stub) wins.
    expect(continentForCall('W1AW', ctyLookup)).toBe('AF');
  });

  it('falls back to the coarse table when cty misses', () => {
    expect(continentForCall('VK2IO', () => null)).toBe('OC');
    expect(continentForCall('VK2IO', undefined)).toBe('OC');
  });

  it('falls back when cty returns an invalid continent code', () => {
    expect(continentForCall('VK2IO', () => ({ cont: 'XX' }))).toBe('OC');
  });

  it('falls back when the cty lookup throws', () => {
    expect(
      continentForCall('VK2IO', () => {
        throw new Error('not loaded');
      }),
    ).toBe('OC');
  });
});

describe('zoneForCall', () => {
  const lookup = (call) => ({ W6XYZ: { cq: 3 }, G4ABC: { cq: '14' }, BAD1: { cq: 99 }, NOZONE: {} })[call] || null;

  it('returns the cty.dat CQ zone as a number', () => {
    expect(zoneForCall('W6XYZ', lookup)).toBe(3);
    expect(zoneForCall('G4ABC', lookup)).toBe(14);
  });

  it('returns null when the zone is missing, invalid, or there is no lookup', () => {
    expect(zoneForCall('NOZONE', lookup)).toBeNull();
    expect(zoneForCall('BAD1', lookup)).toBeNull();
    expect(zoneForCall('UNKNOWN', lookup)).toBeNull();
    expect(zoneForCall('W6XYZ', null)).toBeNull();
    expect(zoneForCall('', lookup)).toBeNull();
  });

  it('never throws when the lookup does', () => {
    expect(
      zoneForCall('W6XYZ', () => {
        throw new Error('boom');
      }),
    ).toBeNull();
  });
});
