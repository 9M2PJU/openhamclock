/**
 * incidentNetMerge — reconciling the running voice net between sites.
 *
 * Inside one browser, Net Control re-applies a refused change to the newer
 * net when rebaseCheck() says the two changes don't overlap (different
 * station lines, different net fields). Across a shared incident only whole
 * net states travel, so the same rule is applied to states: each published
 * state carries its own `tag` and the `parentTag` of the state it was made
 * from, every site keeps the last few states it has seen, and an incoming
 * state is reconciled against the local one through their common ancestor:
 *
 *   ignore    our own state coming back
 *   same      different path, same content — just note it
 *   adopt     theirs was made from what we have: take it
 *   merge     both changed, nothing overlaps (rebaseCheck): keep both
 *   conflict  the same station (or field) changed at both sites: take
 *             theirs, and tell the operator which calls, and where
 *   legacy    no common ancestor known: fall back to revision rules
 *
 * Pure functions; the transport is incidentNetBridge.js.
 */
import { rebaseCheck, changedCalls, changedNetFields } from './netControl.js';

/** Identifies one published net state. */
export const netTag = (data) => (data ? `${data.rev ?? 0}:${data.updatedAt ?? 0}` : '');

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A net without the bookkeeping that differs between copies of the same content. */
function content(net) {
  if (!net) return null;
  const { rev: _r, updatedAt: _u, undo: _d, ...rest } = net;
  return rest;
}

export const sameNetContent = (a, b) => sameValue(content(a), content(b));

const stationOf = (net, call) => (net?.stations || []).find((s) => s.call === call) || null;

/**
 * The order of a merged net's stations, the same at every site: newest
 * check-in first (as Net Control lists them), then callsign. Two sites that
 * merge the same changes therefore hold identical nets at once.
 */
export function orderStations(stations) {
  return [...(stations || [])].sort(
    (a, b) => (b.checkinTime ?? 0) - (a.checkinTime ?? 0) || String(a.call).localeCompare(String(b.call)),
  );
}

/**
 * Apply `mine`'s changes since `base` on top of `theirs`: changed net fields
 * take mine's value; changed station lines are replaced, added or removed.
 * The result is in orderStations() order.
 */
export function mergeNets(base, mine, theirs) {
  const out = { ...theirs };
  for (const f of changedNetFields(base, mine)) out[f] = mine[f];
  const list = [...(theirs.stations || [])];
  for (const call of changedCalls(base, mine)) {
    const m = stationOf(mine, call);
    const at = list.findIndex((s) => s.call === call);
    if (m) {
      if (at >= 0) list[at] = m;
      else list.push(m);
    } else if (at >= 0) {
      list.splice(at, 1);
    }
  }
  out.stations = orderStations(list);
  return out;
}

/**
 * Decide what to do with a net state from another site.
 * @param {object} o
 * @param {string} o.head       tag of the last state this site published or took
 * @param {Map}    o.history    tag → net, states this site has seen
 * @param {object|null} o.local the running net here (live) or null
 * @param {object} o.remote     the received document ({ net, rev, updatedAt, tag, parentTag })
 * @returns {{ action: string, net?: object, calls?: string[], fields?: string[] }}
 */
export function reconcileNet({ head, history, local, remote }) {
  if (!remote) return { action: 'ignore' };
  if (remote.tag && remote.tag === head) return { action: 'ignore' };
  const theirs = remote.net;
  if (!theirs || !local || theirs.id !== local.id || !remote.tag) return { action: 'legacy' };
  if (sameNetContent(local, theirs)) return { action: 'same' };
  if (remote.parentTag && remote.parentTag === head) return { action: 'adopt', net: theirs };
  const base = remote.parentTag ? history?.get(remote.parentTag) : null;
  if (!base || base.id !== local.id) return { action: 'legacy' };
  const check = rebaseCheck(base, local, theirs);
  // A line both sites changed to the same thing is not a conflict.
  const calls = check.calls.filter((c) => !sameValue(stationOf(local, c), stationOf(theirs, c)));
  const fields = check.fields;
  if (!calls.length && !fields.length) return { action: 'merge', net: mergeNets(base, local, theirs) };
  return { action: 'conflict', net: theirs, calls, fields };
}
