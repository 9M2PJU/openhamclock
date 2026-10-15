/**
 * useLightningGuard — lightning antenna protection.
 *
 *  • useLightningGuard({ location, allUnits, layout }): mount ONCE (App.jsx).
 *    While Settings → Alerts → Lightning guard is on it subscribes to the
 *    shared Blitzortung feed (utils/lightningFeed.js — runs even when the
 *    Lightning map layer is off), measures every strike from DE, runs the
 *    warn → alarm → all-clear state machine (utils/lightningGuard.js) and on
 *    each transition fires the chosen alert channels: tone, spoken alert,
 *    browser notification, Web Push (opt-in servers), plus an EmComm event
 *    log entry when the EmComm layout is active. Returns { level, relay } —
 *    `relay` (true/false/null) is what useHardwareIndicators posts to the
 *    Rig Bridge as `lightningRelay` for the GPIO lightningOut line.
 *  • useLightningGuardStatus(): any component (header indicator, banner,
 *    settings) subscribes to the live status.
 *
 * Test without a storm: Settings → Alerts → Lightning guard → "Simulate
 * strike", or
 *   window.dispatchEvent(new CustomEvent('ohc:inject-lightning',
 *     { detail: { distanceKm: 10, bearingDeg: 45 } }))
 * (or detail { lat, lon }). Simulated strikes go through the same feed, so
 * the map layer shows them too.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { subscribeStrikes, injectStrike } from '../utils/lightningFeed.js';
import {
  addStrikes,
  cardinal,
  describeStrike,
  destinationPoint,
  evaluateGuard,
  nextOverride,
  normalizeGuardSettings,
  OVERRIDES,
  relayDemand,
  transitionKind,
} from '../utils/lightningGuard.js';
import { ALERT_SETTINGS_EVENT, getAlertSettings, playTone } from '../utils/audioAlerts.js';
import { formatAlertBody, getNotificationPermission, showAlertNotification } from '../utils/notifications.js';
import { formatSpeechText, getSpeechSettings, speakText } from '../utils/speechAlerts.js';
import { sendLightningPush } from '../utils/push.js';
import { recordEvent } from '../utils/emcommEventLog.js';

export const INJECT_LIGHTNING_EVENT = 'ohc:inject-lightning';
const OVERRIDE_KEY = 'ohc_lightning_override';
const RELAY_CLAIM_KEY = 'ohc_lightning_relay_claimed';
const TICK_MS = 15000; // re-evaluate for the all-clear timer
const ALARM_BEEPS = 3;
const BEEP_GAP_MS = 450;

// ── Settings (inside the shared alert-settings blob) ───────────────────────
// (Saved by the Settings → Alerts card through AudioAlertsTab's blob writer.)
export function readGuardSettings() {
  return normalizeGuardSettings(getAlertSettings().lightningGuard);
}

// ── Store ──────────────────────────────────────────────────────────────────
const lsGet = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
};

export function getRelayOverride() {
  const v = lsGet(OVERRIDE_KEY);
  return OVERRIDES.includes(v) ? v : 'auto';
}

const OFF_STATUS = {
  enabled: false,
  level: 'off',
  since: null,
  nearest: null,
  last: null,
  warnCount: 0,
  alarmCount: 0,
  warnRate: 0,
  alarmRate: 0,
  clearAt: null,
  relay: null,
  relayReport: null,
  override: 'auto',
  imperial: false,
  settings: normalizeGuardSettings(null),
};

let status = { ...OFF_STATUS, override: getRelayOverride() };
const listeners = new Set();
let engineReevaluate = null;

function publish(next) {
  status = next;
  for (const fn of listeners) {
    try {
      fn();
    } catch {}
  }
}

export function getLightningGuardStatus() {
  return status;
}

export function subscribeLightningGuard(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Live guard status for components. */
export function useLightningGuardStatus() {
  return useSyncExternalStore(subscribeLightningGuard, getLightningGuardStatus, getLightningGuardStatus);
}

/** Manual relay override: 'auto' | 'on' (force protect) | 'off' (hold connected). */
export function setRelayOverride(value) {
  const v = OVERRIDES.includes(value) ? value : 'auto';
  lsSet(OVERRIDE_KEY, v === 'auto' ? null : v);
  if (engineReevaluate) engineReevaluate();
  else publish({ ...status, override: v });
}

/**
 * The bridge only hears `lightningRelay` from browsers that drive the relay,
 * so other displays can't release it. When this browser stops driving it
 * (relay switched off in Settings) it reports `false` once more, until the
 * bridge acknowledged it — useHardwareIndicators calls this after each POST.
 */
function relayReportFor(demand) {
  if (demand !== null) {
    if (lsGet(RELAY_CLAIM_KEY) !== '1') lsSet(RELAY_CLAIM_KEY, '1');
    return demand;
  }
  return lsGet(RELAY_CLAIM_KEY) === '1' ? false : null;
}

export function acknowledgeRelayReport(value) {
  if (value === false && status.relay === null && lsGet(RELAY_CLAIM_KEY) === '1') {
    lsSet(RELAY_CLAIM_KEY, null);
    publish({ ...status, relayReport: null });
  }
}

/** Fire a synthetic strike `distanceKm` from DE along `bearingDeg`. */
export function simulateStrike(distanceKm = 10, bearingDeg = 45) {
  window.dispatchEvent(new CustomEvent(INJECT_LIGHTNING_EVENT, { detail: { distanceKm, bearingDeg } }));
}

// ── Alerts ─────────────────────────────────────────────────────────────────
const TITLES = { warn: 'Lightning warning', alarm: 'Lightning ALARM', clear: 'Lightning all clear' };

function fireAlerts({ prev, st, settings, demand, prevDemand, imperial, layout }) {
  const kind = transitionKind(prev, st.level);
  if (!kind) return;
  // Mention the relay when it is engaged, or when this transition released it
  const relay = demand === true ? true : demand === false && prevDemand === true ? false : null;
  const downgraded = kind === 'deescalate' && st.level === 'warn';
  const strike = st.nearest;
  const alertSettings = getAlertSettings();
  const ch = settings.channels;

  if (ch.tone) {
    const volume = alertSettings.volume ?? 0.5;
    if (st.level === 'alarm') {
      for (let i = 0; i < ALARM_BEEPS; i++) setTimeout(() => playTone(settings.tone, volume), i * BEEP_GAP_MS);
    } else if (st.level === 'warn' && !downgraded) {
      playTone(settings.tone, volume);
    } else if (st.level === 'clear') {
      playTone('chime', volume);
    }
  }

  if (ch.speech) {
    const text = formatSpeechText(
      'lightning-guard',
      {
        level: st.level,
        downgraded,
        distanceKm: strike?.distanceKm,
        bearing: strike ? cardinal(strike.bearingDeg, { words: true }) : '',
        imperial,
        relay,
      },
      { phonetic: getSpeechSettings(alertSettings).phonetic },
    );
    if (text) speakText(text, alertSettings);
  }

  const distance = describeStrike(strike, imperial);
  if (ch.notify && getNotificationPermission() === 'granted') {
    showAlertNotification({
      feedId: 'lightning-guard',
      title: downgraded ? 'Lightning alarm ended — warning continues' : TITLES[st.level],
      body: formatAlertBody('lightning-guard', { level: st.level, distance, count: st.warnCount, relay }),
      tag: 'ohc-lightning-guard',
    });
  }

  if (ch.push && !downgraded) {
    sendLightningPush({
      level: st.level,
      distanceKm: strike?.distanceKm,
      bearingDeg: strike?.bearingDeg,
      imperial,
      relay,
    });
  }

  if (layout === 'emcomm') {
    recordEvent('lightning', {
      summary: downgraded ? 'Lightning alarm ended — warning continues' : TITLES[st.level],
      details: [
        distance && st.level !== 'clear' ? `nearest strike ${distance}` : '',
        st.level !== 'clear' ? `${st.warnCount} strike(s) within ${settings.warnKm} km in 10 min` : '',
        relay === true ? 'antenna relay engaged' : relay === false ? 'antenna relay released' : '',
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
}

// ── Engine ─────────────────────────────────────────────────────────────────
export default function useLightningGuard({ location, allUnits, layout } = {}) {
  const [settings, setSettings] = useState(readGuardSettings);
  useEffect(() => {
    const sync = () => setSettings(readGuardSettings());
    window.addEventListener(ALERT_SETTINGS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(ALERT_SETTINGS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const lat = location?.lat;
  const lon = location?.lon;
  const hasDe = Number.isFinite(lat) && Number.isFinite(lon);
  const active = settings.enabled && hasDe;

  // Refs so the feed subscription survives DE moves (GPS follow) and setting edits
  const deRef = useRef({ lat, lon });
  deRef.current = { lat, lon };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const imperialRef = useRef(false);
  imperialRef.current = allUnits?.dist === 'imperial';
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const strikesRef = useRef([]);
  const levelRef = useRef('clear');
  const sinceRef = useRef(null);
  const demandRef = useRef(null);

  const evaluate = useCallback(() => {
    const s = settingsRef.current;
    const now = Date.now();
    strikesRef.current = addStrikes(strikesRef.current, [], deRef.current, s, now);
    const st = evaluateGuard(levelRef.current, strikesRef.current, s, now);
    const prev = levelRef.current;
    if (st.level !== prev || sinceRef.current == null) sinceRef.current = now;
    levelRef.current = st.level;

    let override = getRelayOverride();
    const lapsed = nextOverride(override, st.level);
    if (lapsed !== override) {
      lsSet(OVERRIDE_KEY, lapsed === 'auto' ? null : lapsed);
      override = lapsed;
    }
    const demand = relayDemand({ settings: s, level: st.level, override });
    const prevDemand = demandRef.current;
    demandRef.current = demand;

    publish({
      enabled: true,
      ...st,
      since: sinceRef.current,
      relay: demand,
      relayReport: relayReportFor(demand),
      override,
      imperial: imperialRef.current,
      settings: s,
    });

    if (st.level !== prev) {
      fireAlerts({
        prev,
        st,
        settings: s,
        demand,
        prevDemand,
        imperial: imperialRef.current,
        layout: layoutRef.current,
      });
    } else if (demand !== prevDemand && prevDemand !== null && demand !== null && layoutRef.current === 'emcomm') {
      // Relay moved without a level change (manual override) — log it
      recordEvent('lightning', {
        summary: demand ? 'Antenna relay engaged (manual)' : 'Antenna relay released (manual)',
      });
    }
  }, []);

  useEffect(() => {
    if (!active) {
      strikesRef.current = [];
      levelRef.current = 'clear';
      sinceRef.current = null;
      demandRef.current = null;
      engineReevaluate = null;
      publish({
        ...OFF_STATUS,
        override: getRelayOverride(),
        relayReport: relayReportFor(null),
        settings: settingsRef.current,
        imperial: imperialRef.current,
      });
      return undefined;
    }
    engineReevaluate = evaluate;
    evaluate();
    const unsubscribe = subscribeStrikes((batch) => {
      strikesRef.current = addStrikes(strikesRef.current, batch, deRef.current, settingsRef.current, Date.now());
      evaluate();
    });
    const id = setInterval(evaluate, TICK_MS);
    return () => {
      unsubscribe();
      clearInterval(id);
      if (engineReevaluate === evaluate) engineReevaluate = null;
    };
  }, [active, evaluate]);

  // Settings edits (radii, timer, relay) take effect immediately
  useEffect(() => {
    if (active) evaluate();
  }, [settings, active, evaluate]);

  // Synthetic strikes relative to DE (works for the map layer too)
  useEffect(() => {
    const onInject = (e) => {
      const d = e?.detail || {};
      const de = deRef.current;
      let point = null;
      if (Number.isFinite(d.lat) && Number.isFinite(d.lon)) point = { lat: d.lat, lon: d.lon };
      else if (Number.isFinite(de.lat) && Number.isFinite(de.lon)) {
        const km = Number.isFinite(d.distanceKm) ? d.distanceKm : 10;
        point = destinationPoint(de.lat, de.lon, km, Number.isFinite(d.bearingDeg) ? d.bearingDeg : 45);
      }
      if (point) injectStrike(point);
    };
    window.addEventListener(INJECT_LIGHTNING_EVENT, onInject);
    return () => window.removeEventListener(INJECT_LIGHTNING_EVENT, onInject);
  }, []);

  const live = useLightningGuardStatus();
  return { level: live.level, relay: live.relayReport };
}
