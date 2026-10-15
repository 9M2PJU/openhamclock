/**
 * flmsg-watcher — scans real temp folders (no fs mocking): new files are
 * reported once, changes are re-read, duplicates and old traffic are skipped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import watcherLib from './flmsg-watcher.js';
import fmt from './flmsg-format.js';

const { createFlmsgWatcher, defaultFlmsgDirs } = watcherLib;
const { buildIcs213, wrapFlmsg } = fmt;

let root;
let messages;
let recv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ohc-flmsg-'));
  messages = path.join(root, 'ICS', 'messages');
  recv = path.join(root, 'WRAP', 'recv');
  fs.mkdirSync(messages, { recursive: true });
  fs.mkdirSync(recv, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const form = (subject, call = 'KE8PLM') =>
  buildIcs213({ to: 'EOC', subject, message: `${subject} body` }, { call, when: Date.UTC(2026, 9, 15, 12, 0) });

const make = (extra = {}) => {
  const got = [];
  const w = createFlmsgWatcher({
    dirs: [messages, recv],
    watch: false,
    onForm: (r, f) => got.push({ r, f }),
    ...extra,
  });
  return { w, got };
};

describe('createFlmsgWatcher', () => {
  it('defaults to the NBEMS ICS/messages and WRAP/recv folders under the home directory', () => {
    expect(defaultFlmsgDirs('/home/op')).toEqual([
      path.join('/home/op', 'NBEMS.files', 'ICS', 'messages'),
      path.join('/home/op', 'NBEMS.files', 'WRAP', 'recv'),
    ]);
  });

  it('reports forms in both folders, plain and wrapped, once each', () => {
    fs.writeFileSync(path.join(messages, 'a.213'), form('Cots'));
    fs.writeFileSync(path.join(recv, 'b.213'), wrapFlmsg(form('Water'), 'b.213'));
    fs.writeFileSync(path.join(messages, 'notes.txt'), 'not a form');
    const { w, got } = make();
    expect(w.scan()).toBe(2);
    expect(got.map((g) => g.r.extra.subject).sort()).toEqual(['Cots', 'Water']);
    expect(got.every((g) => g.r.formType === 'ICS-213 (NBEMS)')).toBe(true);
    expect(w.scan()).toBe(0); // unchanged files are not re-read
    expect(w.getStatus()).toMatchObject({ formsFound: 2, filesTracked: 3, skipped: { notForm: 1 } });
  });

  it('picks up files added after the first scan, and an edited form as a new report', () => {
    const { w, got } = make();
    expect(w.scan()).toBe(0);
    const file = path.join(messages, 'c.213');
    fs.writeFileSync(file, form('First'));
    expect(w.scan()).toBe(1);
    fs.writeFileSync(file, form('Second edit'));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(w.scan()).toBe(1);
    expect(got.map((g) => g.r.extra.subject)).toEqual(['First', 'Second edit']);
  });

  it('does not report the same form twice when it lands in both folders', () => {
    const text = form('Dup');
    fs.writeFileSync(path.join(messages, 'd.213'), text);
    fs.writeFileSync(path.join(recv, 'd.213'), wrapFlmsg(text, 'd.213'));
    const { w } = make();
    expect(w.scan()).toBe(1);
  });

  it('on the first scan, skips (but remembers) files older than maxAge', () => {
    const old = path.join(messages, 'old.213');
    fs.writeFileSync(old, form('Last year'));
    const past = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    fs.utimesSync(old, past, past);
    fs.writeFileSync(path.join(messages, 'new.213'), form('Today'));
    const { w, got } = make({ maxAgeMs: 72 * 3600 * 1000 });
    expect(w.scan()).toBe(1);
    expect(got[0].r.extra.subject).toBe('Today');
  });

  it('ignores missing folders and reports which exist', () => {
    const { w } = make({ dirs: [messages, path.join(root, 'nope')] });
    expect(w.scan()).toBe(0);
    expect(w.getStatus().dirs).toEqual([
      { path: messages, exists: true },
      { path: path.join(root, 'nope'), exists: false },
    ]);
  });

  it('reports compressed transfers as an error instead of a form', () => {
    const errors = [];
    fs.writeFileSync(path.join(recv, 'z.213'), wrapFlmsg('[b64:start]XQAAgA[b64:end]', 'z.213'));
    const { w, got } = make({ onError: (m) => errors.push(m) });
    w.scan();
    expect(got).toHaveLength(0);
    expect(errors[0]).toMatch(/compressed/);
    expect(w.getStatus().skipped.compressed).toBe(1);
  });

  it('start() scans immediately and stop() clears timers', () => {
    fs.writeFileSync(path.join(messages, 'e.213'), form('Startup'));
    const { w, got } = make({ pollMs: 60000 });
    w.start();
    expect(got).toHaveLength(1);
    expect(w.getStatus().running).toBe(true);
    w.stop();
    expect(w.getStatus().running).toBe(false);
  });
});
