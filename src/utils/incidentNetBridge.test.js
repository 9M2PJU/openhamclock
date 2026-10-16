import { beforeEach, describe, expect, it } from 'vitest';
import {
  attach,
  detach,
  receiveNet,
  receiveHistory,
  publishNet,
  publishHistory,
  fitHistory,
  NET_DOC_MAX_BYTES,
  STASH_KEY,
  _resetForTests,
} from './incidentNetBridge.js';
import {
  serializeNetState,
  readRunningNetRecord,
  loadRunningNet,
  saveRunningNet,
  loadHistory,
  saveHistory,
  commitRunningNet,
} from './netControl.js';

const net = (name, rev = 1, stations = []) => ({ id: `net-${name}`, name, ncs: 'K0CJH', stations, startTime: 1, rev });

describe('incidentNetBridge', () => {
  let published;
  const join = (docs = {}) => attach({ docs, publish: (id, data) => published.push({ id, data }) });

  beforeEach(() => {
    localStorage.clear();
    _resetForTests();
    published = [];
  });

  it('a net already running here becomes the shared one when the incident has none', () => {
    saveRunningNet(net('ARES', 4, [{ call: 'W1AW' }]));
    join();
    const sent = published.find((p) => p.id === 'net-running');
    expect(sent.data).toMatchObject({ kind: 'net-control', net: { name: 'ARES' }, rev: 4 });
    expect(sent.data.net.undo).toBeUndefined();
  });

  it('the incident’s live net replaces ours on join, whatever the revisions, and ours comes back on leave', () => {
    saveRunningNet(net('Mine', 40));
    saveHistory([net('Old mine')]);
    const theirs = serializeNetState(net('Theirs', 3, [{ call: 'K1ABC' }]));
    join({ 'net-running': { data: theirs }, 'net-history': { data: [net('Their past')] } });
    expect(loadRunningNet().name).toBe('Theirs');
    expect(readRunningNetRecord().rev).toBeGreaterThan(40); // panels with rev 40 accept it
    expect(loadHistory().map((n) => n.name)).toEqual(['Their past']);
    expect(published.filter((p) => p.id === 'net-running')).toEqual([]);

    detach();
    expect(loadRunningNet().name).toBe('Mine');
    expect(loadHistory().map((n) => n.name)).toEqual(['Old mine']);
    expect(localStorage.getItem(STASH_KEY)).toBeNull();
  });

  it('while joined the history is the incident’s (empty when it has none)', () => {
    saveHistory([net('Mine')]);
    join();
    expect(loadHistory()).toEqual([]);
    detach();
    expect(loadHistory().map((n) => n.name)).toEqual(['Mine']);
  });

  it('a second tab leaving after the first does not close the restored net', () => {
    saveRunningNet(net('Mine', 2));
    join({ 'net-running': { data: serializeNetState(net('Theirs', 5)) } });
    detach(); // tab 1 leaves: ours is back
    expect(loadRunningNet().name).toBe('Mine');
    join({ 'net-running': { data: serializeNetState(net('Theirs', 5)) } }); // tab 2 still joined…
    localStorage.removeItem(STASH_KEY); // …but tab 1 already restored and removed the stash
    saveRunningNet({ ...net('Mine', 9) });
    detach(); // tab 2 follows the leave
    expect(loadRunningNet().name).toBe('Mine');
  });

  it('a reload while joined does not overwrite the set-aside copy', () => {
    saveRunningNet(net('Mine', 2));
    join({ 'net-running': { data: serializeNetState(net('Theirs', 5)) } });
    _resetForTests(); // page reload: module state gone, storage kept
    join({ 'net-running': { data: serializeNetState(net('Theirs', 5)) } });
    detach();
    expect(loadRunningNet().name).toBe('Mine');
  });

  it('applies newer remote states with Net Control’s revision rules', () => {
    join({ 'net-running': { data: serializeNetState(net('ARES', 5)) } });
    const rev = readRunningNetRecord().rev;
    expect(receiveNet(serializeNetState(net('ARES', rev + 1, [{ call: 'W1AW' }])))).toBe(true);
    expect(loadRunningNet().stations).toHaveLength(1);
    expect(receiveNet(serializeNetState(net('ARES', rev - 1)))).toBe(false); // older: ignored
    expect(loadRunningNet().stations).toHaveLength(1);
  });

  it('a net closed at another site closes here', () => {
    join({ 'net-running': { data: serializeNetState(net('ARES', 5)) } });
    const live = readRunningNetRecord();
    expect(receiveNet(serializeNetState({ closedId: live.id, rev: live.rev + 1, updatedAt: 9 }))).toBe(true);
    expect(loadRunningNet()).toBeNull();
  });

  it('publishes local commits once, and not what it just received', () => {
    join({ 'net-running': { data: serializeNetState(net('ARES', 5)) } });
    published = [];
    publishNet(); // the state we just wrote from the incident
    const base = loadRunningNet();
    commitRunningNet(base, { ...base, stations: [{ call: 'KD0ABC' }] });
    publishNet();
    publishNet();
    const sent = published.filter((p) => p.id === 'net-running');
    expect(sent).toHaveLength(1);
    expect(sent[0].data.net.stations).toEqual([{ call: 'KD0ABC' }]);
  });

  it('shares history changes, trimmed to fit, and applies received history', () => {
    join();
    saveHistory([net('N1')]);
    publishHistory();
    publishHistory();
    expect(published.filter((p) => p.id === 'net-history')).toHaveLength(1);
    expect(receiveHistory([net('N2'), { junk: true }])).toBe(true);
    expect(loadHistory().map((n) => n.name)).toEqual(['N2']);
    const big = Array.from({ length: 50 }, (_, i) =>
      net(
        `N${i}`,
        1,
        Array.from({ length: 30 }, (_, j) => ({ call: `W${j}AW`, name: 'x'.repeat(20) })),
      ),
    );
    const fitted = fitHistory(big);
    expect(fitted.length).toBeLessThan(50);
    expect(fitted[0].name).toBe('N0');
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(NET_DOC_MAX_BYTES);
  });

  it('does nothing when not joined', () => {
    expect(receiveNet(serializeNetState(net('X', 9)))).toBe(false);
    publishNet();
    expect(published).toEqual([]);
  });

  describe('concurrent edits at two sites', () => {
    const st = (call, extra = {}) => ({ call, flags: [], checkinTime: 1, checkoutTime: null, ...extra });
    /** Join with a shared net, as the other site would have published it. */
    const startShared = () => {
      const shared = { ...serializeNetState(net('ARES', 5, [st('W1AW'), st('K1ABC')])), tag: '5:1', parentTag: null };
      attach({
        docs: { 'net-running': { data: shared } },
        publish: (id, data) => published.push({ id, data }),
        origin: { site: 'North', call: 'K0CJH' },
      });
      return shared;
    };
    const localEdit = (fn) => {
      const base = loadRunningNet();
      commitRunningNet(base, fn(base));
      publishNet();
    };

    it('non-overlapping edits from both sites survive at both', () => {
      const shared = startShared();
      published = [];
      // here: check in KD0ABC; there (South, made from the same shared state): check in N0XYZ
      localEdit((n) => ({ ...n, stations: [st('KD0ABC'), ...n.stations] }));
      const mine = published.at(-1).data;
      expect(mine).toMatchObject({ parentTag: '5:1', origin: { site: 'North' } });
      const theirs = {
        ...serializeNetState({ ...shared.net, stations: [st('N0XYZ'), ...shared.net.stations], rev: 6, updatedAt: 7 }),
        tag: '6:7',
        parentTag: '5:1',
        origin: { site: 'South', call: 'W1AW' },
      };
      expect(receiveNet(theirs)).toBe(true);
      const calls = loadRunningNet().stations.map((s) => s.call);
      expect(calls.sort()).toEqual(['K1ABC', 'KD0ABC', 'N0XYZ', 'W1AW']);
      const merged = published.at(-1).data; // the merge goes out, made from theirs
      expect(merged.parentTag).toBe('6:7');
      expect(merged.net.stations).toHaveLength(4);
      // South receives our merge: it was made from South's state → fast-forward, nothing lost
    });

    it('the same station changed at both sites: theirs is kept and the operator is told where', () => {
      const shared = startShared();
      const heard = [];
      const onConflict = (e) => heard.push(e.detail);
      window.addEventListener('ohc-net-control-remote-conflict', onConflict);
      try {
        localEdit((n) => ({ ...n, stations: n.stations.map((s) => (s.call === 'W1AW' ? { ...s, flags: ['T'] } : s)) }));
        const theirs = {
          ...serializeNetState({
            ...shared.net,
            stations: shared.net.stations.map((s) => (s.call === 'W1AW' ? { ...s, flags: ['M'] } : s)),
            rev: 6,
            updatedAt: 7,
          }),
          tag: '6:7',
          parentTag: '5:1',
          origin: { site: 'South', call: 'W1AW' },
        };
        expect(receiveNet(theirs)).toBe(true);
        expect(loadRunningNet().stations.find((s) => s.call === 'W1AW').flags).toEqual(['M']);
        expect(heard).toEqual([{ calls: ['W1AW'], fields: [], site: 'South' }]);
      } finally {
        window.removeEventListener('ohc-net-control-remote-conflict', onConflict);
      }
    });

    it('our own state echoed back is ignored', () => {
      startShared();
      localEdit((n) => ({ ...n, stations: [st('KD0ABC'), ...n.stations] }));
      const mine = published.at(-1).data;
      published = [];
      expect(receiveNet(mine)).toBe(false);
      expect(published).toEqual([]);
    });
  });
});
