/**
 * Tests for netControl — check-in parsing (flags/suffixes), roster
 * mutators (dedupe, recheck, check-out, undo), traffic queue, report
 * builders, duration formatting, script templates and storage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseCheckin,
  createNet,
  checkIn,
  checkOut,
  toggleFlag,
  updateStation,
  removeStation,
  undoLast,
  trafficQueue,
  passTraffic,
  nextTraffic,
  closeNet,
  buildReport,
  reportToText,
  reportToCsv,
  historyToCsv,
  reportToPrintHtml,
  toRosterEntries,
  formatElapsed,
  formatDuration,
  netDurationMs,
  fillTemplate,
  scriptContext,
  stationFromLogbook,
  stationFromLookup,
  loadRunningNet,
  saveRunningNet,
  clearRunningNet,
  loadHistory,
  pushHistory,
  loadScript,
  saveScript,
  rememberStation,
  loadStationCache,
  saveStationCache,
  saveRosterSnapshot,
  getNetControlRoster,
  mergeRosters,
  NET_CONTROL_ROSTER_EVENT,
  flagsToText,
  DEFAULT_PREAMBLE,
  DEFAULT_CLOSING,
  MAX_HISTORY,
  MAX_UNDO,
  STATION_CACHE_MAX,
  DUPLICATE_WINDOW_MS,
  NET_CONTROL_ROSTER_KEY,
} from './netControl.js';

const T0 = Date.UTC(2026, 9, 15, 19, 0, 0); // 2026-10-15 19:00:00Z
const min = (n) => n * 60 * 1000;

const startNet = () => createNet({ name: 'ARES Tuesday Net', frequency: '146.940 - 100.0', ncs: 'k0cjh', now: T0 });

describe('parseCheckin', () => {
  it('uppercases a bare callsign with no flags', () => {
    expect(parseCheckin('k0cjh')).toEqual({ call: 'K0CJH', flags: [], note: '' });
  });
  it('reads a flag token after the call', () => {
    expect(parseCheckin('K0CJH T')).toEqual({ call: 'K0CJH', flags: ['traffic'], note: '' });
    expect(parseCheckin('K0CJH tm').flags).toEqual(['traffic', 'mobile']);
  });
  it('orders flags canonically and dedupes', () => {
    expect(parseCheckin('K0CJH MT T').flags).toEqual(['traffic', 'mobile']);
    expect(parseCheckin('K0CJH /SMTR').flags).toEqual(['traffic', 'relay', 'mobile', 'short']);
    expect(parseCheckin('K0CJH +i').flags).toEqual(['inout']);
  });
  it('reads slash-suffix flags and strips them from the call', () => {
    expect(parseCheckin('K0CJH/M')).toEqual({ call: 'K0CJH', flags: ['mobile'], note: '' });
    expect(parseCheckin('k0cjh/t s')).toEqual({ call: 'K0CJH', flags: ['traffic', 'short'], note: '' });
  });
  it('keeps real portable suffixes on the call', () => {
    expect(parseCheckin('K0CJH/P').call).toBe('K0CJH/P');
    expect(parseCheckin('K0CJH/QRP').call).toBe('K0CJH/QRP');
    expect(parseCheckin('W1AW/7').call).toBe('W1AW/7');
  });
  it('strips an SSID', () => {
    expect(parseCheckin('KE8PLM-9').call).toBe('KE8PLM');
  });
  it('treats tokens with non-flag letters as a note, and everything after it', () => {
    expect(parseCheckin('K0CJH Chris')).toEqual({ call: 'K0CJH', flags: [], note: 'Chris' });
    expect(parseCheckin('K0CJH T Chris in Denver')).toEqual({
      call: 'K0CJH',
      flags: ['traffic'],
      note: 'Chris in Denver',
    });
    // a name spelled only with flag letters is a note, and so is everything after it
    expect(parseCheckin('K0CJH Tim S')).toEqual({ call: 'K0CJH', flags: [], note: 'Tim S' });
    expect(parseCheckin('K0CJH T Mitt')).toEqual({ call: 'K0CJH', flags: ['traffic'], note: 'Mitt' });
  });
  it('rejects things that are not callsigns', () => {
    expect(parseCheckin('')).toBeNull();
    expect(parseCheckin('   ')).toBeNull();
    expect(parseCheckin('hello')).toBeNull();
    expect(parseCheckin('12345')).toBeNull();
    expect(parseCheckin('K0')).toBeNull();
  });
});

describe('createNet', () => {
  it('builds a running net with defaults', () => {
    const net = startNet();
    expect(net.name).toBe('ARES Tuesday Net');
    expect(net.ncs).toBe('K0CJH');
    expect(net.frequency).toBe('146.940 - 100.0');
    expect(net.startTime).toBe(T0);
    expect(net.endTime).toBeNull();
    expect(net.stations).toEqual([]);
    expect(net.id).toMatch(/^net-/);
  });
  it('requires a name', () => {
    expect(createNet({ name: '  ' })).toBeNull();
  });
});

describe('checkIn', () => {
  it('adds a new station at the top', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 + min(1) }));
    const r = checkIn(net, { call: 'KE8PLM', flags: ['traffic'], name: 'Michael', now: T0 + min(2) });
    expect(r.result).toBe('new');
    expect(r.net.stations.map((s) => s.call)).toEqual(['KE8PLM', 'W1AW']);
    expect(r.station).toMatchObject({
      call: 'KE8PLM',
      name: 'Michael',
      flags: ['traffic'],
      checkinTime: T0 + min(2),
      checkoutTime: null,
      recheckCount: 0,
      trafficPassed: null,
    });
  });
  it('ignores a duplicate Enter within the window', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    const r = checkIn(net, { call: 'w1aw', now: T0 + DUPLICATE_WINDOW_MS - 1 });
    expect(r.result).toBe('duplicate');
    expect(r.net).toBe(net);
    expect(r.net.stations).toHaveLength(1);
  });
  it('rechecks a station: moves it to the top, bumps the count, merges flags', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    ({ net } = checkIn(net, { call: 'K0CJH', now: T0 + min(1) }));
    const r = checkIn(net, { call: 'W1AW', flags: ['traffic'], now: T0 + min(5) });
    expect(r.result).toBe('recheck');
    expect(r.net.stations.map((s) => s.call)).toEqual(['W1AW', 'K0CJH']);
    expect(r.station.recheckCount).toBe(1);
    expect(r.station.flags).toEqual(['traffic']);
    expect(r.station.checkinTime).toBe(T0); // original time kept
    expect(r.station.lastActivity).toBe(T0 + min(5));
    expect(r.net.stations).toHaveLength(2);
  });
  it('returns a checked-out station to the net', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    net = checkOut(net, 'W1AW', T0 + min(2));
    expect(net.stations[0].checkoutTime).toBe(T0 + min(2));
    const r = checkIn(net, { call: 'W1AW', now: T0 + min(3) });
    expect(r.result).toBe('return');
    expect(r.station.checkoutTime).toBeNull();
  });
  it('does not overwrite a known name with a blank one', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', name: 'Hiram', now: T0 }));
    const r = checkIn(net, { call: 'W1AW', name: '', now: T0 + min(5) });
    expect(r.station.name).toBe('Hiram');
  });
});

describe('checkOut / toggleFlag / updateStation / removeStation / undoLast', () => {
  it('checkOut is a no-op for unknown or already-out stations', () => {
    let net = startNet();
    expect(checkOut(net, 'NOBODY')).toBe(net);
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    const out = checkOut(net, 'W1AW', T0 + min(1));
    expect(checkOut(out, 'W1AW', T0 + min(2))).toBe(out);
  });
  it('toggleFlag adds and removes', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    net = toggleFlag(net, 'W1AW', 'mobile');
    expect(net.stations[0].flags).toEqual(['mobile']);
    net = toggleFlag(net, 'W1AW', 'traffic');
    expect(net.stations[0].flags).toEqual(['traffic', 'mobile']);
    net = toggleFlag(net, 'W1AW', 'mobile');
    expect(net.stations[0].flags).toEqual(['traffic']);
    expect(toggleFlag(net, 'W1AW', 'bogus')).toBe(net);
  });
  it('updateStation patches name/location without an undo entry', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    const undoLen = net.undo.length;
    net = updateStation(net, 'W1AW', { name: 'Hiram', location: 'Newington, CT', bogus: 'x' });
    expect(net.stations[0]).toMatchObject({ name: 'Hiram', location: 'Newington, CT' });
    expect(net.stations[0].bogus).toBeUndefined();
    expect(net.undo).toHaveLength(undoLen);
  });
  it('removeStation drops the line; undoLast brings it back', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    ({ net } = checkIn(net, { call: 'K0CJH', now: T0 + min(1) }));
    net = removeStation(net, 'W1AW');
    expect(net.stations.map((s) => s.call)).toEqual(['K0CJH']);
    net = undoLast(net);
    expect(net.stations.map((s) => s.call)).toEqual(['K0CJH', 'W1AW']);
    net = undoLast(net);
    expect(net.stations.map((s) => s.call)).toEqual(['W1AW']);
    net = undoLast(net);
    expect(net.stations).toEqual([]);
    expect(undoLast(net)).toBe(net); // nothing left to undo
  });
  it('caps the undo stack', () => {
    let net = startNet();
    for (let i = 0; i < MAX_UNDO + 10; i++) {
      ({ net } = checkIn(net, { call: `K${i}ABC`, now: T0 + min(i) }));
    }
    expect(net.undo).toHaveLength(MAX_UNDO);
  });
});

describe('traffic queue', () => {
  it('lists traffic stations oldest-first and pops them as passed', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', flags: ['traffic'], now: T0 }));
    ({ net } = checkIn(net, { call: 'K0CJH', now: T0 + min(1) }));
    ({ net } = checkIn(net, { call: 'KE8PLM', flags: ['traffic', 'mobile'], now: T0 + min(2) }));
    expect(trafficQueue(net).map((s) => s.call)).toEqual(['W1AW', 'KE8PLM']);
    net = passTraffic(net, 'W1AW', T0 + min(3));
    expect(trafficQueue(net).map((s) => s.call)).toEqual(['KE8PLM']);
    expect(net.stations.find((s) => s.call === 'W1AW').trafficPassed).toBe(T0 + min(3));
    // passing a non-traffic or already-passed station is a no-op
    expect(passTraffic(net, 'K0CJH')).toBe(net);
    expect(passTraffic(net, 'W1AW')).toBe(net);
  });
  it('nextTraffic calls the head of the queue and passing clears it', () => {
    let net = startNet();
    expect(nextTraffic(net)).toBe(net); // empty queue, nothing calling
    ({ net } = checkIn(net, { call: 'W1AW', flags: ['traffic'], now: T0 }));
    ({ net } = checkIn(net, { call: 'KE8PLM', flags: ['traffic'], now: T0 + min(1) }));
    net = nextTraffic(net);
    expect(net.calling).toBe('W1AW');
    expect(nextTraffic(net)).toBe(net);
    net = passTraffic(net, 'W1AW', T0 + min(2));
    expect(net.calling).toBeNull();
    net = nextTraffic(net);
    expect(net.calling).toBe('KE8PLM');
    // passing a different station leaves the current call alone
    ({ net } = checkIn(net, { call: 'K0CJH', flags: ['traffic'], now: T0 + min(3) }));
    net = passTraffic(net, 'K0CJH', T0 + min(4));
    expect(net.calling).toBe('KE8PLM');
  });
  it('drops checked-out stations from the queue', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', flags: ['traffic'], now: T0 }));
    net = checkOut(net, 'W1AW', T0 + min(1));
    expect(trafficQueue(net)).toEqual([]);
  });
});

describe('closeNet / duration', () => {
  it('sets endTime once and clears undo', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    const closed = closeNet(net, T0 + min(45));
    expect(closed.endTime).toBe(T0 + min(45));
    expect(closed.undo).toEqual([]);
    expect(closeNet(closed, T0 + min(60))).toBe(closed);
    expect(netDurationMs(closed)).toBe(min(45));
    expect(netDurationMs(net, T0 + min(10))).toBe(min(10));
  });
  it('formats elapsed and duration', () => {
    expect(formatElapsed(0)).toBe('00:00:00');
    expect(formatElapsed(min(12) + 34 * 1000)).toBe('00:12:34');
    expect(formatElapsed(min(125))).toBe('02:05:00');
    expect(formatDuration(30 * 1000)).toBe('<1m');
    expect(formatDuration(min(12))).toBe('12m');
    expect(formatDuration(min(65))).toBe('1h 05m');
  });
});

describe('buildReport', () => {
  const fullNet = () => {
    let net = startNet();
    ({ net } = checkIn(net, {
      call: 'W1AW',
      flags: ['traffic'],
      name: 'Hiram',
      location: 'Newington, CT',
      now: T0 + min(1),
    }));
    ({ net } = checkIn(net, { call: 'K0CJH', flags: ['mobile'], now: T0 + min(2) }));
    ({ net } = checkIn(net, { call: 'KE8PLM', flags: ['traffic'], note: 'ARES EC', now: T0 + min(3) }));
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 + min(10) })); // recheck
    net = passTraffic(net, 'W1AW', T0 + min(12));
    net = checkOut(net, 'K0CJH', T0 + min(15));
    return closeNet(net, T0 + min(40));
  };

  it('summarises counts and lists stations in check-in order', () => {
    const r = buildReport(fullNet());
    expect(r).toMatchObject({
      name: 'ARES Tuesday Net',
      ncs: 'K0CJH',
      frequency: '146.940 - 100.0',
      startTime: T0,
      endTime: T0 + min(40),
      durationMs: min(40),
      totalCheckins: 4,
      uniqueStations: 3,
      trafficCount: 2,
      trafficPassed: 1,
    });
    expect(r.stations.map((s) => s.call)).toEqual(['W1AW', 'K0CJH', 'KE8PLM']);
    expect(r.stations[0]).toMatchObject({ recheckCount: 1, trafficPassed: T0 + min(12), name: 'Hiram' });
    expect(r.stations[1].checkoutTime).toBe(T0 + min(15));
  });

  it('renders text, CSV and print HTML', () => {
    const r = buildReport(fullNet());
    const text = reportToText(r);
    expect(text).toContain('NET REPORT — ARES Tuesday Net');
    expect(text).toContain('Net control: K0CJH');
    expect(text).toContain('Check-ins: 4   Unique stations: 3   Traffic: 2 listed, 1 passed');
    expect(text).toContain('19:01 W1AW        TFC          Hiram, Newington, CT (recheck x1)');
    expect(text).toContain('19:02 K0CJH       MOB          (out 19:15)\n');
    expect(text).toContain('(ARES EC)');

    const csv = reportToCsv(r);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Net,NCS,Frequency,/);
    expect(lines[1]).toContain('"Newington, CT"');
    expect(lines[1]).toContain('2026-10-15T19:01:00.000Z');
    expect(lines[2]).toContain('2026-10-15T19:15:00.000Z');

    const html = reportToPrintHtml(r);
    expect(html).toContain('<title>Net Report — ARES Tuesday Net</title>');
    expect(html).toContain('<td class="mono">W1AW</td>');
    expect(html).toContain('recheck x1; traffic passed');
  });

  it('escapes HTML in the print view', () => {
    let net = createNet({ name: '<script>alert(1)</script>', now: T0 });
    ({ net } = checkIn(net, { call: 'W1AW', name: '<b>Hiram</b>', now: T0 }));
    const html = reportToPrintHtml(buildReport(closeNet(net, T0 + min(1))));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;b&gt;Hiram&lt;/b&gt;');
  });

  it('historyToCsv rolls up several nets', () => {
    const a = fullNet();
    let b = createNet({ name: 'Second Net', ncs: 'W1AW', now: T0 + min(60) });
    ({ net: b } = checkIn(b, { call: 'N0CALL', now: T0 + min(61) }));
    b = closeNet(b, T0 + min(70));
    const lines = historyToCsv([b, a]).trim().split('\r\n');
    expect(lines).toHaveLength(1 + 1 + 3);
    expect(lines[1]).toMatch(/^Second Net,W1AW,/);
    expect(lines[2]).toMatch(/^ARES Tuesday Net,K0CJH,/);
  });
});

describe('toRosterEntries', () => {
  it('matches the EmComm roster entry shape', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', flags: ['traffic'], name: 'Hiram', location: 'CT', now: T0 + min(1) }));
    ({ net } = checkIn(net, { call: 'K0CJH', now: T0 + min(2) }));
    net = checkOut(net, 'K0CJH', T0 + min(5));
    const roster = toRosterEntries(net);
    expect(roster.map((r) => r.call)).toEqual(['W1AW', 'K0CJH']);
    expect(roster[0]).toEqual({
      call: 'W1AW',
      netName: 'ARES Tuesday Net',
      status: 'Voice net: TFC · Hiram · CT',
      checkinTime: T0 + min(1),
      lastHeard: T0 + min(1),
      lat: null,
      lon: null,
      tokens: [],
      source: 'net-control',
    });
    expect(roster[1].status).toBe('Voice net: out 19:05');
    expect(roster[1].lastHeard).toBe(T0 + min(5));
  });
});

describe('script templates', () => {
  it('fills placeholders and leaves unknown/empty ones alone', () => {
    const out = fillTemplate('{ncs} opens {net} on {freq} at {time} with {count}; {nope}', {
      ncs: 'K0CJH',
      net: 'ARES Net',
      freq: '',
      time: '19:00',
      count: '7',
    });
    expect(out).toBe('K0CJH opens ARES Net on {freq} at 19:00 with 7; {nope}');
  });
  it('scriptContext derives values from the net', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    const ctx = scriptContext(net, T0);
    expect(ctx).toMatchObject({ net: 'ARES Tuesday Net', ncs: 'K0CJH', freq: '146.940 - 100.0', count: '1' });
    expect(ctx.time).toContain('19:00 UTC');
    expect(ctx.date).toBeTruthy();
  });
  it('the default preamble and closing use the placeholders', () => {
    expect(DEFAULT_PREAMBLE).toContain('{ncs}');
    expect(DEFAULT_PREAMBLE).toContain('{net}');
    expect(DEFAULT_CLOSING).toContain('{count}');
  });
});

describe('station fills', () => {
  it('stationFromLogbook picks the newest QSO with a name', () => {
    const qsos = [
      { call: 'W1AW', qso_date: '20250101', time_on: '120000', name: 'Old Name', extras: { QTH: 'Hartford' } },
      { call: 'W1AW', qso_date: '20260301', time_on: '090000', name: 'Hiram', extras: { STATE: 'CT' } },
      { call: 'W1AW', qso_date: '20260401', time_on: '090000', name: '', extras: {} },
      { call: 'K0CJH', qso_date: '20260401', time_on: '090000', name: 'Chris' },
    ];
    expect(stationFromLogbook(qsos, 'w1aw')).toEqual({ name: 'Hiram', location: 'CT' });
    expect(stationFromLogbook(qsos, 'N0CALL')).toBeNull();
    expect(stationFromLogbook(null, 'W1AW')).toBeNull();
  });
  it('stationFromLookup composes name and location from a callbook result', () => {
    expect(
      stationFromLookup({ fname: 'Hiram', name: 'Maxim', county: 'Hartford', state: 'CT', country: 'United States' }),
    ).toEqual({ name: 'Hiram Maxim', location: 'Hartford, CT' });
    expect(stationFromLookup({ name: 'Koen', country: 'Belgium' })).toEqual({ name: 'Koen', location: 'Belgium' });
    expect(stationFromLookup({ country: 'Unknown', source: 'qrz' })).toBeNull();
    expect(stationFromLookup({ country: 'United States', source: 'prefix' })).toBeNull();
    expect(stationFromLookup({ country: 'United States', source: 'hamqth-dxcc', estimated: true })).toBeNull();
    expect(stationFromLookup({ country: 'United States', source: 'qrz' })).toBeNull();
    expect(stationFromLookup(null)).toBeNull();
  });
});

describe('storage', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips the running net and clears it', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    saveRunningNet(net);
    expect(loadRunningNet()).toEqual(net);
    clearRunningNet();
    expect(loadRunningNet()).toBeNull();
  });
  it('tolerates corrupt storage', () => {
    localStorage.setItem('openhamclock_netControl', '{not json');
    expect(loadRunningNet()).toBeNull();
    localStorage.setItem('openhamclock_netControlHistory', '"nope"');
    expect(loadHistory()).toEqual([]);
    localStorage.setItem('openhamclock_netControlStations', '[]');
    expect(loadStationCache()).toEqual({});
  });
  it('pushHistory prepends, dedupes by id, drops undo and caps', () => {
    let list = [];
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      let net = createNet({ name: `Net ${i}`, now: T0 + min(i) });
      ({ net } = checkIn(net, { call: 'W1AW', now: T0 + min(i) }));
      list = pushHistory(list, closeNet(net, T0 + min(i) + 1000));
    }
    expect(list).toHaveLength(MAX_HISTORY);
    expect(list[0].name).toBe(`Net ${MAX_HISTORY + 4}`);
    expect(list[0].undo).toBeUndefined();
    const again = pushHistory(list, list[3]);
    expect(again).toHaveLength(MAX_HISTORY);
    expect(again[0].id).toBe(list[3].id);
  });
  it('script defaults and persists', () => {
    expect(loadScript()).toEqual({ preamble: DEFAULT_PREAMBLE, closing: DEFAULT_CLOSING });
    saveScript({ preamble: 'Hi', closing: DEFAULT_CLOSING });
    expect(loadScript().preamble).toBe('Hi');
  });
  it('station cache remembers, merges and evicts oldest', () => {
    let cache = rememberStation({}, 'w1aw', { name: 'Hiram' }, 1);
    cache = rememberStation(cache, 'W1AW', { location: 'CT' }, 2);
    expect(cache.W1AW).toEqual({ name: 'Hiram', location: 'CT', ts: 2 });
    expect(rememberStation(cache, 'K0CJH', {}, 3)).toBe(cache);
    for (let i = 0; i < STATION_CACHE_MAX; i++) cache = rememberStation(cache, `K${i}AB`, { name: 'x' }, 10 + i);
    expect(Object.keys(cache)).toHaveLength(STATION_CACHE_MAX);
    expect(cache.W1AW).toBeUndefined(); // oldest evicted
    saveStationCache(cache);
    expect(Object.keys(loadStationCache())).toHaveLength(STATION_CACHE_MAX);
  });
  it('saveRosterSnapshot writes roster-shaped entries', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    let fired = 0;
    const onEvt = () => fired++;
    window.addEventListener(NET_CONTROL_ROSTER_EVENT, onEvt);
    saveRosterSnapshot(net, { active: true });
    window.removeEventListener(NET_CONTROL_ROSTER_EVENT, onEvt);
    expect(fired).toBe(1);
    const snap = JSON.parse(localStorage.getItem(NET_CONTROL_ROSTER_KEY));
    expect(snap.net).toBe('ARES Tuesday Net');
    expect(snap.active).toBe(true);
    expect(snap.roster[0]).toMatchObject({ call: 'W1AW', netName: 'ARES Tuesday Net', source: 'net-control' });
    expect(getNetControlRoster()).toEqual(snap);
  });
  it('mergeRosters adds active voice-net stations the APRS roster lacks', () => {
    let net = startNet();
    ({ net } = checkIn(net, { call: 'W1AW', now: T0 }));
    ({ net } = checkIn(net, { call: 'KE8PLM', now: T0 + min(1) }));
    const aprs = [{ call: 'KE8PLM-7', netName: 'APRSNET', status: 'Checked in', age: 0, stale: false }];
    saveRosterSnapshot(net, { active: true });
    const merged = mergeRosters(aprs, getNetControlRoster(), T0 + min(3));
    expect(merged.map((r) => r.call)).toEqual(['KE8PLM-7', 'W1AW']);
    expect(merged[1]).toMatchObject({ age: 3, stale: false, source: 'net-control' });
    saveRosterSnapshot(closeNet(net, T0 + min(5)), { active: false });
    expect(mergeRosters(aprs, getNetControlRoster())).toBe(aprs);
    expect(mergeRosters(null, null)).toEqual([]);
  });
  it('flagsToText', () => {
    expect(flagsToText(['mobile', 'traffic', 'bogus'])).toBe('TFC MOB');
    expect(flagsToText([])).toBe('');
  });
});
