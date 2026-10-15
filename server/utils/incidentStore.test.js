/**
 * Tests for server/utils/incidentStore.js — shared incident state model.
 */
import { beforeEach, describe, expect, it } from 'vitest';

const { createIncidentStore, IncidentError, LIMITS } = require('./incidentStore.js');

describe('incidentStore', () => {
  let clock;
  let store;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    store = createIncidentStore({ now });
  });

  const make = (input = {}) => store.create({ name: 'Flood 2026', ic: 'K0CJH', netFreq: '146.520', ...input });

  describe('create / verify', () => {
    it('creates an incident with a random id and a one-time join key', () => {
      const { incident, joinKey } = make();
      expect(incident.id).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(joinKey).toHaveLength(16);
      expect(incident.board).toMatchObject({ name: 'Flood 2026', ic: 'K0CJH', netFreq: '146.520' });
      expect(incident.participants).toBe(0);
      expect(incident.counts).toEqual({ roster: 0, events: 0, reports: 0 });
      expect(store.size).toBe(1);
    });

    it('verifies the join key (case/separator tolerant) and rejects wrong keys and ids', () => {
      const { incident, joinKey } = make();
      expect(store.verify(incident.id, joinKey)).not.toBeNull();
      expect(store.verify(incident.id.toLowerCase(), joinKey.toLowerCase())).not.toBeNull();
      expect(store.verify(incident.id, 'WRONGKEYWRONGKEY')).toBeNull();
      expect(store.verify('NOPENOPE', joinKey)).toBeNull();
    });

    it('never persists the join key, only its salted hash', () => {
      const { joinKey } = make();
      expect(JSON.stringify(store.serialise())).not.toContain(joinKey);
    });

    it('caps the number of incidents', () => {
      const small = createIncidentStore({ now, limits: { maxIncidents: 2 } });
      small.create({});
      small.create({});
      expect(() => small.create({})).toThrow(IncidentError);
      try {
        small.create({});
      } catch (e) {
        expect(e.status).toBe(503);
      }
    });

    it('at the cap, evicts the longest-idle unattended incident but never an active one', () => {
      const small = createIncidentStore({ now, limits: { maxIncidents: 2 } });
      const { incident: a } = small.create({});
      const { incident: b } = small.create({});
      small.touchParticipant(a.id, 'client-a');
      expect(() => small.create({})).toThrow(/limit/); // both fresh
      clock += 2 * 60 * 60 * 1000;
      small.touchParticipant(a.id, 'client-a'); // a is attended
      const { incident: c } = small.create({});
      expect(small.has(a.id)).toBe(true);
      expect(small.has(b.id)).toBe(false);
      expect(small.has(c.id)).toBe(true);
    });

    it('uses tighter limits when hosted', () => {
      const hosted = createIncidentStore({ hosted: true });
      expect(hosted.limits).toEqual(LIMITS.hosted);
      expect(hosted.limits.maxIncidents).toBeLessThan(LIMITS.local.maxIncidents);
    });
  });

  describe('apply — roster', () => {
    it('adds entries keyed by callsign and reports only what changed', () => {
      const { incident } = make();
      const r = store.apply(incident.id, {
        roster: [
          { call: 'w1aw', netName: 'ARES', status: 'At EOC', checkinTime: clock - 1000 },
          { call: 'K1ABC', netName: 'ARES' },
          { call: '' },
        ],
      });
      expect(r.changed).toBe(true);
      expect(r.changes.roster.map((e) => e.call)).toEqual(['W1AW', 'K1ABC']);
      expect(r.changes.roster[1].status).toBe('Checked in');
      expect(store.snapshot(incident.id).roster).toHaveLength(2);
    });

    it('is idempotent for an unchanged entry and newest updatedAt wins', () => {
      const { incident } = make();
      const base = { call: 'W1AW', netName: 'ARES', status: 'At EOC', checkinTime: clock, updatedAt: clock };
      const first = store.apply(incident.id, { roster: [base] });
      const again = store.apply(incident.id, { roster: [base] });
      expect(again.changed).toBe(false);
      expect(again.seq).toBe(first.seq);

      const stale = store.apply(incident.id, { roster: [{ ...base, status: 'Old', updatedAt: clock - 5000 }] });
      expect(stale.changed).toBe(false);

      const newer = store.apply(incident.id, {
        roster: [{ ...base, status: 'Checked out', checkedOut: true, updatedAt: clock + 5000 }],
      });
      expect(newer.changes.roster[0]).toMatchObject({ call: 'W1AW', checkedOut: true });
      expect(store.snapshot(incident.id).counts.roster).toBe(0); // checked-out not counted as active
    });

    it('caps the roster, dropping checked-out operators first', () => {
      const small = createIncidentStore({ now, limits: { maxRoster: 3 } });
      const { incident } = small.create({});
      small.apply(incident.id, {
        roster: [
          { call: 'A1A', updatedAt: clock },
          { call: 'B1B', updatedAt: clock + 1, checkedOut: true },
          { call: 'C1C', updatedAt: clock + 2 },
          { call: 'D1D', updatedAt: clock + 3 },
        ],
      });
      const calls = small
        .snapshot(incident.id)
        .roster.map((e) => e.call)
        .sort();
      expect(calls).toEqual(['A1A', 'C1C', 'D1D']);
    });

    it('sanitises tokens and coordinates', () => {
      const { incident } = make();
      const r = store.apply(incident.id, {
        roster: [
          {
            call: 'W1AW',
            lat: 95,
            lon: -71.1,
            tokens: [{ key: 'Beds', current: 30, max: 100 }, { nope: 1 }, 'x'],
          },
        ],
      });
      expect(r.changes.roster[0]).toMatchObject({
        lat: null,
        lon: -71.1,
        tokens: [{ key: 'Beds', type: 'text', current: 30, max: 100 }],
      });
    });
  });

  describe('apply — events', () => {
    it('dedupes by id and by type:dedupeKey across browsers', () => {
      const { incident } = make();
      const a = store.apply(incident.id, {
        events: [{ id: 'b1-1', type: 'net_checkin', callsign: 'W1AW', summary: 'in', dedupeKey: 'W1AW-1' }],
      });
      expect(a.changes.events).toHaveLength(1);
      const b = store.apply(incident.id, {
        events: [
          { id: 'b1-1', type: 'net_checkin', callsign: 'W1AW', summary: 'in' }, // same id
          { id: 'b2-9', type: 'net_checkin', callsign: 'W1AW', summary: 'in', dedupeKey: 'W1AW-1' }, // same real event, other browser
          { id: 'b2-10', type: 'bogus', summary: 'x' }, // unknown type
          { id: 'b2-11', type: 'aprs_msg_rx', callsign: 'K1ABC', summary: 'Message to W1AW', details: 'hi' },
        ],
      });
      expect(b.changes.events.map((e) => e.id)).toEqual(['b2-11']);
      expect(store.snapshot(incident.id).events).toHaveLength(2);
    });

    it('returns events oldest first in snapshots and caps the log by timestamp', () => {
      const small = createIncidentStore({ now, limits: { maxEvents: 3 } });
      const { incident } = small.create({});
      small.apply(incident.id, {
        events: [
          { id: 'e3', type: 'nws_alert', ts: 3, summary: 'three' },
          { id: 'e1', type: 'nws_alert', ts: 1, summary: 'one' },
          { id: 'e4', type: 'nws_alert', ts: 4, summary: 'four' },
          { id: 'e2', type: 'nws_alert', ts: 2, summary: 'two' },
        ],
      });
      expect(small.snapshot(incident.id).events.map((e) => e.id)).toEqual(['e2', 'e3', 'e4']);
    });

    it('stamps the origin site when the record has none', () => {
      const { incident } = make();
      const r = store.apply(
        incident.id,
        { events: [{ id: 'x', type: 'incident_note', summary: 'note' }] },
        { site: 'EOC-North' },
      );
      expect(r.changes.events[0].site).toBe('EOC-North');
    });
  });

  describe('apply — reports and board', () => {
    it('accepts field and shelter reports by id and rejects unknown kinds', () => {
      const { incident } = make();
      const r = store.apply(incident.id, {
        reports: [
          { id: 'f1', kind: 'field', callsign: 'W1AW', formType: 'FSR', text: 'Bridge out', lat: 42.1, lon: -71.2 },
          {
            id: 's1',
            kind: 'shelter',
            callsign: 'K1ABC',
            text: 'Shelter open',
            tokens: [{ key: 'Beds', type: 'capacity', current: 30, max: 100 }],
          },
          { id: 'f1', kind: 'field', callsign: 'W1AW', text: 'dup' },
          { id: 'z1', kind: 'other', text: 'no' },
          { id: 'z2', kind: 'field' }, // empty
        ],
      });
      expect(r.changes.reports.map((x) => x.id)).toEqual(['f1', 's1']);
      expect(r.changes.reports[1].tokens).toEqual([{ key: 'Beds', type: 'capacity', current: 30, max: 100 }]);
    });

    it('updates the board only when the incoming copy is newer, and ignores no-op rewrites', () => {
      const { incident } = make();
      const old = store.apply(incident.id, { board: { name: 'Older', updatedAt: clock - 10 } });
      expect(old.changed).toBe(false);
      const same = store.apply(incident.id, {
        board: { name: 'Flood 2026', ic: 'K0CJH', netFreq: '146.520', notes: '', updatedAt: clock + 10 },
      });
      expect(same.changed).toBe(false);
      const newer = store.apply(incident.id, {
        board: { name: 'Flood 2026', ic: 'K0CJH', netFreq: '146.520', notes: 'Shelter at HS', updatedAt: clock + 20 },
      });
      expect(newer.changed).toBe(true);
      expect(newer.changes.board.notes).toBe('Shelter at HS');
      expect(store.snapshot(incident.id).board.notes).toBe('Shelter at HS');
    });

    it('throws 404 for an unknown incident', () => {
      expect(() => store.apply('NOPENOPE', {})).toThrow(/Unknown or expired/);
    });
  });

  describe('snapshot cursor', () => {
    it('returns only records stamped after `since`', () => {
      const { incident } = make();
      const a = store.apply(incident.id, { events: [{ id: 'e1', type: 'nws_alert', summary: 'one' }] });
      store.apply(incident.id, {
        events: [{ id: 'e2', type: 'nws_alert', summary: 'two' }],
        roster: [{ call: 'W1AW' }],
      });
      const delta = store.snapshot(incident.id, a.seq);
      expect(delta.events.map((e) => e.id)).toEqual(['e2']);
      expect(delta.roster.map((e) => e.call)).toEqual(['W1AW']);
      expect(delta.board).toBeNull(); // unchanged since cursor
      expect(store.snapshot(incident.id, 0).board).not.toBeNull();
    });
  });

  describe('participants', () => {
    it('counts recently-seen clients and forgets them after the TTL', () => {
      const { incident } = make();
      expect(store.touchParticipant(incident.id, 'c1', 'W1AW')).toBe(1);
      expect(store.touchParticipant(incident.id, 'c2', 'K1ABC')).toBe(2);
      expect(store.touchParticipant(incident.id, 'c1', 'W1AW')).toBe(2);
      clock += 10 * 60 * 1000;
      expect(store.meta(incident.id).participants).toBe(0);
      expect(store.touchParticipant(incident.id, 'c3')).toBe(1);
      expect(store.removeParticipant(incident.id, 'c3')).toBe(0);
    });

    it('bounds the participant map', () => {
      const small = createIncidentStore({ now, limits: { maxParticipants: 2 } });
      const { incident } = small.create({});
      small.touchParticipant(incident.id, 'a');
      clock += 1;
      small.touchParticipant(incident.id, 'b');
      clock += 1;
      expect(small.touchParticipant(incident.id, 'c')).toBe(2);
    });
  });

  describe('expiry and persistence', () => {
    it('expires incidents idle for longer than idleMs', () => {
      const s = createIncidentStore({ now, idleMs: 1000 });
      const { incident: a } = s.create({});
      clock += 500;
      const { incident: b } = s.create({});
      clock += 600;
      expect(s.expire()).toBe(1);
      expect(s.has(a.id)).toBe(false);
      expect(s.has(b.id)).toBe(true);
    });

    it('activity refreshes the idle clock', () => {
      const s = createIncidentStore({ now, idleMs: 1000 });
      const { incident } = s.create({});
      clock += 900;
      s.apply(incident.id, { events: [{ id: 'e', type: 'incident_note', summary: 'still here' }] });
      clock += 900;
      expect(s.expire()).toBe(0);
    });

    it('round-trips through serialise/hydrate with keys still valid and seq preserved', () => {
      const { incident, joinKey } = make();
      store.apply(incident.id, {
        roster: [{ call: 'W1AW', netName: 'ARES' }],
        events: [{ id: 'e1', type: 'net_checkin', callsign: 'W1AW', summary: 'in', dedupeKey: 'W1AW-x' }],
        reports: [{ id: 'f1', kind: 'field', callsign: 'W1AW', text: 'ok' }],
      });
      const before = store.snapshot(incident.id);
      const json = JSON.parse(JSON.stringify(store.serialise()));

      const restored = createIncidentStore({ now });
      expect(restored.hydrate(json)).toBe(1);
      expect(restored.verify(incident.id, joinKey)).not.toBeNull();
      const after = restored.snapshot(incident.id);
      expect(after.seq).toBe(before.seq);
      expect(after.roster).toEqual(before.roster);
      expect(after.events).toEqual(before.events);
      expect(after.reports).toEqual(before.reports);
      expect(after.board).toEqual(before.board);
      // dedupe index rebuilt from the loaded log
      const dup = restored.apply(incident.id, {
        events: [{ id: 'e9', type: 'net_checkin', callsign: 'W1AW', summary: 'in', dedupeKey: 'W1AW-x' }],
      });
      expect(dup.changed).toBe(false);
    });

    it('skips malformed persisted entries and respects the incident cap on load', () => {
      const small = createIncidentStore({ now, limits: { maxIncidents: 1 } });
      const good = store.serialise();
      make();
      const two = store.serialise();
      expect(small.hydrate([null, { id: 'x' }, ...two])).toBe(1);
      expect(small.hydrate('nope')).toBe(0);
      expect(good).toHaveLength(0);
    });
  });
});
