import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadDoc,
  saveDoc,
  subscribeDocs,
  attach,
  receive,
  detach,
  isSharing,
  DOC_MAX_BYTES,
  _resetForTests,
} from './incidentDocs.js';
import { saveRunningNet, loadRunningNet, saveHistory, loadHistory, NET_CONTROL_KEY } from './netControl.js';
import { loadDrafts, ICS_DRAFTS_KEY } from './icsForms.js';

const net = (name, stations = []) => ({ id: `net-${name}`, name, ncs: 'K0CJH', stations, startTime: 1, undo: [] });

describe('incidentDocs', () => {
  let published;
  let notes;

  beforeEach(() => {
    localStorage.clear();
    _resetForTests();
    published = [];
    notes = [];
    subscribeDocs((id, reason) => notes.push(`${id}:${reason}`));
  });

  const join = (docs = {}) => attach({ docs, publish: (id, data) => published.push({ id, data }) });

  it('not joined: loads and saves the panels’ own storage', () => {
    expect(isSharing()).toBe(false);
    saveDoc('net-running', net('Local'));
    expect(loadRunningNet().name).toBe('Local');
    expect(loadDoc('net-running').name).toBe('Local');
    saveDoc('net-running', null);
    expect(localStorage.getItem(NET_CONTROL_KEY)).toBeNull();
    expect(published).toEqual([]);
  });

  it('joined: reads the incident’s copy and leaves local storage untouched', () => {
    saveHistory([net('Mine')]);
    join({ 'net-history': { data: [net('Shared')], updatedAt: 5 } });
    expect(loadDoc('net-history').map((n) => n.name)).toEqual(['Shared']);
    saveDoc('net-history', [net('Shared2')]);
    expect(published.map((p) => p.id)).toEqual(['net-history']);
    expect(loadHistory().map((n) => n.name)).toEqual(['Mine']);
    detach();
    expect(loadDoc('net-history').map((n) => n.name)).toEqual(['Mine']);
  });

  it('ICS drafts start from the defaults in a new incident and are shape-fixed when received', () => {
    localStorage.setItem(ICS_DRAFTS_KEY, JSON.stringify({ header: { incidentName: 'Local only' } }));
    join();
    expect(loadDoc('ics-drafts').header.incidentName).toBe('');
    receive([{ id: 'ics-drafts', data: { header: { incidentName: 'Flood' } }, updatedAt: 2 }]);
    const d = loadDoc('ics-drafts');
    expect(d.header.incidentName).toBe('Flood');
    expect(Array.isArray(d.ics214.rows)).toBe(true);
    expect(loadDrafts().header.incidentName).toBe('Local only');
  });

  it('a net already running here seeds an incident that has none, without its undo stack', () => {
    saveRunningNet({ ...net('ARES', [{ call: 'W1AW' }]), undo: [{ x: 1 }] });
    join();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ id: 'net-running', data: { name: 'ARES' } });
    expect(published[0].data.undo).toBeUndefined();
    expect(loadDoc('net-running').name).toBe('ARES');
  });

  it('does not seed over the incident’s own net', () => {
    saveRunningNet(net('Mine'));
    join({ 'net-running': { data: net('Theirs'), updatedAt: 3 } });
    expect(published).toEqual([]);
    expect(loadDoc('net-running').name).toBe('Theirs');
  });

  it('notifies on join, remote changes and leave — not on its own echo or a no-op save', () => {
    join();
    expect(notes).toEqual(['ics-drafts:mode', 'net-running:mode', 'net-history:mode']);
    notes = [];
    saveDoc('net-running', net('A'));
    saveDoc('net-running', net('A')); // unchanged → not republished
    expect(published).toHaveLength(1);
    receive([{ id: 'net-running', data: { ...net('A'), undo: undefined }, updatedAt: Date.now() + 1 }]); // echo
    expect(notes).toEqual([]);
    receive([{ id: 'net-running', data: net('B'), updatedAt: Date.now() + 2 }]);
    expect(notes).toEqual(['net-running:remote']);
    receive([{ id: 'net-running', data: net('Old'), updatedAt: 1 }]); // older than ours
    expect(loadDoc('net-running').name).toBe('B');
    detach();
    expect(notes.slice(-3)).toEqual(['ics-drafts:mode', 'net-running:mode', 'net-history:mode']);
  });

  it('trims net history to fit, and refuses a document it cannot fit', () => {
    join();
    const big = Array.from({ length: 50 }, (_, i) =>
      net(
        `N${i}`,
        Array.from({ length: 30 }, (_, j) => ({ call: `W${j}AW`, name: 'x'.repeat(20) })),
      ),
    );
    expect(saveDoc('net-history', big)).toBe(true);
    const sent = published.at(-1).data;
    expect(sent.length).toBeLessThan(50);
    expect(sent[0].name).toBe('N0'); // newest kept
    expect(JSON.stringify(sent).length).toBeLessThanOrEqual(DOC_MAX_BYTES);
    const huge = { header: { notes: 'x'.repeat(DOC_MAX_BYTES + 10) } };
    expect(saveDoc('ics-drafts', huge)).toBe(false);
  });
});
