/**
 * Winlink Gateways Map Layer Plugin
 *
 * Renders ~4800 Winlink RMS gateways from /api/winlink/gateways on the map.
 * Server-side proxy (server/routes/winlink.js) caches the global list for 1h
 * so this layer is cheap regardless of how many users have it on.
 *
 * Multiple channels per callsign are aggregated into a single marker — popup
 * lists every (frequency, mode) combo. Filters: band group, service code,
 * and mode family.
 *
 * Reachability: while the Winlink panel's Reachable view is on, it
 * broadcasts predicted per-gateway status (WINLINK_REACH_EVENT). The layer
 * then colours markers Good / Marginal / Closed instead of by mode, greys
 * out gateways that were not predicted, and offers a reachability filter.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { esc } from '../../utils/escapeHtml.js';
import { maidenheadToLatLon, replicatePoint } from '../../utils/geo.js';
import { apiFetch } from '../../utils/apiFetch.js';
import {
  WINLINK_MODE_FAMILIES,
  WINLINK_MODE_UNKNOWN_COLOR,
  winlinkModeLabel,
  winlinkModeFamily,
} from '../../utils/winlinkModes.js';
import { STATUS_COLORS, passesReachFilter } from '../../utils/winlinkReach.js';
import { WINLINK_REACH_EVENT, getWinlinkReachSnapshot } from '../../hooks/useWinlinkReach.js';
import i18n from '../../lang/i18n';
import { makeDraggable } from './makeDraggable.js';
import { addMinimizeToggle } from './addMinimizeToggle.js';

export const metadata = {
  id: 'winlink-gateways',
  name: 'plugins.layers.winlinkGateways.name',
  description: 'plugins.layers.winlinkGateways.description',
  icon: '📬',
  category: 'overlay',
  defaultEnabled: false,
  defaultOpacity: 0.85,
  version: '1.0.0',
};

// 1h refresh — matches the server cache TTL so we never poll faster than
// the upstream window. Browser ETag would be nicer, but the proxy already
// returns Cache-Control: public,max-age=300 for 5-minute revalidation.
const REFRESH_MS = 60 * 60 * 1000;

function freqToBandGroup(freqHz) {
  const mhz = freqHz / 1e6;
  if (mhz < 30) return 'hf';
  if (mhz < 300) return 'vhf';
  return 'uhf';
}

// Group raw channel rows into one entry per callsign, preserving the list
// of (freq, mode, hours, baud, service) tuples for the popup.
function aggregateByCallsign(rows) {
  const byCall = new Map();
  for (const r of rows) {
    if (!r.callsign || !r.gridsquare) continue;
    const pos = maidenheadToLatLon(r.gridsquare);
    if (!pos) continue;
    let entry = byCall.get(r.callsign);
    if (!entry) {
      entry = {
        callsign: r.callsign,
        gridsquare: r.gridsquare,
        lat: pos.lat,
        lon: pos.lon,
        channels: [],
      };
      byCall.set(r.callsign, entry);
    }
    entry.channels.push({
      frequency: r.frequency,
      mode: r.mode,
      modeLabel: winlinkModeLabel(r.mode),
      hours: r.hours,
      baud: r.baud,
      serviceCode: r.serviceCode || 'PUBLIC',
    });
  }
  return [...byCall.values()];
}

const REACH_LEGEND = [
  ['good', 'winlinkReach.status.good', 'Good'],
  ['marginal', 'winlinkReach.status.marginal', 'Marginal'],
  ['closed', 'winlinkReach.status.closed', 'Closed'],
  ['unknown', 'winlinkReach.layer.notPredicted', 'Not predicted'],
];

const LOS_STATUS = { los: 'good', extended: 'marginal', beyond: 'closed' };

/** Marker colour for a gateway under reachability colouring. */
function reachColor(entry) {
  if (!entry) return STATUS_COLORS.unknown;
  if (entry.kind === 'packet') return STATUS_COLORS[LOS_STATUS[entry.los] || 'unknown'];
  return STATUS_COLORS[entry.status] || STATUS_COLORS.unknown;
}

function reachLine(entry) {
  if (!entry) return '';
  if (entry.kind === 'packet') {
    const label = {
      los: i18n.t('winlinkReach.los.los', { defaultValue: 'Line of sight' }),
      extended: i18n.t('winlinkReach.los.extended', { defaultValue: 'Needs height / good antenna' }),
      beyond: i18n.t('winlinkReach.los.beyond', { defaultValue: 'Beyond line of sight' }),
    }[entry.los];
    return label
      ? `<div style="margin-bottom:4px;color:${reachColor(entry)};font-weight:600;">${esc(label)}</div>`
      : '';
  }
  const status = {
    good: i18n.t('winlinkReach.status.good', { defaultValue: 'Good' }),
    marginal: i18n.t('winlinkReach.status.marginal', { defaultValue: 'Marginal' }),
    closed: i18n.t('winlinkReach.status.closed', { defaultValue: 'Closed' }),
  }[entry.status];
  if (!status) return '';
  const rel = Number.isFinite(entry.reliability) ? ` · ${entry.reliability}%` : '';
  const snr = Number.isFinite(entry.snrMargin) ? ` · ${entry.snrMargin >= 0 ? '+' : ''}${entry.snrMargin} dB` : '';
  const where = entry.freqHz ? ` · ${(entry.freqHz / 1e6).toFixed(3)} ${entry.modeLabel || ''}` : '';
  return `<div style="margin-bottom:4px;color:${reachColor(entry)};font-weight:600;">${esc(status + rel + snr + where)}</div>`;
}

function popupHtml(gw, reachEntry = null) {
  const rows = gw.channels
    .slice() // don't mutate
    .sort((a, b) => a.frequency - b.frequency)
    .map((c) => {
      const fam = winlinkModeFamily(c.mode);
      const color = fam ? fam.color : WINLINK_MODE_UNKNOWN_COLOR;
      const mhz = (c.frequency / 1e6).toFixed(3);
      return `
        <tr>
          <td style="padding:1px 6px 1px 0;color:var(--text-secondary);">${esc(mhz)}</td>
          <td style="padding:1px 6px 1px 0;color:${color};font-weight:600;">${esc(c.modeLabel)}</td>
          <td style="padding:1px 0;color:var(--text-muted);font-size:9px;">${esc(c.serviceCode)}</td>
        </tr>`;
    })
    .join('');

  // Pull a representative hours/baud — same operator usually publishes the same
  // OperatingHours across channels, no point repeating it per row.
  const hours = gw.channels[0]?.hours;
  const services = [...new Set(gw.channels.map((c) => c.serviceCode))].join(' / ');

  return `
    <div style="font-family:var(--font-mono);font-size:11px;min-width:200px;">
      <div style="font-weight:700;font-size:13px;margin-bottom:2px;">${esc(gw.callsign)}</div>
      <div style="color:var(--text-muted);font-size:10px;margin-bottom:6px;">Grid ${esc(gw.gridsquare)} • ${esc(services)}${hours ? ` • ${esc(hours)} UTC` : ''}</div>
      ${reachLine(reachEntry)}
      <table style="border-collapse:collapse;font-size:10px;">${rows}</table>
      <div style="font-size:9px;color:var(--text-muted);margin-top:6px;padding-top:4px;border-top:1px solid var(--border-color);">${gw.channels.length} channel${gw.channels.length === 1 ? '' : 's'}</div>
    </div>`;
}

export function useLayer({ enabled = false, opacity = 0.85, map = null }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [bandFilter, setBandFilter] = useState('all');
  const [serviceFilter, setServiceFilter] = useState('all');
  const [familyFilter, setFamilyFilter] = useState('all');
  const [reachFilter, setReachFilter] = useState('all');
  const [reach, setReach] = useState(getWinlinkReachSnapshot);

  const layersRef = useRef([]);
  const controlRef = useRef(null);

  // State refs so the render effect always reads current values
  const bandFilterRef = useRef(bandFilter);
  const serviceFilterRef = useRef(serviceFilter);
  const familyFilterRef = useRef(familyFilter);
  const reachFilterRef = useRef(reachFilter);
  reachFilterRef.current = reachFilter;
  bandFilterRef.current = bandFilter;
  serviceFilterRef.current = serviceFilter;
  familyFilterRef.current = familyFilter;

  // Fetch the full gateway list on enable, refresh hourly while enabled.
  // The server proxy caches for 1h so this is essentially free.
  const fetchGateways = useCallback(async () => {
    try {
      const res = await apiFetch('/api/winlink/gateways');
      if (!res) return;
      if (res.status === 503) {
        setError('winlinkLayer.noServerKey');
        return;
      }
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setRows(Array.isArray(data.gateways) ? data.gateways : []);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    fetchGateways();
    const id = setInterval(fetchGateways, REFRESH_MS);
    return () => clearInterval(id);
  }, [enabled, fetchGateways]);

  // Predicted reachability from the Winlink panel's Reachable view.
  useEffect(() => {
    const onReach = (e) => setReach(e.detail || { enabled: false });
    window.addEventListener(WINLINK_REACH_EVENT, onReach);
    return () => window.removeEventListener(WINLINK_REACH_EVENT, onReach);
  }, []);

  // Broadcast the aggregated gateway list (callsign + lat/lon + channels) to
  // the text view panel (#1002). Rows change hourly at most.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('mapdata:winlink', {
        detail: enabled ? { enabled: true, gateways: aggregateByCallsign(rows) } : { enabled: false },
      }),
    );
  }, [enabled, rows]);
  useEffect(() => () => window.dispatchEvent(new CustomEvent('mapdata:winlink', { detail: { enabled: false } })), []);

  // Render markers
  useEffect(() => {
    if (!map || typeof L === 'undefined') return;

    layersRef.current.forEach((l) => {
      try {
        map.removeLayer(l);
      } catch (_) {}
    });
    layersRef.current = [];

    if (!enabled || rows.length === 0) return;

    const gateways = aggregateByCallsign(rows);
    const bf = bandFilterRef.current;
    const sf = serviceFilterRef.current;
    const ff = familyFilterRef.current;
    const reachOn = !!reach?.enabled;
    const byCall = reachOn ? reach.byCall || {} : null;
    const rf = reachOn ? reachFilterRef.current : 'all';

    const visible = gateways.filter((gw) => {
      if (rf !== 'all' && !passesReachFilter(byCall[gw.callsign], rf)) return false;
      const channels = gw.channels.filter((c) => {
        if (bf !== 'all' && freqToBandGroup(c.frequency) !== bf) return false;
        if (sf !== 'all' && c.serviceCode !== sf) return false;
        if (ff !== 'all') {
          const fam = winlinkModeFamily(c.mode);
          if (!fam || fam.id !== ff) return false;
        }
        return true;
      });
      if (channels.length === 0) return false;
      // Replace the channels array with the filtered subset for popup display
      gw.visibleChannels = channels;
      return true;
    });

    // L.layerGroup batches DOM ops so adding ~3-4k markers stays smooth.
    const group = L.layerGroup();

    visible.forEach((gw) => {
      // Color by the dominant family among visible channels — pick the
      // first family that has a visible channel so it's deterministic.
      const channelsForColor = gw.visibleChannels || gw.channels;
      const fam = winlinkModeFamily(channelsForColor[0]?.mode);
      const reachEntry = byCall ? byCall[gw.callsign] : null;
      // Under reachability colouring, gateways that were not predicted (out
      // of range / over the cap) shrink to grey dots so the ones that matter stand out.
      const color = byCall ? reachColor(reachEntry) : fam ? fam.color : WINLINK_MODE_UNKNOWN_COLOR;
      const dim = byCall && !reachEntry;

      replicatePoint(gw.lat, gw.lon).forEach(([lat, lon]) => {
        const marker = L.circleMarker([lat, lon], {
          radius: dim ? 3 : byCall ? 5 : 4,
          fillColor: color,
          color: '#000',
          weight: 0.5,
          opacity: dim ? opacity * 0.5 : opacity,
          fillOpacity: dim ? opacity * 0.35 : opacity * 0.85,
        });
        marker.bindPopup(popupHtml({ ...gw, channels: channelsForColor }, reachEntry));
        group.addLayer(marker);
      });
    });

    group.addTo(map);
    layersRef.current.push(group);
  }, [map, enabled, rows, opacity, bandFilter, serviceFilter, familyFilter, reach, reachFilter]);

  // Control panel
  useEffect(() => {
    if (!enabled || !map || controlRef.current) return;

    const Control = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const wrapper = L.DomUtil.create('div', 'panel-wrapper');
        const div = L.DomUtil.create('div', 'winlink-layer-control', wrapper);
        div.style.minWidth = '210px';
        div.innerHTML = `
          <div class="floating-panel-header">📬 Winlink Gateways</div>
          <div id="winlink-stats" style="
            font-family:var(--font-mono);
            font-size:11px;color:var(--text-secondary);
            margin-bottom:8px;
          ">Loading…</div>
          <div style="margin-bottom:6px;">
            <label style="font-size:11px;">Band:</label>
            <select id="winlink-band" style="width:100%;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-color);padding:3px;font-size:11px;">
              <option value="all">All bands</option>
              <option value="hf">HF (&lt; 30 MHz)</option>
              <option value="vhf">VHF (30–300 MHz)</option>
              <option value="uhf">UHF (&gt; 300 MHz)</option>
            </select>
          </div>
          <div style="margin-bottom:6px;">
            <label style="font-size:11px;">Service:</label>
            <select id="winlink-service" style="width:100%;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-color);padding:3px;font-size:11px;">
              <option value="all">All services</option>
              <option value="PUBLIC">PUBLIC</option>
              <option value="EMCOMM">EMCOMM</option>
              <option value="MARS">MARS</option>
            </select>
          </div>
          <div style="margin-bottom:6px;">
            <label style="font-size:11px;">Mode:</label>
            <select id="winlink-mode" style="width:100%;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-color);padding:3px;font-size:11px;">
              <option value="all">All modes</option>
              ${WINLINK_MODE_FAMILIES.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}
            </select>
          </div>
          <div style="margin-bottom:6px;">
            <label style="font-size:11px;">${esc(i18n.t('winlinkReach.layer.label', { defaultValue: 'Reachability:' }))}</label>
            <select id="winlink-reach" style="width:100%;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-color);padding:3px;font-size:11px;">
              <option value="all">${esc(i18n.t('winlinkReach.layer.all', { defaultValue: 'All gateways' }))}</option>
              <option value="reachable">${esc(i18n.t('winlinkReach.layer.reachable', { defaultValue: 'Predicted reachable' }))}</option>
              <option value="good">${esc(i18n.t('winlinkReach.layer.good', { defaultValue: 'Good only' }))}</option>
            </select>
            <div id="winlink-reach-hint" style="font-size:9px;color:var(--text-muted);margin-top:3px;"></div>
          </div>
          <div id="winlink-legend-mode" style="font-size:9px;color:var(--text-muted);padding-top:6px;border-top:1px solid var(--border-color);display:flex;flex-wrap:wrap;gap:4px;">
            ${WINLINK_MODE_FAMILIES.map((f) => `<span style="display:inline-flex;align-items:center;gap:3px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${f.color};"></span>${f.label}</span>`).join('')}
          </div>
          <div id="winlink-legend-reach" style="font-size:9px;color:var(--text-muted);padding-top:6px;border-top:1px solid var(--border-color);display:none;flex-wrap:wrap;gap:4px;">
            ${REACH_LEGEND.map(
              ([st, key, fallback]) =>
                `<span style="display:inline-flex;align-items:center;gap:3px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${STATUS_COLORS[st]};"></span>${esc(i18n.t(key, { defaultValue: fallback }))}</span>`,
            ).join('')}
          </div>`;

        const bandSel = div.querySelector('#winlink-band');
        const svcSel = div.querySelector('#winlink-service');
        const modeSel = div.querySelector('#winlink-mode');
        const reachSel = div.querySelector('#winlink-reach');

        if (bandSel) {
          bandSel.value = bandFilterRef.current;
          bandSel.addEventListener('change', (e) => setBandFilter(e.target.value));
        }
        if (svcSel) {
          svcSel.value = serviceFilterRef.current;
          svcSel.addEventListener('change', (e) => setServiceFilter(e.target.value));
        }
        if (modeSel) {
          modeSel.value = familyFilterRef.current;
          modeSel.addEventListener('change', (e) => setFamilyFilter(e.target.value));
        }
        if (reachSel) {
          reachSel.value = reachFilterRef.current;
          reachSel.addEventListener('change', (e) => setReachFilter(e.target.value));
        }

        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        return wrapper;
      },
    });

    const control = new Control();
    map.addControl(control);
    controlRef.current = control;

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const container = controlRef.current?.getContainer()?.querySelector('.winlink-layer-control');
        if (!container) return;
        const saved = localStorage.getItem('winlink-gateways-panel-position');
        if (saved) {
          try {
            const { top, left } = JSON.parse(saved);
            container.style.position = 'fixed';
            container.style.top = top + 'px';
            container.style.left = left + 'px';
            container.style.right = 'auto';
            container.style.bottom = 'auto';
          } catch (_) {}
        }
        makeDraggable(container, 'winlink-gateways-panel-position', { snap: 5 });
        addMinimizeToggle(container, 'winlink-gateways-panel-position', {
          contentClassName: 'winlink-panel-content',
          buttonClassName: 'winlink-minimize-btn',
        });
      }),
    );

    return () => {
      if (controlRef.current) {
        map.removeControl(controlRef.current);
        controlRef.current = null;
      }
    };
  }, [map, enabled]);

  // Reachability hint + legend swap — follows the Reachable view's broadcasts.
  useEffect(() => {
    if (!enabled || !controlRef.current) return;
    const root = controlRef.current.getContainer();
    if (!root) return;
    const on = !!reach?.enabled;
    const hint = root.querySelector('#winlink-reach-hint');
    const sel = root.querySelector('#winlink-reach');
    const modeLegend = root.querySelector('#winlink-legend-mode');
    const reachLegend = root.querySelector('#winlink-legend-reach');
    if (sel) sel.disabled = !on;
    if (hint) {
      hint.textContent = on
        ? i18n.t('winlinkReach.layer.on', {
            defaultValue: 'Coloured by predicted reachability for {{hour}}:00z',
            hour: String(reach.hour ?? '--').padStart(2, '0'),
          })
        : i18n.t('winlinkReach.layer.off', {
            defaultValue: "Open the Winlink panel's Reachable view to colour gateways by predicted reachability.",
          });
    }
    if (modeLegend) modeLegend.style.display = on ? 'none' : 'flex';
    if (reachLegend) reachLegend.style.display = on ? 'flex' : 'none';
  }, [enabled, reach]);

  // Stats line — updates whenever rows change
  useEffect(() => {
    if (!enabled || !controlRef.current) return;
    const el = controlRef.current.getContainer()?.querySelector('#winlink-stats');
    if (!el) return;
    if (error) {
      el.textContent = error === 'winlinkLayer.noServerKey' ? 'Server has no API key' : `Error: ${error}`;
      el.style.color = 'var(--accent-amber)';
      return;
    }
    if (rows.length === 0) {
      el.textContent = 'Loading…';
      el.style.color = 'var(--text-muted)';
      return;
    }
    const callsigns = new Set(rows.map((r) => r.callsign)).size;
    el.textContent = `${callsigns} gateways • ${rows.length} channels`;
    el.style.color = 'var(--text-secondary)';
  }, [enabled, rows, error]);

  // Cleanup on disable
  useEffect(() => {
    if (enabled) return;
    layersRef.current.forEach((l) => {
      try {
        map?.removeLayer(l);
      } catch (_) {}
    });
    layersRef.current = [];
    if (controlRef.current) {
      map?.removeControl(controlRef.current);
      controlRef.current = null;
    }
  }, [enabled, map]);

  return null;
}
