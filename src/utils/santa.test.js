import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSantaState,
  santaLaunchMs,
  SANTA_STOPS,
  FLIGHT_HOURS,
  slerpLatLon,
  bearingDeg,
  destinationPoint,
  resolveSantaClock,
  _resetSantaClock,
  formatPresents,
} from './santa.js';

const H = 3_600_000;
const launch = santaLaunchMs(2026);

describe('santa route table', () => {
  it('is ordered in time and ends about 25 h after launch', () => {
    for (let i = 1; i < SANTA_STOPS.length; i++) {
      expect(SANTA_STOPS[i][3]).toBeGreaterThan(SANTA_STOPS[i - 1][3]);
    }
    expect(FLIGHT_HOURS).toBeGreaterThanOrEqual(24);
    expect(FLIGHT_HOURS).toBeLessThanOrEqual(26);
  });

  it('has sane coordinates', () => {
    for (const [, lat, lon] of SANTA_STOPS) {
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
    }
  });
});

describe('getSantaState', () => {
  it('launches at 10:00Z on 24 December (midnight at UTC+14)', () => {
    expect(new Date(launch).toISOString()).toBe('2026-12-24T10:00:00.000Z');
  });

  it('is hidden outside 24–25 December', () => {
    expect(getSantaState(Date.UTC(2026, 11, 23, 23, 59)).visible).toBe(false);
    expect(getSantaState(Date.UTC(2026, 11, 26, 0, 0)).visible).toBe(false);
    expect(getSantaState(Date.UTC(2026, 6, 4)).visible).toBe(false);
  });

  it('is parked at the North Pole on the morning of the 24th', () => {
    const s = getSantaState(Date.UTC(2026, 11, 24, 3, 0));
    expect(s.visible).toBe(true);
    expect(s.phase).toBe('pre');
    expect(s.lat).toBeGreaterThan(89);
    expect(s.nextStop).toBe('Kiritimati');
    expect(s.delivered).toBe(0);
  });

  it('is over Kiritimati at launch and heading toward Tonga', () => {
    const s = getSantaState(launch + 1);
    expect(s.phase).toBe('flight');
    expect(s.lat).toBeCloseTo(1.87, 0);
    expect(s.lon).toBeCloseTo(-157.4, 0);
    expect(s.nextStop).toBe("Nuku'alofa");
  });

  it('crosses the date line smoothly between Apia and Auckland', () => {
    // Apia (−171.8) → Auckland (+174.8): the short way is westward across ±180
    const mid = getSantaState(launch + 1.7 * H);
    expect(Math.abs(mid.lon)).toBeGreaterThan(170);
    expect(mid.lastStop).toBe('Apia');
    expect(mid.nextStop).toBe('Auckland');
  });

  it('is over London at 14 h (midnight GMT) and moving west', () => {
    const s = getSantaState(launch + 14 * H);
    expect(s.lastStop).toBe('London');
    expect(s.lat).toBeCloseTo(51.5, 0);
    expect(s.lon).toBeCloseTo(-0.1, 0);
    expect(s.heading).toBeGreaterThan(180); // westerly bearing toward Dublin
    expect(s.delivered).toBeGreaterThan(1e9);
  });

  it('is over New York at 19.75 h (midnight Eastern)', () => {
    const s = getSantaState(launch + 19.75 * H);
    expect(s.lastStop).toBe('New York');
    expect(s.lon).toBeCloseTo(-74, 0);
  });

  it('progress and presents grow monotonically through the run', () => {
    let prev = getSantaState(launch);
    for (let h = 0.5; h <= FLIGHT_HOURS; h += 0.5) {
      const s = getSantaState(launch + h * H);
      expect(s.progress).toBeGreaterThanOrEqual(prev.progress);
      expect(s.delivered).toBeGreaterThanOrEqual(prev.delivered);
      prev = s;
    }
    expect(prev.delivered).toBe(2_200_000_000);
  });

  it('heads home after the last stop, then parks at the Pole until the 26th', () => {
    const home = getSantaState(launch + (FLIGHT_HOURS + 0.75) * H);
    expect(home.phase).toBe('home');
    expect(home.lat).toBeGreaterThan(-14.3);
    expect(home.nextStop).toBe('the North Pole');
    const post = getSantaState(Date.UTC(2026, 11, 25, 23, 0));
    expect(post.phase).toBe('post');
    expect(post.visible).toBe(true);
    expect(post.lat).toBeGreaterThan(89);
  });
});

describe('geometry helpers', () => {
  it('slerp endpoints and midpoint', () => {
    const a = { lat: 0, lon: 0 };
    const b = { lat: 0, lon: 90 };
    expect(slerpLatLon(a, b, 0).lon).toBeCloseTo(0);
    expect(slerpLatLon(a, b, 1).lon).toBeCloseTo(90);
    expect(slerpLatLon(a, b, 0.5).lon).toBeCloseTo(45);
  });
  it('destinationPoint moves along the bearing', () => {
    const n = destinationPoint({ lat: 0, lon: 0 }, 0, 1);
    expect(n.lat).toBeCloseTo(1, 5);
    expect(n.lon).toBeCloseTo(0, 5);
    const w = destinationPoint({ lat: 0, lon: -179.5 }, 270, 1);
    expect(w.lon).toBeCloseTo(179.5, 5); // wraps across the date line
  });
  it('bearing north/east', () => {
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 10, lon: 0 })).toBeCloseTo(0);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 10 })).toBeCloseTo(90);
  });
});

describe('resolveSantaClock', () => {
  beforeEach(() => {
    _resetSantaClock();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('is real time with no simulation', () => {
    const r = resolveSantaClock(1000);
    expect(r).toEqual({ nowMs: 1000, simulated: false });
  });

  it("?santa=1 jumps six hours into this year's run and keeps ticking", () => {
    window.history.replaceState({}, '', '/?santa=1');
    const real = Date.UTC(2026, 5, 1);
    const r = resolveSantaClock(real);
    expect(r.simulated).toBe(true);
    expect(r.nowMs).toBe(santaLaunchMs(2026) + 6 * H);
    expect(resolveSantaClock(real + 5000).nowMs).toBe(santaLaunchMs(2026) + 6 * H + 5000);
    expect(localStorage.getItem('openhamclock_santaTime')).toBe('1');
  });

  it('?santa=<iso> simulates that instant; ?santa=off clears it', () => {
    window.history.replaceState({}, '', '/?santa=2026-12-24T18:00:00Z');
    expect(resolveSantaClock(0).nowMs).toBe(Date.UTC(2026, 11, 24, 18));
    _resetSantaClock();
    window.history.replaceState({}, '', '/?santa=off');
    expect(resolveSantaClock(0)).toEqual({ nowMs: 0, simulated: false });
    expect(localStorage.getItem('openhamclock_santaTime')).toBeNull();
  });
});

describe('formatPresents', () => {
  it('formats billions, millions, and small counts', () => {
    expect(formatPresents(2_200_000_000)).toBe('2.20 billion');
    expect(formatPresents(412_345_678)).toBe('412 million');
    expect(formatPresents(1234)).toBe('1,234');
  });
});
