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
});
