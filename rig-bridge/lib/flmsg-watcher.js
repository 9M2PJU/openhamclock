'use strict';
/**
 * flmsg-watcher.js — watch NBEMS folders for new flmsg form files.
 *
 * flmsg saves forms under ~/NBEMS.files/ICS/messages, and fldigi drops
 * received WRAP transfers into ~/NBEMS.files/WRAP/recv (same layout on
 * Linux, macOS and Windows, under the user's home directory). This module
 * scans those folders (fs.watch for promptness plus an interval poll, since
 * fs.watch is unreliable on network shares), parses each new or changed file
 * with flmsg-format, and hands the resulting field-report record to onForm().
 *
 * Files are tracked by path + mtime + size and de-duplicated by the form's
 * content hash, so re-saving or re-scanning never reports the same form twice.
 * On the first scan, files older than maxAgeMs are only marked as seen — a
 * folder holding last year's exercise traffic does not flood the panel.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { formToFieldReport } = require('./flmsg-format');

const MAX_FILE_BYTES = 256 * 1024;
const MAX_SEEN = 5000;

/** The usual NBEMS receive folders for this machine's user. */
function defaultFlmsgDirs(home = os.homedir()) {
  const base = path.join(home, 'NBEMS.files');
  return [path.join(base, 'ICS', 'messages'), path.join(base, 'WRAP', 'recv')];
}

/**
 * @param {object} opts
 * @param {string[]} [opts.dirs]          folders to watch (default: defaultFlmsgDirs())
 * @param {number}   [opts.pollMs=15000]  poll interval
 * @param {number}   [opts.maxAgeMs]      first-scan age cutoff (default 72 h; 0 = no cutoff)
 * @param {function} opts.onForm          (record, filePath) => void
 * @param {function} [opts.onError]       (message) => void
 * @param {object}   [opts.fsImpl]        injectable fs (tests)
 * @param {boolean}  [opts.watch=true]    use fs.watch in addition to polling
 */
function createFlmsgWatcher(opts) {
  const fsx = opts.fsImpl || fs;
  const dirs = (opts.dirs && opts.dirs.length ? opts.dirs : defaultFlmsgDirs()).map((d) => path.resolve(d));
  const pollMs = Math.max(1000, opts.pollMs ?? 15000);
  const maxAgeMs = opts.maxAgeMs ?? 72 * 3600 * 1000;
  const onForm = opts.onForm || (() => {});
  const onError = opts.onError || (() => {});
  const useWatch = opts.watch !== false;

  const fileStamps = new Map(); // path → `${mtimeMs}:${size}`
  const seenIds = new Set();
  const watchers = [];
  let pollTimer = null;
  let debounce = null;
  let firstScanDone = false;
  let running = false;
  let formsFound = 0;
  let lastScan = null;
  let lastError = null;
  const skipped = { compressed: 0, unreadable: 0, notForm: 0 };

  function markSeen(id) {
    seenIds.add(id);
    if (seenIds.size > MAX_SEEN) seenIds.delete(seenIds.values().next().value);
  }

  function processFile(file, st, initial) {
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (fileStamps.get(file) === stamp) return;
    fileStamps.set(file, stamp);
    if (st.size > MAX_FILE_BYTES || st.size === 0) return;

    let text;
    try {
      text = fsx.readFileSync(file, 'utf8');
    } catch (e) {
      skipped.unreadable++;
      return;
    }
    const record = formToFieldReport(text, { file, mtimeMs: st.mtimeMs });
    if (!record) {
      skipped.notForm++;
      return;
    }
    if (record.error === 'compressed') {
      skipped.compressed++;
      lastError = `${path.basename(file)} is compressed — turn off compression in flmsg`;
      onError(lastError);
      return;
    }
    if (seenIds.has(record.id)) return;
    markSeen(record.id);
    if (initial && maxAgeMs > 0 && Date.now() - st.mtimeMs > maxAgeMs) return; // old traffic: remember, don't report
    formsFound++;
    onForm(record, file);
  }

  /** Scan every folder once. Returns the number of forms reported. */
  function scan() {
    const before = formsFound;
    const initial = !firstScanDone;
    lastScan = Date.now();
    for (const dir of dirs) {
      let names;
      try {
        names = fsx.readdirSync(dir);
      } catch (e) {
        continue; // folder absent (flmsg not installed / not used yet) — not an error
      }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const file = path.join(dir, name);
        let st;
        try {
          st = fsx.statSync(file);
        } catch (e) {
          continue;
        }
        if (!st.isFile()) continue;
        try {
          processFile(file, st, initial);
        } catch (e) {
          lastError = `${name}: ${e.message}`;
          onError(lastError);
        }
      }
    }
    firstScanDone = true;
    return formsFound - before;
  }

  function start() {
    if (running) return;
    running = true;
    scan();
    if (useWatch) {
      for (const dir of dirs) {
        try {
          const w = fsx.watch(dir, () => {
            clearTimeout(debounce);
            debounce = setTimeout(scan, 750);
          });
          w.on('error', () => {
            try {
              w.close();
            } catch (e) {}
          });
          watchers.push(w);
        } catch (e) {
          // folder missing or watch unsupported — polling covers it
        }
      }
    }
    pollTimer = setInterval(scan, pollMs);
  }

  function stop() {
    running = false;
    clearInterval(pollTimer);
    pollTimer = null;
    clearTimeout(debounce);
    debounce = null;
    for (const w of watchers.splice(0)) {
      try {
        w.close();
      } catch (e) {}
    }
  }

  function getStatus() {
    return {
      running,
      dirs: dirs.map((d) => ({
        path: d,
        exists: (() => {
          try {
            return fsx.statSync(d).isDirectory();
          } catch (e) {
            return false;
          }
        })(),
      })),
      watching: watchers.length,
      pollIntervalSec: pollMs / 1000,
      filesTracked: fileStamps.size,
      formsFound,
      skipped: { ...skipped },
      lastScan,
      lastError,
    };
  }

  return { start, stop, scan, getStatus };
}

module.exports = { createFlmsgWatcher, defaultFlmsgDirs };
