/**
 * incidentNetBridge — the running voice net and net history over a shared
 * incident.
 *
 * Net Control (src/components/NetControlPanel.jsx) keeps every tab and panel
 * of one browser in step on its own: each write of the running net goes to
 * localStorage with a rising revision (`rev`), other tabs hear it through the
 * `storage` event and other panels through the NET_CONTROL_CHANNEL
 * BroadcastChannel. This bridge extends that to the other stations of a
 * shared incident without touching the panel, through the adapters Net
 * Control exports for exactly this (src/utils/netControl.js):
 *
 *   out  a change on this browser (channel message / storage event)
 *        → serializeNetState(readRunningNetRecord()) → publish('net-running')
 *        → loadHistory() → publish('net-history')
 *   in   a document from the incident → applyRemoteNetState(local, remote),
 *        written back with saveRunningNet and announced on the channel, so
 *        the panels pick it up with their usual revision rules
 *
 * On join the incident's net wins (or, when the incident has no net, a net
 * already running here becomes the shared one), and while joined the
 * history shown is the incident's. This browser's own running net and
 * history are set aside first and put back on leave, so leaving returns
 * Net Control to exactly what it had before.
 */
import {
  serializeNetState,
  applyRemoteNetState,
  readRunningNetRecord,
  loadRunningNet,
  saveRunningNet,
  loadHistory,
  saveHistory,
  saveRosterSnapshot,
  NET_CONTROL_CHANNEL,
  NET_CONTROL_KEY,
  NET_CONTROL_HISTORY_KEY,
} from './netControl.js';

export const BRIDGE_ID = 'shared-incident';
export const STASH_KEY = 'openhamclock_netControlBeforeIncident';
/** Stay under the hosted server's 64 KB per-document cap. */
export const NET_DOC_MAX_BYTES = 60 * 1024;

const state = {
  attached: false,
  publish: null,
  known: { net: '', history: '' },
  channel: null,
  onStorage: null,
};

/** Comparison key for a serialized net state (updatedAt of an empty state changes every call). */
const netKey = (d) => JSON.stringify([d?.net ?? null, d?.closedId ?? null, d?.rev ?? 0]);
const historyKey = (list) => JSON.stringify(list || []);

/** Newest first: drop the oldest nets until the history fits one shared document. */
export function fitHistory(list) {
  let out = Array.isArray(list) ? list : [];
  while (out.length && JSON.stringify(out).length > NET_DOC_MAX_BYTES) out = out.slice(0, -1);
  return out;
}

function announce(type) {
  try {
    state.channel?.postMessage({ type, from: BRIDGE_ID });
  } catch {
    /* channel closed */
  }
}

function readStash() {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** This browser's running net (or closed-net record) changed: share it. */
export function publishNet() {
  if (!state.attached) return;
  const data = serializeNetState(readRunningNetRecord());
  const key = netKey(data);
  if (key === state.known.net) return;
  state.known.net = key;
  state.publish?.('net-running', data);
}

/** This browser's net history changed: share it (trimmed to fit). */
export function publishHistory() {
  if (!state.attached) return;
  const list = fitHistory(loadHistory());
  const key = historyKey(list);
  if (key === state.known.history) return;
  state.known.history = key;
  state.publish?.('net-history', list);
}

/**
 * A running-net document from the incident. `force` (on join) makes the
 * incident's net replace whatever runs here, whatever its revision.
 */
export function receiveNet(data, { force = false } = {}) {
  if (!state.attached || !data || data.kind !== 'net-control') return false;
  const key = netKey(data);
  if (!force && key === state.known.net) return false;
  state.known.net = key;
  const local = loadRunningNet();
  let next;
  let changed;
  if (force) {
    const localRev = readRunningNetRecord()?.rev ?? 0;
    const rev = Math.max(data.rev ?? 0, localRev + 1);
    if (data.net) {
      next = { ...data.net, rev, undo: [] };
      changed = true;
    } else {
      next = null;
      changed = !!local;
    }
  } else {
    ({ net: next, changed } = applyRemoteNetState(local, data));
  }
  if (!changed) return false;
  if (next) {
    saveRunningNet(next);
  } else {
    if (local) saveRosterSnapshot(local, { active: false });
    const rev = Math.max(data.rev ?? 0, (readRunningNetRecord()?.rev ?? 0) + 1);
    saveRunningNet({ closedId: data.closedId || local?.id || '', rev, updatedAt: data.updatedAt || Date.now() });
  }
  announce('net');
  return true;
}

/** A net-history document from the incident. */
export function receiveHistory(list) {
  if (!state.attached || !Array.isArray(list)) return false;
  const clean = list.filter((n) => n && Array.isArray(n.stations));
  const key = historyKey(clean);
  if (key === state.known.history) return false;
  state.known.history = key;
  saveHistory(clean);
  announce('history');
  return true;
}

/**
 * Joined (or resumed after a reload). `docs` are the incident's documents
 * ({ id: { data } }); `publish(id, data)` sends one.
 */
export function attach({ docs = {}, publish }) {
  if (state.attached) detachListeners();
  // Set this browser's own net aside once — a reload while joined must not
  // overwrite the stash with the incident's copy.
  if (!readStash()) {
    try {
      localStorage.setItem(STASH_KEY, JSON.stringify({ net: readRunningNetRecord(), history: loadHistory() }));
    } catch {
      /* storage full — leaving will keep the incident's copy */
    }
  }
  state.attached = true;
  state.publish = publish;
  state.known = { net: '', history: '' };
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      state.channel = new BroadcastChannel(NET_CONTROL_CHANNEL);
      state.channel.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.from === BRIDGE_ID) return;
        if (msg.type === 'net') publishNet();
        else if (msg.type === 'history') publishHistory();
      };
    } catch {
      state.channel = null;
    }
  }
  state.onStorage = (e) => {
    if (e.key === NET_CONTROL_KEY) publishNet();
    else if (e.key === NET_CONTROL_HISTORY_KEY) publishHistory();
  };
  window.addEventListener('storage', state.onStorage);

  const netDoc = docs['net-running']?.data;
  if (netDoc?.net) receiveNet(netDoc, { force: true });
  else if (loadRunningNet())
    publishNet(); // the incident has no live net: ours becomes the shared one
  else if (netDoc) state.known.net = netKey(netDoc);

  const histDoc = docs['net-history']?.data;
  if (Array.isArray(histDoc)) receiveHistory(histDoc);
  else {
    state.known.history = historyKey([]);
    saveHistory([]);
    announce('history');
  }
}

function detachListeners() {
  if (state.onStorage) window.removeEventListener('storage', state.onStorage);
  try {
    state.channel?.close();
  } catch {
    /* ignore */
  }
  state.channel = null;
  state.onStorage = null;
}

/** Left the incident: put this browser's own running net and history back. */
export function detach() {
  if (!state.attached) return;
  const stash = readStash();
  const current = loadRunningNet();
  const rev = (readRunningNetRecord()?.rev ?? 0) + 1;
  const now = Date.now();
  const mine = stash?.net && Array.isArray(stash.net.stations) && stash.net.name ? stash.net : null;
  if (mine) {
    if (current && current.id !== mine.id) saveRosterSnapshot(current, { active: false });
    saveRunningNet({ ...mine, rev, updatedAt: now });
    saveRosterSnapshot(mine, { active: true });
  } else if (current) {
    saveRosterSnapshot(current, { active: false });
    saveRunningNet({ closedId: current.id, rev, updatedAt: now });
  }
  saveHistory(Array.isArray(stash?.history) ? stash.history : []);
  try {
    localStorage.removeItem(STASH_KEY);
  } catch {
    /* ignore */
  }
  announce('net');
  announce('history');
  detachListeners();
  state.attached = false;
  state.publish = null;
  state.known = { net: '', history: '' };
}

export const isAttached = () => state.attached;

/** Test helper. */
export function _resetForTests() {
  detachListeners();
  state.attached = false;
  state.publish = null;
  state.known = { net: '', history: '' };
}
