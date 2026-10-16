import { describe, expect, it } from 'vitest';
import { reconcileNet, mergeNets, netTag, sameNetContent, orderStations } from './incidentNetMerge.js';

const st = (call, extra = {}) => ({ call, flags: [], checkinTime: 1, checkoutTime: null, ...extra });
const base = {
  id: 'n1',
  name: 'ARES',
  frequency: '146.52',
  stations: [st('W1AW'), st('K1ABC')],
  rev: 10,
  updatedAt: 100,
};
const history = new Map([['10:100', base]]);
const doc = (net, parentTag, rev = 11, updatedAt = 200) => ({
  kind: 'net-control',
  net,
  rev,
  updatedAt,
  tag: `${rev}:${updatedAt}`,
  parentTag,
});

describe('reconcileNet (shared net across sites)', () => {
  it('two sites checking in different stations both survive', () => {
    const mine = { ...base, stations: [st('KD0ABC'), ...base.stations], rev: 11, updatedAt: 150 };
    const theirs = { ...base, stations: [st('N0XYZ'), ...base.stations] };
    const r = reconcileNet({ head: '11:150', history, local: mine, remote: doc(theirs, '10:100') });
    expect(r.action).toBe('merge');
    expect(r.net.stations.map((s) => s.call).sort()).toEqual(['K1ABC', 'KD0ABC', 'N0XYZ', 'W1AW']);
  });

  it('a flag on one line here and a check-out on another there both survive', () => {
    const mine = { ...base, stations: [st('W1AW', { flags: ['T'] }), st('K1ABC')], rev: 11, updatedAt: 150 };
    const theirs = { ...base, stations: [st('W1AW'), st('K1ABC', { checkoutTime: 5 })] };
    const r = reconcileNet({ head: '11:150', history, local: mine, remote: doc(theirs, '10:100') });
    expect(r.action).toBe('merge');
    expect(r.net.stations.find((s) => s.call === 'W1AW').flags).toEqual(['T']);
    expect(r.net.stations.find((s) => s.call === 'K1ABC').checkoutTime).toBe(5);
  });

  it('a removal here survives an unrelated change there', () => {
    const mine = { ...base, stations: [st('W1AW')], rev: 11, updatedAt: 150 };
    const theirs = { ...base, frequency: '147.00' };
    const r = reconcileNet({ head: '11:150', history, local: mine, remote: doc(theirs, '10:100') });
    expect(r.action).toBe('merge');
    expect(r.net.stations.map((s) => s.call)).toEqual(['W1AW']);
    expect(r.net.frequency).toBe('147.00');
  });

  it('the same station changed at both sites is a conflict naming the call; theirs is taken', () => {
    const mine = { ...base, stations: [st('W1AW', { flags: ['T'] }), st('K1ABC')], rev: 11, updatedAt: 150 };
    const theirs = { ...base, stations: [st('W1AW', { flags: ['M'] }), st('K1ABC')] };
    const r = reconcileNet({ head: '11:150', history, local: mine, remote: doc(theirs, '10:100') });
    expect(r).toMatchObject({ action: 'conflict', calls: ['W1AW'], net: theirs });
  });

  it('the same field set differently at both sites is a conflict; the same value is not', () => {
    const mine = { ...base, frequency: '147.00', rev: 11, updatedAt: 150 };
    expect(
      reconcileNet({ head: '11:150', history, local: mine, remote: doc({ ...base, frequency: '145.00' }, '10:100') }),
    ).toMatchObject({ action: 'conflict', fields: ['frequency'] });
    const sameLine = { ...base, stations: [st('W1AW', { flags: ['T'] }), st('K1ABC')], frequency: '147.00' };
    const mine2 = { ...sameLine, rev: 11, updatedAt: 150 };
    expect(
      reconcileNet({ head: '11:150', history, local: mine2, remote: doc({ ...sameLine, name: 'ARES 2' }, '10:100') })
        .action,
    ).toBe('merge');
  });

  it('fast-forwards when theirs was made from what we have', () => {
    const theirs = { ...base, stations: [st('N0XYZ'), ...base.stations] };
    expect(reconcileNet({ head: '10:100', history, local: base, remote: doc(theirs, '10:100') })).toMatchObject({
      action: 'adopt',
      net: theirs,
    });
  });

  it('ignores its own state, notes an equal one, falls back without an ancestor', () => {
    expect(reconcileNet({ head: '11:200', history, local: base, remote: doc(base, '10:100') }).action).toBe('ignore');
    const same = { ...base, rev: 12, updatedAt: 999 };
    expect(reconcileNet({ head: '11:150', history, local: base, remote: doc(same, '10:100', 12, 300) }).action).toBe(
      'same',
    );
    const other = { ...base, stations: [] };
    expect(reconcileNet({ head: 'x', history, local: base, remote: doc(other, 'unknown') }).action).toBe('legacy');
    expect(reconcileNet({ head: 'x', history, local: null, remote: doc(other, '10:100') }).action).toBe('legacy');
    expect(
      reconcileNet({ head: 'x', history, local: base, remote: doc({ ...other, id: 'n2' }, '10:100') }).action,
    ).toBe('legacy');
  });

  it('converges at once: both sites hold the same stations in the same order', () => {
    const a = { ...base, stations: [st('KD0ABC', { checkinTime: 5 }), ...base.stations], rev: 11, updatedAt: 150 };
    const b = { ...base, stations: [st('N0XYZ', { checkinTime: 5 }), ...base.stations], rev: 11, updatedAt: 160 };
    const atA = reconcileNet({ head: netTag(a), history, local: a, remote: doc(b, '10:100', 11, 160) }).net;
    const atB = reconcileNet({ head: netTag(b), history, local: b, remote: doc(a, '10:100', 11, 150) }).net;
    expect(atA.stations.map((s) => s.call)).toEqual(atB.stations.map((s) => s.call));
    expect(atA.stations.map((s) => s.call)).toEqual(['KD0ABC', 'N0XYZ', 'K1ABC', 'W1AW']); // newest first, then call
    expect(sameNetContent(atA, atB)).toBe(true);
  });

  it('orderStations: newest check-in first, ties by callsign', () => {
    const out = orderStations([
      st('W1AW', { checkinTime: 1 }),
      st('K1ABC', { checkinTime: 3 }),
      st('AA1A', { checkinTime: 3 }),
    ]);
    expect(out.map((s) => s.call)).toEqual(['AA1A', 'K1ABC', 'W1AW']);
  });

  it('mergeNets keeps theirs where mine did not change anything (in merged order)', () => {
    const theirs = { ...base, name: 'X' };
    expect(sameNetContent(mergeNets(base, base, theirs), { ...theirs, stations: orderStations(theirs.stations) })).toBe(
      true,
    );
  });
});
