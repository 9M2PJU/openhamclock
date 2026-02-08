/**
 * OWM Clouds Layer for OpenHamClock Uses open Weather API
 * Added for USRadioguy.com - Real-time global cloud overlay
 */
// src/plugins/layers/OWMClouds.js
import React, { useEffect, useRef } from 'react';

export const metadata = {
  id: 'owm-clouds',
  name: 'Global Clouds (OWM)',
  description: 'Real-time global cloud overlay',
  icon: '☁️',
  category: 'weather',
  defaultEnabled: false,
  defaultOpacity: 0.5
};

// The registry looks for this EXACT name: useLayer
export const useLayer = (map, enabled, opacity) => {
  const layerRef = useRef(null);

  useEffect(() => {
    // This log MUST appear if the connection is working
    console.log(`Cloud Layer Status - Enabled: ${enabled}, Opacity: ${opacity}`);

    if (!map) return;

    if (enabled) {
      const apiKey = import.meta.env.VITE_OPENWEATHER_API_KEY || '';
      
      if (!layerRef.current) {
        layerRef.current = L.tileLayer(
          `https://tile.openweathermap.org/map/clouds_new/{z}/{x}/{y}.png?appid=${apiKey}`,
          {
            opacity: opacity,
            zIndex: 1000,
            attribution: '© OpenWeatherMap'
          }
        );
        layerRef.current.addTo(map);
      } else {
        layerRef.current.setOpacity(opacity);
      }
    } else {
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
    }
  }, [map, enabled, opacity]);
};
