/**
 * Lightning guard settings.
 *
 *  • LightningGuardSettings — Settings → Alerts card: enable, warning/alarm
 *    radii, all-clear time, strikes needed, alert channels (tone, spoken,
 *    browser notification, Web Push), the Rig Bridge relay, live status with
 *    the manual relay override, and "Simulate strike" buttons. Persists in
 *    the shared alert-settings blob (`lightningGuard`), handed in by
 *    AudioAlertsTab like the spoken-alerts card so the two never overwrite
 *    each other.
 *  • LightningRelayPinSettings — Settings → Rig Bridge card: which GPIO line
 *    drives the relay (lightningOut), fail-safe polarity and hold-when-quiet,
 *    pushed to the bridge's /api/config.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { lgT } from '../utils/lightningGuardStrings.js';
import { TONE_PRESETS, playTone } from '../utils/audioAlerts';
import { getNotificationPermission } from '../utils/notifications';
import { getServerPushStatus } from '../utils/push';
import { GUARD_DEFAULTS, normalizeGuardSettings } from '../utils/lightningGuard.js';
import { simulateStrike, useLightningGuardStatus } from '../hooks/useLightningGuard.js';
import { buildRigUrl } from '../contexts/RigContext.jsx';
import { LightningGuardDetails } from './LightningGuardIndicator.jsx';

const cardStyle = (on) => ({
  background: 'var(--bg-tertiary)',
  border: `1px solid ${on ? 'var(--accent-amber)' : 'var(--border-color)'}`,
  borderRadius: '8px',
  padding: '14px',
});

const pillStyle = (on, disabled = false) => ({
  background: on ? 'var(--accent-amber)' : 'var(--bg-secondary)',
  color: on ? '#000' : 'var(--text-muted)',
  border: `1px solid ${on ? 'var(--accent-amber)' : 'var(--border-color)'}`,
  borderRadius: '4px',
  padding: '4px 12px',
  fontSize: '11px',
  fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  fontFamily: 'var(--font-mono)',
});

const inputStyle = {
  width: '72px',
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  borderRadius: '4px',
  padding: '5px 6px',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
};

const noteStyle = { color: 'var(--text-muted)', fontSize: '11px', lineHeight: '1.5' };
const warnBoxStyle = {
  border: '1px solid var(--accent-red, #ef4444)',
  background: 'rgba(239, 68, 68, 0.08)',
  borderRadius: '6px',
  padding: '8px 10px',
  color: 'var(--text-primary)',
  fontSize: '11px',
  lineHeight: '1.5',
};

/** Number input that commits on blur / Enter, so typing "5" on the way to "50" doesn't clamp anything. */
function NumberField({ value, onCommit, label, min, max, step = 1, suffix }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = parseFloat(draft);
    if (Number.isFinite(n)) onCommit(n);
    else setDraft(String(value));
  };
  return (
    <label
      style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)' }}
    >
      <span style={{ minWidth: '150px', color: 'var(--text-muted)' }}>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-label={label}
        style={inputStyle}
      />
      {suffix && <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{suffix}</span>}
    </label>
  );
}

const kmHint = (km, imperial) => (imperial ? `km (≈ ${Math.round(km * 0.621371)} mi)` : 'km');

export function LightningGuardSettings({ alertSettings, updateSettings, imperial = false, hasLocation = true }) {
  const { t } = useTranslation();
  const g = normalizeGuardSettings(alertSettings?.lightningGuard);
  const status = useLightningGuardStatus();
  const [pushAvailable, setPushAvailable] = useState(null); // null = checking
  const notifGranted = getNotificationPermission() === 'granted';

  useEffect(() => {
    let alive = true;
    getServerPushStatus().then((s) => alive && setPushAvailable(!!(s.configured && s.lightning)));
    return () => {
      alive = false;
    };
  }, []);

  const set = (patch) =>
    updateSettings({ ...alertSettings, lightningGuard: normalizeGuardSettings({ ...g, ...patch }) });
  const setChannel = (k, v) => set({ channels: { ...g.channels, [k]: v } });
  const setRelay = (patch) => set({ relay: { ...g.relay, ...patch } });

  const check = (checked, onChange, label, disabled = false, hint = null) => (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
        fontSize: '12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      title={hint || undefined}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: 'var(--accent-amber)' }}
      />
      {label}
    </label>
  );

  return (
    <div style={cardStyle(g.enabled)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600 }}>
          ⚡ {lgT(t, 'lightningGuard.settings.title')}
        </span>
        <button
          type="button"
          onClick={() => set({ enabled: !g.enabled })}
          aria-pressed={g.enabled}
          aria-label={lgT(t, 'lightningGuard.settings.title')}
          style={pillStyle(g.enabled)}
        >
          {g.enabled ? 'ON' : 'OFF'}
        </button>
      </div>
      <div style={{ ...noteStyle, marginTop: '6px' }}>{lgT(t, 'lightningGuard.settings.description')}</div>
      {g.enabled && !hasLocation && (
        <div style={{ ...noteStyle, color: 'var(--accent-red, #ef4444)', marginTop: '6px' }}>
          {lgT(t, 'lightningGuard.settings.noLocation')}
        </div>
      )}

      {g.enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
          <NumberField
            label={lgT(t, 'lightningGuard.settings.warnRadius')}
            value={g.warnKm}
            min={2}
            max={500}
            onCommit={(v) => set({ warnKm: v })}
            suffix={kmHint(g.warnKm, imperial)}
          />
          <NumberField
            label={lgT(t, 'lightningGuard.settings.alarmRadius')}
            value={g.alarmKm}
            min={1}
            max={500}
            onCommit={(v) => set({ alarmKm: v })}
            suffix={kmHint(g.alarmKm, imperial)}
          />
          <NumberField
            label={lgT(t, 'lightningGuard.settings.allClear')}
            value={g.allClearMin}
            min={1}
            max={240}
            onCommit={(v) => set({ allClearMin: v })}
            suffix="min"
          />
          <NumberField
            label={lgT(t, 'lightningGuard.settings.minStrikes')}
            value={g.minStrikes}
            min={1}
            max={50}
            onCommit={(v) => set({ minStrikes: v })}
            suffix={lgT(t, 'lightningGuard.settings.minStrikesSuffix')}
          />
          <div style={noteStyle}>
            {lgT(t, 'lightningGuard.settings.hysteresisNote', {
              pct: g.hysteresisPct,
              defaultWarn: GUARD_DEFAULTS.warnKm,
              defaultAlarm: GUARD_DEFAULTS.alarmKm,
            })}
          </div>

          <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
            {lgT(t, 'lightningGuard.settings.channels')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {check(g.channels.tone, (v) => setChannel('tone', v), lgT(t, 'lightningGuard.settings.channelTone'))}
            <select
              value={g.tone}
              onChange={(e) => set({ tone: e.target.value })}
              aria-label={lgT(t, 'lightningGuard.settings.tone')}
              style={{ ...inputStyle, width: 'auto' }}
            >
              {Object.entries(TONE_PRESETS).map(([key, preset]) => (
                <option key={key} value={key}>
                  {preset.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => playTone(g.tone, alertSettings.volume ?? 0.5)}
              aria-label={lgT(t, 'lightningGuard.settings.previewTone')}
              title={lgT(t, 'lightningGuard.settings.previewTone')}
              style={pillStyle(false)}
            >
              🔊
            </button>
          </div>
          {check(g.channels.speech, (v) => setChannel('speech', v), lgT(t, 'lightningGuard.settings.channelSpeech'))}
          {check(
            g.channels.notify,
            (v) => setChannel('notify', v),
            lgT(t, 'lightningGuard.settings.channelNotify'),
            false,
            notifGranted ? null : lgT(t, 'lightningGuard.settings.notifyNeedsPermission'),
          )}
          {g.channels.notify && !notifGranted && (
            <div style={noteStyle}>{lgT(t, 'lightningGuard.settings.notifyNeedsPermission')}</div>
          )}
          {check(
            g.channels.push && !!pushAvailable,
            (v) => setChannel('push', v),
            lgT(t, 'lightningGuard.settings.channelPush'),
            !pushAvailable,
          )}
          {pushAvailable === false && <div style={noteStyle}>{lgT(t, 'lightningGuard.settings.pushUnavailable')}</div>}

          <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
            {lgT(t, 'lightningGuard.settings.relayTitle')}
          </div>
          {check(g.relay.enabled, (v) => setRelay({ enabled: v }), lgT(t, 'lightningGuard.settings.relayEnable'))}
          {g.relay.enabled && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                <span style={{ minWidth: '150px', color: 'var(--text-muted)' }}>
                  {lgT(t, 'lightningGuard.settings.relayOn')}
                </span>
                <select
                  value={g.relay.on}
                  onChange={(e) => setRelay({ on: e.target.value })}
                  aria-label={lgT(t, 'lightningGuard.settings.relayOn')}
                  style={{ ...inputStyle, width: 'auto' }}
                >
                  <option value="alarm">{lgT(t, 'lightningGuard.settings.relayOnAlarm')}</option>
                  <option value="warn">{lgT(t, 'lightningGuard.settings.relayOnWarn')}</option>
                </select>
              </label>
              <div style={noteStyle}>{lgT(t, 'lightningGuard.settings.relayHowTo')}</div>
            </>
          )}
          <div style={warnBoxStyle}>
            <strong>{lgT(t, 'lightningGuard.settings.safetyTitle')}</strong>{' '}
            {lgT(t, 'lightningGuard.settings.safetyText')}
          </div>

          <div
            style={{
              borderTop: '1px solid var(--border-color)',
              paddingTop: '8px',
              marginTop: '4px',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {status.enabled ? (
              <LightningGuardDetails status={status} />
            ) : (
              <div style={noteStyle}>{lgT(t, 'lightningGuard.settings.statusOff')}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={noteStyle}>{lgT(t, 'lightningGuard.settings.test')}</span>
            <button
              type="button"
              disabled={!status.enabled}
              onClick={() => simulateStrike(Math.max(0.5, g.alarmKm * 0.6), 45)}
              style={pillStyle(false, !status.enabled)}
            >
              {lgT(t, 'lightningGuard.settings.simulateAlarm')}
            </button>
            <button
              type="button"
              disabled={!status.enabled}
              onClick={() => simulateStrike((g.alarmKm * (1 + g.hysteresisPct / 100) + g.warnKm) / 2, 270)}
              style={pillStyle(false, !status.enabled)}
            >
              {lgT(t, 'lightningGuard.settings.simulateWarn')}
            </button>
          </div>
          <div style={noteStyle}>{lgT(t, 'lightningGuard.settings.testNote')}</div>
        </div>
      )}
    </div>
  );
}

/** Settings → Rig Bridge: GPIO line for the lightning relay. */
export function LightningRelayPinSettings({ rigEnabled, rigHost, rigPort, rigApiToken }) {
  const { t } = useTranslation();
  const [pin, setPin] = useState('');
  const [failSafe, setFailSafe] = useState(false);
  const [hold, setHold] = useState(true);
  const [loadState, setLoadState] = useState(null); // null | 'ok' | 'error'
  const [pushState, setPushState] = useState(null); // null | 'pushing' | 'ok' | 'error'
  const [gpioStatus, setGpioStatus] = useState(null);
  const bridgeUrl = buildRigUrl({ host: rigHost, port: rigPort });
  const headers = { 'Content-Type': 'application/json', ...(rigApiToken ? { 'X-RigBridge-Token': rigApiToken } : {}) };

  const load = async () => {
    try {
      const [cfgRes, stRes] = await Promise.all([
        fetch(`${bridgeUrl}/api/config`, { headers, signal: AbortSignal.timeout(4000) }),
        fetch(`${bridgeUrl}/api/gpio/status`, { headers, signal: AbortSignal.timeout(4000) }).catch(() => null),
      ]);
      if (!cfgRes.ok) throw new Error(`HTTP ${cfgRes.status}`);
      const cfg = await cfgRes.json();
      const g = cfg?.gpio || {};
      const p = g.pins?.lightningOut;
      setPin(p == null || p === -1 || p === '-1' ? '' : String(p));
      setFailSafe(!!g.lightningFailSafe);
      setHold(g.lightningHoldWhenStale !== false);
      setGpioStatus(stRes && stRes.ok ? await stRes.json() : null);
      setLoadState('ok');
    } catch {
      setLoadState('error');
    }
  };

  useEffect(() => {
    if (rigEnabled) load();
  }, [rigEnabled, bridgeUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const push = async () => {
    setPushState('pushing');
    const raw = pin.trim();
    const pinValue = raw === '' ? -1 : /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
    try {
      const res = await fetch(`${bridgeUrl}/api/config`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          gpio: { pins: { lightningOut: pinValue }, lightningFailSafe: failSafe, lightningHoldWhenStale: hold },
        }),
      });
      setPushState(res.ok ? 'ok' : 'error');
      if (res.ok) setTimeout(load, 1500);
    } catch {
      setPushState('error');
    }
  };

  const running = gpioStatus?.running;
  return (
    <div
      style={{
        background: 'var(--bg-tertiary)',
        padding: '12px',
        borderRadius: '6px',
        border: '1px solid var(--border-color)',
        marginTop: '16px',
      }}
    >
      <div
        style={{
          fontSize: '11px',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '1px',
          marginBottom: '8px',
        }}
      >
        ⚡ {lgT(t, 'lightningGuard.pin.title')}
      </div>
      <div style={{ ...noteStyle, marginBottom: '10px' }}>{lgT(t, 'lightningGuard.pin.description')}</div>
      {!rigEnabled ? (
        <div style={noteStyle}>{lgT(t, 'lightningGuard.pin.needsBridge')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
            <span style={{ minWidth: '150px', color: 'var(--text-muted)' }}>{lgT(t, 'lightningGuard.pin.pin')}</span>
            <input
              type="text"
              value={pin}
              placeholder={lgT(t, 'lightningGuard.pin.placeholder')}
              onChange={(e) => setPin(e.target.value)}
              aria-label={lgT(t, 'lightningGuard.pin.pin')}
              style={{ ...inputStyle, width: '90px' }}
            />
            <span style={noteStyle}>{lgT(t, 'lightningGuard.pin.pinHint')}</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={failSafe}
              onChange={(e) => setFailSafe(e.target.checked)}
              style={{ accentColor: 'var(--accent-amber)' }}
            />
            {lgT(t, 'lightningGuard.pin.failSafe')}
          </label>
          <div style={noteStyle}>{lgT(t, 'lightningGuard.pin.failSafeHint')}</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={hold}
              onChange={(e) => setHold(e.target.checked)}
              style={{ accentColor: 'var(--accent-amber)' }}
            />
            {lgT(t, 'lightningGuard.pin.hold')}
          </label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" onClick={push} disabled={pushState === 'pushing'} style={pillStyle(true)}>
              {lgT(t, 'lightningGuard.pin.push')}
            </button>
            <button type="button" onClick={load} style={pillStyle(false)}>
              {lgT(t, 'lightningGuard.pin.reload')}
            </button>
            {pushState === 'ok' && (
              <span style={{ color: 'var(--accent-green, #22c55e)', fontSize: '11px' }}>
                {lgT(t, 'lightningGuard.pin.pushed')}
              </span>
            )}
            {(pushState === 'error' || loadState === 'error') && (
              <span style={{ color: 'var(--accent-red, #ef4444)', fontSize: '11px' }}>
                {lgT(t, 'lightningGuard.pin.unreachable')}
              </span>
            )}
          </div>
          {loadState === 'ok' && (
            <div style={noteStyle}>
              {running
                ? lgT(t, 'lightningGuard.pin.gpioRunning', {
                    backend: gpioStatus.backend || '?',
                    relay: gpioStatus.lightning?.pin != null ? (gpioStatus.lightning.relay ? 'ON' : 'OFF') : '—',
                  })
                : lgT(t, 'lightningGuard.pin.gpioOff')}
            </div>
          )}
          <div style={warnBoxStyle}>
            <strong>{lgT(t, 'lightningGuard.settings.safetyTitle')}</strong> {lgT(t, 'lightningGuard.pin.wiring')}
          </div>
        </div>
      )}
    </div>
  );
}

export default LightningGuardSettings;
