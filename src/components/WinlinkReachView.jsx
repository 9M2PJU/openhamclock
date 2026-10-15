/**
 * WinlinkReachView — the Winlink panel's "Reachable" view.
 *
 * Ranked list of HF gateways within range by predicted P.533 circuit
 * reliability from the station to each gateway, on the gateway's own
 * frequencies, for the current (display-time) UTC hour; plus nearby
 * VHF/UHF gateways ranked by distance with a line-of-sight hint.
 *
 * Kept mounted (hidden) after first use while the panel is open so the
 * Winlink Gateways map layer keeps its reachability colouring when the
 * operator flips to the inbox.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRig } from '../contexts/RigContext.jsx';
import { useWinlinkReach } from '../hooks/useWinlinkReach.js';
import { ANTENNA_PROFILES } from '../utils/propagationAdjust.js';
import { formatDistance } from '../utils/geo.js';
import { winlinkModeColor } from '../utils/winlinkModes.js';
import {
  DEFAULT_RANGE_KM,
  RANGE_OPTIONS_KM,
  STATUS_COLORS,
  patConnectUrl,
  rigModeForChannel,
} from '../utils/winlinkReach.js';

const RANGE_STORAGE_KEY = 'ohc_winlinkReachRangeKm';

function loadRange() {
  try {
    const v = parseInt(localStorage.getItem(RANGE_STORAGE_KEY), 10);
    return RANGE_OPTIONS_KM.includes(v) ? v : DEFAULT_RANGE_KM;
  } catch {
    return DEFAULT_RANGE_KM;
  }
}

function utcHHMM(ms) {
  if (!ms) return '--';
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}z`;
}

function compass(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const smallBtn = {
  padding: '2px 6px',
  fontSize: '10px',
  borderRadius: '3px',
  border: '1px solid var(--border-color)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  flexShrink: 0,
};

export default function WinlinkReachView({
  hidden = false,
  deLocation,
  propConfig,
  solarIndices,
  units = 'imperial',
  onSelectGateway,
}) {
  const { t } = useTranslation();
  const rig = useRig();
  const [rangeKm, setRangeKm] = useState(loadRange);
  const [expanded, setExpanded] = useState(null);
  const [copied, setCopied] = useState(null);
  const ssn = solarIndices?.data?.ssn?.current ?? 100;

  const reach = useWinlinkReach({ active: true, deLocation, rangeKm, propConfig, ssn });

  useEffect(() => {
    try {
      localStorage.setItem(RANGE_STORAGE_KEY, String(rangeKm));
    } catch {
      /* storage unavailable */
    }
  }, [rangeKm]);

  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(id);
  }, [copied]);

  const canTune = !!(rig?.enabled && rig?.connected && typeof rig?.tuneTo === 'function');

  const tune = useCallback(
    (channel) => {
      if (!canTune || !channel?.dialHz) return;
      rig.tuneTo(channel.dialHz, rigModeForChannel(channel));
    },
    [canTune, rig],
  );

  const select = useCallback(
    (row, channel) => {
      onSelectGateway?.({ lat: row.lat, lon: row.lon, callsign: row.callsign });
      tune(channel);
    },
    [onSelectGateway, tune],
  );

  const copyPat = useCallback(async (callsign, channel) => {
    const url = patConnectUrl(callsign, channel);
    if (!url) return;
    const ok = await copyText(url);
    setCopied(ok ? url : null);
  }, []);

  const statusLabel = (s) =>
    ({
      good: t('winlinkReach.status.good', { defaultValue: 'Good' }),
      marginal: t('winlinkReach.status.marginal', { defaultValue: 'Marginal' }),
      closed: t('winlinkReach.status.closed', { defaultValue: 'Closed' }),
      unknown: t('winlinkReach.status.unknown', { defaultValue: '…' }),
    })[s] || s;

  const losLabel = (los) =>
    ({
      los: t('winlinkReach.los.los', { defaultValue: 'Line of sight' }),
      extended: t('winlinkReach.los.extended', { defaultValue: 'Needs height / good antenna' }),
      beyond: t('winlinkReach.los.beyond', { defaultValue: 'Beyond line of sight' }),
    })[los] || '';

  const engineLabel =
    reach.engine === 'wasm'
      ? t('winlinkReach.engine.wasm', { defaultValue: 'ITU-R P.533, computed in your browser' })
      : reach.engine === 'server'
        ? t('winlinkReach.engine.server', { defaultValue: 'ITU-R P.533 on the server (band-level)' })
        : reach.engine === 'est'
          ? t('winlinkReach.engine.est', { defaultValue: 'Solar-indices estimate (P.533 engine unavailable)' })
          : '';

  const antennaName = (ANTENNA_PROFILES[propConfig?.antenna] || ANTENNA_PROFILES.isotropic).name;
  const { done, total } = reach.progress;

  const renderChip = (status) => (
    <span
      style={{
        display: 'inline-block',
        minWidth: '52px',
        textAlign: 'center',
        padding: '1px 5px',
        borderRadius: '3px',
        fontSize: '9px',
        fontWeight: 700,
        color: status === 'unknown' ? 'var(--text-muted)' : '#000',
        background: status === 'unknown' ? 'var(--bg-tertiary)' : STATUS_COLORS[status],
        flexShrink: 0,
      }}
    >
      {statusLabel(status)}
    </span>
  );

  const renderChannelActions = (callsign, channel) => {
    const url = patConnectUrl(callsign, channel);
    return (
      <span style={{ display: 'inline-flex', gap: '3px' }} onClick={(e) => e.stopPropagation()}>
        {canTune && (
          <button
            type="button"
            style={smallBtn}
            onClick={() => tune(channel)}
            title={t('winlinkReach.tuneTitle', {
              defaultValue: 'Tune the rig to {{dial}} kHz dial',
              dial: (channel.dialHz / 1000).toFixed(1),
            })}
          >
            {t('winlinkReach.tune', { defaultValue: 'Tune' })}
          </button>
        )}
        {url && (
          <button
            type="button"
            style={smallBtn}
            onClick={() => copyPat(callsign, channel)}
            title={t('winlinkReach.copyTitle', { defaultValue: 'Copy the Pat connect string: {{url}}', url })}
          >
            {t('winlinkReach.copy', { defaultValue: 'Pat' })}
          </button>
        )}
      </span>
    );
  };

  return (
    <div style={{ display: hidden ? 'none' : 'block' }} aria-hidden={hidden}>
      {/* Controls */}
      <div
        style={{
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
          flexWrap: 'wrap',
          padding: '4px',
          borderBottom: '1px solid var(--border-color)',
          fontSize: '10px',
          color: 'var(--text-muted)',
        }}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          {t('winlinkReach.range', { defaultValue: 'Range' })}
          <select
            value={rangeKm}
            onChange={(e) => setRangeKm(parseInt(e.target.value, 10))}
            style={{
              padding: '2px 4px',
              fontSize: '10px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: '3px',
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
            }}
          >
            {RANGE_OPTIONS_KM.map((km) => (
              <option key={km} value={km}>
                {formatDistance(km, units)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          style={{ ...smallBtn, opacity: reach.running ? 0.5 : 1 }}
          disabled={reach.running}
          onClick={reach.refresh}
        >
          {t('winlinkReach.refresh', { defaultValue: 'Refresh' })}
        </button>
        {reach.hour != null && (
          <span title={reach.timeShifted ? t('winlinkReach.shifted', { defaultValue: 'Display time is shifted' }) : ''}>
            {String(reach.hour).padStart(2, '0')}:00z{reach.timeShifted ? ' ⏱' : ''}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }} title={engineLabel}>
          {t('winlinkReach.station', {
            defaultValue: '{{power}} W · {{antenna}} · SSN {{ssn}}',
            power: parseFloat(propConfig?.power) || 100,
            antenna: antennaName,
            ssn: Math.round(ssn),
          })}
        </span>
      </div>

      {/* Progress */}
      {reach.running && total > 0 && (
        <div style={{ padding: '4px' }} role="status" aria-live="polite">
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>
            {t('winlinkReach.progress', {
              defaultValue: 'Predicting paths… {{done}}/{{total}}',
              done,
              total,
            })}
          </div>
          <div style={{ height: '3px', background: 'var(--bg-tertiary)', borderRadius: '2px' }}>
            <div
              style={{
                height: '100%',
                width: `${Math.round((done / total) * 100)}%`,
                background: 'var(--accent-cyan)',
                borderRadius: '2px',
                transition: 'width 0.2s',
              }}
            />
          </div>
        </div>
      )}

      {copied && (
        <div
          style={{
            padding: '3px 6px',
            fontSize: '10px',
            color: '#22c55e',
            background: 'rgba(34,197,94,0.12)',
            fontFamily: 'var(--font-mono)',
            wordBreak: 'break-all',
          }}
        >
          {t('winlinkReach.copied', { defaultValue: 'Copied {{url}}', url: copied })}
        </div>
      )}

      {/* Empty states */}
      {!reach.hasDe ? (
        <div style={{ textAlign: 'center', padding: '16px', color: 'var(--text-muted)' }}>
          {t('winlinkReach.noDe', { defaultValue: 'Set your station location to predict gateway paths.' })}
        </div>
      ) : reach.listError && !reach.gatewayCount ? (
        <div style={{ textAlign: 'center', padding: '16px', color: 'var(--text-muted)' }}>
          {t('winlinkReach.noList', {
            defaultValue:
              'The gateway list is unavailable: this server has no Winlink API key and no Rig Bridge Winlink plugin answered.',
          })}
        </div>
      ) : !reach.listLoaded ? (
        <div style={{ textAlign: 'center', padding: '16px', color: 'var(--text-muted)' }}>
          {t('winlinkReach.loading', { defaultValue: 'Loading the gateway list…' })}
        </div>
      ) : (
        <>
          {/* HF list */}
          <div
            style={{
              padding: '4px 4px 2px',
              fontSize: '10px',
              fontWeight: 700,
              color: 'var(--text-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {t('winlinkReach.hfHeading', {
              defaultValue: 'HF gateways within {{range}} ({{count}})',
              range: formatDistance(rangeKm, units),
              count: reach.rows.length,
            })}
          </div>
          {reach.rows.length === 0 && (
            <div style={{ padding: '8px', color: 'var(--text-muted)', fontSize: '11px' }}>
              {t('winlinkReach.noneInRange', { defaultValue: 'No HF gateways in range. Try a larger range.' })}
            </div>
          )}
          {reach.rows.map((row) => {
            const best = row.best;
            const isOpen = expanded === row.callsign;
            return (
              <div key={row.callsign} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => select(row, best)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      select(row, best);
                    }
                  }}
                  title={
                    canTune
                      ? t('winlinkReach.rowTitleTune', { defaultValue: 'Set as DX and tune the rig' })
                      : t('winlinkReach.rowTitle', { defaultValue: 'Set as DX' })
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '4px',
                    cursor: 'pointer',
                  }}
                >
                  {renderChip(row.status)}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                        {row.callsign}
                      </span>
                      {best && (
                        <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
                          {best.band || ''} {(best.frequency / 1e6).toFixed(3)}{' '}
                          <span style={{ color: winlinkModeColor(best.mode), fontWeight: 600 }}>{best.modeLabel}</span>
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                      {row.bearing}° {compass(row.bearing)} · {formatDistance(row.distanceKm, units)}
                      {row.reliability != null && (
                        <>
                          {' · '}
                          {t('winlinkReach.rel', { defaultValue: '{{rel}}% rel', rel: row.reliability })}
                        </>
                      )}
                      {row.snrMargin != null && (
                        <>
                          {' · '}
                          {t('winlinkReach.margin', {
                            defaultValue: 'SNR {{sign}}{{margin}} dB',
                            sign: row.snrMargin >= 0 ? '+' : '',
                            margin: row.snrMargin,
                          })}
                        </>
                      )}
                      {row.updatedAt && ` · ${utcHHMM(row.updatedAt)}`}
                    </div>
                  </div>
                  {best && renderChannelActions(row.callsign, best)}
                  {row.channels.length > 1 && (
                    <button
                      type="button"
                      style={smallBtn}
                      aria-expanded={isOpen}
                      aria-label={t('winlinkReach.channels', {
                        defaultValue: '{{count}} channels',
                        count: row.channels.length,
                      })}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpanded(isOpen ? null : row.callsign);
                      }}
                    >
                      {isOpen ? '▴' : `▾${row.channels.length}`}
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div style={{ padding: '0 4px 4px 62px' }}>
                    {row.channels.map((c, i) => (
                      <div
                        key={`${c.frequency}-${c.mode}-${i}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          fontSize: '10px',
                          fontFamily: 'var(--font-mono)',
                          padding: '1px 0',
                        }}
                      >
                        <span
                          style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: STATUS_COLORS[c.status],
                            flexShrink: 0,
                          }}
                          title={statusLabel(c.status)}
                        />
                        <span style={{ width: '34px' }}>{c.band || '—'}</span>
                        <span style={{ width: '58px' }}>{(c.frequency / 1e6).toFixed(3)}</span>
                        <span style={{ color: winlinkModeColor(c.mode), flex: 1 }}>{c.modeLabel}</span>
                        <span style={{ width: '34px', textAlign: 'right' }}>
                          {c.reliability != null ? `${c.reliability}%` : '—'}
                        </span>
                        <span style={{ width: '44px', textAlign: 'right' }}>
                          {c.snrMargin != null ? `${c.snrMargin >= 0 ? '+' : ''}${c.snrMargin}` : ''}
                        </span>
                        {renderChannelActions(row.callsign, c)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {reach.truncated > 0 && (
            <div style={{ padding: '4px', fontSize: '10px', color: 'var(--text-muted)' }}>
              {t('winlinkReach.truncated', {
                defaultValue:
                  '{{count}} more gateways in range were not predicted (per-refresh cap). Reduce the range.',
                count: reach.truncated,
              })}
            </div>
          )}

          {/* VHF/UHF */}
          {reach.packet.length > 0 && (
            <>
              <div
                style={{
                  padding: '8px 4px 2px',
                  fontSize: '10px',
                  fontWeight: 700,
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {t('winlinkReach.vhfHeading', {
                  defaultValue: 'VHF/UHF gateways nearby ({{count}})',
                  count: reach.packet.length,
                })}
              </div>
              {reach.packet.slice(0, 25).map((p) => {
                const ch = p.channels[0];
                return (
                  <div
                    key={`pk-${p.callsign}`}
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      select(
                        { lat: p.gateway.lat, lon: p.gateway.lon, callsign: p.callsign },
                        { ...ch, dialHz: ch.frequency },
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        select(
                          { lat: p.gateway.lat, lon: p.gateway.lon, callsign: p.callsign },
                          { ...ch, dialHz: ch.frequency },
                        );
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '4px',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--border-color)',
                    }}
                  >
                    <span
                      style={{
                        minWidth: '52px',
                        fontSize: '9px',
                        color: p.los === 'beyond' ? 'var(--text-muted)' : 'var(--accent-green)',
                        flexShrink: 0,
                      }}
                    >
                      {losLabel(p.los)}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                        {p.callsign}
                      </span>{' '}
                      <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
                        {(ch.frequency / 1e6).toFixed(3)}{' '}
                        <span style={{ color: winlinkModeColor(ch.mode) }}>{ch.modeLabel}</span>
                      </span>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        {p.bearing}° {compass(p.bearing)} · {formatDistance(p.distanceKm, units)}
                      </div>
                    </div>
                    {renderChannelActions(p.callsign, { ...ch, dialHz: ch.frequency })}
                  </div>
                );
              })}
            </>
          )}

          <div style={{ padding: '6px 4px', fontSize: '9px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
            {engineLabel && <div>{engineLabel}</div>}
            {t('winlinkReach.footnote', {
              defaultValue:
                'Reliability is the share of days this hour the path meets the mode’s needed SNR (monthly median model). Good ≥ 50%, Marginal ≥ 20% or within 6 dB. VHF/UHF is by distance only. Click a gateway to set it as DX; with rig control connected it also tunes the dial frequency.',
            })}
          </div>
        </>
      )}
    </div>
  );
}
