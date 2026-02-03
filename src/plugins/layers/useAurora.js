import { useState, useEffect } from 'react';

// NOAA OVATION Aurora Forecast
// Provides 30-min forecast of auroral activity as a global image overlay
// Data: https://services.swpc.noaa.gov/products/animations/ovation_north_24h.json
// Image: https://services.swpc.noaa.gov/images/animations/ovation/north/latest.jpg

export const metadata = {
  id: 'aurora',
  name: 'Aurora Forecast',
  description: 'NOAA OVATION auroral oval forecast (Northern & Southern)',
  icon: '🌌',
  category: 'space-weather',
  defaultEnabled: false,
  defaultOpacity: 0.5,
  version: '1.0.0'
};

export function useLayer({ enabled = false, opacity = 0.5, map = null }) {
  const [northLayer, setNorthLayer] = useState(null);
  const [southLayer, setSouthLayer] = useState(null);
  const [refreshTimestamp, setRefreshTimestamp] = useState(Date.now());

  // NOAA provides aurora forecast as a GeoJSON-like data product
  // We'll use the OVATION aurora map images which cover both hemispheres
  // These are pre-rendered transparent PNGs showing aurora probability

  useEffect(() => {
    if (!map || typeof L === 'undefined') return;

    if (enabled) {
      try {
        // NOAA OVATION aurora forecast - uses a tile overlay from SWPC
        // The aurora oval images are projected onto a polar view, but SWPC also
        // provides an equirectangular overlay we can use with Leaflet
        const t = Math.floor(Date.now() / 300000) * 300000; // 5-min cache bust

        // Northern hemisphere aurora overlay
        const north = L.imageOverlay(
          `https://services.swpc.noaa.gov/images/aurora-forecast-northern-hemisphere.jpg?t=${t}`,
          [[0, -180], [90, 180]],
          {
            opacity: opacity,
            zIndex: 210,
            className: 'aurora-overlay'
          }
        );

        // Southern hemisphere aurora overlay  
        const south = L.imageOverlay(
          `https://services.swpc.noaa.gov/images/aurora-forecast-southern-hemisphere.jpg?t=${t}`,
          [[-90, -180], [0, 180]],
          {
            opacity: opacity,
            zIndex: 210,
            className: 'aurora-overlay'
          }
        );

        north.addTo(map);
        south.addTo(map);
        setNorthLayer(north);
        setSouthLayer(south);
      } catch (err) {
        console.error('Aurora overlay error:', err);
      }
    } else {
      // Remove layers when disabled
      if (northLayer) {
        try { map.removeLayer(northLayer); } catch (e) {}
        setNorthLayer(null);
      }
      if (southLayer) {
        try { map.removeLayer(southLayer); } catch (e) {}
        setSouthLayer(null);
      }
    }

    return () => {
      if (northLayer && map) {
        try { map.removeLayer(northLayer); } catch (e) {}
      }
      if (southLayer && map) {
        try { map.removeLayer(southLayer); } catch (e) {}
      }
    };
  }, [enabled, map, refreshTimestamp]);

  // Update opacity
  useEffect(() => {
    if (northLayer) northLayer.setOpacity(opacity);
    if (southLayer) southLayer.setOpacity(opacity);
  }, [opacity, northLayer, southLayer]);

  // Auto-refresh every 10 minutes (NOAA updates ~every 30 min)
  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      // Remove old layers and trigger re-add with new timestamp
      if (northLayer && map) {
        try { map.removeLayer(northLayer); } catch (e) {}
        setNorthLayer(null);
      }
      if (southLayer && map) {
        try { map.removeLayer(southLayer); } catch (e) {}
        setSouthLayer(null);
      }
      setRefreshTimestamp(Date.now());
    }, 600000); // 10 minutes

    return () => clearInterval(interval);
  }, [enabled, northLayer, southLayer, map]);

  return {
    layers: [northLayer, southLayer].filter(Boolean),
    refresh: () => {
      if (northLayer && map) {
        try { map.removeLayer(northLayer); } catch (e) {}
        setNorthLayer(null);
      }
      if (southLayer && map) {
        try { map.removeLayer(southLayer); } catch (e) {}
        setSouthLayer(null);
      }
      setRefreshTimestamp(Date.now());
    }
  };
}
