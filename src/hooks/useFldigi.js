/**
 * useFldigi — NBEMS state from the Rig Bridge fldigi plugin.
 *
 * Data path: the plugin publishes 'fldigi' (status), 'fldigi-rx' (receive
 * text; `reset` = full tail), 'nbems-form' (a received flmsg form) and, for
 * relayed commands, 'fldigi-cmd-result'. RigContext re-dispatches each as a
 * window 'rig-plugin-data' event, whether it came from the bridge's own
 * /stream (local/LAN) or through the hosted server's relay stream (cloud
 * relay). Both replay the latest status and receive tail on connect; in
 * direct mode this hook also fetches them once on mount.
 *
 * Commands (send text, send ICS-213, mode, stop):
 *   - direct: POST straight to the bridge, like rig tuning, with the bridge
 *     API token when one is set.
 *   - cloud relay: queued on the hosted server as a 'fldigi' relay command
 *     carrying the same token; the bridge runs it against its own routes with
 *     that token (never its own) and answers with a 'fldigi-cmd-result' event,
 *     which this hook waits for.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiToken]        Rig Bridge API token (config.rigControl.apiToken)
 * @param {number} [opts.rxMax=4000]
 * @param {number} [opts.relayTimeoutMs=20000]
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRig } from '../contexts/RigContext.jsx';

const FETCH_TIMEOUT_MS = 5000;

let requestSeq = 0;
const newRequestId = () => `nb-${Date.now().toString(36)}-${(requestSeq++).toString(36)}`;

export function useFldigi({ apiToken = '', rxMax = 4000, relayTimeoutMs = 20000 } = {}) {
  const { rigUrl, isCloudRelay, cloudRelaySession } = useRig();
  const [status, setStatus] = useState(null);
  const [rxText, setRxText] = useState('');
  const [lastForm, setLastForm] = useState(null);
  const [lastEventAt, setLastEventAt] = useState(0);
  const waiters = useRef(new Map()); // requestId → resolve

  // Live events from the bridge (direct or relayed)
  useEffect(() => {
    const onData = (e) => {
      const d = e?.detail;
      if (!d || d.type !== 'plugin') return;
      if (d.event === 'fldigi') {
        setStatus((prev) => ({ ...(prev || {}), ...(d.data || {}), running: true }));
        setLastEventAt(Date.now());
      } else if (d.event === 'fldigi-rx') {
        const text = String(d.data?.text ?? '');
        setRxText((prev) => (d.data?.reset ? text : prev + text).slice(-rxMax));
        setLastEventAt(Date.now());
      } else if (d.event === 'nbems-form') {
        setLastForm({ ...(d.data || {}), at: Date.now() });
      } else if (d.event === 'fldigi-cmd-result') {
        const id = d.data?.requestId;
        const resolve = id && waiters.current.get(id);
        if (resolve) {
          waiters.current.delete(id);
          resolve(d.data);
        }
      }
    };
    window.addEventListener('rig-plugin-data', onData);
    return () => window.removeEventListener('rig-plugin-data', onData);
  }, [rxMax]);

  // Direct mode: one-off fetch on mount (and when the bridge URL changes)
  useEffect(() => {
    if (isCloudRelay || !rigUrl) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${rigUrl}/api/fldigi/status`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.ok && !cancelled) {
          const s = await res.json();
          setStatus((prev) => ({ ...s, ...(prev?.connected != null ? prev : {}) }));
        }
        const rx = await fetch(`${rigUrl}/api/fldigi/rx`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (rx.ok && !cancelled) {
          const r = await rx.json();
          if (typeof r.text === 'string') setRxText((prev) => (prev ? prev : r.text.slice(-rxMax)));
        }
      } catch {
        /* bridge not reachable — the stream fills in when it is */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rigUrl, isCloudRelay, rxMax]);

  const viaRelay = useCallback(
    async (action, body) => {
      if (!cloudRelaySession) return { ok: false, error: 'relay' };
      const requestId = newRequestId();
      const result = new Promise((resolve) => {
        waiters.current.set(requestId, resolve);
        setTimeout(() => {
          if (waiters.current.delete(requestId)) resolve({ ok: false, error: 'relay-timeout' });
        }, relayTimeoutMs);
      });
      try {
        const res = await fetch(`/api/rig-bridge/relay/command?session=${encodeURIComponent(cloudRelaySession)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'fldigi', payload: { action, body: body || {}, token: apiToken, requestId } }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          waiters.current.delete(requestId);
          return { ok: false, status: res.status, error: res.status === 404 ? 'relay-inactive' : `HTTP ${res.status}` };
        }
      } catch {
        waiters.current.delete(requestId);
        return { ok: false, error: 'unreachable' };
      }
      const r = await result;
      if (r.ok) return r;
      return { ...r, ok: false, error: r.error || `HTTP ${r.status}` };
    },
    [cloudRelaySession, apiToken, relayTimeoutMs],
  );

  const post = useCallback(
    async (path, body) => {
      if (isCloudRelay) return viaRelay(path, body);
      try {
        const res = await fetch(`${rigUrl}/api/fldigi/${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiToken ? { 'X-RigBridge-Token': apiToken } : {}),
          },
          body: JSON.stringify(body || {}),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, status: res.status, error: data.error || `HTTP ${res.status}` };
        return { ok: true, ...data };
      } catch (e) {
        return { ok: false, error: e?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
      }
    },
    [rigUrl, isCloudRelay, apiToken, viaRelay],
  );

  const sendText = useCallback((text) => post('send', { text }), [post]);
  const sendIcs213 = useCallback((form) => post('send-ics213', form), [post]);
  const setMode = useCallback((mode) => post('mode', { mode }), [post]);
  const abort = useCallback(() => post('abort'), [post]);

  return {
    status,
    connected: !!status?.connected,
    running: !!status?.running,
    rxText,
    lastForm,
    lastEventAt,
    viaRelay: !!isCloudRelay,
    sendText,
    sendIcs213,
    setMode,
    abort,
  };
}

export default useFldigi;
