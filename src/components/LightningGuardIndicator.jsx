/**
 * Lightning guard UI: the header bolt (grey = all clear, amber = warning,
 * red pulsing = alarm) with a popover — nearest strike, last strike time,
 * strike rate, all-clear countdown, antenna relay state with the manual
 * override — and the banner shown across the top while a warning or alarm
 * is active. State comes from hooks/useLightningGuard.js (no prop plumbing);
 * nothing renders while the guard is off in Settings → Alerts.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { lgT } from '../utils/lightningGuardStrings.js';
import { useLightningGuardStatus, setRelayOverride } from '../hooks/useLightningGuard.js';
import { useBridgeEvent } from '../hooks/useBridgeEvent.js';
import { useAlarmState } from '../hooks/app/useAlarmClock.js';
import { describeStrike, formatDistance } from '../utils/lightningGuard.js';

const RED = '#ff4d4d';
const AMBER = '#f59e0b';
const GREEN = '#4ade80';

const levelColor = (level) => (level === 'alarm' ? RED : level === 'warn' ? AMBER : 'var(--text-muted)');

export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60000)} min`;
}

const clock = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** Re-render every second while `on` (countdowns, ages). */
function useSecondTicker(on) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const id = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [on]);
}

function BoltIcon({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}

/** Shared status lines (popover + settings card). */
export function LightningGuardDetails({ status, showOverride = true }) {
  const { t } = useTranslation();
  const { data: gpio } = useBridgeEvent('gpio');
  const now = Date.now();
  const imperial = status.imperial;
  const warnR = formatDistance(status.settings.warnKm, imperial);
  const bridgeRelay =
    gpio?.outputs && typeof gpio.outputs.lightningOut === 'boolean' ? gpio.outputs.lightningOut : null;
  const btn = (active) => ({
    background: active ? 'var(--accent-cyan)' : 'var(--bg-tertiary)',
    color: active ? '#000' : 'var(--text-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: '4px',
    padding: '3px 8px',
    fontSize: '11px',
    cursor: 'pointer',
    fontFamily: 'var(--font-mono)',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', lineHeight: 1.5 }}>
      <div style={{ fontWeight: 700, color: levelColor(status.level) }}>
        {lgT(t, `lightningGuard.level.${status.level === 'off' ? 'clear' : status.level}`)}
      </div>
      {status.nearest ? (
        <>
          <div>
            {lgT(t, 'lightningGuard.nearest', { distance: describeStrike(status.nearest, imperial) })}
            {status.nearest.simulated ? ` (${lgT(t, 'lightningGuard.simulated')})` : ''}
          </div>
          {status.last && (
            <div>
              {lgT(t, 'lightningGuard.lastStrike', {
                time: clock(status.last.timestamp),
                age: formatAge(now - status.last.timestamp),
                distance: describeStrike(status.last, imperial),
              })}
            </div>
          )}
          <div style={{ color: 'var(--text-muted)' }}>
            {lgT(t, 'lightningGuard.rate', { count: status.warnCount, radius: `${warnR.value} ${warnR.unit}` })}
          </div>
        </>
      ) : (
        <div style={{ color: 'var(--text-muted)' }}>
          {lgT(t, 'lightningGuard.noStrikes', { radius: `${warnR.value} ${warnR.unit}` })}
        </div>
      )}
      {status.clearAt && (status.level === 'warn' || status.level === 'alarm') && (
        <div>{lgT(t, 'lightningGuard.allClearIn', { countdown: formatCountdown(status.clearAt - now) })}</div>
      )}
      {status.relay !== null && (
        <>
          <div style={{ color: status.relay ? RED : GREEN, fontWeight: 600, marginTop: '4px' }}>
            {status.relay ? lgT(t, 'lightningGuard.relay.engaged') : lgT(t, 'lightningGuard.relay.released')}
          </div>
          {bridgeRelay !== null && (
            <div style={{ color: 'var(--text-muted)' }}>
              {lgT(t, 'lightningGuard.relay.bridge', {
                state: bridgeRelay ? lgT(t, 'lightningGuard.relay.bridgeOn') : lgT(t, 'lightningGuard.relay.bridgeOff'),
              })}
            </div>
          )}
          {showOverride && (
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap', marginTop: '2px' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                {lgT(t, 'lightningGuard.override.label')}
              </span>
              {['auto', 'on', 'off'].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setRelayOverride(v)}
                  aria-pressed={status.override === v}
                  style={btn(status.override === v)}
                >
                  {lgT(t, `lightningGuard.override.${v}`)}
                </button>
              ))}
            </div>
          )}
          {status.override === 'off' && (
            <div style={{ color: AMBER, fontSize: '11px' }}>{lgT(t, 'lightningGuard.override.offHint')}</div>
          )}
        </>
      )}
    </div>
  );
}

/** Header bolt + popover. Renders nothing while the guard is off. */
export function LightningGuardIndicator({ size = 'small' }) {
  const { t } = useTranslation();
  const status = useLightningGuardStatus();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useSecondTicker(open && status.enabled);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!status.enabled) return null;
  const label = `${lgT(t, 'lightningGuard.title')} — ${lgT(t, `lightningGuard.level.${status.level}`)}`;
  const px = size === 'large' ? '1em' : '14px';

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        title={status.nearest ? `${label} · ${describeStrike(status.nearest, status.imperial)}` : label}
        style={{
          background: 'none',
          border: 'none',
          padding: '2px',
          cursor: 'pointer',
          color: levelColor(status.level),
          display: 'inline-flex',
          alignItems: 'center',
          animation: status.level === 'alarm' ? 'pulse 1s infinite' : 'none',
          lineHeight: 1,
        }}
      >
        <BoltIcon size={px} />
        {status.relay === true && (
          <span style={{ fontSize: '9px', fontWeight: 700, marginLeft: '1px' }} aria-hidden="true">
            R
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={lgT(t, 'lightningGuard.title')}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: '6px',
            zIndex: 3000,
            minWidth: '260px',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            padding: '10px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-primary)',
            textAlign: 'left',
          }}
        >
          <div style={{ fontWeight: 700, color: 'var(--accent-cyan)', marginBottom: '6px', fontSize: '11px' }}>
            ⚡ {lgT(t, 'lightningGuard.title')}
          </div>
          <LightningGuardDetails status={status} />
        </div>
      )}
    </div>
  );
}

/** Banner across the top while a warning or alarm is active. Mount once (App). */
export function LightningGuardBanner() {
  const { t } = useTranslation();
  const status = useLightningGuardStatus();
  const { ringing } = useAlarmState();
  const [hiddenFor, setHiddenFor] = useState(null);
  const active = status.enabled && (status.level === 'warn' || status.level === 'alarm');
  useSecondTicker(active);

  if (!active) return null;
  const episode = `${status.level}-${status.since}`;
  if (hiddenFor === episode) return null;
  const now = Date.now();
  const bg = status.level === 'alarm' ? RED : AMBER;
  const parts = [];
  if (status.nearest)
    parts.push(lgT(t, 'lightningGuard.nearest', { distance: describeStrike(status.nearest, status.imperial) }));
  if (status.last) parts.push(lgT(t, 'lightningGuard.bannerLast', { time: clock(status.last.timestamp) }));
  if (status.clearAt)
    parts.push(lgT(t, 'lightningGuard.allClearIn', { countdown: formatCountdown(status.clearAt - now) }));
  if (status.relay === true) parts.push(lgT(t, 'lightningGuard.relay.engagedShort'));

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        top: ringing ? '46px' : 0,
        left: 0,
        right: 0,
        zIndex: 19999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: '6px 14px',
        padding: '8px 16px',
        background: bg,
        color: status.level === 'alarm' ? '#fff' : '#000',
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        fontSize: '14px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
      }}
    >
      <span style={{ animation: status.level === 'alarm' ? 'pulse 1s infinite' : 'none' }}>⚡</span>
      <span>{lgT(t, `lightningGuard.level.${status.level}`)}</span>
      {parts.length > 0 && <span style={{ fontWeight: 400 }}>{parts.join(' · ')}</span>}
      <button
        type="button"
        onClick={() => setHiddenFor(episode)}
        aria-label={lgT(t, 'lightningGuard.hide')}
        style={{
          background: 'rgba(0,0,0,0.25)',
          color: 'inherit',
          border: 'none',
          borderRadius: '4px',
          padding: '4px 10px',
          fontWeight: 700,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {lgT(t, 'lightningGuard.hide')}
      </button>
    </div>
  );
}

export default LightningGuardIndicator;
