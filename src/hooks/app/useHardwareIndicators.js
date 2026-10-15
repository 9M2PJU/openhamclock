/**
 * useHardwareIndicators — tell the Rig Bridge what the display is showing so
 * hardware plugins (GPIO LEDs) can mirror it: satellite visible / seconds to
 * AOS / seconds to LOS, the ID-timer countdown state, and whether an alarm
 * (ID timer expired) is ringing.
 *
 * POSTs <rig-bridge>/api/indicators every 15 s and within 1 s of a change.
 * Silent when rig control is disabled, in cloud-relay mode, or when the
 * bridge is unreachable (backs off to once a minute after 3 failures).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildRigUrl } from '../../contexts/RigContext.jsx';
import { isRelayConfigured } from '../../utils/relaySession.js';

const PUSH_INTERVAL_MS = 15000;
const CHANGE_DEBOUNCE_MS = 1000;
const BACKOFF_MS = 60000;

/** Window event the ID timer fires: detail = { state: 'off'|'running'|'expired' } */
export const COUNTDOWN_STATE_EVENT = 'ohc-countdown-state';

/** Pure: derive satellite indicator fields from the satellites hook output. */
export function deriveSatIndicators(satellites, now = Date.now()) {
  let satVisible = false;
  let satAosInSec = null;
  let satLosInSec = null;
  for (const sat of satellites || []) {
    const starts = sat.nextPassStartTimes || [];
    const ends = sat.nextPassEndTimes || [];
    if (sat.isVisible) {
      satVisible = true;
      for (const e of ends) {
        const end = new Date(e).getTime();
        if (Number.isFinite(end) && end > now) {
          const s = Math.round((end - now) / 1000);
          if (satLosInSec == null || s < satLosInSec) satLosInSec = s;
          break;
        }
      }
    } else {
      for (const st of starts) {
        const start = new Date(st).getTime();
        if (Number.isFinite(start) && start > now) {
          const s = Math.round((start - now) / 1000);
          if (satAosInSec == null || s < satAosInSec) satAosInSec = s;
          break;
        }
      }
    }
  }
  return { satVisible, satAosInSec, satLosInSec };
}

export default function useHardwareIndicators({ satellites, rigConfig }) {
  const [countdown, setCountdown] = useState('off');
  const failuresRef = useRef(0);
  const timerRef = useRef(null);
  const lastKeyRef = useRef('');

  useEffect(() => {
    const onState = (e) => {
      const s = e?.detail?.state;
      if (s === 'off' || s === 'running' || s === 'expired') setCountdown(s);
    };
    window.addEventListener(COUNTDOWN_STATE_EVENT, onState);
    return () => window.removeEventListener(COUNTDOWN_STATE_EVENT, onState);
  }, []);

  const enabled = !!rigConfig?.enabled && !isRelayConfigured();
  const rigUrl = buildRigUrl(rigConfig);
  const apiToken = rigConfig?.apiToken?.trim() || '';

  const sat = useMemo(() => deriveSatIndicators(satellites), [satellites]);
  const payload = useMemo(
    () => ({ ...sat, countdown, alarm: countdown === 'expired' }),
    [sat.satVisible, sat.satAosInSec, sat.satLosInSec, countdown], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Coarse key: AOS/LOS seconds change every tick; only re-push on meaningful changes
  const key = `${payload.satVisible}|${payload.countdown}|${payload.satAosInSec != null && payload.satAosInSec <= 90}|${payload.satLosInSec != null && payload.satLosInSec <= 90}`;

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    const push = async () => {
      if (!active) return;
      try {
        const res = await fetch(`${rigUrl}/api/indicators`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiToken ? { 'X-RigBridge-Token': apiToken } : {}) },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(4000),
        });
        failuresRef.current = res.ok ? 0 : failuresRef.current + 1;
      } catch {
        failuresRef.current += 1;
      }
      if (!active) return;
      const delay = failuresRef.current >= 3 ? BACKOFF_MS : PUSH_INTERVAL_MS;
      timerRef.current = setTimeout(push, delay);
    };
    const changed = key !== lastKeyRef.current;
    lastKeyRef.current = key;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(push, changed ? CHANGE_DEBOUNCE_MS : PUSH_INTERVAL_MS);
    return () => {
      active = false;
      clearTimeout(timerRef.current);
    };
  }, [enabled, rigUrl, apiToken, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return payload;
}
