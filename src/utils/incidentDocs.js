/**
 * incidentDocs — shared working documents while a shared incident is joined.
 *
 * Three documents travel with an incident (server: `docs`):
 *
 *   ics-drafts    the ICS Forms drafts (src/utils/icsForms.js) — handled here
 *   net-running   the running voice net  ┐ handled by incidentNetBridge.js
 *   net-history   past nets              ┘ through Net Control's own adapters
 *
 * While joined, every station edits the same 309/214/213/205 drafts and sees
 * the same net. Not joined, nothing changes: each panel reads and writes its
 * own localStorage.
 *
 * ICS Forms calls loadDoc / saveDoc in place of loadDrafts / saveDrafts and
 * subscribeDocs to reload when the drafts change underneath it (another
 * station saved, or this browser joined or left). The local copy is
 * untouched while joined, so leaving restores exactly what this browser had.
 *
 * useSharedIncident is the other side: attach() when joined (with a publish
 * function and the incident's documents), receive() whenever documents arrive
 * from the server, detach() on leave. Loops are avoided by remembering the
 * last serialised value per document: a save of what is already there is not
 * published, and a received document equal to what this browser last saw or
 * sent does not notify.
 */
import { loadDrafts, saveDrafts, defaultDrafts, mergeDrafts } from './icsForms.js';
import * as netBridge from './incidentNetBridge.js';

/** Stay under the hosted server's 64 KB per-document cap. */
export const DOC_MAX_BYTES = 60 * 1024;

/** Documents panels load and save through this module. */
export const DOC_SPECS = {
  'ics-drafts': {
    local: () => loadDrafts(),
    saveLocal: (v) => saveDrafts(v),
    empty: () => defaultDrafts(),
    normalise: (v) => mergeDrafts(v),
  },
};

/** Documents the Net Control bridge owns. */
const NET_DOC_IDS = new Set(['net-running', 'net-history']);

export const DOC_IDS = Object.keys(DOC_SPECS);

const state = {
  attached: false,
  publish: null,
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
  if (!doc) return spec.empty();
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
  const json = JSON.stringify(value ?? null);
  if (json.length > DOC_MAX_BYTES) return false;
  if (state.known[id] === json) return true;
  state.known[id] = json;
  state.docs[id] = { data: JSON.parse(json), updatedAt: Date.now() };
  state.publish?.(id, value ?? null);
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
  for (const id of DOC_IDS) notify(id, 'mode');
  netBridge.attach({ docs: docs || {}, publish });
}

/** Documents from the server (snapshot or change). Notifies only real changes. */
export function receive(docs) {
  if (!state.attached) return;
  for (const doc of Array.isArray(docs) ? docs : Object.values(docs || {})) {
    if (!doc?.id) continue;
    if (NET_DOC_IDS.has(doc.id)) {
      if (doc.id === 'net-running') netBridge.receiveNet(doc.data);
      else netBridge.receiveHistory(doc.data);
      continue;
    }
    if (!DOC_SPECS[doc.id]) continue;
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
  netBridge.detach();
}

/** Test helper. */
export function _resetForTests() {
  state.attached = false;
  state.publish = null;
  state.docs = {};
  state.known = {};
  listeners.clear();
  netBridge._resetForTests();
}
