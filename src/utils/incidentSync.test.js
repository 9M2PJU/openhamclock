import { describe, expect, it } from 'vitest';
import {
  emptyIncidentState,
  applyIncidentDelta,
  incidentEventList,
  incidentRosterList,
  mergeDisplayedRoster,
  diffRosterForPush,
  fieldReportForPush,
  shelterReportForPush,
  mergeFieldReports,
  mergeShelterReports,
  eventForPush,
  emptyOutbox,
  queueOutbox,
  outboxBatch,
  outboxSize,
  ackOutbox,
  buildJoinUrl,
  parseJoinUrl,
  formatCode,
  normaliseCode,
  stateForCache,
  MAX_CACHED_EVENTS,
} from './incidentSync.js';

const NOW = 1_700_000_000_000;

describe('applyIncidentDelta', () => {
  it('merges events by id so a replayed snapshot adds nothing', () => {
    const delta = {
      seq: 3,
      events: [
        { id: 'a', ts: 2, type: 'nws_alert', seq: 2 },
        { id: 'b', ts: 1, type: 'nws_alert', seq: 3 },
      ],
    };
    const s1 = applyIncidentDelta(emptyIncidentState(), delta);
    const s2 = applyIncidentDelta(s1, delta); // reconnect replays the same records
    expect(Object.keys(s2.events)).toHaveLength(2);
    expect(s2.events).toBe(s1.events); // no change → same identity
    expect(incidentEventList(s2).map((e) => e.id)).toEqual(['b', 'a']);
    expect(s2.seq).toBe(3);
  });

  it('keeps the newer roster entry and never moves seq backwards', () => {
    let s = applyIncidentDelta(emptyIncidentState(), {
      seq: 5,
      roster: [{ call: 'W1AW', status: 'new', updatedAt: 200 }],
    });
    s = applyIncidentDelta(s, { seq: 2, roster: [{ call: 'W1AW', status: 'old', updatedAt: 100 }] });
    expect(s.roster.W1AW.status).toBe('new');
    expect(s.seq).toBe(5);
    s = applyIncidentDelta(s, { seq: 6, roster: [{ call: 'W1AW', status: 'out', checkedOut: true, updatedAt: 300 }] });
    expect(s.roster.W1AW.checkedOut).toBe(true);
  });

  it('takes the board, participants and reports', () => {
    const s = applyIncidentDelta(emptyIncidentState(), {
      seq: 4,
      participants: 3,
      board: { name: 'Flood', seq: 4 },
      reports: [{ id: 'field-1', kind: 'field', timestamp: 1 }],
    });
    expect(s.board.name).toBe('Flood');
    expect(s.participants).toBe(3);
    expect(s.reports['field-1']).toBeTruthy();
    const older = applyIncidentDelta(s, { board: { name: 'Old', seq: 1 } });
    expect(older.board.name).toBe('Flood');
  });

  it('ignores junk', () => {
    const s = emptyIncidentState();
    expect(applyIncidentDelta(s, null)).toBe(s);
    expect(applyIncidentDelta(s, { events: [null, {}], roster: [{}] }).events).toEqual({});
  });

  it('trims the cached copy to the latest events', () => {
    const events = Array.from({ length: MAX_CACHED_EVENTS + 10 }, (_, i) => ({ id: `e${i}`, ts: i }));
    const s = applyIncidentDelta(emptyIncidentState(), { events });
    const cached = stateForCache(s);
    expect(Object.keys(cached.events)).toHaveLength(MAX_CACHED_EVENTS);
    expect(cached.events.e0).toBeUndefined();
    expect(cached.events[`e${MAX_CACHED_EVENTS + 9}`]).toBeTruthy();
  });
});

describe('roster display', () => {
  const state = applyIncidentDelta(emptyIncidentState(), {
    roster: [
      { call: 'K1ABC', status: 'At shelter', lastHeard: NOW - 20 * 60000, source: 'manual', updatedAt: 1 },
      { call: 'N0OUT', checkedOut: true, updatedAt: NOW },
      { call: 'W1AW', status: 'Remote status', lastHeard: NOW - 60000, source: 'aprs', updatedAt: 1, site: 'EOC' },
    ],
  });

  it('lists only active incident operators, manual check-ins never stale', () => {
    const list = incidentRosterList(state, NOW);
    expect(list.map((e) => e.call)).toEqual(['W1AW', 'K1ABC']);
    expect(list.find((e) => e.call === 'K1ABC')).toMatchObject({ age: 20, stale: false });
  });

  it('merges local and incident rosters without duplicates; incident check-out hides a stale local entry', () => {
    const local = [
      { call: 'W1AW', status: 'Checked in', checkinTime: NOW - 3600000, lat: 42, lon: -71, age: 0 },
      { call: 'N0OUT', checkinTime: NOW - 3600000, age: 5 },
      { call: 'KD0NEW', checkinTime: NOW, age: 0 },
    ];
    const merged = mergeDisplayedRoster(local, state, NOW);
    expect(merged.map((e) => e.call).sort()).toEqual(['K1ABC', 'KD0NEW', 'W1AW']);
    const w = merged.find((e) => e.call === 'W1AW');
    expect(w).toMatchObject({ status: 'Remote status', lat: 42, site: 'EOC' });
  });

  it('a local re-check-in after an incident check-out is shown', () => {
    const local = [{ call: 'N0OUT', checkinTime: NOW + 1000, age: 0 }];
    expect(mergeDisplayedRoster(local, state, NOW).map((e) => e.call)).toContain('N0OUT');
  });
});

describe('diffRosterForPush', () => {
  const op = { call: 'w1aw', netName: 'ARES', status: 'Checked in', checkinTime: NOW - 1000, lastHeard: NOW };

  it('first pass sends every entry with updatedAt = check-in time', () => {
    const { push, next } = diffRosterForPush(null, [op], emptyIncidentState(), NOW);
    expect(push).toHaveLength(1);
    expect(push[0]).toMatchObject({ call: 'W1AW', updatedAt: NOW - 1000, checkedOut: false });
    expect(next.has('W1AW')).toBe(true);
  });

  it('sends nothing when nothing changed (lastHeard alone is not a change)', () => {
    const { next } = diffRosterForPush(null, [op], emptyIncidentState(), NOW);
    const { push } = diffRosterForPush(next, [{ ...op, lastHeard: NOW + 5000 }], emptyIncidentState(), NOW);
    expect(push).toEqual([]);
  });

  it('sends a status change stamped now', () => {
    const { next } = diffRosterForPush(null, [op], emptyIncidentState(), NOW);
    const { push } = diffRosterForPush(next, [{ ...op, status: 'Mobile' }], emptyIncidentState(), NOW + 10);
    expect(push[0]).toMatchObject({ status: 'Mobile', updatedAt: NOW + 10 });
  });

  it('does not resurrect an operator checked out elsewhere because of local beacon changes', () => {
    const { next } = diffRosterForPush(null, [op], emptyIncidentState(), NOW);
    const inc = applyIncidentDelta(emptyIncidentState(), {
      roster: [{ call: 'W1AW', checkedOut: true, updatedAt: NOW }],
    });
    const { push } = diffRosterForPush(next, [{ ...op, lat: 1, lon: 2 }], inc, NOW + 10);
    expect(push).toEqual([]);
  });

  it('sends a check-out when an operator leaves the local roster, once', () => {
    const { next } = diffRosterForPush(null, [op], emptyIncidentState(), NOW);
    const out = diffRosterForPush(next, [], emptyIncidentState(), NOW + 10);
    expect(out.push).toEqual([expect.objectContaining({ call: 'W1AW', checkedOut: true, updatedAt: NOW + 10 })]);
    const inc = applyIncidentDelta(emptyIncidentState(), {
      roster: [{ call: 'W1AW', checkedOut: true, updatedAt: 1 }],
    });
    expect(diffRosterForPush(next, [], inc, NOW).push).toEqual([]);
  });

  it('treats a local roster that empties all at once as a server reset, not mass check-out', () => {
    const two = [op, { ...op, call: 'K1ABC' }];
    const { next } = diffRosterForPush(null, two, emptyIncidentState(), NOW);
    expect(diffRosterForPush(next, [], emptyIncidentState(), NOW + 10).push).toEqual([]);
  });

  it('a re-check-in (new check-in time) is sent as a fresh check-in', () => {
    const { next } = diffRosterForPush(null, [op], emptyIncidentState(), NOW);
    const { push } = diffRosterForPush(next, [{ ...op, checkinTime: NOW + 50 }], emptyIncidentState(), NOW + 60);
    expect(push[0]).toMatchObject({ updatedAt: NOW + 50 });
  });
});

describe('reports', () => {
  it('maps local field and shelter reports to stable incident ids', () => {
    expect(fieldReportForPush({ id: 'abc', callsign: 'W1AW', timestamp: 5 })).toMatchObject({
      id: 'field-abc',
      kind: 'field',
    });
    expect(shelterReportForPush({ from: 'K1ABC', timestamp: 7, text: 'open' })).toMatchObject({
      id: 'shelter-K1ABC-7',
      kind: 'shelter',
      callsign: 'K1ABC',
    });
  });

  it('merges incident reports into local lists without duplicating ones both sides have', () => {
    const state = applyIncidentDelta(emptyIncidentState(), {
      reports: [
        { id: 'field-abc', kind: 'field', callsign: 'W1AW', timestamp: NOW - 120000 },
        { id: 'field-remote', kind: 'field', callsign: 'K1ABC', timestamp: NOW - 60000 },
        { id: 'shelter-K1ABC-7', kind: 'shelter', callsign: 'K1ABC', timestamp: 7, text: 'open' },
        { id: 'shelter-N0X-9', kind: 'shelter', callsign: 'N0X', timestamp: 9, text: 'full', tokens: [] },
      ],
    });
    const fr = mergeFieldReports([{ id: 'abc', callsign: 'W1AW', timestamp: NOW - 120000, age: 2 }], state, NOW);
    expect(fr.map((r) => r.id)).toEqual(['field-remote', 'abc']);
    expect(fr[0].age).toBe(1);

    const sr = mergeShelterReports([{ from: 'K1ABC', timestamp: 7, text: 'open' }], state);
    expect(sr).toHaveLength(2);
    expect(sr[1]).toMatchObject({ from: 'N0X', source: 'incident' });
  });

  it('strips local-only fields from events', () => {
    const ev = eventForPush({ id: 'x', ts: 1, type: 'nws_alert', summary: 's', recordedAt: 5, dedupeKey: 'k' });
    expect(ev).toEqual({ id: 'x', ts: 1, type: 'nws_alert', callsign: '', summary: 's', details: '', dedupeKey: 'k' });
  });
});

describe('outbox', () => {
  it('queues, dedupes and keeps only the newest roster entry per call', () => {
    let o = queueOutbox(emptyOutbox(), {
      roster: [{ call: 'W1AW', updatedAt: 2, status: 'b' }],
      events: [{ id: 'e1', ts: 1 }],
    });
    o = queueOutbox(o, {
      roster: [{ call: 'W1AW', updatedAt: 1, status: 'older' }],
      events: [{ id: 'e1', ts: 1 }],
      reports: [{ id: 'r1', timestamp: 1 }],
    });
    expect(o.roster.W1AW.status).toBe('b');
    expect(outboxSize(o)).toBe(3);
  });

  it('acks only what was sent; items re-queued in flight survive', () => {
    let o = queueOutbox(emptyOutbox(), {
      roster: [{ call: 'W1AW', updatedAt: 1 }],
      events: [{ id: 'e1', ts: 1 }],
      board: { name: 'A', updatedAt: 1 },
    });
    const batch = outboxBatch(o);
    expect(batch.board.name).toBe('A');
    // while the POST is in flight:
    o = queueOutbox(o, { roster: [{ call: 'W1AW', updatedAt: 5 }], events: [{ id: 'e2', ts: 2 }] });
    o = ackOutbox(o, batch);
    expect(Object.keys(o.events)).toEqual(['e2']);
    expect(o.roster.W1AW.updatedAt).toBe(5);
    expect(o.board).toBeNull();
    expect(outboxBatch(ackOutbox(o, outboxBatch(o)))).toBeNull();
  });

  it('caps the buffer, dropping the oldest events', () => {
    const events = Array.from({ length: 600 }, (_, i) => ({ id: `e${i}`, ts: i }));
    const o = queueOutbox(emptyOutbox(), { events });
    expect(Object.keys(o.events)).toHaveLength(500);
    expect(o.events.e0).toBeUndefined();
    expect(o.events.e599).toBeTruthy();
  });
});

describe('join link', () => {
  it('puts the key in the fragment and round-trips', () => {
    const url = buildJoinUrl('https://eoc.local:3000/', 'ABCDEFGH', 'JKMNPQRSTUVWXYZ2');
    expect(url).toBe('https://eoc.local:3000/#incident=ABCDEFGH&key=JKMNPQRSTUVWXYZ2');
    expect(parseJoinUrl(url)).toEqual({ id: 'ABCDEFGH', key: 'JKMNPQRSTUVWXYZ2' });
    expect(parseJoinUrl('#incident=abcd-efgh&key=jkmn-pqrs-tuvw-xyz2')).toEqual({
      id: 'ABCDEFGH',
      key: 'JKMNPQRSTUVWXYZ2',
    });
    expect(parseJoinUrl('#other=1')).toBeNull();
    expect(parseJoinUrl('')).toBeNull();
  });

  it('formats codes in groups of four', () => {
    expect(formatCode('jkmnpqrstuvwxyz2')).toBe('JKMN-PQRS-TUVW-XYZ2');
    expect(normaliseCode(' ab-cd ')).toBe('ABCD');
    expect(formatCode('')).toBe('');
  });
});

describe('event types', () => {
  it('the server accepts every Event Log type, so no local entry fails to sync', async () => {
    const { EVENT_TYPE_META } = await import('./emcommEventLog.js');
    const { EVENT_TYPES } = await import('../../server/utils/incidentStore.js');
    for (const type of Object.keys(EVENT_TYPE_META)) expect(EVENT_TYPES.has(type), type).toBe(true);
  });
});
