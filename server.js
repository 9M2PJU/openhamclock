/**
 * OpenHamClock Server
 * 
 * Express server that:
 * 1. Serves the static web application
 * 2. Proxies API requests to avoid CORS issues
 * 3. Provides WebSocket support for future real-time features
 * 
 * Usage:
 *   node server.js
 *   PORT=8080 node server.js
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// API PROXY ENDPOINTS
// ============================================

// NOAA Space Weather - Solar Flux
app.get('/api/noaa/flux', async (req, res) => {
  try {
    const response = await fetch('https://services.swpc.noaa.gov/json/f107_cm_flux.json');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('NOAA Flux API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch solar flux data' });
  }
});

// NOAA Space Weather - K-Index
app.get('/api/noaa/kindex', async (req, res) => {
  try {
    const response = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('NOAA K-Index API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch K-index data' });
  }
});

// NOAA Space Weather - Sunspots
app.get('/api/noaa/sunspots', async (req, res) => {
  try {
    const response = await fetch('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('NOAA Sunspots API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch sunspot data' });
  }
});

// Solar Indices with History and Kp Forecast
app.get('/api/solar-indices', async (req, res) => {
  try {
    const [fluxRes, kIndexRes, kForecastRes, sunspotRes] = await Promise.allSettled([
      fetch('https://services.swpc.noaa.gov/json/f107_cm_flux.json'),
      fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'),
      fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json'),
      fetch('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json')
    ]);

    const result = {
      sfi: { current: null, history: [] },
      kp: { current: null, history: [], forecast: [] },
      ssn: { current: null, history: [] },
      timestamp: new Date().toISOString()
    };

    // Process SFI data (last 30 days)
    if (fluxRes.status === 'fulfilled' && fluxRes.value.ok) {
      const data = await fluxRes.value.json();
      if (data?.length) {
        // Get last 30 entries
        const recent = data.slice(-30);
        result.sfi.history = recent.map(d => ({
          date: d.time_tag || d.date,
          value: Math.round(d.flux || d.value || 0)
        }));
        result.sfi.current = result.sfi.history[result.sfi.history.length - 1]?.value || null;
      }
    }

    // Process Kp history (last 3 days, data comes in 3-hour intervals)
    if (kIndexRes.status === 'fulfilled' && kIndexRes.value.ok) {
      const data = await kIndexRes.value.json();
      if (data?.length > 1) {
        // Skip header row, get last 24 entries (3 days)
        const recent = data.slice(1).slice(-24);
        result.kp.history = recent.map(d => ({
          time: d[0],
          value: parseFloat(d[1]) || 0
        }));
        result.kp.current = result.kp.history[result.kp.history.length - 1]?.value || null;
      }
    }

    // Process Kp forecast
    if (kForecastRes.status === 'fulfilled' && kForecastRes.value.ok) {
      const data = await kForecastRes.value.json();
      if (data?.length > 1) {
        // Skip header row
        result.kp.forecast = data.slice(1).map(d => ({
          time: d[0],
          value: parseFloat(d[1]) || 0
        }));
      }
    }

    // Process Sunspot data (last 12 months)
    if (sunspotRes.status === 'fulfilled' && sunspotRes.value.ok) {
      const data = await sunspotRes.value.json();
      if (data?.length) {
        // Get last 12 entries (monthly data)
        const recent = data.slice(-12);
        result.ssn.history = recent.map(d => ({
          date: `${d['time-tag'] || d.time_tag || ''}`,
          value: Math.round(d.ssn || 0)
        }));
        result.ssn.current = result.ssn.history[result.ssn.history.length - 1]?.value || null;
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Solar Indices API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch solar indices' });
  }
});

// DXpedition Calendar - fetches from NG3K ADXO plain text version
let dxpeditionCache = { data: null, timestamp: 0, maxAge: 30 * 60 * 1000 }; // 30 min cache

app.get('/api/dxpeditions', async (req, res) => {
  try {
    const now = Date.now();
    console.log('[DXpeditions] API called');
    
    // Return cached data if fresh
    if (dxpeditionCache.data && (now - dxpeditionCache.timestamp) < dxpeditionCache.maxAge) {
      console.log('[DXpeditions] Returning cached data:', dxpeditionCache.data.dxpeditions?.length, 'entries');
      return res.json(dxpeditionCache.data);
    }
    
    // Fetch NG3K ADXO plain text version
    console.log('[DXpeditions] Fetching from NG3K...');
    const response = await fetch('https://www.ng3k.com/Misc/adxoplain.html');
    if (!response.ok) {
      console.log('[DXpeditions] NG3K fetch failed:', response.status);
      throw new Error('Failed to fetch NG3K: ' + response.status);
    }
    
    let text = await response.text();
    console.log('[DXpeditions] Received', text.length, 'bytes raw');
    
    // Strip HTML tags and decode entities - the "plain" page is actually HTML!
    text = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove styles  
      .replace(/<br\s*\/?>/gi, '\n') // Convert br to newlines
      .replace(/<[^>]+>/g, ' ') // Remove all HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
    
    console.log('[DXpeditions] Cleaned text length:', text.length);
    console.log('[DXpeditions] First 500 chars:', text.substring(0, 500));
    
    const dxpeditions = [];
    
    // Each entry starts with a date pattern like "Jan 1-Feb 16, 2026 DXCC:"
    // Split on date patterns that are followed by DXCC
    const entryPattern = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}[^D]*?DXCC:[^·]+?)(?=(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}|$)/gi;
    const entries = text.match(entryPattern) || [];
    
    console.log('[DXpeditions] Found', entries.length, 'potential entries');
    
    // Log first 3 entries for debugging
    entries.slice(0, 3).forEach((e, i) => {
      console.log(`[DXpeditions] Entry ${i}:`, e.substring(0, 150));
    });
    
    for (const entry of entries) {
      if (!entry.trim()) continue;
      
      // Skip header/footer/legend content
      if (entry.includes('ADXB=') || entry.includes('OPDX=') || entry.includes('425DX=') ||
          entry.includes('Last updated') || entry.includes('Copyright') || 
          entry.includes('Expired Announcements') || entry.includes('Table Version') ||
          entry.includes('About ADXO') || entry.includes('Search ADXO') ||
          entry.includes('GazDX=') || entry.includes('LNDX=') || entry.includes('TDDX=') ||
          entry.includes('DXW.Net=') || entry.includes('DXMB=')) continue;
      
      // Try multiple parsing strategies
      let callsign = null;
      let entity = null;
      let qsl = null;
      let info = null;
      let dateStr = null;
      
      // Strategy 1: "DXCC: xxx Callsign: xxx" format
      const dxccMatch = entry.match(/DXCC:\s*([^C\n]+?)(?=Callsign:|QSL:|Source:|Info:|$)/i);
      const callMatch = entry.match(/Callsign:\s*([A-Z0-9\/]+)/i);
      
      if (callMatch && dxccMatch) {
        callsign = callMatch[1].trim().toUpperCase();
        entity = dxccMatch[1].trim();
      }
      
      // Strategy 2: Look for callsign patterns directly (like "3Y0K" or "VP8/G3ABC")
      if (!callsign) {
        const directCallMatch = entry.match(/\b([A-Z]{1,2}\d[A-Z0-9]*[A-Z](?:\/[A-Z0-9]+)?)\b/);
        if (directCallMatch) {
          callsign = directCallMatch[1];
        }
      }
      
      // Strategy 3: Parse "Entity - Callsign" or similar patterns
      if (!callsign) {
        const altMatch = entry.match(/([A-Za-z\s&]+?)\s*[-–:]\s*([A-Z]{1,2}\d[A-Z0-9]*)/);
        if (altMatch) {
          entity = altMatch[1].trim();
          callsign = altMatch[2].trim();
        }
      }
      
      // Extract other fields
      const qslMatch = entry.match(/QSL:\s*([A-Za-z0-9]+)/i);
      const infoMatch = entry.match(/Info:\s*(.+)/i);
      // Date is at the start of entry: "Jan 1-Feb 16, 2026"
      const dateMatch = entry.match(/^([A-Za-z]{3}\s+\d{1,2}[^D]*?)(?=DXCC:)/i);
      
      qsl = qslMatch ? qslMatch[1].trim() : '';
      info = infoMatch ? infoMatch[1].trim() : '';
      dateStr = dateMatch ? dateMatch[1].trim() : '';
      
      // Skip if we couldn't find a callsign
      if (!callsign || callsign.length < 3) continue;
      
      // Skip obviously wrong matches
      if (/^(DXCC|QSL|INFO|SOURCE|THE|AND|FOR)$/i.test(callsign)) continue;
      
      // Log first few successful parses
      if (dxpeditions.length < 3) {
        console.log(`[DXpeditions] Parsed: ${callsign} - ${entity} - ${dateStr}`);
      }
      
      // Try to extract entity from context if not found
      if (!entity && info) {
        // Look for "from Entity" or "fm Entity" patterns
        const fromMatch = info.match(/(?:from|fm)\s+([A-Za-z\s]+?)(?:;|,|$)/i);
        if (fromMatch) entity = fromMatch[1].trim();
      }
      
      // Parse dates
      let startDate = null;
      let endDate = null;
      let isActive = false;
      let isUpcoming = false;
      
      if (dateStr) {
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const datePattern = /([A-Za-z]{3})\s+(\d{1,2})(?:,?\s*(\d{4}))?(?:\s*[-–]\s*([A-Za-z]{3})?\s*(\d{1,2})(?:,?\s*(\d{4}))?)?/i;
        const dateParsed = dateStr.match(datePattern);
        
        if (dateParsed) {
          const currentYear = new Date().getFullYear();
          const startMonth = monthNames.indexOf(dateParsed[1].toLowerCase());
          const startDay = parseInt(dateParsed[2]);
          const startYear = dateParsed[3] ? parseInt(dateParsed[3]) : currentYear;
          
          const endMonthStr = dateParsed[4] || dateParsed[1];
          const endMonth = monthNames.indexOf(endMonthStr.toLowerCase());
          const endDay = parseInt(dateParsed[5]) || startDay + 14;
          const endYear = dateParsed[6] ? parseInt(dateParsed[6]) : startYear;
          
          if (startMonth >= 0) {
            startDate = new Date(startYear, startMonth, startDay);
            endDate = new Date(endYear, endMonth >= 0 ? endMonth : startMonth, endDay);
            
            if (endDate < startDate && !dateParsed[6]) {
              endDate.setFullYear(endYear + 1);
            }
            
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            isActive = startDate <= today && endDate >= today;
            isUpcoming = startDate > today;
          }
        }
      }
      
      // Extract bands and modes
      const bandsMatch = entry.match(/(\d+(?:-\d+)?m)/g);
      const bands = bandsMatch ? [...new Set(bandsMatch)].join(' ') : '';
      
      const modesMatch = entry.match(/\b(CW|SSB|FT8|FT4|RTTY|PSK|FM|AM|DIGI)\b/gi);
      const modes = modesMatch ? [...new Set(modesMatch.map(m => m.toUpperCase()))].join(' ') : '';
      
      dxpeditions.push({
        callsign,
        entity: entity || 'Unknown',
        dates: dateStr,
        qsl,
        info: (info || '').substring(0, 100),
        bands,
        modes,
        startDate: startDate?.toISOString(),
        endDate: endDate?.toISOString(),
        isActive,
        isUpcoming
      });
    }
    
    // Remove duplicates by callsign
    const seen = new Set();
    const uniqueDxpeditions = dxpeditions.filter(d => {
      if (seen.has(d.callsign)) return false;
      seen.add(d.callsign);
      return true;
    });
    
    // Sort: active first, then upcoming by start date
    uniqueDxpeditions.sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      if (a.isUpcoming && !b.isUpcoming) return -1;
      if (!a.isUpcoming && b.isUpcoming) return 1;
      if (a.startDate && b.startDate) return new Date(a.startDate) - new Date(b.startDate);
      return 0;
    });
    
    console.log('[DXpeditions] Parsed', uniqueDxpeditions.length, 'unique entries');
    if (uniqueDxpeditions.length > 0) {
      console.log('[DXpeditions] First entry:', JSON.stringify(uniqueDxpeditions[0]));
    }
    
    const result = {
      dxpeditions: uniqueDxpeditions.slice(0, 50),
      active: uniqueDxpeditions.filter(d => d.isActive).length,
      upcoming: uniqueDxpeditions.filter(d => d.isUpcoming).length,
      source: 'NG3K ADXO',
      timestamp: new Date().toISOString()
    };
    
    console.log('[DXpeditions] Result:', result.active, 'active,', result.upcoming, 'upcoming');
    
    dxpeditionCache.data = result;
    dxpeditionCache.timestamp = now;
    
    res.json(result);
  } catch (error) {
    console.error('[DXpeditions] API error:', error.message);
    
    if (dxpeditionCache.data) {
      console.log('[DXpeditions] Returning stale cache');
      return res.json({ ...dxpeditionCache.data, stale: true });
    }
    
    res.status(500).json({ error: 'Failed to fetch DXpedition data' });
  }
});

// NOAA Space Weather - X-Ray Flux
app.get('/api/noaa/xray', async (req, res) => {
  try {
    const response = await fetch('https://services.swpc.noaa.gov/json/goes/primary/xrays-7-day.json');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('NOAA X-Ray API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch X-ray data' });
  }
});

// POTA Spots
app.get('/api/pota/spots', async (req, res) => {
  try {
    const response = await fetch('https://api.pota.app/spot/activator');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('POTA API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch POTA spots' });
  }
});

// SOTA Spots
app.get('/api/sota/spots', async (req, res) => {
  try {
    const response = await fetch('https://api2.sota.org.uk/api/spots/50/all');
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('SOTA API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch SOTA spots' });
  }
});

// HamQSL Band Conditions
app.get('/api/hamqsl/conditions', async (req, res) => {
  try {
    const response = await fetch('https://www.hamqsl.com/solarxml.php');
    const text = await response.text();
    res.set('Content-Type', 'application/xml');
    res.send(text);
  } catch (error) {
    console.error('HamQSL API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch band conditions' });
  }
});

// DX Cluster proxy - fetches from selectable sources
// Query param: ?source=hamqth|dxspider|auto (default: auto)
// Note: DX Spider uses telnet - works locally but may be blocked on cloud hosting

// Cache for DX Spider telnet spots (to avoid excessive connections)
let dxSpiderCache = { spots: [], timestamp: 0 };
const DXSPIDER_CACHE_TTL = 60000; // 60 seconds cache

app.get('/api/dxcluster/spots', async (req, res) => {
  const source = (req.query.source || 'auto').toLowerCase();
  
  // Helper function for HamQTH (HTTP-based, works everywhere)
  async function fetchHamQTH() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    try {
      const response = await fetch('https://www.hamqth.com/dxc_csv.php?limit=25', {
        headers: { 'User-Agent': 'OpenHamClock/3.5' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (response.ok) {
        const text = await response.text();
        // HamQTH CSV format: Spotter^Frequency^DXCall^Comment^TimeDate^^^Continent^Band^Country^DXCC
        // Example: KF0NYM^18070.0^TX5U^Correction, Good Sig MO, 73^2149 2025-05-27^^^EU^17M^France^227
        const lines = text.trim().split('\n').filter(line => line.includes('^'));
        
        if (lines.length > 0) {
          const spots = lines.slice(0, 25).map(line => {
            const parts = line.split('^');
            const spotter = parts[0] || '';
            const freqKhz = parseFloat(parts[1]) || 0;
            const dxCall = parts[2] || 'UNKNOWN';
            const comment = parts[3] || '';
            const timeDate = parts[4] || '';
            
            // Frequency: convert from kHz to MHz
            const freqMhz = freqKhz > 1000 ? (freqKhz / 1000).toFixed(3) : String(freqKhz);
            
            // Time: extract HHMM from "2149 2025-05-27" format
            let time = '';
            if (timeDate && timeDate.length >= 4) {
              const timeStr = timeDate.substring(0, 4);
              time = timeStr.substring(0, 2) + ':' + timeStr.substring(2, 4) + 'z';
            }
            
            return {
              freq: freqMhz,
              call: dxCall,
              comment: comment,
              time: time,
              spotter: spotter,
              source: 'HamQTH'
            };
          });
          console.log('[DX Cluster] HamQTH:', spots.length, 'spots');
          return spots;
        }
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error.name !== 'AbortError') {
        console.error('[DX Cluster] HamQTH error:', error.message);
      }
    }
    return null;
  }
  
  // Helper function for DX Spider (telnet-based, works locally/Pi)
  async function fetchDXSpider() {
    // Check cache first
    if (Date.now() - dxSpiderCache.timestamp < DXSPIDER_CACHE_TTL && dxSpiderCache.spots.length > 0) {
      console.log('[DX Cluster] DX Spider: returning', dxSpiderCache.spots.length, 'cached spots');
      return dxSpiderCache.spots;
    }
    
    return new Promise((resolve) => {
      const spots = [];
      let buffer = '';
      let loginSent = false;
      let commandSent = false;
      
      const client = new net.Socket();
      client.setTimeout(15000);
      
      // Try connecting to DX Spider node
      client.connect(7300, 'dxspider.co.uk', () => {
        console.log('[DX Cluster] DX Spider: connected to dxspider.co.uk:7300');
      });
      
      client.on('data', (data) => {
        buffer += data.toString();
        
        // Wait for login prompt
        if (!loginSent && (buffer.includes('login:') || buffer.includes('Please enter your call') || buffer.includes('enter your callsign'))) {
          loginSent = true;
          client.write('GUEST\r\n');
          console.log('[DX Cluster] DX Spider: sent login');
          return;
        }
        
        // Wait for prompt after login, then send command
        if (loginSent && !commandSent && (buffer.includes('Hello') || buffer.includes('de ') || buffer.includes('>') || buffer.includes('GUEST'))) {
          commandSent = true;
          setTimeout(() => {
            client.write('sh/dx 25\r\n');
            console.log('[DX Cluster] DX Spider: sent sh/dx 25');
          }, 1000);
          return;
        }
        
        // Parse DX spots from the output
        // Format: DX de W3LPL:     14195.0  TI5/AA8HH    FT8 -09 dB           1234Z
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.includes('DX de ')) {
            const match = line.match(/DX de ([A-Z0-9\/\-]+):\s+(\d+\.?\d*)\s+([A-Z0-9\/\-]+)\s+(.+?)\s+(\d{4})Z/i);
            if (match) {
              const spotter = match[1].replace(':', '');
              const freqKhz = parseFloat(match[2]);
              const dxCall = match[3];
              const comment = match[4].trim();
              const timeStr = match[5];
              
              if (!isNaN(freqKhz) && freqKhz > 0 && dxCall) {
                const freqMhz = (freqKhz / 1000).toFixed(3);
                const time = timeStr.substring(0, 2) + ':' + timeStr.substring(2, 4) + 'z';
                
                // Avoid duplicates
                if (!spots.find(s => s.call === dxCall && s.freq === freqMhz)) {
                  spots.push({
                    freq: freqMhz,
                    call: dxCall,
                    comment: comment,
                    time: time,
                    spotter: spotter,
                    source: 'DX Spider'
                  });
                }
              }
            }
          }
        }
        
        // If we have enough spots, close connection
        if (spots.length >= 20) {
          client.write('bye\r\n');
          setTimeout(() => client.destroy(), 500);
        }
      });
      
      client.on('timeout', () => {
        console.log('[DX Cluster] DX Spider: timeout');
        client.destroy();
      });
      
      client.on('error', (err) => {
        console.error('[DX Cluster] DX Spider error:', err.message);
        client.destroy();
      });
      
      client.on('close', () => {
        if (spots.length > 0) {
          console.log('[DX Cluster] DX Spider:', spots.length, 'spots');
          dxSpiderCache = { spots: spots, timestamp: Date.now() };
          resolve(spots);
        } else {
          console.log('[DX Cluster] DX Spider: no spots received');
          resolve(null);
        }
      });
      
      // Fallback timeout - close after 20 seconds regardless
      setTimeout(() => {
        if (spots.length > 0) {
          client.destroy();
        } else if (client.readable) {
          client.destroy();
          resolve(null);
        }
      }, 20000);
    });
  }
  
  // Fetch based on selected source
  let spots = null;
  
  if (source === 'hamqth') {
    spots = await fetchHamQTH();
  } else if (source === 'dxspider') {
    spots = await fetchDXSpider();
    // Fallback to HamQTH if DX Spider fails
    if (!spots) {
      console.log('[DX Cluster] DX Spider failed, falling back to HamQTH');
      spots = await fetchHamQTH();
    }
  } else {
    // Auto mode - try HamQTH first (most reliable), then DX Spider
    spots = await fetchHamQTH();
    if (!spots) {
      spots = await fetchDXSpider();
    }
  }
  
  res.json(spots || []);
});

// Get available DX cluster sources
app.get('/api/dxcluster/sources', (req, res) => {
  res.json([
    { id: 'auto', name: 'Auto (Best Available)', description: 'Tries HamQTH first, then DX Spider' },
    { id: 'hamqth', name: 'HamQTH', description: 'HamQTH.com CSV feed (HTTP, works everywhere)' },
    { id: 'dxspider', name: 'DX Spider (G6NHU)', description: 'Telnet to dxspider.co.uk:7300 (works locally/Pi, may fail on cloud hosting)' }
  ]);
});

// ============================================
// DX SPOT PATHS API - Get spots with locations for map visualization
// Returns spots from the last 5 minutes with spotter and DX locations
// ============================================

// Cache for DX spot paths to avoid excessive lookups
let dxSpotPathsCache = { paths: [], allPaths: [], timestamp: 0 };
const DXPATHS_CACHE_TTL = 5000; // 5 seconds cache between fetches
const DXPATHS_RETENTION = 30 * 60 * 1000; // 30 minute spot retention

app.get('/api/dxcluster/paths', async (req, res) => {
  // Check cache first
  if (Date.now() - dxSpotPathsCache.timestamp < DXPATHS_CACHE_TTL && dxSpotPathsCache.paths.length > 0) {
    console.log('[DX Paths] Returning', dxSpotPathsCache.paths.length, 'cached paths');
    return res.json(dxSpotPathsCache.paths);
  }
  
  try {
    // Get recent DX spots from HamQTH
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch('https://www.hamqth.com/dxc_csv.php?limit=50', {
      headers: { 'User-Agent': 'OpenHamClock/3.7' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    const now = Date.now();
    
    if (!response.ok) {
      // Return existing paths if fetch failed
      const validPaths = dxSpotPathsCache.allPaths.filter(p => (now - p.timestamp) < DXPATHS_RETENTION);
      return res.json(validPaths.slice(0, 50));
    }
    
    const text = await response.text();
    const lines = text.trim().split('\n').filter(line => line.includes('^'));
    
    // Parse new spots
    const newSpots = [];
    
    for (const line of lines) {
      const parts = line.split('^');
      if (parts.length < 5) continue;
      
      const spotter = parts[0]?.trim().toUpperCase();
      const freqKhz = parseFloat(parts[1]) || 0;
      const dxCall = parts[2]?.trim().toUpperCase();
      const comment = parts[3]?.trim() || '';
      const timeDate = parts[4]?.trim() || '';
      
      if (!spotter || !dxCall || freqKhz <= 0) continue;
      
      newSpots.push({
        spotter,
        dxCall,
        freq: (freqKhz / 1000).toFixed(3),
        comment,
        time: timeDate.length >= 4 ? timeDate.substring(0, 2) + ':' + timeDate.substring(2, 4) + 'z' : '',
        id: `${dxCall}-${freqKhz}-${spotter}`
      });
    }
    
    // Get unique callsigns to look up
    const allCalls = new Set();
    newSpots.forEach(s => {
      allCalls.add(s.spotter);
      allCalls.add(s.dxCall);
    });
    
    // Look up locations for all callsigns
    const locations = {};
    const callsToLookup = [...allCalls].slice(0, 40);
    
    for (const call of callsToLookup) {
      const loc = estimateLocationFromPrefix(call);
      if (loc) {
        locations[call] = { lat: loc.lat, lon: loc.lon, country: loc.country };
      }
    }
    
    // Build new paths with locations
    const newPaths = newSpots
      .map(spot => {
        const spotterLoc = locations[spot.spotter];
        const dxLoc = locations[spot.dxCall];
        
        if (spotterLoc && dxLoc) {
          return {
            spotter: spot.spotter,
            spotterLat: spotterLoc.lat,
            spotterLon: spotterLoc.lon,
            spotterCountry: spotterLoc.country,
            dxCall: spot.dxCall,
            dxLat: dxLoc.lat,
            dxLon: dxLoc.lon,
            dxCountry: dxLoc.country,
            freq: spot.freq,
            comment: spot.comment,
            time: spot.time,
            id: spot.id,
            timestamp: now
          };
        }
        return null;
      })
      .filter(p => p !== null);
    
    // Merge with existing paths, removing expired and duplicates
    const existingValidPaths = dxSpotPathsCache.allPaths.filter(p => 
      (now - p.timestamp) < DXPATHS_RETENTION
    );
    
    // Add new paths, avoiding duplicates (same dxCall+freq within 2 minutes)
    const mergedPaths = [...existingValidPaths];
    for (const newPath of newPaths) {
      const isDuplicate = mergedPaths.some(existing => 
        existing.dxCall === newPath.dxCall && 
        existing.freq === newPath.freq &&
        (now - existing.timestamp) < 120000 // 2 minute dedup window
      );
      if (!isDuplicate) {
        mergedPaths.push(newPath);
      }
    }
    
    // Sort by timestamp (newest first) and limit
    const sortedPaths = mergedPaths.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
    
    console.log('[DX Paths]', sortedPaths.length, 'total paths (', newPaths.length, 'new from', newSpots.length, 'spots)');
    
    // Update cache
    dxSpotPathsCache = { 
      paths: sortedPaths.slice(0, 50), // Return 50 for display
      allPaths: sortedPaths, // Keep all for accumulation
      timestamp: now 
    };
    
    res.json(dxSpotPathsCache.paths);
  } catch (error) {
    console.error('[DX Paths] Error:', error.message);
    // Return cached data on error
    res.json(dxSpotPathsCache.paths || []);
  }
});

// ============================================
// CALLSIGN LOOKUP API (for getting location from callsign)
// ============================================

// Simple callsign to grid/location lookup using HamQTH
app.get('/api/callsign/:call', async (req, res) => {
  const callsign = req.params.call.toUpperCase();
  console.log('[Callsign Lookup] Looking up:', callsign);
  
  try {
    // Try HamQTH XML API (no auth needed for basic lookup)
    const response = await fetch(`https://www.hamqth.com/dxcc.php?callsign=${callsign}`);
    if (response.ok) {
      const text = await response.text();
      
      // Parse basic info from response
      const latMatch = text.match(/<lat>([^<]+)<\/lat>/);
      const lonMatch = text.match(/<lng>([^<]+)<\/lng>/);
      const countryMatch = text.match(/<name>([^<]+)<\/name>/);
      const cqMatch = text.match(/<cq>([^<]+)<\/cq>/);
      const ituMatch = text.match(/<itu>([^<]+)<\/itu>/);
      
      if (latMatch && lonMatch) {
        const result = {
          callsign,
          lat: parseFloat(latMatch[1]),
          lon: parseFloat(lonMatch[1]),
          country: countryMatch ? countryMatch[1] : 'Unknown',
          cqZone: cqMatch ? cqMatch[1] : '',
          ituZone: ituMatch ? ituMatch[1] : ''
        };
        console.log('[Callsign Lookup] Found:', result);
        return res.json(result);
      }
    }
    
    // Fallback: estimate location from callsign prefix
    const estimated = estimateLocationFromPrefix(callsign);
    if (estimated) {
      console.log('[Callsign Lookup] Estimated from prefix:', estimated);
      return res.json(estimated);
    }
    
    res.status(404).json({ error: 'Callsign not found' });
  } catch (error) {
    console.error('[Callsign Lookup] Error:', error.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// Estimate location from callsign prefix (fallback)
function estimateLocationFromPrefix(callsign) {
  const prefixLocations = {
    'K': { lat: 39.8, lon: -98.5, country: 'USA' },
    'W': { lat: 39.8, lon: -98.5, country: 'USA' },
    'N': { lat: 39.8, lon: -98.5, country: 'USA' },
    'AA': { lat: 39.8, lon: -98.5, country: 'USA' },
    'AB': { lat: 39.8, lon: -98.5, country: 'USA' },
    'VE': { lat: 56.1, lon: -106.3, country: 'Canada' },
    'VA': { lat: 56.1, lon: -106.3, country: 'Canada' },
    'G': { lat: 52.4, lon: -1.5, country: 'England' },
    'M': { lat: 52.4, lon: -1.5, country: 'England' },
    'F': { lat: 46.2, lon: 2.2, country: 'France' },
    'DL': { lat: 51.2, lon: 10.4, country: 'Germany' },
    'DJ': { lat: 51.2, lon: 10.4, country: 'Germany' },
    'DK': { lat: 51.2, lon: 10.4, country: 'Germany' },
    'I': { lat: 41.9, lon: 12.6, country: 'Italy' },
    'JA': { lat: 36.2, lon: 138.3, country: 'Japan' },
    'JH': { lat: 36.2, lon: 138.3, country: 'Japan' },
    'JR': { lat: 36.2, lon: 138.3, country: 'Japan' },
    'VK': { lat: -25.3, lon: 133.8, country: 'Australia' },
    'ZL': { lat: -40.9, lon: 174.9, country: 'New Zealand' },
    'ZS': { lat: -30.6, lon: 22.9, country: 'South Africa' },
    'LU': { lat: -38.4, lon: -63.6, country: 'Argentina' },
    'PY': { lat: -14.2, lon: -51.9, country: 'Brazil' },
    'EA': { lat: 40.5, lon: -3.7, country: 'Spain' },
    'CT': { lat: 39.4, lon: -8.2, country: 'Portugal' },
    'PA': { lat: 52.1, lon: 5.3, country: 'Netherlands' },
    'ON': { lat: 50.5, lon: 4.5, country: 'Belgium' },
    'OZ': { lat: 56.3, lon: 9.5, country: 'Denmark' },
    'SM': { lat: 60.1, lon: 18.6, country: 'Sweden' },
    'LA': { lat: 60.5, lon: 8.5, country: 'Norway' },
    'OH': { lat: 61.9, lon: 25.7, country: 'Finland' },
    'UA': { lat: 61.5, lon: 105.3, country: 'Russia' },
    'RU': { lat: 61.5, lon: 105.3, country: 'Russia' },
    'RA': { lat: 61.5, lon: 105.3, country: 'Russia' },
    'BY': { lat: 35.9, lon: 104.2, country: 'China' },
    'BV': { lat: 23.7, lon: 121.0, country: 'Taiwan' },
    'HL': { lat: 35.9, lon: 127.8, country: 'South Korea' },
    'VU': { lat: 20.6, lon: 79.0, country: 'India' },
    'HS': { lat: 15.9, lon: 100.9, country: 'Thailand' },
    'DU': { lat: 12.9, lon: 121.8, country: 'Philippines' },
    'YB': { lat: -0.8, lon: 113.9, country: 'Indonesia' },
    '9V': { lat: 1.4, lon: 103.8, country: 'Singapore' },
    '9M': { lat: 4.2, lon: 101.9, country: 'Malaysia' }
  };
  
  // Try 2-char prefix first, then 1-char
  const prefix2 = callsign.substring(0, 2);
  const prefix1 = callsign.substring(0, 1);
  
  if (prefixLocations[prefix2]) {
    return { callsign, ...prefixLocations[prefix2], estimated: true };
  }
  if (prefixLocations[prefix1]) {
    return { callsign, ...prefixLocations[prefix1], estimated: true };
  }
  
  return null;
}

// ============================================
// MY SPOTS API - Get spots involving a specific callsign
// ============================================

app.get('/api/myspots/:callsign', async (req, res) => {
  const callsign = req.params.callsign.toUpperCase();
  console.log('[My Spots] Searching for callsign:', callsign);
  
  const mySpots = [];
  
  try {
    // Try HamQTH for spots involving this callsign
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(
      `https://www.hamqth.com/dxc_csv.php?limit=100`,
      {
        headers: { 'User-Agent': 'OpenHamClock/3.3' },
        signal: controller.signal
      }
    );
    clearTimeout(timeout);
    
    if (response.ok) {
      const text = await response.text();
      const lines = text.trim().split('\n');
      
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split('^');
        if (parts.length < 3) continue;
        
        const spotter = parts[0]?.trim().toUpperCase();
        const dxCall = parts[2]?.trim().toUpperCase();
        const freq = parts[1]?.trim();
        const comment = parts[3]?.trim() || '';
        const timeStr = parts[4]?.trim() || '';
        
        // Check if our callsign is involved (as spotter or spotted)
        if (spotter === callsign || dxCall === callsign || 
            spotter.includes(callsign) || dxCall.includes(callsign)) {
          mySpots.push({
            spotter,
            dxCall,
            freq: freq ? (parseFloat(freq) / 1000).toFixed(3) : '0.000',
            comment,
            time: timeStr ? timeStr.substring(0, 5) + 'z' : '',
            isMySpot: spotter.includes(callsign),
            isSpottedMe: dxCall.includes(callsign)
          });
        }
      }
    }
    
    console.log('[My Spots] Found', mySpots.length, 'spots involving', callsign);
    
    // Now try to get locations for each unique callsign
    const uniqueCalls = [...new Set(mySpots.map(s => s.isMySpot ? s.dxCall : s.spotter))];
    const locations = {};
    
    for (const call of uniqueCalls.slice(0, 10)) { // Limit to 10 lookups
      try {
        const loc = estimateLocationFromPrefix(call);
        if (loc) {
          locations[call] = { lat: loc.lat, lon: loc.lon, country: loc.country };
        }
      } catch (e) {
        // Ignore lookup errors
      }
    }
    
    // Add locations to spots
    const spotsWithLocations = mySpots.map(spot => {
      const targetCall = spot.isMySpot ? spot.dxCall : spot.spotter;
      const loc = locations[targetCall];
      return {
        ...spot,
        targetCall,
        lat: loc?.lat,
        lon: loc?.lon,
        country: loc?.country
      };
    }).filter(s => s.lat && s.lon); // Only return spots with valid locations
    
    res.json(spotsWithLocations);
  } catch (error) {
    console.error('[My Spots] Error:', error.message);
    res.json([]);
  }
});

// ============================================
// SATELLITE TRACKING API
// ============================================

// Ham radio satellites - NORAD IDs
const HAM_SATELLITES = {
  'ISS': { norad: 25544, name: 'ISS (ZARYA)', color: '#00ffff', priority: 1 },
  'AO-91': { norad: 43017, name: 'AO-91 (Fox-1B)', color: '#ff6600', priority: 2 },
  'AO-92': { norad: 43137, name: 'AO-92 (Fox-1D)', color: '#ff9900', priority: 2 },
  'SO-50': { norad: 27607, name: 'SO-50 (SaudiSat)', color: '#00ff00', priority: 2 },
  'RS-44': { norad: 44909, name: 'RS-44 (DOSAAF)', color: '#ff0066', priority: 2 },
  'IO-117': { norad: 53106, name: 'IO-117 (GreenCube)', color: '#00ff99', priority: 3 },
  'CAS-4A': { norad: 42761, name: 'CAS-4A (ZHUHAI-1 01)', color: '#9966ff', priority: 3 },
  'CAS-4B': { norad: 42759, name: 'CAS-4B (ZHUHAI-1 02)', color: '#9933ff', priority: 3 },
  'PO-101': { norad: 43678, name: 'PO-101 (Diwata-2)', color: '#ff3399', priority: 3 },
  'TEVEL': { norad: 50988, name: 'TEVEL-1', color: '#66ccff', priority: 4 }
};

// Cache for TLE data (refresh every 6 hours)
let tleCache = { data: null, timestamp: 0 };
const TLE_CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

app.get('/api/satellites/tle', async (req, res) => {
  console.log('[Satellites] Fetching TLE data...');
  
  try {
    const now = Date.now();
    
    // Return cached data if fresh
    if (tleCache.data && (now - tleCache.timestamp) < TLE_CACHE_DURATION) {
      console.log('[Satellites] Returning cached TLE data');
      return res.json(tleCache.data);
    }
    
    // Fetch fresh TLE data from CelesTrak
    const tleData = {};
    
    // Fetch amateur radio satellites TLE
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch(
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle',
      {
        headers: { 'User-Agent': 'OpenHamClock/3.3' },
        signal: controller.signal
      }
    );
    clearTimeout(timeout);
    
    if (response.ok) {
      const text = await response.text();
      const lines = text.trim().split('\n');
      
      // Parse TLE data (3 lines per satellite: name, line1, line2)
      for (let i = 0; i < lines.length - 2; i += 3) {
        const name = lines[i].trim();
        const line1 = lines[i + 1]?.trim();
        const line2 = lines[i + 2]?.trim();
        
        if (line1 && line2 && line1.startsWith('1 ') && line2.startsWith('2 ')) {
          // Extract NORAD ID from line 1
          const noradId = parseInt(line1.substring(2, 7));
          
          // Check if this is a satellite we care about
          for (const [key, sat] of Object.entries(HAM_SATELLITES)) {
            if (sat.norad === noradId) {
              tleData[key] = {
                ...sat,
                tle1: line1,
                tle2: line2
              };
              console.log('[Satellites] Found TLE for:', key, noradId);
            }
          }
        }
      }
    }
    
    // Also try to get ISS specifically (it's in the stations group)
    if (!tleData['ISS']) {
      try {
        const issResponse = await fetch(
          'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle',
          { headers: { 'User-Agent': 'OpenHamClock/3.3' } }
        );
        if (issResponse.ok) {
          const issText = await issResponse.text();
          const issLines = issText.trim().split('\n');
          if (issLines.length >= 3) {
            tleData['ISS'] = {
              ...HAM_SATELLITES['ISS'],
              tle1: issLines[1].trim(),
              tle2: issLines[2].trim()
            };
            console.log('[Satellites] Found ISS TLE');
          }
        }
      } catch (e) {
        console.log('[Satellites] Could not fetch ISS TLE:', e.message);
      }
    }
    
    // Cache the result
    tleCache = { data: tleData, timestamp: now };
    
    console.log('[Satellites] Loaded TLE for', Object.keys(tleData).length, 'satellites');
    res.json(tleData);
    
  } catch (error) {
    console.error('[Satellites] TLE fetch error:', error.message);
    // Return cached data even if stale, or empty object
    res.json(tleCache.data || {});
  }
});

// ============================================
// IONOSONDE DATA API (Real-time ionospheric data from KC2G/GIRO)
// ============================================

// Cache for ionosonde data (refresh every 10 minutes)
let ionosondeCache = {
  data: null,
  timestamp: 0,
  maxAge: 10 * 60 * 1000 // 10 minutes
};

// Fetch real-time ionosonde data from KC2G (GIRO network)
async function fetchIonosondeData() {
  const now = Date.now();
  
  // Return cached data if fresh
  if (ionosondeCache.data && (now - ionosondeCache.timestamp) < ionosondeCache.maxAge) {
    return ionosondeCache.data;
  }
  
  try {
    const response = await fetch('https://prop.kc2g.com/api/stations.json', {
      headers: { 'User-Agent': 'OpenHamClock/3.5' },
      timeout: 15000
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    
    // Filter to only recent data (within last 2 hours) with valid readings
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const validStations = data.filter(s => {
      if (!s.fof2 || !s.station) return false;
      const stationTime = new Date(s.time);
      return stationTime > twoHoursAgo && s.cs > 0; // confidence score > 0
    }).map(s => ({
      code: s.station.code,
      name: s.station.name,
      lat: parseFloat(s.station.latitude),
      lon: parseFloat(s.station.longitude) > 180 ? parseFloat(s.station.longitude) - 360 : parseFloat(s.station.longitude),
      foF2: s.fof2,
      mufd: s.mufd, // MUF at 3000km
      hmF2: s.hmf2, // Height of F2 layer
      md: parseFloat(s.md) || 3.0, // M(3000)F2 factor
      confidence: s.cs,
      time: s.time
    }));
    
    ionosondeCache = {
      data: validStations,
      timestamp: now
    };
    
    console.log(`[Ionosonde] Fetched ${validStations.length} valid stations from KC2G`);
    return validStations;
    
  } catch (error) {
    console.error('[Ionosonde] Fetch error:', error.message);
    return ionosondeCache.data || [];
  }
}

// API endpoint to get ionosonde data
app.get('/api/ionosonde', async (req, res) => {
  try {
    const stations = await fetchIonosondeData();
    res.json({
      count: stations.length,
      timestamp: new Date().toISOString(),
      stations: stations
    });
  } catch (error) {
    console.error('[Ionosonde] API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch ionosonde data' });
  }
});

// Calculate distance between two points in km
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Interpolate foF2 at a given location using inverse distance weighting
function interpolateFoF2(lat, lon, stations) {
  if (!stations || stations.length === 0) return null;
  
  // Calculate distances to all stations
  const stationsWithDist = stations.map(s => ({
    ...s,
    distance: haversineDistance(lat, lon, s.lat, s.lon)
  })).filter(s => s.foF2 > 0);
  
  if (stationsWithDist.length === 0) return null;
  
  // Sort by distance and take nearest 5
  stationsWithDist.sort((a, b) => a.distance - b.distance);
  const nearest = stationsWithDist.slice(0, 5);
  
  // If very close to a station, use its value directly
  if (nearest[0].distance < 100) {
    return {
      foF2: nearest[0].foF2,
      mufd: nearest[0].mufd,
      hmF2: nearest[0].hmF2,
      md: nearest[0].md,
      source: nearest[0].name,
      confidence: nearest[0].confidence,
      method: 'direct'
    };
  }
  
  // Inverse distance weighted interpolation
  let sumWeights = 0;
  let sumFoF2 = 0;
  let sumMufd = 0;
  let sumHmF2 = 0;
  let sumMd = 0;
  
  nearest.forEach(s => {
    const weight = (s.confidence / 100) / Math.pow(s.distance, 2);
    sumWeights += weight;
    sumFoF2 += s.foF2 * weight;
    if (s.mufd) sumMufd += s.mufd * weight;
    if (s.hmF2) sumHmF2 += s.hmF2 * weight;
    if (s.md) sumMd += s.md * weight;
  });
  
  return {
    foF2: sumFoF2 / sumWeights,
    mufd: sumMufd > 0 ? sumMufd / sumWeights : null,
    hmF2: sumHmF2 > 0 ? sumHmF2 / sumWeights : null,
    md: sumMd > 0 ? sumMd / sumWeights : 3.0,
    nearestStation: nearest[0].name,
    nearestDistance: Math.round(nearest[0].distance),
    stationsUsed: nearest.length,
    method: 'interpolated'
  };
}

// ============================================
// ENHANCED PROPAGATION PREDICTION API (ITU-R P.533 based)
// ============================================

app.get('/api/propagation', async (req, res) => {
  const { deLat, deLon, dxLat, dxLon } = req.query;
  
  console.log('[Propagation] Enhanced calculation for DE:', deLat, deLon, 'to DX:', dxLat, dxLon);
  
  try {
    // Get current space weather data
    let sfi = 150, ssn = 100, kIndex = 2;
    
    try {
      const [fluxRes, kRes] = await Promise.allSettled([
        fetch('https://services.swpc.noaa.gov/json/f107_cm_flux.json'),
        fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json')
      ]);
      
      if (fluxRes.status === 'fulfilled' && fluxRes.value.ok) {
        const data = await fluxRes.value.json();
        if (data?.length) sfi = Math.round(data[data.length - 1].flux || 150);
      }
      if (kRes.status === 'fulfilled' && kRes.value.ok) {
        const data = await kRes.value.json();
        if (data?.length > 1) kIndex = parseInt(data[data.length - 1][1]) || 2;
      }
      ssn = Math.max(0, Math.round((sfi - 67) / 0.97));
    } catch (e) {
      console.log('[Propagation] Using default solar values');
    }
    
    // Get real ionosonde data
    const ionosondeStations = await fetchIonosondeData();
    
    // Calculate path geometry
    const de = { lat: parseFloat(deLat) || 40, lon: parseFloat(deLon) || -75 };
    const dx = { lat: parseFloat(dxLat) || 35, lon: parseFloat(dxLon) || 139 };
    
    const distance = haversineDistance(de.lat, de.lon, dx.lat, dx.lon);
    const midLat = (de.lat + dx.lat) / 2;
    let midLon = (de.lon + dx.lon) / 2;
    
    // Handle antimeridian crossing
    if (Math.abs(de.lon - dx.lon) > 180) {
      midLon = (de.lon + dx.lon + 360) / 2;
      if (midLon > 180) midLon -= 360;
    }
    
    // Get ionospheric data at path midpoint
    const ionoData = interpolateFoF2(midLat, midLon, ionosondeStations);
    
    console.log('[Propagation] Distance:', Math.round(distance), 'km');
    console.log('[Propagation] Solar: SFI', sfi, 'SSN', ssn, 'K', kIndex);
    if (ionoData) {
      console.log('[Propagation] Real foF2:', ionoData.foF2?.toFixed(2), 'MHz from', ionoData.nearestStation || ionoData.source);
    }
    
    const bands = ['160m', '80m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
    const bandFreqs = [1.8, 3.5, 7, 10, 14, 18, 21, 24, 28, 50];
    const currentHour = new Date().getUTCHours();
    
    // Generate 24-hour predictions
    const predictions = {};
    
    bands.forEach((band, idx) => {
      const freq = bandFreqs[idx];
      predictions[band] = [];
      
      for (let hour = 0; hour < 24; hour++) {
        const reliability = calculateEnhancedReliability(
          freq, distance, midLat, midLon, hour, sfi, ssn, kIndex, de, dx, ionoData, currentHour
        );
        predictions[band].push({
          hour,
          reliability: Math.round(reliability),
          snr: calculateSNR(reliability)
        });
      }
    });
    
    // Current best bands
    const currentBands = bands.map((band, idx) => ({
      band,
      freq: bandFreqs[idx],
      reliability: predictions[band][currentHour].reliability,
      snr: predictions[band][currentHour].snr,
      status: getStatus(predictions[band][currentHour].reliability)
    })).sort((a, b) => b.reliability - a.reliability);
    
    // Calculate current MUF and LUF
    const currentMuf = calculateMUF(distance, midLat, midLon, currentHour, sfi, ssn, ionoData);
    const currentLuf = calculateLUF(distance, midLat, currentHour, sfi, kIndex);
    
    res.json({
      solarData: { sfi, ssn, kIndex },
      ionospheric: ionoData ? {
        foF2: ionoData.foF2?.toFixed(2),
        mufd: ionoData.mufd?.toFixed(1),
        hmF2: ionoData.hmF2?.toFixed(0),
        source: ionoData.nearestStation || ionoData.source,
        method: ionoData.method,
        stationsUsed: ionoData.stationsUsed || 1
      } : { source: 'model', method: 'estimated' },
      muf: Math.round(currentMuf * 10) / 10,
      luf: Math.round(currentLuf * 10) / 10,
      distance: Math.round(distance),
      currentHour,
      currentBands,
      hourlyPredictions: predictions,
      dataSource: ionoData ? 'KC2G/GIRO Ionosonde Network' : 'Estimated from solar indices'
    });
    
  } catch (error) {
    console.error('[Propagation] Error:', error.message);
    res.status(500).json({ error: 'Failed to calculate propagation' });
  }
});

// Calculate MUF using real ionosonde data or model
function calculateMUF(distance, midLat, midLon, hour, sfi, ssn, ionoData) {
  // If we have real MUF(3000) data, scale it for actual distance
  if (ionoData?.mufd) {
    // MUF scales with distance: MUF(d) ≈ MUF(3000) * sqrt(3000/d) for d < 3000km
    // For d > 3000km, MUF(d) ≈ MUF(3000) * (1 + 0.1 * log(d/3000))
    if (distance < 3000) {
      return ionoData.mufd * Math.sqrt(distance / 3000);
    } else {
      return ionoData.mufd * (1 + 0.15 * Math.log10(distance / 3000));
    }
  }
  
  // If we have foF2, calculate MUF using M(3000)F2 factor
  if (ionoData?.foF2) {
    const M = ionoData.md || 3.0; // M(3000)F2 factor, typically 2.5-3.5
    const muf3000 = ionoData.foF2 * M;
    
    // Scale for actual distance
    if (distance < 3000) {
      return muf3000 * Math.sqrt(distance / 3000);
    } else {
      return muf3000 * (1 + 0.15 * Math.log10(distance / 3000));
    }
  }
  
  // Fallback: Estimate foF2 from solar indices
  // foF2 ≈ 0.9 * sqrt(SSN + 15) * diurnal_factor
  const hourFactor = 1 + 0.4 * Math.cos((hour - 14) * Math.PI / 12); // Peak at 14:00 local
  const latFactor = 1 - Math.abs(midLat) / 150; // Higher latitudes = lower foF2
  const foF2_est = 0.9 * Math.sqrt(ssn + 15) * hourFactor * latFactor;
  
  // Standard M(3000)F2 factor
  const M = 3.0;
  const muf3000 = foF2_est * M;
  
  // Scale for distance
  if (distance < 3000) {
    return muf3000 * Math.sqrt(distance / 3000);
  } else {
    return muf3000 * (1 + 0.15 * Math.log10(distance / 3000));
  }
}

// Calculate LUF (Lowest Usable Frequency) based on D-layer absorption
function calculateLUF(distance, midLat, hour, sfi, kIndex) {
  // LUF increases with:
  // - Higher solar flux (more D-layer ionization)
  // - Daytime (D-layer forms during day)
  // - Shorter paths (higher elevation angles = more time in D-layer)
  // - Geomagnetic activity
  
  // Local solar time at midpoint (approximate)
  const localHour = hour; // Would need proper calculation with midLon
  
  // Day/night factor: D-layer absorption is much higher during daytime
  let dayFactor = 0.3; // Night
  if (localHour >= 6 && localHour <= 18) {
    // Daytime - peaks around noon
    dayFactor = 0.5 + 0.5 * Math.cos((localHour - 12) * Math.PI / 6);
  }
  
  // Solar flux factor: higher SFI = more absorption
  const sfiFactor = 1 + (sfi - 70) / 200;
  
  // Distance factor: shorter paths have higher LUF (higher angles)
  const distFactor = Math.max(0.5, 1 - distance / 10000);
  
  // Latitude factor: polar paths have more absorption
  const latFactor = 1 + Math.abs(midLat) / 90 * 0.5;
  
  // K-index: geomagnetic storms increase absorption
  const kFactor = 1 + kIndex * 0.1;
  
  // Base LUF is around 2 MHz for long night paths
  const baseLuf = 2.0;
  
  return baseLuf * dayFactor * sfiFactor * distFactor * latFactor * kFactor;
}

// Enhanced reliability calculation using real ionosonde data
function calculateEnhancedReliability(freq, distance, midLat, midLon, hour, sfi, ssn, kIndex, de, dx, ionoData, currentHour) {
  // Calculate MUF and LUF for this hour
  // For non-current hours, we need to estimate how foF2 changes
  let hourIonoData = ionoData;
  
  if (ionoData && hour !== currentHour) {
    // Estimate foF2 change based on diurnal variation
    // foF2 typically varies by factor of 2-3 between day and night
    const currentHourFactor = 1 + 0.4 * Math.cos((currentHour - 14) * Math.PI / 12);
    const targetHourFactor = 1 + 0.4 * Math.cos((hour - 14) * Math.PI / 12);
    const scaleFactor = targetHourFactor / currentHourFactor;
    
    hourIonoData = {
      ...ionoData,
      foF2: ionoData.foF2 * scaleFactor,
      mufd: ionoData.mufd ? ionoData.mufd * scaleFactor : null
    };
  }
  
  const muf = calculateMUF(distance, midLat, midLon, hour, sfi, ssn, hourIonoData);
  const luf = calculateLUF(distance, midLat, hour, sfi, kIndex);
  
  // Calculate reliability based on frequency position relative to MUF/LUF
  let reliability = 0;
  
  if (freq > muf * 1.1) {
    // Well above MUF - very poor
    reliability = Math.max(0, 30 - (freq - muf) * 5);
  } else if (freq > muf) {
    // Slightly above MUF - marginal (sometimes works due to scatter)
    reliability = 30 + (muf * 1.1 - freq) / (muf * 0.1) * 20;
  } else if (freq < luf * 0.8) {
    // Well below LUF - absorbed
    reliability = Math.max(0, 20 - (luf - freq) * 10);
  } else if (freq < luf) {
    // Near LUF - marginal
    reliability = 20 + (freq - luf * 0.8) / (luf * 0.2) * 30;
  } else {
    // In usable range - calculate optimum
    // Optimum Working Frequency (OWF) is typically 80-85% of MUF
    const owf = muf * 0.85;
    const range = muf - luf;
    
    if (range <= 0) {
      reliability = 30; // Very narrow window
    } else {
      // Higher reliability near OWF, tapering toward MUF and LUF
      const position = (freq - luf) / range; // 0 at LUF, 1 at MUF
      const optimalPosition = 0.75; // 75% up from LUF = OWF
      
      if (position < optimalPosition) {
        // Below OWF - reliability increases as we approach OWF
        reliability = 50 + (position / optimalPosition) * 45;
      } else {
        // Above OWF - reliability decreases as we approach MUF
        reliability = 95 - ((position - optimalPosition) / (1 - optimalPosition)) * 45;
      }
    }
  }
  
  // K-index degradation (geomagnetic storms)
  if (kIndex >= 7) reliability *= 0.1;
  else if (kIndex >= 6) reliability *= 0.2;
  else if (kIndex >= 5) reliability *= 0.4;
  else if (kIndex >= 4) reliability *= 0.6;
  else if (kIndex >= 3) reliability *= 0.8;
  
  // Very long paths (multiple hops) are harder
  const hops = Math.ceil(distance / 3500);
  if (hops > 1) {
    reliability *= Math.pow(0.92, hops - 1); // ~8% loss per additional hop
  }
  
  // Polar path penalty (auroral absorption)
  if (Math.abs(midLat) > 60) {
    reliability *= 0.7;
    if (kIndex >= 3) reliability *= 0.7; // Additional penalty during storms
  }
  
  // High bands need sufficient solar activity
  if (freq >= 21 && sfi < 100) reliability *= Math.sqrt(sfi / 100);
  if (freq >= 28 && sfi < 120) reliability *= Math.sqrt(sfi / 120);
  if (freq >= 50 && sfi < 150) reliability *= Math.pow(sfi / 150, 1.5);
  
  // Low bands work better at night
  const localHour = (hour + midLon / 15 + 24) % 24;
  const isNight = localHour < 6 || localHour > 18;
  if (freq <= 7 && isNight) reliability *= 1.1;
  if (freq <= 3.5 && !isNight) reliability *= 0.7;
  
  return Math.min(99, Math.max(0, reliability));
}

// Convert reliability to estimated SNR
function calculateSNR(reliability) {
  if (reliability >= 80) return '+20dB';
  if (reliability >= 60) return '+10dB';
  if (reliability >= 40) return '0dB';
  if (reliability >= 20) return '-10dB';
  return '-20dB';
}

// Get status label from reliability
function getStatus(reliability) {
  if (reliability >= 70) return 'EXCELLENT';
  if (reliability >= 50) return 'GOOD';
  if (reliability >= 30) return 'FAIR';
  if (reliability >= 15) return 'POOR';
  return 'CLOSED';
}

// QRZ Callsign lookup (requires API key)
app.get('/api/qrz/lookup/:callsign', async (req, res) => {
  const { callsign } = req.params;
  // Note: QRZ requires an API key - this is a placeholder
  res.json({ 
    message: 'QRZ lookup requires API key configuration',
    callsign: callsign.toUpperCase()
  });
});

// ============================================
// CONTEST CALENDAR API
// ============================================

app.get('/api/contests', async (req, res) => {
  // Try WA7BNM Contest Calendar RSS feed
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch('https://www.contestcalendar.com/calendar.rss', {
      headers: { 
        'User-Agent': 'OpenHamClock/3.3',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (response.ok) {
      const text = await response.text();
      const contests = parseContestRSS(text);
      
      if (contests.length > 0) {
        console.log('[Contests] WA7BNM RSS:', contests.length, 'contests');
        return res.json(contests);
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('[Contests] RSS error:', error.message);
    }
  }

  // Fallback: Use calculated contests
  try {
    const contests = calculateUpcomingContests();
    console.log('[Contests] Using calculated:', contests.length, 'contests');
    return res.json(contests);
  } catch (error) {
    console.error('[Contests] Calculation error:', error.message);
  }

  res.json([]);
});

// Parse WA7BNM RSS feed
function parseContestRSS(xml) {
  const contests = [];
  const now = new Date();
  const currentYear = now.getFullYear();
  
  // Simple regex-based XML parsing (no external dependencies)
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const titleRegex = /<title>([^<]+)<\/title>/;
  const linkRegex = /<link>([^<]+)<\/link>/;
  const descRegex = /<description>([^<]+)<\/description>/;
  
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    
    const titleMatch = item.match(titleRegex);
    const linkMatch = item.match(linkRegex);
    const descMatch = item.match(descRegex);
    
    if (titleMatch && descMatch) {
      const name = titleMatch[1].trim();
      const desc = descMatch[1].trim();
      const url = linkMatch ? linkMatch[1].trim() : null;
      
      // Parse description like "1300Z, Jan 31 to 1300Z, Feb 1" or "0000Z-2359Z, Jan 31"
      const parsed = parseContestDateTime(desc, currentYear);
      
      if (parsed) {
        const status = (now >= parsed.start && now <= parsed.end) ? 'active' : 'upcoming';
        
        // Try to detect mode from contest name
        let mode = 'Mixed';
        const nameLower = name.toLowerCase();
        if (nameLower.includes('cw') || nameLower.includes('morse')) mode = 'CW';
        else if (nameLower.includes('ssb') || nameLower.includes('phone') || nameLower.includes('sideband')) mode = 'SSB';
        else if (nameLower.includes('rtty')) mode = 'RTTY';
        else if (nameLower.includes('ft4') || nameLower.includes('ft8') || nameLower.includes('digi')) mode = 'Digital';
        else if (nameLower.includes('vhf') || nameLower.includes('uhf')) mode = 'VHF';
        
        contests.push({
          name,
          start: parsed.start.toISOString(),
          end: parsed.end.toISOString(),
          mode,
          status,
          url
        });
      }
    }
  }
  
  // Sort by start date and limit
  contests.sort((a, b) => new Date(a.start) - new Date(b.start));
  return contests.slice(0, 20);
}

// Parse contest date/time strings
function parseContestDateTime(desc, year) {
  try {
    const months = { 'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5, 
                     'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11 };
    
    // Pattern 1: "1300Z, Jan 31 to 1300Z, Feb 1"
    const rangeMatch = desc.match(/(\d{4})Z,\s*(\w+)\s+(\d+)\s+to\s+(\d{4})Z,\s*(\w+)\s+(\d+)/i);
    if (rangeMatch) {
      const [, startTime, startMon, startDay, endTime, endMon, endDay] = rangeMatch;
      const startMonth = months[startMon.toLowerCase()];
      const endMonth = months[endMon.toLowerCase()];
      
      let startYear = year;
      let endYear = year;
      // Handle year rollover
      if (startMonth > 10 && endMonth < 2) endYear = year + 1;
      
      const start = new Date(Date.UTC(startYear, startMonth, parseInt(startDay), 
        parseInt(startTime.substring(0, 2)), parseInt(startTime.substring(2, 4))));
      const end = new Date(Date.UTC(endYear, endMonth, parseInt(endDay),
        parseInt(endTime.substring(0, 2)), parseInt(endTime.substring(2, 4))));
      
      return { start, end };
    }
    
    // Pattern 2: "0000Z-2359Z, Jan 31" (same day)
    const sameDayMatch = desc.match(/(\d{4})Z-(\d{4})Z,\s*(\w+)\s+(\d+)/i);
    if (sameDayMatch) {
      const [, startTime, endTime, mon, day] = sameDayMatch;
      const month = months[mon.toLowerCase()];
      
      const start = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(startTime.substring(0, 2)), parseInt(startTime.substring(2, 4))));
      const end = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(endTime.substring(0, 2)), parseInt(endTime.substring(2, 4))));
      
      // Handle overnight contests (end time < start time means next day)
      if (end <= start) end.setUTCDate(end.getUTCDate() + 1);
      
      return { start, end };
    }
    
    // Pattern 3: "0000Z-0100Z, Feb 5 and 0200Z-0300Z, Feb 6" (multiple sessions - use first)
    const multiMatch = desc.match(/(\d{4})Z-(\d{4})Z,\s*(\w+)\s+(\d+)/i);
    if (multiMatch) {
      const [, startTime, endTime, mon, day] = multiMatch;
      const month = months[mon.toLowerCase()];
      
      const start = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(startTime.substring(0, 2)), parseInt(startTime.substring(2, 4))));
      const end = new Date(Date.UTC(year, month, parseInt(day),
        parseInt(endTime.substring(0, 2)), parseInt(endTime.substring(2, 4))));
      
      if (end <= start) end.setUTCDate(end.getUTCDate() + 1);
      
      return { start, end };
    }
    
  } catch (e) {
    // Parse error, skip this contest
  }
  
  return null;
}

// Helper function to calculate upcoming contests
function calculateUpcomingContests() {
  const now = new Date();
  const contests = [];
  
  // Major contest definitions with typical schedules
  const majorContests = [
    { name: 'CQ WW DX CW', month: 10, weekend: -1, duration: 48, mode: 'CW' }, // Last full weekend Nov
    { name: 'CQ WW DX SSB', month: 9, weekend: -1, duration: 48, mode: 'SSB' }, // Last full weekend Oct
    { name: 'ARRL DX CW', month: 1, weekend: 3, duration: 48, mode: 'CW' }, // 3rd full weekend Feb
    { name: 'ARRL DX SSB', month: 2, weekend: 1, duration: 48, mode: 'SSB' }, // 1st full weekend Mar
    { name: 'CQ WPX SSB', month: 2, weekend: -1, duration: 48, mode: 'SSB' }, // Last full weekend Mar
    { name: 'CQ WPX CW', month: 4, weekend: -1, duration: 48, mode: 'CW' }, // Last full weekend May
    { name: 'IARU HF Championship', month: 6, weekend: 2, duration: 24, mode: 'Mixed' }, // 2nd full weekend Jul
    { name: 'ARRL Field Day', month: 5, weekend: 4, duration: 27, mode: 'Mixed' }, // 4th full weekend Jun
    { name: 'ARRL Sweepstakes CW', month: 10, weekend: 1, duration: 24, mode: 'CW' }, // 1st full weekend Nov
    { name: 'ARRL Sweepstakes SSB', month: 10, weekend: 3, duration: 24, mode: 'SSB' }, // 3rd full weekend Nov
    { name: 'ARRL 10m Contest', month: 11, weekend: 2, duration: 48, mode: 'Mixed' }, // 2nd full weekend Dec
    { name: 'ARRL RTTY Roundup', month: 0, weekend: 1, duration: 24, mode: 'RTTY' }, // 1st full weekend Jan
    { name: 'NA QSO Party CW', month: 0, weekend: 2, duration: 12, mode: 'CW' },
    { name: 'NA QSO Party SSB', month: 0, weekend: 3, duration: 12, mode: 'SSB' },
    { name: 'CQ 160m CW', month: 0, weekend: -1, duration: 42, mode: 'CW' }, // Last full weekend Jan
    { name: 'CQ 160m SSB', month: 1, weekend: -1, duration: 42, mode: 'SSB' }, // Last full weekend Feb
    { name: 'CQ WW RTTY', month: 8, weekend: -1, duration: 48, mode: 'RTTY' },
    { name: 'JIDX CW', month: 3, weekend: 2, duration: 48, mode: 'CW' },
    { name: 'JIDX SSB', month: 10, weekend: 2, duration: 48, mode: 'SSB' },
    { name: 'ARRL VHF Contest', month: 0, weekend: 3, duration: 33, mode: 'Mixed' }, // 3rd weekend Jan
    { name: 'ARRL June VHF', month: 5, weekend: 2, duration: 33, mode: 'Mixed' }, // 2nd weekend Jun
    { name: 'ARRL Sept VHF', month: 8, weekend: 2, duration: 33, mode: 'Mixed' }, // 2nd weekend Sep
    { name: 'Winter Field Day', month: 0, weekend: -1, duration: 24, mode: 'Mixed' }, // Last weekend Jan
    { name: 'CQWW WPX RTTY', month: 1, weekend: 2, duration: 48, mode: 'RTTY' }, // 2nd weekend Feb
    { name: 'Stew Perry Topband', month: 11, weekend: 4, duration: 14, mode: 'CW' }, // 4th weekend Dec
    { name: 'RAC Canada Day', month: 6, weekend: 1, duration: 24, mode: 'Mixed' }, // 1st weekend Jul
    { name: 'RAC Winter Contest', month: 11, weekend: -1, duration: 24, mode: 'Mixed' }, // Last weekend Dec
    { name: 'NAQP RTTY', month: 1, weekend: 4, duration: 12, mode: 'RTTY' }, // 4th weekend Feb
    { name: 'NAQP RTTY', month: 6, weekend: 3, duration: 12, mode: 'RTTY' }, // 3rd weekend Jul
  ];

  // Weekly mini-contests (CWT, SST, etc.) - dayOfWeek: 0=Sun, 1=Mon, ... 6=Sat
  const weeklyContests = [
    { name: 'CWT 1300z', dayOfWeek: 3, hour: 13, duration: 1, mode: 'CW' }, // Wednesday
    { name: 'CWT 1900z', dayOfWeek: 3, hour: 19, duration: 1, mode: 'CW' }, // Wednesday
    { name: 'CWT 0300z', dayOfWeek: 4, hour: 3, duration: 1, mode: 'CW' }, // Thursday
    { name: 'CWT 0700z', dayOfWeek: 4, hour: 7, duration: 1, mode: 'CW' }, // Thursday
    { name: 'NCCC Sprint', dayOfWeek: 5, hour: 3, minute: 30, duration: 0.5, mode: 'CW' }, // Friday
    { name: 'K1USN SST', dayOfWeek: 0, hour: 0, duration: 1, mode: 'CW' }, // Sunday 0000z (Sat evening US)
    { name: 'K1USN SST', dayOfWeek: 1, hour: 20, duration: 1, mode: 'CW' }, // Monday 2000z
    { name: 'ICWC MST', dayOfWeek: 1, hour: 13, duration: 1, mode: 'CW' }, // Monday 1300z
    { name: 'ICWC MST', dayOfWeek: 1, hour: 19, duration: 1, mode: 'CW' }, // Monday 1900z
    { name: 'ICWC MST', dayOfWeek: 2, hour: 3, duration: 1, mode: 'CW' }, // Tuesday 0300z
    { name: 'SKCC Sprint', dayOfWeek: 3, hour: 0, duration: 2, mode: 'CW' }, // Wednesday 0000z
    { name: 'QRP Fox Hunt', dayOfWeek: 3, hour: 2, duration: 1.5, mode: 'CW' }, // Wednesday 0200z
    { name: 'RTTY Weekday Sprint', dayOfWeek: 2, hour: 23, duration: 1, mode: 'RTTY' }, // Tuesday 2300z
  ];

  // Calculate next occurrences of weekly contests
  weeklyContests.forEach(contest => {
    const next = new Date(now);
    const currentDay = now.getUTCDay();
    let daysUntil = contest.dayOfWeek - currentDay;
    if (daysUntil < 0) daysUntil += 7;
    if (daysUntil === 0) {
      // Check if it's today but already passed
      const todayStart = new Date(now);
      todayStart.setUTCHours(contest.hour, contest.minute || 0, 0, 0);
      if (now > todayStart) daysUntil = 7;
    }
    
    next.setUTCDate(now.getUTCDate() + daysUntil);
    next.setUTCHours(contest.hour, contest.minute || 0, 0, 0);
    
    const endTime = new Date(next.getTime() + contest.duration * 3600000);
    
    contests.push({
      name: contest.name,
      start: next.toISOString(),
      end: endTime.toISOString(),
      mode: contest.mode,
      status: (now >= next && now <= endTime) ? 'active' : 'upcoming'
    });
  });

  // Calculate next occurrences of major contests
  const year = now.getFullYear();
  majorContests.forEach(contest => {
    for (let y = year; y <= year + 1; y++) {
      let startDate;
      
      if (contest.weekend === -1) {
        // Last weekend of month
        startDate = getLastWeekendOfMonth(y, contest.month);
      } else {
        // Nth weekend of month
        startDate = getNthWeekendOfMonth(y, contest.month, contest.weekend);
      }
      
      // Most contests start at 00:00 UTC Saturday
      startDate.setUTCHours(0, 0, 0, 0);
      const endDate = new Date(startDate.getTime() + contest.duration * 3600000);
      
      if (endDate > now) {
        const status = (now >= startDate && now <= endDate) ? 'active' : 'upcoming';
        contests.push({
          name: contest.name,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          mode: contest.mode,
          status: status
        });
        break; // Only add next occurrence
      }
    }
  });

  // Sort by start date
  contests.sort((a, b) => new Date(a.start) - new Date(b.start));
  
  return contests.slice(0, 15);
}

function getNthWeekendOfMonth(year, month, n) {
  const date = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  let weekendCount = 0;
  
  while (date.getUTCMonth() === month) {
    if (date.getUTCDay() === 6) { // Saturday
      weekendCount++;
      if (weekendCount === n) return new Date(date);
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  
  return date;
}

function getLastWeekendOfMonth(year, month) {
  // Start from last day of month and work backwards
  const date = new Date(Date.UTC(year, month + 1, 0)); // Last day of month
  
  while (date.getUTCDay() !== 6) { // Find last Saturday
    date.setUTCDate(date.getUTCDate() - 1);
  }
  
  return date;
}

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '3.3.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ============================================
// CONFIGURATION ENDPOINT
// ============================================

app.get('/api/config', (req, res) => {
  res.json({
    version: '3.0.0',
    features: {
      spaceWeather: true,
      pota: true,
      sota: true,
      dxCluster: true,
      satellites: false, // Coming soon
      contests: false    // Coming soon
    },
    refreshIntervals: {
      spaceWeather: 300000,
      pota: 60000,
      sota: 60000,
      dxCluster: 30000
    }
  });
});

// ============================================
// CATCH-ALL FOR SPA
// ============================================

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║                                                       ║');
  console.log('║   ██████╗ ██████╗ ███████╗███╗   ██╗                  ║');
  console.log('║  ██╔═══██╗██╔══██╗██╔════╝████╗  ██║                  ║');
  console.log('║  ██║   ██║██████╔╝█████╗  ██╔██╗ ██║                  ║');
  console.log('║  ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║                  ║');
  console.log('║  ╚██████╔╝██║     ███████╗██║ ╚████║                  ║');
  console.log('║   ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝                  ║');
  console.log('║                                                       ║');
  console.log('║  ██╗  ██╗ █████╗ ███╗   ███╗ ██████╗██╗      ██╗  ██╗ ║');
  console.log('║  ██║  ██║██╔══██╗████╗ ████║██╔════╝██║      ██║ ██╔╝ ║');
  console.log('║  ███████║███████║██╔████╔██║██║     ██║      █████╔╝  ║');
  console.log('║  ██╔══██║██╔══██║██║╚██╔╝██║██║     ██║      ██╔═██╗  ║');
  console.log('║  ██║  ██║██║  ██║██║ ╚═╝ ██║╚██████╗███████╗██║  ██╗ ║');
  console.log('║  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ║');
  console.log('║                                                       ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  🌐 Server running at http://localhost:${PORT}`);
  console.log('  📡 API proxy enabled for NOAA, POTA, SOTA, DX Cluster');
  console.log('  🖥️  Open your browser to start using OpenHamClock');
  console.log('');
  console.log('  In memory of Elwood Downey, WB0OEW');
  console.log('  73 de OpenHamClock contributors');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});
