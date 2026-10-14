/**
 * buildPanelDefs — the dockable layout's panel registry.
 *
 * Extracted from DockableApp so the panel list has one home shared by:
 *   • DockableApp — the ＋ panel picker and the flexlayout tab factory
 *   • CommandPalette — "add/focus panel" entries (dockable layout only)
 *
 * Keys are the flexlayout component ids (see also utils/helpTopics.js
 * PANEL_HELP). Auto-discovered panel plugins are appended; built-in ids are
 * passed to the plugin registry so a plugin can never shadow a built-in.
 */
import { getPanelPlugins } from './plugins/panelRegistry.js';

export function buildPanelDefs({ isLocalInstall = false } = {}) {
  // Only show Ambient Weather when credentials are configured
  const hasAmbient = (() => {
    try {
      return !!(import.meta.env?.VITE_AMBIENT_API_KEY && import.meta.env?.VITE_AMBIENT_APPLICATION_KEY);
    } catch {
      return false;
    }
  })();

  const defs = {
    'world-map': { name: 'World Map', icon: '🗺️' },
    'map-list-view': { name: 'Map Data (text view)', icon: '👁️‍🗨️' },
    'de-location': { name: 'DE Location', icon: '📍' },
    'dx-location': { name: 'DX Target', icon: '🎯' },
    'analog-clock': { name: 'Analog Clock', icon: '🕐' },
    solar: { name: 'Solar (all views)', icon: '☀️' },
    'solar-image': { name: 'Solar Image', icon: '☀️', group: 'Solar' },
    'solar-indices': { name: 'Solar Indices', icon: '📊', group: 'Solar' },
    'solar-xray': { name: 'X-Ray Flux', icon: '⚡', group: 'Solar' },
    lunar: { name: 'Lunar Phase', icon: '🌙', group: 'Solar' },
    propagation: { name: 'Propagation (all views)', icon: '📡' },
    'propagation-chart': { name: 'VOACAP Chart', icon: '📈', group: 'Propagation' },
    'propagation-bars': { name: 'VOACAP Bars', icon: '📊', group: 'Propagation' },
    'band-conditions': { name: 'Band Conditions', icon: '📶', group: 'Propagation' },
    'band-health': { name: 'Band Health', icon: '📶' },
    'band-activity': { name: 'Band Activity (Continent)', icon: '🔥' },
    'psk-bands': { name: 'Band Activity (PSKR)', icon: '📡' },
    ibp: { name: 'IBP Beacons', icon: '📡', group: 'Propagation' },
    'sked-planner': { name: 'Sked Planner', icon: '🤝', group: 'Propagation' },
    ionosonde: { name: 'Ionosondes', icon: '📡', group: 'Propagation' },
    'prop-verify': { name: 'Prediction Check', icon: '🎯', group: 'Propagation' },
    'dx-cluster': { name: 'DX Cluster', icon: '📻' },
    logbook: { name: 'Logbook', icon: '📓' },
    awards: { name: 'Awards', icon: '🏆' },
    'psk-reporter': { name: 'PSK Reporter', icon: '📡' },
    dxpeditions: { name: 'DXpeditions', icon: '🏝️' },
    pota: { name: 'POTA', icon: '▲', iconColor: '#44cc44' },
    wwff: { name: 'WWFF', icon: '▼', iconColor: '#a3f3a3' },
    sota: { name: 'SOTA', icon: '◆', iconColor: '#ff9632' },
    wwbota: { name: 'WWBOTA', icon: '■', iconColor: '#8b7fff' },
    aprs: { name: 'APRS', icon: '📍' },
    'aprs-telemetry': { name: 'APRS Telemetry', icon: '📊' },
    ...(isLocalInstall ? { rotator: { name: 'Rotator', icon: '🧭' } } : {}),
    contests: { name: 'Contests', icon: '🏆' },
    'swpc-alerts': { name: 'Space Wx Alerts', icon: '🚨' },
    'meteor-showers': { name: 'Meteor Showers', icon: '☄️' },
    ...(hasAmbient ? { ambient: { name: 'Ambient Weather', icon: '🌦️' } } : {}),
    'rig-control': { name: 'Rig Control', icon: '📻' },
    'freq-memories': { name: 'Frequencies', icon: '📻' },
    'net-schedule': { name: 'Nets', icon: '🕐' },
    'callsign-search': { name: 'Callsign Lookup', icon: '🔎' },
    'dx-news': { name: 'DX News', icon: '📰' },
    'solar-cycle': { name: 'Solar Cycle', icon: '📈' },
    'log-stats': { name: 'Log Stats', icon: '📊' },
    'on-air': { name: 'On Air', icon: '🔴' },
    'id-timer': { name: 'ID Timer', icon: '📢' },
    image: { name: 'Custom Image', icon: '🖼️' },
    keybindings: { name: 'Keyboard Shortcuts', icon: '⌨️' },
    meshtastic: { name: 'Meshtastic', icon: '📡' },
    meshcom: { name: 'MeshCom', icon: '🔗' },
    'digital-modes': { name: 'Digital Modes', icon: '📻', group: 'Rig Bridge' },
    winlink: { name: 'Winlink', icon: '📬', group: 'Rig Bridge' },
    'sat-passes': { name: 'Satellite Passes', icon: '🛰️' },
    'amsat-status': { name: 'AMSAT Status', icon: '🛰️' },
    'sun-moon': { name: 'Sun & Moon', icon: '🌗', group: 'Solar' },
    'swpc-trends': { name: 'Space Wx Trends', icon: '📉', group: 'Solar' },
    'rbn-mine': { name: 'My Signal (RBN)', icon: '📶', group: 'Propagation' },
    'wspr-mine': { name: 'WSPR My Spots', icon: '📡', group: 'Propagation' },
    'pota-activator': { name: 'POTA Activator', icon: '▲', iconColor: '#44cc44' },
    repeaters: { name: 'Repeaters', icon: '🗼' },
    'world-clocks': { name: 'World Clocks', icon: '🌐' },
    stopwatch: { name: 'Stopwatch', icon: '⏱️' },
    'aircraft-nearby': { name: 'Aircraft Nearby', icon: '✈️' },
    'grayline-planner': { name: 'Grayline Planner', icon: '🌅', group: 'Propagation' },
    'eme-planner': { name: 'EME Planner', icon: '🌙', group: 'Solar' },
    'sat-planner': { name: 'Satellite Planner', icon: '🛰️' },
  };

  // Append auto-discovered panel plugins (src/plugins/local/panels/*.jsx).
  // Built-in ids are passed so a plugin can never shadow a built-in panel.
  for (const plugin of getPanelPlugins(new Set(Object.keys(defs)))) {
    defs[plugin.id] = { name: plugin.name, icon: plugin.icon, group: 'Plugins' };
  }

  return defs;
}

export default buildPanelDefs;
