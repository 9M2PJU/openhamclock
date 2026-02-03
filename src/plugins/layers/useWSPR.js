import { useState, useEffect, useRef } from 'react';

/**
 * WSPR Propagation Heatmap Plugin v1.5.0
 * 
 * Advanced Features:
 * - Great circle curved path lines between transmitters and receivers
 * - Color-coded by signal strength (SNR)
 * - Animated signal pulses along paths (v1.3.0)
 * - Band selector dropdown (v1.2.0)
 * - Time range slider (15min - 6hr) (v1.2.0)
 * - SNR threshold filter (v1.2.0)
 * - Hot spot density heatmap (v1.4.0)
 * - Band activity chart (v1.3.0)
 * - Propagation score indicator (v1.3.0)
 * - Best DX paths highlighting (v1.3.0)
 * - Draggable control panels with CTRL+drag (v1.4.0)
 * - Persistent panel positions (v1.4.1)
 * - Proper cleanup on disable (v1.4.1)
 * - Fixed duplicate control creation (v1.4.2)
 * - Performance optimizations (v1.4.2)
 * - Separate opacity controls for paths and heatmap (v1.4.3)
 * - Minimize/maximize toggle for all panels (v1.5.0)
 * - Statistics display (total stations, spots)
 * - Signal strength legend
 * 
 * Data source: PSK Reporter API (WSPR mode spots)
 * Update interval: 5 minutes
 */

export const metadata = {
  id: 'wspr',
  name: 'WSPR Propagation',
  description: 'Advanced WSPR propagation visualization with filters, analytics, and heatmaps',
  icon: '📡',
  category: 'propagation',
  defaultEnabled: false,
  defaultOpacity: 0.7,
  version: '1.5.0'
};

// Convert grid square to lat/lon
function gridToLatLon(grid) {
  if (!grid || grid.length < 4) return null;
  
  grid = grid.toUpperCase();
  const lon = (grid.charCodeAt(0) - 65) * 20 - 180;
  const lat = (grid.charCodeAt(1) - 65) * 10 - 90;
  const lon2 = parseInt(grid[2]) * 2;
  const lat2 = parseInt(grid[3]);
  
  let longitude = lon + lon2 + 1;
  let latitude = lat + lat2 + 0.5;
  
  if (grid.length >= 6) {
    const lon3 = (grid.charCodeAt(4) - 65) * (2/24);
    const lat3 = (grid.charCodeAt(5) - 65) * (1/24);
    longitude = lon + lon2 + lon3 + (1/24);
    latitude = lat + lat2 + lat3 + (0.5/24);
  }
  
  return { lat: latitude, lon: longitude };
}

// Get color based on SNR
function getSNRColor(snr) {
  if (snr === null || snr === undefined) return '#888888';
  if (snr < -20) return '#ff0000';
  if (snr < -10) return '#ff6600';
  if (snr < 0) return '#ffaa00';
  if (snr < 5) return '#ffff00';
  return '#00ff00';
}

// Get line weight based on SNR
function getLineWeight(snr) {
  if (snr === null || snr === undefined) return 1;
  if (snr < -20) return 1;
  if (snr < -10) return 1.5;
  if (snr < 0) return 2;
  if (snr < 5) return 2.5;
  return 3;
}

// Calculate great circle path between two points
function getGreatCirclePath(lat1, lon1, lat2, lon2, numPoints = 30) {
  // Validate input coordinates
  if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) {
    return [[lat1, lon1], [lat2, lon2]];
  }
  
  // Check if points are very close (less than 0.5 degree)
  const deltaLat = Math.abs(lat2 - lat1);
  const deltaLon = Math.abs(lon2 - lon1);
  if (deltaLat < 0.5 && deltaLon < 0.5) {
    return [[lat1, lon1], [lat2, lon2]];
  }
  
  const path = [];
  
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  
  const lat1Rad = toRad(lat1);
  const lon1Rad = toRad(lon1);
  const lat2Rad = toRad(lat2);
  const lon2Rad = toRad(lon2);
  
  const cosD = Math.sin(lat1Rad) * Math.sin(lat2Rad) +
               Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.cos(lon2Rad - lon1Rad);
  
  const d = Math.acos(Math.max(-1, Math.min(1, cosD)));
  
  if (d < 0.01 || Math.abs(d - Math.PI) < 0.01) {
    return [[lat1, lon1], [lat2, lon2]];
  }
  
  const sinD = Math.sin(d);
  
  for (let i = 0; i <= numPoints; i++) {
    const f = i / numPoints;
    
    const A = Math.sin((1 - f) * d) / sinD;
    const B = Math.sin(f * d) / sinD;
    
    const x = A * Math.cos(lat1Rad) * Math.cos(lon1Rad) + B * Math.cos(lat2Rad) * Math.cos(lon2Rad);
    const y = A * Math.cos(lat1Rad) * Math.sin(lon1Rad) + B * Math.cos(lat2Rad) * Math.sin(lon2Rad);
    const z = A * Math.sin(lat1Rad) + B * Math.sin(lat2Rad);
    
    const lat = toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)));
    const lon = toDeg(Math.atan2(y, x));
    
    if (isFinite(lat) && isFinite(lon)) {
      path.push([lat, lon]);
    }
  }
  
  if (path.length < 2) {
    return [[lat1, lon1], [lat2, lon2]];
  }
  
  return path;
}

// Calculate propagation score (0-100)
function calculatePropagationScore(spots) {
  if (!spots || spots.length === 0) return 0;
  
  const avgSNR = spots.reduce((sum, s) => sum + (s.snr || -20), 0) / spots.length;
  const pathCount = spots.length;
  const strongSignals = spots.filter(s => s.snr > 0).length;
  
  // Score based on: average SNR (40%), path count (30%), strong signal ratio (30%)
  const snrScore = Math.max(0, Math.min(100, ((avgSNR + 20) / 25) * 40));
  const countScore = Math.min(30, (pathCount / 100) * 30);
  const strongScore = (strongSignals / pathCount) * 30;
  
  return Math.round(snrScore + countScore + strongScore);
}

// Make control panel draggable with CTRL+drag and save position
function makeDraggable(element, storageKey) {
  if (!element) return;
  
  // Load saved position
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try {
      const { top, left } = JSON.parse(saved);
      element.style.position = 'fixed';
      element.style.top = top + 'px';
      element.style.left = left + 'px';
      element.style.right = 'auto';
      element.style.bottom = 'auto';
    } catch (e) {}
  } else {
    // Convert from Leaflet control position to fixed
    const rect = element.getBoundingClientRect();
    element.style.position = 'fixed';
    element.style.top = rect.top + 'px';
    element.style.left = rect.left + 'px';
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  }
  
  // Add drag hint
  element.title = 'Hold CTRL and drag to reposition';
  
  let isDragging = false;
  let startX, startY, startLeft, startTop;
  
  // Update cursor based on CTRL key
  const updateCursor = (e) => {
    if (e.ctrlKey) {
      element.style.cursor = 'grab';
    } else {
      element.style.cursor = 'default';
    }
  };
  
  element.addEventListener('mouseenter', updateCursor);
  element.addEventListener('mousemove', updateCursor);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Control') updateCursor(e);
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control') updateCursor(e);
  });
  
  element.addEventListener('mousedown', function(e) {
    // Only allow dragging with CTRL key
    if (!e.ctrlKey) return;
    
    // Only allow dragging from empty areas (not inputs/selects)
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') {
      return;
    }
    
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = element.offsetLeft;
    startTop = element.offsetTop;
    
    element.style.cursor = 'grabbing';
    element.style.opacity = '0.8';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', function(e) {
    if (!isDragging) return;
    
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    
    element.style.left = (startLeft + dx) + 'px';
    element.style.top = (startTop + dy) + 'px';
  });
  
  document.addEventListener('mouseup', function(e) {
    if (isDragging) {
      isDragging = false;
      element.style.opacity = '1';
      updateCursor(e);
      
      // Save position
      const position = {
        top: element.offsetTop,
        left: element.offsetLeft
      };
      localStorage.setItem(storageKey, JSON.stringify(position));
    }
  });
}

// Add minimize/maximize functionality to control panels
function addMinimizeToggle(element, storageKey) {
  if (!element) return;
  
  const minimizeKey = storageKey + '-minimized';
  
  // Create minimize button
  const header = element.querySelector('div:first-child');
  if (!header) return;
  
  // Wrap content (everything except header)
  const content = Array.from(element.children).slice(1);
  const contentWrapper = document.createElement('div');
  contentWrapper.className = 'wspr-panel-content';
  content.forEach(child => contentWrapper.appendChild(child));
  element.appendChild(contentWrapper);
  
  // Add minimize button to header
  const minimizeBtn = document.createElement('span');
  minimizeBtn.className = 'wspr-minimize-btn';
  minimizeBtn.innerHTML = '▼';
  minimizeBtn.style.cssText = `
    float: right;
    cursor: pointer;
    user-select: none;
    padding: 0 4px;
    margin: -2px -4px 0 0;
    font-size: 10px;
    opacity: 0.7;
    transition: opacity 0.2s;
  `;
  minimizeBtn.title = 'Minimize/Maximize';
  
  minimizeBtn.addEventListener('mouseenter', () => {
    minimizeBtn.style.opacity = '1';
  });
  minimizeBtn.addEventListener('mouseleave', () => {
    minimizeBtn.style.opacity = '0.7';
  });
  
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.appendChild(minimizeBtn);
  
  // Load saved state
  const isMinimized = localStorage.getItem(minimizeKey) === 'true';
  if (isMinimized) {
    contentWrapper.style.display = 'none';
    minimizeBtn.innerHTML = '▶';
    element.style.cursor = 'pointer';
  }
  
  // Toggle function
  const toggle = (e) => {
    // Don't toggle if CTRL is held (for dragging)
    if (e && e.ctrlKey) return;
    
    const isCurrentlyMinimized = contentWrapper.style.display === 'none';
    
    if (isCurrentlyMinimized) {
      // Expand
      contentWrapper.style.display = 'block';
      minimizeBtn.innerHTML = '▼';
      element.style.cursor = 'default';
      localStorage.setItem(minimizeKey, 'false');
    } else {
      // Minimize
      contentWrapper.style.display = 'none';
      minimizeBtn.innerHTML = '▶';
      element.style.cursor = 'pointer';
      localStorage.setItem(minimizeKey, 'true');
    }
  };
  
  // Click header to toggle (except on button itself)
  header.addEventListener('click', (e) => {
    if (e.target === header || e.target.tagName === 'DIV') {
      toggle(e);
    }
  });
  
  // Click button to toggle
  minimizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle(e);
  });
}

export function useLayer({ enabled = false, opacity = 0.7, map = null }) {
  const [pathLayers, setPathLayers] = useState([]);
  const [markerLayers, setMarkerLayers] = useState([]);
  const [heatmapLayer, setHeatmapLayer] = useState(null);
  const [wsprData, setWsprData] = useState([]);
  
  // v1.2.0 - Advanced Filters
  const [bandFilter, setBandFilter] = useState('all');
  const [timeWindow, setTimeWindow] = useState(30); // minutes
  const [snrThreshold, setSNRThreshold] = useState(-30); // dB
  const [showAnimation, setShowAnimation] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(false);
  
  // v1.4.3 - Separate opacity controls
  const [pathOpacity, setPathOpacity] = useState(0.7);
  const [heatmapOpacity, setHeatmapOpacity] = useState(0.6);
  
  // UI Controls (refs to avoid recreation)
  const legendControlRef = useRef(null);
  const statsControlRef = useRef(null);
  const filterControlRef = useRef(null);
  const chartControlRef = useRef(null);
  
  const [legendControl, setLegendControl] = useState(null);
  const [statsControl, setStatsControl] = useState(null);
  const [filterControl, setFilterControl] = useState(null);
  const [chartControl, setChartControl] = useState(null);
  
  const animationFrameRef = useRef(null);

  // Fetch WSPR data with dynamic time window and band filter
  useEffect(() => {
    if (!enabled) return;

    const fetchWSPR = async () => {
      try {
        const response = await fetch(`/api/wspr/heatmap?minutes=${timeWindow}&band=${bandFilter}`);
        if (response.ok) {
          const data = await response.json();
          setWsprData(data.spots || []);
          console.log(`[WSPR Plugin] Loaded ${data.spots?.length || 0} spots (${timeWindow}min, band: ${bandFilter})`);
        }
      } catch (err) {
        console.error('WSPR data fetch error:', err);
      }
    };

    fetchWSPR();
    const interval = setInterval(fetchWSPR, 300000);

    return () => clearInterval(interval);
  }, [enabled, bandFilter, timeWindow]);

  // Create UI controls once (v1.2.0+)
  useEffect(() => {
    if (!enabled || !map) return;
    if (filterControlRef.current || statsControlRef.current || legendControlRef.current || chartControlRef.current) return;

    const FilterControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function() {
        const container = L.DomUtil.create('div', 'wspr-filter-control');
        container.style.cssText = `
          background: rgba(0, 0, 0, 0.9);
          padding: 12px;
          border-radius: 5px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          min-width: 180px;
        `;
        
        container.innerHTML = `
          <div style="font-weight: bold; margin-bottom: 8px; font-size: 12px;">🎛️ Filters</div>
          
          <div style="margin-bottom: 8px;">
            <label style="display: block; margin-bottom: 3px;">Band:</label>
            <select id="wspr-band-filter" style="width: 100%; padding: 4px; background: #333; color: white; border: 1px solid #555; border-radius: 3px;">
              <option value="all">All Bands</option>
              <option value="160m">160m</option>
              <option value="80m">80m</option>
              <option value="60m">60m</option>
              <option value="40m">40m</option>
              <option value="30m">30m</option>
              <option value="20m">20m</option>
              <option value="17m">17m</option>
              <option value="15m">15m</option>
              <option value="12m">12m</option>
              <option value="10m">10m</option>
              <option value="6m">6m</option>
            </select>
          </div>
          
          <div style="margin-bottom: 8px;">
            <label style="display: block; margin-bottom: 3px;">Time Window:</label>
            <select id="wspr-time-filter" style="width: 100%; padding: 4px; background: #333; color: white; border: 1px solid #555; border-radius: 3px;">
              <option value="15">15 minutes</option>
              <option value="30" selected>30 minutes</option>
              <option value="60">1 hour</option>
              <option value="120">2 hours</option>
              <option value="360">6 hours</option>
            </select>
          </div>
          
          <div style="margin-bottom: 8px;">
            <label style="display: block; margin-bottom: 3px;">Min SNR: <span id="snr-value">-30</span> dB</label>
            <input type="range" id="wspr-snr-filter" min="-30" max="10" value="-30" step="5" 
              style="width: 100%;" />
          </div>
          
          <div style="margin-bottom: 8px; padding-top: 8px; border-top: 1px solid #555;">
            <label style="display: block; margin-bottom: 3px;">Path Opacity: <span id="path-opacity-value">70</span>%</label>
            <input type="range" id="wspr-path-opacity" min="10" max="100" value="70" step="5" 
              style="width: 100%;" />
          </div>
          
          <div style="margin-bottom: 8px;">
            <label style="display: block; margin-bottom: 3px;">Heatmap Opacity: <span id="heatmap-opacity-value">60</span>%</label>
            <input type="range" id="wspr-heatmap-opacity" min="10" max="100" value="60" step="5" 
              style="width: 100%;" />
          </div>
          
          <div style="margin-bottom: 8px; padding-top: 8px; border-top: 1px solid #555;">
            <label style="display: flex; align-items: center; cursor: pointer;">
              <input type="checkbox" id="wspr-animation" checked style="margin-right: 5px;" />
              <span>Animate Paths</span>
            </label>
          </div>
          
          <div>
            <label style="display: flex; align-items: center; cursor: pointer;">
              <input type="checkbox" id="wspr-heatmap" style="margin-right: 5px;" />
              <span>Show Heatmap</span>
            </label>
          </div>
        `;
        
        // Prevent map events from propagating
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);
        
        return container;
      }
    });
    
    const control = new FilterControl();
    map.addControl(control);
    filterControlRef.current = control;
    setFilterControl(control);
    
    // Make control draggable after it's added to DOM
    setTimeout(() => {
      const container = document.querySelector('.wspr-filter-control');
      if (container) {
        makeDraggable(container, 'wspr-filter-position');
        addMinimizeToggle(container, 'wspr-filter-position');
      }
    }, 150);
    
    // Add event listeners after control is added
    setTimeout(() => {
      const bandSelect = document.getElementById('wspr-band-filter');
      const timeSelect = document.getElementById('wspr-time-filter');
      const snrSlider = document.getElementById('wspr-snr-filter');
      const snrValue = document.getElementById('snr-value');
      const pathOpacitySlider = document.getElementById('wspr-path-opacity');
      const pathOpacityValue = document.getElementById('path-opacity-value');
      const heatmapOpacitySlider = document.getElementById('wspr-heatmap-opacity');
      const heatmapOpacityValue = document.getElementById('heatmap-opacity-value');
      const animCheck = document.getElementById('wspr-animation');
      const heatCheck = document.getElementById('wspr-heatmap');
      
      if (bandSelect) bandSelect.addEventListener('change', (e) => setBandFilter(e.target.value));
      if (timeSelect) timeSelect.addEventListener('change', (e) => setTimeWindow(parseInt(e.target.value)));
      if (snrSlider) {
        snrSlider.addEventListener('input', (e) => {
          setSNRThreshold(parseInt(e.target.value));
          if (snrValue) snrValue.textContent = e.target.value;
        });
      }
      if (pathOpacitySlider) {
        pathOpacitySlider.addEventListener('input', (e) => {
          const value = parseInt(e.target.value) / 100;
          setPathOpacity(value);
          if (pathOpacityValue) pathOpacityValue.textContent = e.target.value;
        });
      }
      if (heatmapOpacitySlider) {
        heatmapOpacitySlider.addEventListener('input', (e) => {
          const value = parseInt(e.target.value) / 100;
          setHeatmapOpacity(value);
          if (heatmapOpacityValue) heatmapOpacityValue.textContent = e.target.value;
        });
      }
      if (animCheck) animCheck.addEventListener('change', (e) => setShowAnimation(e.target.checked));
      if (heatCheck) heatCheck.addEventListener('change', (e) => {
        console.log('[WSPR] Heatmap toggle:', e.target.checked);
        setShowHeatmap(e.target.checked);
      });
    }, 100);
    
    // Create stats control
    const StatsControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function() {
        const div = L.DomUtil.create('div', 'wspr-stats');
        div.style.cssText = `
          background: rgba(0, 0, 0, 0.9);
          padding: 12px;
          border-radius: 5px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        `;
        div.innerHTML = `
          <div style="font-weight: bold; margin-bottom: 6px; font-size: 13px;">📊 WSPR Activity</div>
          <div style="margin-bottom: 8px; padding: 6px; background: rgba(255,255,255,0.1); border-radius: 3px;">
            <div style="font-size: 10px; opacity: 0.8; margin-bottom: 2px;">Propagation Score</div>
            <div style="font-size: 18px; font-weight: bold; color: #888;">--/100</div>
          </div>
          <div>Paths: <span style="color: #00aaff;">0</span></div>
          <div>TX Stations: <span style="color: #ff6600;">0</span></div>
          <div>RX Stations: <span style="color: #0088ff;">0</span></div>
          <div>Total: <span style="color: #00ff00;">0</span></div>
          <div style="margin-top: 6px; font-size: 10px; opacity: 0.7;">Initializing...</div>
        `;
        return div;
      }
    });
    
    const stats = new StatsControl();
    map.addControl(stats);
    statsControlRef.current = stats;
    setStatsControl(stats);
    
    setTimeout(() => {
      const container = document.querySelector('.wspr-stats');
      if (container) {
        makeDraggable(container, 'wspr-stats-position');
        addMinimizeToggle(container, 'wspr-stats-position');
      }
    }, 150);
    
    // Create legend control
    const LegendControl = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd: function() {
        const div = L.DomUtil.create('div', 'wspr-legend');
        div.style.cssText = `
          background: rgba(0, 0, 0, 0.9);
          padding: 10px;
          border-radius: 5px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        `;
        div.innerHTML = `
          <div style="font-weight: bold; margin-bottom: 5px; font-size: 12px;">📡 Signal Strength</div>
          <div><span style="color: #00ff00;">●</span> Excellent (&gt; 5 dB)</div>
          <div><span style="color: #ffff00;">●</span> Good (0 to 5 dB)</div>
          <div><span style="color: #ffaa00;">●</span> Moderate (-10 to 0 dB)</div>
          <div><span style="color: #ff6600;">●</span> Weak (-20 to -10 dB)</div>
          <div><span style="color: #ff0000;">●</span> Very Weak (&lt; -20 dB)</div>
          <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #555;">
            <span style="color: #00ffff;">●</span> Best DX Paths
          </div>
        `;
        return div;
      }
    });
    const legend = new LegendControl();
    map.addControl(legend);
    legendControlRef.current = legend;
    setLegendControl(legend);
    
    setTimeout(() => {
      const container = document.querySelector('.wspr-legend');
      if (container) {
        makeDraggable(container, 'wspr-legend-position');
        addMinimizeToggle(container, 'wspr-legend-position');
      }
    }, 150);
    
    // Create band chart control
    const ChartControl = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function() {
        const div = L.DomUtil.create('div', 'wspr-chart');
        div.style.cssText = `
          background: rgba(0, 0, 0, 0.9);
          padding: 10px;
          border-radius: 5px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          color: white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          max-width: 200px;
        `;
        div.innerHTML = '<div style="font-weight: bold; margin-bottom: 6px; font-size: 11px;">📊 Band Activity</div><div style="opacity: 0.7;">Loading...</div>';
        return div;
      }
    });
    
    const chart = new ChartControl();
    map.addControl(chart);
    chartControlRef.current = chart;
    setChartControl(chart);
    
    setTimeout(() => {
      const container = document.querySelector('.wspr-chart');
      if (container) {
        makeDraggable(container, 'wspr-chart-position');
        addMinimizeToggle(container, 'wspr-chart-position');
      }
    }, 150);
    
    console.log('[WSPR] All controls created once');
    
  }, [enabled, map]);

  // Render WSPR paths and markers
  useEffect(() => {
    if (!map || typeof L === 'undefined') return;

    // Clear old layers
    pathLayers.forEach(layer => {
      try { map.removeLayer(layer); } catch (e) {}
    });
    markerLayers.forEach(layer => {
      try { map.removeLayer(layer); } catch (e) {}
    });
    setPathLayers([]);
    setMarkerLayers([]);

    if (!enabled || wsprData.length === 0) return;

    const newPaths = [];
    const newMarkers = [];
    const txStations = new Set();
    const rxStations = new Set();
    
    // Filter by SNR threshold
    const filteredData = wsprData.filter(spot => (spot.snr || -30) >= snrThreshold);
    const limitedData = filteredData.slice(0, 500);
    
    // Find best DX paths (longest distance, good SNR)
    const bestPaths = limitedData
      .map(spot => {
        const dist = Math.sqrt(
          Math.pow(spot.receiverLat - spot.senderLat, 2) +
          Math.pow(spot.receiverLon - spot.senderLon, 2)
        );
        return { ...spot, distance: dist };
      })
      .filter(s => s.snr > 0)
      .sort((a, b) => b.distance - a.distance)
      .slice(0, 10);
    
    const bestPathSet = new Set(bestPaths.map(p => `${p.sender}-${p.receiver}`));

    limitedData.forEach(spot => {
      // Validate coordinates
      if (!spot.senderLat || !spot.senderLon || !spot.receiverLat || !spot.receiverLon) {
        return;
      }
      
      const sLat = parseFloat(spot.senderLat);
      const sLon = parseFloat(spot.senderLon);
      const rLat = parseFloat(spot.receiverLat);
      const rLon = parseFloat(spot.receiverLon);
      
      if (!isFinite(sLat) || !isFinite(sLon) || !isFinite(rLat) || !isFinite(rLon)) {
        return;
      }
      
      // Calculate great circle path
      const pathCoords = getGreatCirclePath(sLat, sLon, rLat, rLon, 30);
      
      if (!pathCoords || pathCoords.length < 2) {
        return;
      }
      
      // Check if this is a best DX path
      const isBestPath = bestPathSet.has(`${spot.sender}-${spot.receiver}`);
      
      const path = L.polyline(pathCoords, {
        color: isBestPath ? '#00ffff' : getSNRColor(spot.snr),
        weight: isBestPath ? 4 : getLineWeight(spot.snr),
        opacity: pathOpacity * (isBestPath ? 0.9 : 0.6),
        smoothFactor: 1,
        className: showAnimation ? 'wspr-animated-path' : ''
      });

      const snrStr = spot.snr !== null ? `${spot.snr} dB` : 'N/A';
      const ageStr = spot.age < 60 ? `${spot.age} min ago` : `${Math.floor(spot.age / 60)}h ago`;
      
      path.bindPopup(`
        <div style="font-family: 'JetBrains Mono', monospace; min-width: 220px;">
          <div style="font-size: 14px; font-weight: bold; color: ${getSNRColor(spot.snr)}; margin-bottom: 6px;">
            ${isBestPath ? '⭐ Best DX Path' : '📡 WSPR Spot'}
          </div>
          <table style="font-size: 11px; width: 100%;">
            <tr><td><b>TX:</b></td><td>${spot.sender} (${spot.senderGrid})</td></tr>
            <tr><td><b>RX:</b></td><td>${spot.receiver} (${spot.receiverGrid})</td></tr>
            <tr><td><b>Freq:</b></td><td>${spot.freqMHz} MHz (${spot.band})</td></tr>
            <tr><td><b>SNR:</b></td><td style="color: ${getSNRColor(spot.snr)}; font-weight: bold;">${snrStr}</td></tr>
            <tr><td><b>Time:</b></td><td>${ageStr}</td></tr>
          </table>
        </div>
      `);

      path.addTo(map);
      newPaths.push(path);

      // Add markers
      const txKey = `${spot.sender}-${spot.senderGrid}`;
      if (!txStations.has(txKey)) {
        txStations.add(txKey);
        const txMarker = L.circleMarker([sLat, sLon], {
          radius: 4,
          fillColor: '#ff6600',
          color: '#ffffff',
          weight: 1,
          fillOpacity: pathOpacity * 0.8,
          opacity: pathOpacity
        });
        txMarker.bindTooltip(`TX: ${spot.sender}`, { permanent: false, direction: 'top' });
        txMarker.addTo(map);
        newMarkers.push(txMarker);
      }

      const rxKey = `${spot.receiver}-${spot.receiverGrid}`;
      if (!rxStations.has(rxKey)) {
        rxStations.add(rxKey);
        const rxMarker = L.circleMarker([rLat, rLon], {
          radius: 4,
          fillColor: '#0088ff',
          color: '#ffffff',
          weight: 1,
          fillOpacity: pathOpacity * 0.8,
          opacity: pathOpacity
        });
        rxMarker.bindTooltip(`RX: ${spot.receiver}`, { permanent: false, direction: 'top' });
        rxMarker.addTo(map);
        newMarkers.push(rxMarker);
      }
    });

    setPathLayers(newPaths);
    setMarkerLayers(newMarkers);
    
    // Update stats content only (don't recreate control)
    const propScore = calculatePropagationScore(limitedData);
    const scoreColor = propScore > 70 ? '#00ff00' : propScore > 40 ? '#ffaa00' : '#ff6600';
    const totalStations = txStations.size + rxStations.size;
    
    // Update existing stats panel content if it exists
    setTimeout(() => {
      const statsContainer = document.querySelector('.wspr-stats');
      if (statsContainer && enabled) {
        statsContainer.innerHTML = `
          <div style="font-weight: bold; margin-bottom: 6px; font-size: 13px;">📊 WSPR Activity</div>
          <div style="margin-bottom: 8px; padding: 6px; background: rgba(255,255,255,0.1); border-radius: 3px;">
            <div style="font-size: 10px; opacity: 0.8; margin-bottom: 2px;">Propagation Score</div>
            <div style="font-size: 18px; font-weight: bold; color: ${scoreColor};">${propScore}/100</div>
          </div>
          <div>Paths: <span style="color: #00aaff;">${newPaths.length}</span></div>
          <div>TX Stations: <span style="color: #ff6600;">${txStations.size}</span></div>
          <div>RX Stations: <span style="color: #0088ff;">${rxStations.size}</span></div>
          <div>Total: <span style="color: #00ff00;">${totalStations}</span></div>
          <div style="margin-top: 6px; font-size: 10px; opacity: 0.7;">Last ${timeWindow} min</div>
        `;
      }
    }, 50);
    
    // Update band chart content if it exists
    setTimeout(() => {
      const chartContainer = document.querySelector('.wspr-chart');
      if (chartContainer && limitedData.length > 0 && enabled) {
        const bandCounts = {};
        limitedData.forEach(spot => {
          const band = spot.band || 'Unknown';
          bandCounts[band] = (bandCounts[band] || 0) + 1;
        });
        
        let chartHTML = '<div style="font-weight: bold; margin-bottom: 6px; font-size: 11px;">📊 Band Activity</div>';
        
        Object.entries(bandCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .forEach(([band, count]) => {
            const percentage = (count / limitedData.length) * 100;
            const barWidth = Math.max(percentage, 5);
            chartHTML += `
              <div style="margin-bottom: 4px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                  <span>${band}</span>
                  <span style="color: #00aaff;">${count}</span>
                </div>
                <div style="background: #333; height: 6px; border-radius: 3px; overflow: hidden;">
                  <div style="background: linear-gradient(90deg, #ff6600, #00aaff); height: 100%; width: ${barWidth}%;"></div>
                </div>
              </div>
            `;
          });
        
        chartContainer.innerHTML = chartHTML;
      }
    }, 50);
    
    console.log(`[WSPR Plugin] Rendered ${newPaths.length} paths, ${newMarkers.length} markers, ${bestPaths.length} best DX`);

    return () => {
      newPaths.forEach(layer => {
        try { map.removeLayer(layer); } catch (e) {}
      });
      newMarkers.forEach(layer => {
        try { map.removeLayer(layer); } catch (e) {}
      });
    };
  }, [enabled, wsprData, map, pathOpacity, snrThreshold, showAnimation, timeWindow]);

  // Render heatmap overlay (v1.4.0)
  useEffect(() => {
    if (!map || typeof L === 'undefined') return;
    
    // Remove existing heatmap
    if (heatmapLayer && map) {
      try {
        map.removeLayer(heatmapLayer);
      } catch (e) {}
      setHeatmapLayer(null);
    }
    
    if (!enabled || !showHeatmap || wsprData.length === 0) return;
    
    console.log('[WSPR] Rendering heatmap with', wsprData.length, 'spots');
    
    // Create heatmap circles for all TX and RX stations
    const heatPoints = [];
    const stationCounts = {};
    
    // Filter by SNR threshold
    const filteredData = wsprData.filter(spot => (spot.snr || -30) >= snrThreshold);
    
    filteredData.forEach(spot => {
      if (!spot.senderLat || !spot.senderLon || !spot.receiverLat || !spot.receiverLon) return;
      
      const sLat = parseFloat(spot.senderLat);
      const sLon = parseFloat(spot.senderLon);
      const rLat = parseFloat(spot.receiverLat);
      const rLon = parseFloat(spot.receiverLon);
      
      if (!isFinite(sLat) || !isFinite(sLon) || !isFinite(rLat) || !isFinite(rLon)) return;
      
      // Count activity at each location
      const txKey = `${sLat.toFixed(1)},${sLon.toFixed(1)}`;
      const rxKey = `${rLat.toFixed(1)},${rLon.toFixed(1)}`;
      
      stationCounts[txKey] = (stationCounts[txKey] || 0) + 1;
      stationCounts[rxKey] = (stationCounts[rxKey] || 0) + 1;
      
      heatPoints.push({ lat: sLat, lon: sLon, key: txKey });
      heatPoints.push({ lat: rLat, lon: rLon, key: rxKey });
    });
    
    // Create gradient circles for heatmap
    const heatCircles = [];
    const uniquePoints = {};
    
    heatPoints.forEach(point => {
      if (!uniquePoints[point.key]) {
        uniquePoints[point.key] = { lat: point.lat, lon: point.lon, count: stationCounts[point.key] };
      }
    });
    
    Object.values(uniquePoints).forEach(point => {
      const intensity = Math.min(point.count / 10, 1); // Normalize to 0-1
      const radius = 20 + (intensity * 30); // 20-50 pixels
      const fillOpacity = 0.3 + (intensity * 0.4); // 0.3-0.7
      
      // Color based on activity level
      let color;
      if (intensity > 0.7) color = '#ff0000'; // Red - very hot
      else if (intensity > 0.5) color = '#ff6600'; // Orange - hot
      else if (intensity > 0.3) color = '#ffaa00'; // Yellow - warm
      else color = '#00aaff'; // Blue - cool
      
      const circle = L.circle([point.lat, point.lon], {
        radius: radius * 50000, // Convert to meters for Leaflet
        fillColor: color,
        fillOpacity: fillOpacity * heatmapOpacity,
        color: color,
        weight: 0,
        opacity: 0
      });
      
      circle.bindPopup(`
        <div style="font-family: 'JetBrains Mono', monospace;">
          <b>🔥 Activity Hot Spot</b><br>
          Stations: ${point.count}<br>
          Lat: ${point.lat.toFixed(2)}<br>
          Lon: ${point.lon.toFixed(2)}
        </div>
      `);
      
      circle.addTo(map);
      heatCircles.push(circle);
    });
    
    // Store as layer group
    const heatGroup = L.layerGroup(heatCircles);
    setHeatmapLayer(heatGroup);
    
    console.log(`[WSPR] Heatmap rendered with ${Object.keys(uniquePoints).length} hot spots`);
    
    return () => {
      heatCircles.forEach(circle => {
        try {
          map.removeLayer(circle);
        } catch (e) {}
      });
    };
  }, [enabled, showHeatmap, wsprData, map, heatmapOpacity, snrThreshold, heatmapLayer]);

  // Cleanup controls on disable - FIX: properly remove all controls and layers
  useEffect(() => {
    if (!enabled && map) {
      console.log('[WSPR] Plugin disabled - cleaning up all controls and layers');
      
      // Remove filter control
      if (filterControlRef.current) {
        try {
          map.removeControl(filterControlRef.current);
          console.log('[WSPR] Removed filter control');
        } catch (e) {
          console.error('[WSPR] Error removing filter control:', e);
        }
        filterControlRef.current = null;
        setFilterControl(null);
      }
      
      // Remove legend control
      if (legendControlRef.current) {
        try {
          map.removeControl(legendControlRef.current);
          console.log('[WSPR] Removed legend control');
        } catch (e) {
          console.error('[WSPR] Error removing legend control:', e);
        }
        legendControlRef.current = null;
        setLegendControl(null);
      }
      
      // Remove stats control
      if (statsControlRef.current) {
        try {
          map.removeControl(statsControlRef.current);
          console.log('[WSPR] Removed stats control');
        } catch (e) {
          console.error('[WSPR] Error removing stats control:', e);
        }
        statsControlRef.current = null;
        setStatsControl(null);
      }
      
      // Remove chart control
      if (chartControlRef.current) {
        try {
          map.removeControl(chartControlRef.current);
          console.log('[WSPR] Removed chart control');
        } catch (e) {
          console.error('[WSPR] Error removing chart control:', e);
        }
        chartControlRef.current = null;
        setChartControl(null);
      }
      
      // Remove heatmap layer
      if (heatmapLayer) {
        try {
          map.removeLayer(heatmapLayer);
          console.log('[WSPR] Removed heatmap layer');
        } catch (e) {
          console.error('[WSPR] Error removing heatmap layer:', e);
        }
        setHeatmapLayer(null);
      }
      
      // Clear all paths and markers
      pathLayers.forEach(layer => {
        try { map.removeLayer(layer); } catch (e) {}
      });
      markerLayers.forEach(layer => {
        try { map.removeLayer(layer); } catch (e) {}
      });
      setPathLayers([]);
      setMarkerLayers([]);
    }
  }, [enabled, map, heatmapLayer, pathLayers, markerLayers]);

  return {
    paths: pathLayers,
    markers: markerLayers,
    spotCount: wsprData.length,
    filteredCount: wsprData.filter(s => (s.snr || -30) >= snrThreshold).length,
    filters: { bandFilter, timeWindow, snrThreshold, showAnimation, showHeatmap, pathOpacity, heatmapOpacity }
  };
}
