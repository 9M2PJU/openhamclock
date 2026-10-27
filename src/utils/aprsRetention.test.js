import { describe, it, expect, beforeEach } from 'vitest';
import {
  pruneStations,
  mergeStations,
  capStations,
  loadStations,
  saveStations,
  readDwellMinutes,
  writeDwellMinutes,
  readClearedAt,
  writeClearedAt,
  DEFAULT_DWELL_MINUTES,
  DWELL_OPTIONS_MINUTES,
  MAX_RETAINED,
} from './aprsRetention.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const st = (ssid, ageMin, extra = {}) => ({ ssid, call: ssid.split('-')[0], timestamp: NOW - ageMin * MIN, ...extra });
const toMap = (list) => new Map(list.map((s) => [s.ssid, s]));

describe('aprsRetention', () => {
  beforeEach(() => localStorage.clear());

  describe('pruneStations', () => {
    it('drops stations older than the dwell and keeps the rest', () => {
      const map = toMap([st('A-1', 10), st('B-2', 70), st('C-3', 59)]);
      const out = pruneStations(map, { dwellMs: 60 * MIN, now: NOW });
      expect([...out.keys()]).toEqual(['A-1', 'C-3']);
    });

    it('returns the same Map instance when nothing expired', () => {
      const map = toMap([st('A-1', 10)]);
      expect(pruneStations(map, { dwellMs: 60 * MIN, now: NOW })).toBe(map);
    });

    it('honours clearedAt even inside the dwell window', () => {
      const map = toMap([st('A-1', 10), st('B-2', 5)]);
      const out = pruneStations(map, { dwellMs: 6 * 60 * MIN, now: NOW, clearedAt: NOW - 7 * MIN });
      expect([...out.keys()]).toEqual(['B-2']);
    });

    it('treats a station with no usable timestamp as expired', () => {
      const map = new Map([['X', { ssid: 'X' }]]);
      expect(pruneStations(map, { dwellMs: 60 * MIN, now: NOW }).size).toBe(0);
    });
  });

  describe('mergeStations', () => {
    it('adds new stations and refreshes older copies', () => {
      const map = toMap([st('A-1', 30)]);
      const out = mergeStations(map, [st('A-1', 1, { comment: 'fresh' }), st('B-2', 2)]);
      expect(out.get('A-1').comment).toBe('fresh');
      expect(out.has('B-2')).toBe(true);
    });

    it('keeps the retained copy when it is newer than the snapshot', () => {
      const map = toMap([st('A-1', 1, { comment: 'kept' })]);
      const out = mergeStations(map, [st('A-1', 30)]);
      expect(out.get('A-1').comment).toBe('kept');
    });

    it('ignores stations heard at or before clearedAt so a clear sticks', () => {
      const out = mergeStations(new Map(), [st('A-1', 10), st('B-2', 1)], { clearedAt: NOW - 5 * MIN });
      expect([...out.keys()]).toEqual(['B-2']);
    });

    it('returns the same Map instance when the snapshot adds nothing', () => {
      const a = st('A-1', 1);
      const map = new Map([['A-1', a]]);
      expect(mergeStations(map, [a])).toBe(map);
      expect(mergeStations(map, [])).toBe(map);
    });

    it('falls back to call when there is no ssid', () => {
      const out = mergeStations(new Map(), [{ call: 'N0CALL', timestamp: NOW }]);
      expect(out.has('N0CALL')).toBe(true);
    });
  });

  it('capStations keeps the newest entries', () => {
    const list = Array.from({ length: MAX_RETAINED + 5 }, (_, i) => st(`S-${i}`, i));
    const out = capStations(toMap(list));
    expect(out.size).toBe(MAX_RETAINED);
    expect(out.has('S-0')).toBe(true);
    expect(out.has(`S-${MAX_RETAINED + 4}`)).toBe(false);
  });

  describe('storage round-trip', () => {
    it('saves and loads a store, pruning on load', () => {
      saveStations('k', toMap([st('A-1', 10), st('B-2', 200)]));
      const out = loadStations('k', { dwellMs: 60 * MIN, now: NOW });
      expect([...out.keys()]).toEqual(['A-1']);
    });

    it('removes the key when the store is empty', () => {
      saveStations('k', toMap([st('A-1', 1)]));
      saveStations('k', new Map());
      expect(localStorage.getItem('k')).toBeNull();
    });

    it('survives corrupt storage', () => {
      localStorage.setItem('k', '{not json');
      expect(loadStations('k', { dwellMs: 60 * MIN, now: NOW }).size).toBe(0);
      localStorage.setItem('k', '{"a":1}');
      expect(loadStations('k', { dwellMs: 60 * MIN, now: NOW }).size).toBe(0);
    });

    it('dwell defaults to 60 and only accepts listed options', () => {
      expect(readDwellMinutes()).toBe(DEFAULT_DWELL_MINUTES);
      writeDwellMinutes(180);
      expect(readDwellMinutes()).toBe(180);
      writeDwellMinutes(17);
      expect(readDwellMinutes()).toBe(DEFAULT_DWELL_MINUTES);
      expect(DWELL_OPTIONS_MINUTES[0]).toBe(30);
      expect(DWELL_OPTIONS_MINUTES).toContain(360);
    });

    it('clearedAt round-trips and defaults to 0', () => {
      expect(readClearedAt()).toBe(0);
      writeClearedAt(NOW);
      expect(readClearedAt()).toBe(NOW);
    });
  });
});
