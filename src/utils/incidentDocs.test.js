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
import { loadDrafts, ICS_DRAFTS_KEY } from './icsForms.js';

describe('incidentDocs (ICS drafts)', () => {
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

  it('not joined: loads and saves this browser’s own drafts', () => {
    expect(isSharing()).toBe(false);
    const d = loadDoc('ics-drafts');
    saveDoc('ics-drafts', { ...d, header: { ...d.header, incidentName: 'Local' } });
    expect(loadDrafts().header.incidentName).toBe('Local');
    expect(published.filter((p) => p.id === 'ics-drafts')).toEqual([]);
  });

  it('joined: starts from blank drafts, publishes edits, and leaves the local copy alone', () => {
    localStorage.setItem(ICS_DRAFTS_KEY, JSON.stringify({ header: { incidentName: 'Local only' } }));
    join();
    expect(loadDoc('ics-drafts').header.incidentName).toBe('');
    const d = loadDoc('ics-drafts');
    saveDoc('ics-drafts', { ...d, header: { ...d.header, incidentName: 'Flood' } });
    expect(published.filter((p) => p.id === 'ics-drafts')).toHaveLength(1);
    expect(loadDrafts().header.incidentName).toBe('Local only');
    detach();
    expect(loadDoc('ics-drafts').header.incidentName).toBe('Local only');
  });

  it('shape-fixes received drafts', () => {
    join();
    receive([{ id: 'ics-drafts', data: { header: { incidentName: 'Flood' } }, updatedAt: 2 }]);
    const d = loadDoc('ics-drafts');
    expect(d.header.incidentName).toBe('Flood');
    expect(Array.isArray(d.ics214.rows)).toBe(true);
  });

  it('notifies on join, remote changes and leave — not on its own echo or a no-op save', () => {
    join();
    expect(notes).toEqual(['ics-drafts:mode']);
    notes = [];
    const d = { header: { incidentName: 'A' } };
    saveDoc('ics-drafts', d);
    saveDoc('ics-drafts', d); // unchanged → not republished
    expect(published.filter((p) => p.id === 'ics-drafts')).toHaveLength(1);
    receive([{ id: 'ics-drafts', data: d, updatedAt: Date.now() + 1 }]); // echo
    expect(notes).toEqual([]);
    receive([{ id: 'ics-drafts', data: { header: { incidentName: 'B' } }, updatedAt: Date.now() + 2 }]);
    expect(notes).toEqual(['ics-drafts:remote']);
    receive([{ id: 'ics-drafts', data: { header: { incidentName: 'Old' } }, updatedAt: 1 }]); // older
    expect(loadDoc('ics-drafts').header.incidentName).toBe('B');
    detach();
    expect(notes.at(-1)).toBe('ics-drafts:mode');
  });

  it('refuses drafts too large to share', () => {
    join();
    expect(saveDoc('ics-drafts', { header: { notes: 'x'.repeat(DOC_MAX_BYTES + 10) } })).toBe(false);
  });
});
