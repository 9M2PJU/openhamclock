/**
 * useFldigi — NBEMS state from the Rig Bridge fldigi plugin.
 *
 * Data path: the plugin publishes 'fldigi' (status), 'fldigi-rx' (receive
 * text; `reset` = full tail) and 'nbems-form' (flmsg form just read) on the
 * bridge's SSE /stream; RigContext re-dispatches each as a window
 * 'rig-plugin-data' event. The bridge replays status and the RX tail to
 * every new SSE client, and this hook also fetches both once on mount so a
 * layout switch after the stream connected still starts populated.
 *
 * Commands (send text, send ICS-213, mode, abort) POST straight to the
 * bridge, like rig tuning does, with the bridge API token when one is set.
 * They need a direct connection to the bridge — in cloud-relay mode the
 * hook reports `relayOnly` and the commands are refused.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiToken]  Rig Bridge API token (config.rigControl.apiToken)
 * @param {number} [opts.rxMax=4000]
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRig } from '../contexts/RigContext.jsx';

const FETCH_TIMEOUT_MS = 5000;

export function useFldigi({ apiToken = '', rxMax = 4000 } = {}) {
  const { rigUrl, isCloudRelay } = useRig();
  const [status, setStatus] = useState(null);
  const [rxText, setRxText] = useState('');
  const [lastForm, setLastForm] = useState(null);
  const [lastEventAt, setLastEventAt] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Live events from the bridge stream
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
      }
    };
    window.addEventListener('rig-plugin-data', onData);
    return () => window.removeEventListener('rig-plugin-data', onData);
  }, [rxMax]);

  // One-off fetch on mount (and when the bridge URL changes)
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
        /* bridge not reachable — the stream will fill in when it is */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rigUrl, isCloudRelay, rxMax]);

  const post = useCallback(
    async (path, body) => {
      if (isCloudRelay) return { ok: false, error: 'relay' };
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
    [rigUrl, isCloudRelay, apiToken],
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
    relayOnly: !!isCloudRelay,
    sendText,
    sendIcs213,
    setMode,
    abort,
  };
}

export default useFldigi;
