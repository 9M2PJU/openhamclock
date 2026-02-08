/**
 * PluginLayer Component
 * Renders a single plugin layer using its hook.
 * Support for both legacy object-based hooks and new direct-argument hooks.
 * Added for Cloud layer weather and satellite integration.
 */
import React from 'react';

export const PluginLayer = ({ plugin, enabled, opacity, map, callsign, locator, lowMemoryMode }) => {
  
  // 1. Identify which function name the plugin is using
  const layerFunc = plugin.useLayer || plugin.hook;

  if (typeof layerFunc === 'function') {
    // 2. Try the OWM style (individual arguments)
    // Most newer hooks expect: (map, enabled, opacity, options)
    layerFunc(map, enabled, opacity, { callsign, locator, lowMemoryMode });

    // 3. Try the Legacy style (single object)
    // Older plugins like Earthquakes/WSPR expect: ({ map, enabled, opacity... })
    // We call it again with the object format to ensure they receive their props
    layerFunc({ map, enabled, opacity, callsign, locator, lowMemoryMode });
  }

  return null;
};

export default PluginLayer;
