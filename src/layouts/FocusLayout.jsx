/**
 * FocusLayout — four purpose-built layouts sharing one chassis:
 * header, a dominant map, and a focus-specific panel rail.
 *
 *   activator  — POTA/SOTA in the field: self-spot, activations, RBN, repeaters
 *   hunter     — chasing activators: cluster, activations, sun & moon
 *   weather    — wx radar, lightning, hazards, aurora + space weather panels
 *   airtraffic — aircraft + ATC sectors over a big map, world clocks
 *
 * Entering a focus layout applies its layer preset once: `mapLayers`
 * toggles (spot markers, paths…) plus plugin map layers via the
 * window.hamclockLayerControls bridge WorldMap registers after mount.
 * Changes the user makes afterwards stick until the layout is re-entered —
 * re-picking the layout IS the "give me the standard view again" gesture.
 */
import { useEffect, useRef } from 'react';
import {
  Header,
  WorldMap,
  DXClusterPanel,
  PotaSotaPanel,
  WeatherPanel,
  SWPCAlertsPanel,
  POTAActivatorPanel,
  RBNMySignalPanel,
  RepeatersPanel,
  WorldClockPanel,
  SunMoonPanel,
  SpaceWxTrendsPanel,
  StopwatchPanel,
  AircraftNearbyPanel,
} from '../components';
import { useRig } from '../contexts/RigContext.jsx';
import { findDXPathForSpot } from '../utils/dxClusterSpotMatcher';
import useBreakpoint from '../hooks/app/useBreakpoint';

export const FOCUS_LAYOUT_IDS = ['activator', 'hunter', 'weather', 'airtraffic'];

// Per-focus presets. mapLayers: desired state for App-level toggles.
// pluginLayers: desired state for layer-registry layers (bridge ids).
const SPECS = {
  activator: {
    title: 'ACTIVATOR',
    accent: '#44cc44',
    panels: ['activator-spot', 'activations', 'rbn-mine', 'repeaters'],
    mapLayers: { showPOTA: true, showSOTA: true, showWWFF: true, showDeDxMarkers: true },
    pluginLayers: {},
  },
  hunter: {
    title: 'HUNTER',
    accent: 'var(--accent-amber)',
    panels: ['dx-cluster', 'activations', 'sun-moon'],
    mapLayers: { showPOTA: true, showSOTA: true, showWWFF: true, showDXPaths: true },
    pluginLayers: { grayline: true },
  },
  weather: {
    title: 'WEATHER',
    accent: 'var(--accent-cyan)',
    bareMap: true, // weather / geological / hazards only — no ham traffic
    panels: ['de-weather', 'swpc-alerts', 'swpc-trends'],
    mapLayers: {
      showPOTA: false,
      showSOTA: false,
      showWWFF: false,
      showWWBOTA: false,
      showDXPaths: false,
      showPSKReporter: false,
      showWSJTX: false,
    },
    pluginLayers: {
      wxradar: true,
      lightning: true,
      earthquakes: true,
      wildfires: true,
      floods: true,
      'tornado-warnings': true,
      aurora: true,
    },
  },
  airtraffic: {
    title: 'AIR TRAFFIC',
    accent: 'var(--accent-blue)',
    bareMap: true, // aviation only — no ham traffic
    panels: ['aircraft-nearby', 'world-clocks', 'de-weather'],
    mapLayers: {
      showPOTA: false,
      showSOTA: false,
      showWWFF: false,
      showWWBOTA: false,
      showDXPaths: false,
      showPSKReporter: false,
      showSatellites: false,
      showWSJTX: false,
    },
    pluginLayers: { aircraft: true, 'atc-sectors': true },
  },
};

export default function FocusLayout(props) {
  const {
    focus,
    config,
    t,
    utcTime,
    utcDate,
    localTime,
    localDate,
    localWeather,
    localAlerts,
    spaceWeather,
    solarIndices,
    bandConditions,
    use12Hour,
    handleTimeFormatToggle,
    setShowSettings,
    handleUpdateClick,
    handleFullscreenToggle,
    isFullscreen,
    updateInProgress,
    isLocalInstall,
    dxLocation,
    dxLocked,
    handleDXChange,
    dxClusterData,
    potaSpots,
    filteredPotaSpots,
    wwffSpots,
    filteredWwffSpots,
    sotaSpots,
    filteredSotaSpots,
    wwbotaSpots,
    filteredWwbotaSpots,
    mySpots,
    swpcAlerts,
    filteredPskSpots,
    wsjtxMapSpots,
    dxFilters,
    setDxFilters,
    mapBandFilter,
    setMapBandFilter,
    pskFilters,
    setShowDXFilters,
    setShowPotaFilters,
    setShowSotaFilters,
    setShowWwffFilters,
    setShowWwbotaFilters,
    potaFilters,
    sotaFilters,
    wwffFilters,
    wwbotaFilters,
    mapLayers,
    toggleDeDxMarkers,
    toggleDXPaths,
    toggleDXLabels,
    togglePOTA,
    togglePOTALabels,
    toggleWWFF,
    toggleWWFFLabels,
    toggleSOTA,
    toggleSOTALabels,
    toggleWWBOTA,
    toggleWWBOTALabels,
    toggleSatellites,
    togglePSKReporter,
    toggleWSJTX,
    hoveredSpot,
    setHoveredSpot,
    filteredSatellites,
  } = props;

  const spec = SPECS[focus] || SPECS.activator;
  const bareMap = !!spec.bareMap;
  const { tuneTo } = useRig();
  const { breakpoint } = useBreakpoint();
  const isNarrow = breakpoint !== 'desktop';

  // ── Focus layer presets: full reset semantics ───────────────────────────
  // Entering the first focus layout snapshots the user's layer state (the
  // "baseline"). Every focus layout then applies its preset EXHAUSTIVELY:
  // declared plugin layers on, every other plugin layer off, declared
  // mapLayers flags as specified and undeclared ones back to baseline —
  // so each focus layout always looks the same regardless of what was on
  // before. Leaving the focus layouts (or switching between them, which
  // restores and immediately re-applies) puts the baseline back, so
  // Modern/Classic/Dockable return exactly as the user left them.
  const mapLayerToggles = {
    showDeDxMarkers: toggleDeDxMarkers,
    showDXPaths: toggleDXPaths,
    showPOTA: togglePOTA,
    showWWFF: toggleWWFF,
    showSOTA: toggleSOTA,
    showWWBOTA: toggleWWBOTA,
    showSatellites: toggleSatellites,
    showPSKReporter: togglePSKReporter,
    showWSJTX: toggleWSJTX,
  };
  const MANAGED_MAP_FLAGS = Object.keys(mapLayerToggles);
  // Refs so the cleanup sees live values, not the ones from effect setup
  const mapLayersRef = useRef(mapLayers);
  mapLayersRef.current = mapLayers;
  const togglesRef = useRef(mapLayerToggles);
  togglesRef.current = mapLayerToggles;

  useEffect(() => {
    const BASELINE_KEY = 'ohc_focus_layer_baseline';
    const readJson = (key) => {
      try {
        return JSON.parse(localStorage.getItem(key) || 'null');
      } catch {
        return null;
      }
    };

    // 1. Capture the baseline once, on first entry into the focus world
    let baseline = readJson(BASELINE_KEY);
    if (!baseline) {
      const settings = readJson('openhamclock_mapSettings') || {};
      baseline = {
        mapLayers: Object.fromEntries(MANAGED_MAP_FLAGS.map((k) => [k, !!mapLayersRef.current[k]])),
        pluginLayers: settings.layers || {},
      };
      try {
        localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
      } catch {}
    }

    // 2. App-level flags: spec wins, undeclared flags return to baseline
    for (const key of MANAGED_MAP_FLAGS) {
      const want = key in spec.mapLayers ? spec.mapLayers[key] : !!baseline.mapLayers[key];
      if (!!mapLayersRef.current[key] !== want) togglesRef.current[key]?.();
    }

    // 3. Plugin layers, exhaustively: declared ids on, everything else off.
    // ('satellites' is governed by showSatellites above, so it is left
    // alone here.) The bridge appears once WorldMap mounts — retry briefly.
    let tries = 0;
    const id = setInterval(() => {
      const ctl = window.hamclockLayerControls;
      if (!ctl?.layers?.length) {
        if (++tries > 20) clearInterval(id);
        return;
      }
      for (const layer of ctl.layers) {
        if (layer.id === 'satellites') continue;
        const want = !!spec.pluginLayers[layer.id];
        if (layer.enabled !== want) ctl.toggleLayer(layer.id, want);
      }
      clearInterval(id);
    }, 500);

    return () => {
      clearInterval(id);
      // Restore the baseline. On focus→focus the next effect run re-captures
      // (identical) and re-applies its own preset; on focus→normal-layout the
      // user's own layer state is back. Storage writes matter even without a
      // live bridge — the next WorldMap mount reads them.
      const b = readJson(BASELINE_KEY);
      if (!b) return;
      for (const key of MANAGED_MAP_FLAGS) {
        if (!!mapLayersRef.current[key] !== !!b.mapLayers[key]) togglesRef.current[key]?.();
      }
      const ctl = window.hamclockLayerControls;
      if (ctl?.layers?.length) {
        for (const layer of ctl.layers) {
          if (layer.id === 'satellites') continue;
          const want = !!(b.pluginLayers[layer.id]?.enabled ?? layer.defaultEnabled);
          if (layer.enabled !== want) ctl.toggleLayer(layer.id, want);
        }
      } else {
        const settings = readJson('openhamclock_mapSettings') || {};
        settings.layers = b.pluginLayers;
        try {
          localStorage.setItem('openhamclock_mapSettings', JSON.stringify(settings));
        } catch {}
      }
      try {
        localStorage.removeItem(BASELINE_KEY);
      } catch {}
    };
    // Intentionally keyed on the focus only — this is an entry action, not sync
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const handleParkSpotClick = (spot) => {
    tuneTo(spot);
    if (spot.lat != null && spot.lon != null) {
      handleDXChange({ lat: spot.lat, lon: spot.lon, callsign: spot.call ?? null });
    }
  };
  const handleDXSpotClick = (spot) => {
    tuneTo(spot);
    const path = findDXPathForSpot(dxClusterData.paths || [], spot);
    if (path && path.dxLat != null && path.dxLon != null) {
      handleDXChange({ lat: path.dxLat, lon: path.dxLon, callsign: spot.call ?? spot.dxCall ?? null });
    }
  };

  // ── Panel builders (keyed by spec.panels ids) ───────────────────────────
  const panelEl = (id) => {
    switch (id) {
      case 'activator-spot':
        return <POTAActivatorPanel config={config} />;
      case 'rbn-mine':
        return <RBNMySignalPanel config={config} />;
      case 'repeaters':
        return <RepeatersPanel config={config} />;
      case 'world-clocks':
        return <WorldClockPanel />;
      case 'sun-moon':
        return <SunMoonPanel deLocation={config.location} dxLocation={dxLocation} />;
      case 'swpc-trends':
        return <SpaceWxTrendsPanel />;
      case 'stopwatch':
        return <StopwatchPanel />;
      case 'aircraft-nearby':
        return <AircraftNearbyPanel config={config} />;
      case 'swpc-alerts':
        return <SWPCAlertsPanel data={swpcAlerts?.data} loading={swpcAlerts?.loading} error={swpcAlerts?.error} />;
      case 'de-weather':
        return (
          <div className="panel" style={{ padding: '10px' }}>
            <div style={{ fontSize: '12px', color: 'var(--accent-cyan)', fontWeight: 700, marginBottom: '6px' }}>
              {t('app.dxLocation.deTitle')}
            </div>
            <WeatherPanel weatherData={localWeather} allUnits={config.allUnits} alerts={localAlerts} />
          </div>
        );
      case 'dx-cluster':
        return (
          <DXClusterPanel
            data={dxClusterData.spots}
            loading={dxClusterData.loading}
            error={dxClusterData.error}
            totalSpots={dxClusterData.totalSpots}
            filters={dxFilters}
            onFilterChange={setDxFilters}
            onOpenFilters={() => setShowDXFilters(true)}
            onHoverSpot={setHoveredSpot}
            onSpotClick={handleDXSpotClick}
            hoveredSpot={bareMap ? null : hoveredSpot}
            showOnMap={mapLayers.showDXPaths}
            onToggleMap={toggleDXPaths}
            userCallsign={config.callsign}
            deLat={config.location?.lat}
            deLon={config.location?.lon}
          />
        );
      case 'activations':
        return (
          <PotaSotaPanel
            potaData={potaSpots.data}
            potaLoading={potaSpots.loading}
            potaLastUpdated={potaSpots.lastUpdated}
            potaLastChecked={potaSpots.lastChecked}
            showPOTA={mapLayers.showPOTA}
            onTogglePOTA={togglePOTA}
            showPOTALabels={mapLayers.showPOTALabels}
            togglePOTALabels={togglePOTALabels}
            onPOTASpotClick={handleParkSpotClick}
            onPOTAHoverSpot={setHoveredSpot}
            potaFilters={potaFilters}
            setShowPotaFilters={setShowPotaFilters}
            filteredPotaSpots={filteredPotaSpots}
            sotaData={sotaSpots.data}
            sotaLoading={sotaSpots.loading}
            sotaLastUpdated={sotaSpots.lastUpdated}
            sotaLastChecked={sotaSpots.lastChecked}
            showSOTA={mapLayers.showSOTA}
            onToggleSOTA={toggleSOTA}
            showSOTALabels={mapLayers.showSOTALabels}
            toggleSOTALabels={toggleSOTALabels}
            onSOTASpotClick={handleParkSpotClick}
            onSOTAHoverSpot={setHoveredSpot}
            sotaFilters={sotaFilters}
            setShowSotaFilters={setShowSotaFilters}
            filteredSotaSpots={filteredSotaSpots}
            wwffData={wwffSpots.data}
            wwffLoading={wwffSpots.loading}
            wwffLastUpdated={wwffSpots.lastUpdated}
            wwffLastChecked={wwffSpots.lastChecked}
            showWWFF={mapLayers.showWWFF}
            onToggleWWFF={toggleWWFF}
            showWWFFLabels={mapLayers.showWWFFLabels}
            toggleWWFFLabels={toggleWWFFLabels}
            onWWFFSpotClick={handleParkSpotClick}
            onWWFFHoverSpot={setHoveredSpot}
            wwffFilters={wwffFilters}
            setShowWwffFilters={setShowWwffFilters}
            filteredWwffSpots={filteredWwffSpots}
            wwbotaData={wwbotaSpots.data}
            wwbotaLoading={wwbotaSpots.loading}
            wwbotaLastUpdated={wwbotaSpots.lastUpdated}
            wwbotaConnected={wwbotaSpots.connected}
            showWWBOTA={mapLayers.showWWBOTA}
            onToggleWWBOTA={toggleWWBOTA}
            showWWBOTALabels={mapLayers.showWWBOTALabels}
            toggleWWBOTALabels={toggleWWBOTALabels}
            onWWBOTASpotClick={handleParkSpotClick}
            onWWBOTAHoverSpot={setHoveredSpot}
            wwbotaFilters={wwbotaFilters}
            setShowWwbotaFilters={setShowWwbotaFilters}
            filteredWwbotaSpots={filteredWwbotaSpots}
          />
        );
      default:
        return null;
    }
  };

  const mapEl = (
    <div
      style={{
        position: 'relative',
        borderRadius: '6px',
        overflow: 'hidden',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <WorldMap
        config={config}
        isLocalInstall={isLocalInstall}
        deLocation={config.location}
        dxLocation={dxLocation}
        onDXChange={handleDXChange}
        dxLocked={dxLocked}
        potaSpots={bareMap ? [] : filteredPotaSpots ? filteredPotaSpots : potaSpots.data}
        wwffSpots={bareMap ? [] : filteredWwffSpots ? filteredWwffSpots : wwffSpots.data}
        sotaSpots={bareMap ? [] : filteredSotaSpots ? filteredSotaSpots : sotaSpots.data}
        wwbotaSpots={bareMap ? [] : filteredWwbotaSpots ? filteredWwbotaSpots : wwbotaSpots.data}
        mySpots={bareMap ? [] : mySpots.data}
        dxPaths={bareMap ? [] : dxClusterData.paths}
        dxFilters={dxFilters}
        mapBandFilter={mapBandFilter}
        onMapBandFilterChange={setMapBandFilter}
        satellites={bareMap ? [] : filteredSatellites}
        pskReporterSpots={bareMap ? [] : filteredPskSpots}
        showDeDxMarkers={mapLayers.showDeDxMarkers}
        showDXPaths={mapLayers.showDXPaths}
        showDXLabels={mapLayers.showDXLabels}
        onToggleDXLabels={toggleDXLabels}
        showPOTA={mapLayers.showPOTA}
        showPOTALabels={mapLayers.showPOTALabels}
        showWWFF={mapLayers.showWWFF}
        showWWFFLabels={mapLayers.showWWFFLabels}
        showSOTA={mapLayers.showSOTA}
        showSOTALabels={mapLayers.showSOTALabels}
        showWWBOTA={mapLayers.showWWBOTA}
        showWWBOTALabels={mapLayers.showWWBOTALabels}
        showSatellites={mapLayers.showSatellites}
        showPSKReporter={mapLayers.showPSKReporter}
        showPSKPaths={mapLayers.showPSKPaths}
        showMutualReception={config.showMutualReception !== false}
        wsjtxSpots={bareMap ? [] : wsjtxMapSpots}
        showWSJTX={mapLayers.showWSJTX}
        showDXNews={mapLayers.showDXNews}
        onToggleSatellites={toggleSatellites}
        hoveredSpot={bareMap ? null : hoveredSpot}
        callsign={config.callsign}
        lowMemoryMode={config.lowMemoryMode}
        allUnits={config.allUnits}
        mouseZoom={config.mouseZoom}
        onSpotClick={tuneTo}
      />
      <div
        style={{
          position: 'absolute',
          top: '8px',
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '2px',
          color: spec.accent,
          background: 'rgba(0,0,0,0.7)',
          padding: '2px 10px',
          borderRadius: '4px',
          pointerEvents: 'none',
        }}
      >
        {spec.title}
      </div>
    </div>
  );

  const headerEl = (
    <Header
      config={config}
      utcTime={utcTime}
      utcDate={utcDate}
      localTime={localTime}
      localDate={localDate}
      localWeather={localWeather}
      spaceWeather={spaceWeather}
      solarIndices={solarIndices}
      bandConditions={bandConditions}
      use12Hour={use12Hour}
      onTimeFormatToggle={handleTimeFormatToggle}
      onSettingsClick={() => setShowSettings(true)}
      onUpdateClick={handleUpdateClick}
      onFullscreenToggle={handleFullscreenToggle}
      isFullscreen={isFullscreen}
      updateInProgress={updateInProgress}
      showUpdateButton={isLocalInstall}
      breakpoint={breakpoint}
    />
  );

  // Narrow screens: map on top, panels stacked below
  if (isNarrow) {
    return (
      <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flexShrink: 0, padding: '4px 6px' }}>{headerEl}</div>
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '4px 6px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          <div style={{ width: '100%', height: '50vh', minHeight: '260px', flexShrink: 0 }}>{mapEl}</div>
          {spec.panels.map((id) => (
            <div key={id} style={{ minHeight: '220px', flexShrink: 0 }}>
              {panelEl(id)}
            </div>
          ))}
          <div style={{ height: '20px', flexShrink: 0 }} />
        </div>
      </div>
    );
  }

  // Desktop: header | map + right rail
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'grid',
        gridTemplateColumns: '1fr clamp(300px, 22vw, 460px)',
        gridTemplateRows: 'auto 1fr',
        gap: '8px',
        padding: '8px',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ gridColumn: '1 / -1' }}>{headerEl}</div>
      {mapEl}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', overflow: 'hidden', minHeight: 0 }}>
        {spec.panels.map((id) => (
          <div key={id} style={{ flex: '1 1 0', minHeight: '120px', overflow: 'hidden' }}>
            {panelEl(id)}
          </div>
        ))}
      </div>
    </div>
  );
}
