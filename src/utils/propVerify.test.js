import { describe, it, expect } from 'vitest';
import {
  countObservedByBand,
  observedScore,
  maxAcrossContinents,
  verdictFor,
  verdictForScore,
  buildComparison,
  pickCellReliability,
  nearestContinent,
  VERIFY_BANDS,
  OBSERVED_CAP,
} from './propVerify.js';

const NOW = Date.parse('2026-08-28T12:00:00Z');
const MIN = 60 * 1000;

// Synthetic cluster-style spots. Real prefixes so getCallsignInfo resolves
// continents: W=NA, DL=EU, JA=AS, VK=OC.
const spot = (over = {}) => ({
  call: 'DL1AAA',
  spotter: 'W1AW',
  freq: 14025, // kHz → 20m
  timestamp: NOW - 5 * MIN,
  ...over,
});

describe('countObservedByBand', () => {
  it('counts spots involving the DE continent within the window, per band', () => {
    const spots = [
      spot(), // NA spotter hears EU → involves NA, 20m
      spot({ freq: 7012 }), // 40m
      spot({ spotter: 'JA1AAA', call: 'VK2AAA' }), // AS↔OC — does NOT involve NA
      spot({ timestamp: NOW - 20 * MIN }), // outside 15-min window
      spot({ freq: 144200 }), // 2m — not an HF verify band
    ];
    const counts = countObservedByBand(spots, { deContinent: 'NA', now: NOW });
    expect(counts['20m']).toBe(1);
    expect(counts['40m']).toBe(1);
    expect(counts['15m']).toBe(0);
  });

  it('trusts involvesDe for DE-centric feeds (PSKReporter) and accepts band directly', () => {
    const spots = [
      { band: '10m', timestamp: NOW - MIN, involvesDe: true },
      { band: '10m', timestamp: NOW - MIN, involvesDe: true },
      { band: 'other', timestamp: NOW - MIN, involvesDe: true },
    ];
    const counts = countObservedByBand(spots, { deContinent: 'NA', now: NOW });
    expect(counts['10m']).toBe(2);
  });

  it('handles empty/bad input', () => {
    const counts = countObservedByBand(null, { deContinent: 'EU', now: NOW });
    expect(Object.keys(counts)).toEqual(VERIFY_BANDS);
    expect(Object.values(counts).every((c) => c === 0)).toBe(true);
  });
});

describe('observedScore', () => {
  it('normalizes counts to the 0-99 reliability scale, capped', () => {
    expect(observedScore(0)).toBe(0);
    expect(observedScore(OBSERVED_CAP)).toBe(99);
    expect(observedScore(OBSERVED_CAP * 3)).toBe(99);
    expect(observedScore(Math.round(OBSERVED_CAP / 3))).toBeGreaterThan(20);
  });
});

describe('maxAcrossContinents', () => {
  it('takes the per-band max, ignoring non-finite entries', () => {
    const matrix = {
      '20m': { EU: 80, AS: 45, OC: null },
      '10m': { EU: null, AS: undefined },
    };
    const out = maxAcrossContinents(matrix);
    expect(out['20m']).toBe(80);
    expect(out['10m']).toBeNull();
    expect(maxAcrossContinents(null)).toEqual({});
  });
});

describe('verdictFor', () => {
  it('agrees when both say closed', () => {
    expect(verdictFor(5, 0)).toBe('agrees');
  });

  it('agrees within the tolerance band', () => {
    // predicted 60, 8 spots → observed ~53 → |diff| < 25
    expect(verdictFor(60, 8)).toBe('agrees');
  });

  it('flags better-than-predicted when a "closed" band is busy', () => {
    // predicted 10, 10 spots → observed 66 → diff +56
    expect(verdictFor(10, 10)).toBe('better');
  });

  it('flags worse-than-predicted when a "open" band is silent', () => {
    expect(verdictFor(80, 0)).toBe('worse');
    expect(verdictFor(80, 2)).toBe('worse'); // observed 13 vs predicted 80
  });

  it('returns nodata without a prediction', () => {
    expect(verdictFor(null, 5)).toBe('nodata');
    expect(verdictFor(undefined, 0)).toBe('nodata');
  });
});

describe('buildComparison', () => {
  it('produces one row per verify band, in order', () => {
    const rows = buildComparison({ '20m': 80, '40m': 5 }, { '20m': 12, '40m': 0 });
    expect(rows.map((r) => r.band)).toEqual(VERIFY_BANDS);
    const r20 = rows.find((r) => r.band === '20m');
    expect(r20).toMatchObject({ predicted: 80, count: 12, verdict: 'agrees' });
    const r40 = rows.find((r) => r.band === '40m');
    expect(r40.verdict).toBe('agrees'); // both closed
    const r15 = rows.find((r) => r.band === '15m');
    expect(r15).toMatchObject({ predicted: null, verdict: 'nodata' });
  });
});

describe('pickCellReliability', () => {
  const cells = [
    { lat: 50, lon: 10, r: 72 },
    { lat: -30, lon: -170, r: 33 },
  ];

  it('picks the nearest cell', () => {
    expect(pickCellReliability(cells, 51, 12)).toBe(72);
  });

  it('wraps longitude at the antimeridian', () => {
    expect(pickCellReliability(cells, -30, 175)).toBe(33);
  });

  it('handles empty input', () => {
    expect(pickCellReliability([], 0, 0)).toBeNull();
    expect(pickCellReliability(null, 0, 0)).toBeNull();
  });
});

describe('nearestContinent', () => {
  it('maps coordinates to the nearest continent point', () => {
    expect(nearestContinent(40.015, -105.27)).toBe('NA'); // Boulder
    expect(nearestContinent(52.5, 13.4)).toBe('EU'); // Berlin
    expect(nearestContinent(-33.9, 151.2)).toBe('OC'); // Sydney
  });
});

describe('verdictForScore / beacon third source', () => {
  it('applies the same ±25 tolerance to a normalized beacon score', () => {
    expect(verdictForScore(80, 70)).toBe('agrees');
    expect(verdictForScore(80, 20)).toBe('worse');
    expect(verdictForScore(10, 60)).toBe('better');
    expect(verdictForScore(5, 0)).toBe('agrees');
    expect(verdictForScore(null, 50)).toBe('nodata');
    expect(verdictForScore(50, undefined)).toBe('nodata');
  });

  it('buildComparison attaches beacon rows only for bands with measured data', () => {
    const rows = buildComparison(
      { '20m': 80, '10m': 10 },
      { '20m': 3 },
      { '20m': { maxSnr: 18, score: 69, n: 4 }, '15m': { maxSnr: null, score: null, n: 0 } },
    );
    const r20 = rows.find((r) => r.band === '20m');
    expect(r20.beacon).toEqual({ maxSnr: 18, score: 69, n: 4, verdict: 'agrees' });
    expect(rows.find((r) => r.band === '15m').beacon).toBeNull();
    expect(rows.find((r) => r.band === '10m').beacon).toBeNull();
    // Without the third argument nothing changes for existing callers.
    expect(buildComparison({ '20m': 80 }, {}).every((r) => r.beacon === null)).toBe(true);
  });
});
