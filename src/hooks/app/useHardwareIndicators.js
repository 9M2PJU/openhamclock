/**
 * useHardwareIndicators — tell the Rig Bridge what the display is showing so
 * hardware plugins (GPIO LEDs) can mirror it: satellite visible / seconds to
 * AOS / seconds to LOS, the ID-timer countdown state, whether an alarm
 * (ID timer expired) is ringing, and — only when this browser drives the
 * lightning relay — the lightning guard level and relay request
 * (`lightning`, `lightningRelay`; see hooks/useLightningGuard.js).
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

/**
 * Pure: the body POSTed to /api/indicators. Lightning fields are added only
 * when `lightning.relay` is a boolean — a display that does not drive the
 * relay leaves the bridge's lightning state alone.
 */
export function buildIndicatorPayload(sat, countdown, lightning) {
  const payload = { ...sat, countdown, alarm: countdown === 'expired' };
  if (lightning && typeof lightning.relay === 'boolean') {
    payload.lightningRelay = lightning.relay;
    if (lightning.level === 'clear' || lightning.level === 'warn' || lightning.level === 'alarm') {
      payload.lightning = lightning.level;
    }
  }
  return payload;
}

export default function useHardwareIndicators({ satellites, rigConfig, lightning, onLightningAck }) {
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
  const lightningLevel = lightning?.level;
  const lightningRelay = lightning?.relay;
  const payload = useMemo(
    () => buildIndicatorPayload(sat, countdown, { level: lightningLevel, relay: lightningRelay }),
    [sat.satVisible, sat.satAosInSec, sat.satLosInSec, countdown, lightningLevel, lightningRelay], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const ackRef = useRef(onLightningAck);
  ackRef.current = onLightningAck;
  // Coarse key: AOS/LOS seconds change every tick; only re-push on meaningful changes
  const key = `${payload.satVisible}|${payload.countdown}|${payload.satAosInSec != null && payload.satAosInSec <= 90}|${payload.satLosInSec != null && payload.satLosInSec <= 90}|${payload.lightning ?? ''}|${payload.lightningRelay ?? ''}`;

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
        if (res.ok && typeof payload.lightningRelay === 'boolean') ackRef.current?.(payload.lightningRelay);
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
