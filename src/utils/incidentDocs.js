/**
 * incidentDocs — shared working documents while a shared incident is joined.
 *
 * Three panels keep a document of their own in localStorage: the ICS Forms
 * drafts (src/utils/icsForms.js), the running voice net and the net history
 * (src/utils/netControl.js). While this browser has joined a shared incident
 * those documents live in the incident instead, so every station edits the
 * same 309/214/213/205 drafts and sees the same running net. Not joined,
 * nothing changes: each panel reads and writes its own localStorage key.
 *
 * Panels call loadDoc / saveDoc in place of their load / save functions and
 * subscribeDocs to reload when the document changes underneath them (another
 * station saved it, or this browser joined or left). This module only uses
 * the panels' public load / save helpers, so their own storage stays theirs —
 * and the local copy is untouched while joined, so leaving restores exactly
 * what this browser had before.
 *
 * useSharedIncident is the other side: attach() when joined (with a publish
 * function and the incident's documents), receive() whenever documents arrive
 * from the server, detach() on leave. Loops are avoided by remembering the
 * last serialised value per document: a save of what is already there is not
 * published, and a received document equal to what this browser last saw or
 * sent does not notify.
 */
import { loadDrafts, saveDrafts, defaultDrafts, mergeDrafts } from './icsForms.js';
import { loadRunningNet, saveRunningNet, clearRunningNet, loadHistory, saveHistory } from './netControl.js';

/** Stay under the hosted server's 64 KB per-document cap. */
export const DOC_MAX_BYTES = 60 * 1024;

/**
 * Per-document behaviour.
 *   local / saveLocal   the panel's own storage
 *   empty               value in an incident that has no copy yet
 *   seed                publish the local copy when joining an incident that has none
 *   normalise           shape-fix a received value (older/newer clients)
 *   fit                 shrink a value to fit DOC_MAX_BYTES (or return null when it cannot)
 */
export const DOC_SPECS = {
  'ics-drafts': {
    local: () => loadDrafts(),
    saveLocal: (v) => saveDrafts(v),
    empty: () => defaultDrafts(),
    normalise: (v) => mergeDrafts(v),
    seed: false,
  },
  'net-running': {
    local: () => loadRunningNet(),
    saveLocal: (v) => (v ? saveRunningNet(v) : clearRunningNet()),
    empty: () => null,
    // A net already running here when the station joins becomes the shared net.
    seed: true,
    normalise: (v) => (v && typeof v === 'object' && Array.isArray(v.stations) ? { undo: [], ...v } : null),
    // The undo stack is per-operator working state, not part of the net.
    strip: (v) => {
      if (!v) return v;
      const { undo: _undo, ...rest } = v;
      return rest;
    },
  },
  'net-history': {
    local: () => loadHistory(),
    saveLocal: (v) => saveHistory(v),
    empty: () => [],
    normalise: (v) => (Array.isArray(v) ? v.filter((n) => n && Array.isArray(n.stations)) : []),
    seed: false,
    // Newest first: drop the oldest nets until it fits.
    fit: (v) => {
      let list = Array.isArray(v) ? v : [];
      while (list.length && JSON.stringify(list).length > DOC_MAX_BYTES) list = list.slice(0, -1);
      return list;
    },
  },
};

export const DOC_IDS = Object.keys(DOC_SPECS);

const state = {
  attached: false,
  publish: null, // (id, data) → void
  docs: {}, // id → { data, updatedAt, by }
  known: {}, // id → JSON last seen or sent
};
const listeners = new Set();

const notify = (id, reason) => {
  for (const fn of listeners) {
    try {
      fn(id, reason);
    } catch {
      /* a panel's handler must not break the others */
    }
  }
};

/** Is this browser sharing documents through an incident right now? */
export const isSharing = () => state.attached;

/** The current value of a document: the incident's while joined, the panel's own otherwise. */
export function loadDoc(id) {
  const spec = DOC_SPECS[id];
  if (!spec) throw new Error(`Unknown shared document ${id}`);
  if (!state.attached) return spec.local();
  const doc = state.docs[id];
  if (!doc) return spec.seed ? spec.local() : spec.empty();
  return spec.normalise ? spec.normalise(doc.data) : doc.data;
}

/**
 * Save a document. Not joined: the panel's own storage. Joined: published to
 * the incident (unless unchanged). → false when it is too large to share.
 */
export function saveDoc(id, value) {
  const spec = DOC_SPECS[id];
  if (!spec) throw new Error(`Unknown shared document ${id}`);
  if (!state.attached) {
    spec.saveLocal(value);
    return true;
  }
  let data = spec.strip ? spec.strip(value) : value;
  if (spec.fit) data = spec.fit(data);
  const json = JSON.stringify(data ?? null);
  if (json.length > DOC_MAX_BYTES) return false;
  if (state.known[id] === json) return true;
  state.known[id] = json;
  state.docs[id] = { data: JSON.parse(json), updatedAt: Date.now() };
  state.publish?.(id, data ?? null);
  return true;
}

/** Listen for document changes: fn(id, reason) — reason 'remote' or 'mode' (joined / left). → unsubscribe */
export function subscribeDocs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The incident side (useSharedIncident). `docs` is the incident's documents
 * ({ id: { data, updatedAt } }); `publish(id, data)` sends one.
 * Documents the incident lacks are seeded from local copies where the spec says so.
 */
export function attach({ docs = {}, publish }) {
  state.attached = true;
  state.publish = publish;
  state.docs = {};
  state.known = {};
  for (const [id, doc] of Object.entries(docs || {})) {
    if (!DOC_SPECS[id] || !doc) continue;
    state.docs[id] = doc;
    state.known[id] = JSON.stringify(doc.data ?? null);
  }
  for (const id of DOC_IDS) {
    const spec = DOC_SPECS[id];
    if (state.docs[id] || !spec.seed) continue;
    const local = spec.local();
    if (local != null) saveDoc(id, local);
  }
  for (const id of DOC_IDS) notify(id, 'mode');
}

/** Documents from the server (snapshot or change). Notifies only real changes. */
export function receive(docs) {
  if (!state.attached) return;
  for (const doc of Array.isArray(docs) ? docs : Object.values(docs || {})) {
    if (!doc?.id || !DOC_SPECS[doc.id]) continue;
    const cur = state.docs[doc.id];
    if (cur && (cur.updatedAt || 0) > (doc.updatedAt || 0)) continue;
    const json = JSON.stringify(doc.data ?? null);
    state.docs[doc.id] = doc;
    if (state.known[doc.id] === json) continue; // our own echo, or no change
    state.known[doc.id] = json;
    notify(doc.id, 'remote');
  }
}

/** Left the incident: panels go back to their own storage. */
export function detach() {
  if (!state.attached) return;
  state.attached = false;
  state.publish = null;
  state.docs = {};
  state.known = {};
  for (const id of DOC_IDS) notify(id, 'mode');
}

/** Test helper. */
export function _resetForTests() {
  state.attached = false;
  state.publish = null;
  state.docs = {};
  state.known = {};
  listeners.clear();
}
