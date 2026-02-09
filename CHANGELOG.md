# Changelog

All notable changes to OpenHamClock will be documented in this file.

## [15.0.1] - 2026-02-08

### Added
- **Per-panel font sizing (Dockable Mode)** — A−/A+ buttons in each panel's tabset header. 10 zoom steps from 70% to 200%, persisted per-panel in localStorage. Percentage badge shown when zoomed; click to reset. World Map excluded (has its own zoom)
- **DX News Ticker toggle** — New checkbox in Settings → Map Layers tab to show/hide the scrolling DX news ticker. Persisted in localStorage with other map layer settings
- **Weather proxy** — New `/api/weather` server endpoint proxies Open-Meteo requests. Coordinates rounded to ~11km grid for cache sharing across users. 15-minute cache, 1-hour stale serving on rate limit/errors. Client debounced (2s) to prevent rapid-fire calls when clicking through DX spots

### Changed
- **ITU-R P.533 by default** — All installs now use the public OpenHamClock ITURHFProp service (`proppy-production.up.railway.app`) for propagation predictions out of the box. No `.env` configuration needed. Self-hosting still supported via `ITURHFPROP_URL` override

### Fixed
- **DX Cluster spot clicks** — Clicking a DX cluster spot now updates the DX panel and map. Root cause: `DXClusterPanel` had no `onClick` handler; paths data with coordinates wasn't being looked up. Fixed across Modern, Classic, and Dockable layouts
- **RBN layer showing N0CALL** — RBN (and all plugin layers) showed "N0CALL" instead of the user's callsign. Root cause: `WorldMap` wasn't passing `callsign`, `locator`, or `lowMemoryMode` to `PluginLayer`. Also fixed 4 of 6 `WorldMap` instances across layouts that were missing the `callsign` prop entirely
- **Update button fails with "Local changes detected"** — `git status --porcelain` blocked updates when file permissions changed (e.g., `chmod +x update.sh`) or on cross-platform mode differences. Fix: `git config core.fileMode false` set at server startup, in setup scripts, and in `update.sh`. Auto-update now stashes local changes before pulling instead of refusing
- **Update button missing in Dockable Mode** — `DockableApp` wasn't passing `onUpdateClick`, `updateInProgress`, or `showUpdateButton` to the Header component
- **WSJT-X relay agent ECONNRESET** — Relay v1.1.0: added `Connection: close` header, startup connectivity test, clear error diagnostics for ECONNRESET/ECONNREFUSED/DNS/timeout
- **Pi kiosk mode loses settings on reboot** — Chromium `--incognito` flag wiped localStorage on every restart. Replaced with dedicated `--user-data-dir` profile. `update.sh` auto-patches existing kiosk installs
- **Open-Meteo 429 rate limiting** — Client-side Open-Meteo calls replaced with server-side proxy (see Weather proxy above)

## [15.0.0] - 2026-02-08

### Added
- **N0NBH Band Conditions** — Real-time band condition data from N0NBH's NOAA-sourced feed replaces the old calculated estimates. Server-side `/api/n0nbh` endpoint with 1-hour caching. Day/night conditions per band, VHF conditions (Aurora, E-skip by region), geomagnetic field status, signal noise level, and MUF. PropagationPanel shows mini day/night indicators when conditions differ between day and night
- **User Profiles** — Save and load named configuration profiles from Settings → Profiles tab. Each profile snapshots all localStorage keys (config, layout, filters, map layers, preferences). Supports save, load, rename, delete, export to JSON file, and import from file. Useful for multi-operator shared stations or switching between personal views (contest mode, field day, everyday)
- **Concurrent User Tracking** — Health dashboard (`/api/health`) now shows real-time concurrent users, peak concurrent count, session duration analytics (avg/median/p90/max), duration distribution buckets, and an active users table with anonymized IPs and session durations
- **Auto-Refresh on Update** — New `useVersionCheck` hook polls `/api/version` every 60 seconds. When a new version is detected after deployment, connected browsers show a toast notification and automatically reload after 3 seconds. Lightweight `/api/version` endpoint with no-cache headers
- **Cloud Layer Restriction** — OWM cloud overlay restricted to local installs only via `localOnly` flag in layer registry. Cloud layer invisible on openhamclock.com, visible on localhost/LAN
- **A-Index Display** — A-index and geomagnetic field status added to Header and ClassicLayout solar stats bars, color-coded by severity
- **Space Weather Extras** — Header shows A-index (color-coded: green <10, amber 10-19, red ≥20) and geomagnetic field status from N0NBH data

### Changed
- **Band Conditions Rewrite** — `useBandConditions` hook completely rewritten. Removed 200+ lines of local SFI/K-index formula calculations. Now fetches from `/api/n0nbh` server proxy and maps N0NBH grouped ranges (80m-40m, 30m-20m, etc.) to individual bands
- **Health Dashboard Auto-Refresh** — HTML health dashboard now auto-refreshes every 30 seconds
- **Stats Grid** — Health dashboard shows 6 stat cards (added Online Now and Peak Concurrent)
- **Donate Buttons** — Hidden in fullscreen mode across Header, ModernLayout, and ClassicLayout
- **CI Pipeline** — Dropped Node 18 (replaced with 20.x/22.x), replaced `npm start` with `node server.js` to skip redundant prestart build, added retry loop for health check (up to 30 attempts), same retry pattern for Docker health check
- **Version** — Bumped to 15.0.0

### Fixed
- **CI Health Check Failure** — `npm start` was running `prestart` (full rebuild) before starting the server, causing the 5-second `sleep` + `curl` to fail every time. Now uses `node server.js` directly since the build step already ran

## [3.12.0] - 2025-02-03

### Added
- **State persistence** — All user preferences survive page refresh: PSK/WSJT-X panel mode, TX/RX tab, solar image wavelength, weather panel expanded state, temperature unit
- **Collapsible weather** — DE location weather section collapses to one-line summary, expands for full details
- **Lunar phase display** — 4th cycling mode in Solar panel shows current moon phase with SVG rendering, illumination %, and next full/new moon dates
- **F°/C° toggle** — Switch temperature units with localStorage persistence; header always shows both
- **Satellite filtering** — Complete satellite filter interface in Settings → Satellites tab. Select/deselect from 40+ satellites, real-time visibility status, persistent filters
- **WSPR heatmap improvements** — Increased brightness (opacity 0.75-1.0), 4-layer glow effect, tighter clustering (radius 50,000m → 6,000m), adjustable opacity slider
- **DX Target enhancements** — Distance calculation (Haversine), beam headings (SP/LP), color-coded display
- **Lightning detection** — WebSocket server fallback system, proximity alerts, RBN history management
- **WSPR data quality** — Spot limit increased from 2,000 to 10,000, detailed marker tooltips with power/SNR/distance/efficiency

### Fixed
- **PSKReporter MQTT** — Field mapping used `sa`/`ra` (ADIF country codes) instead of `sc`/`rc` (callsigns), so no MQTT spots ever matched
- **PSKReporter RX topic** — Subscription pattern had one extra wildcard
- **PSKReporter HTTP fallback** — If MQTT fails within 12 seconds, automatically falls back to HTTP API
- **Map layer persistence** — Map style/zoom save was overwriting plugin layer settings. Now merges correctly
- **Version consistency** — All version numbers now read from package.json as single source of truth
- **PSKReporter 403 spam** — Server backs off for 30 minutes on 403/429 responses
- **WSPR heatmap infinite loop** — Removed heatmapLayer from useEffect dependencies
- **WSPR grid filter** — Supports 2-6 character grids, prefix matching (FN → FN03, FN21)
- **WSPR callsign filter** — Proper suffix stripping (VE3TOS/M → VE3TOS), respects grid filter state
- **Satellite initialization** — Fixed ReferenceError when filteredSatellites referenced satellites.data before hook initialized
- **VOACAP ionosonde label** — Added "Iono:" prefix to clarify it's the data source, not the DX location

### Changed
- **WSPR update frequency** — Polling interval from 5 minutes to 60 seconds
- **WSPR band chart** — Removed pulsing animation, added smooth CSS transition

### Reverted
- **WSPR MQTT** — Real-time MQTT feed attempted and reverted due to mixed content policy (HTTPS pages cannot connect to insecure WebSocket)

## [3.11.0] - 2025-02-02

### Added
- **PSKReporter Integration** — New panel showing stations hearing you (TX) and stations you're hearing (RX). Supports FT8, FT4, JS8, and other digital modes. Configurable time window. Signal paths drawn on map
- **Bandwidth Optimization** — Reduced network egress by ~85%: GZIP compression, server-side caching, reduced polling intervals, HTTP Cache-Control headers

### Fixed
- Empty ITURHFPROP_URL causing "Only absolute URLs supported" error
- Satellite TLE fetch timeout errors handled silently
- Reduced console log spam for network errors

## [3.10.0] - 2025-02-02

### Added
- **Environment-based configuration** — `.env` file auto-created from `.env.example` on first run. Supports CALLSIGN, LOCATOR, PORT, HOST, UNITS, TIME_FORMAT, THEME, LAYOUT
- **Auto-build on start** — `npm start` automatically builds React frontend
- **Update script** — `./scripts/update.sh` for easy local/Pi updates
- **Network access configuration** — `HOST=0.0.0.0` for LAN access
- **Grid locator auto-conversion** — Calculates lat/lon from LOCATOR
- **Setup wizard** — Settings panel auto-opens if callsign or locator missing
- **Retro theme** — 90s Windows style
- **Classic layout** — Original HamClock-style with black background and large colored numbers

### Changed
- Configuration priority: localStorage > .env > defaults
- DX Spider connection uses dxspider.co.uk as primary

### Fixed
- Header clock "shaking" when digits change
- Header layout wrapping on smaller screens
- Reduced log spam with rate-limited error logging

## [3.9.0] - 2025-01-31

### Added
- DX Filter modal with tabs for Zones, Bands, Modes, Watchlist, Exclude
- Spot retention time configurable (5-30 minutes) in Settings
- Satellite tracking with 40+ amateur radio satellites
- Satellite footprints and orbit path visualization
- Map legend showing all 10 HF bands plus DE/DX/Sun/Moon markers

### Fixed
- DX Filter modal crash when opening
- K-Index display showing correct values
- Contest calendar attribution

## [3.8.0] - 2025-01-28

### Added
- Multiple DX cluster source fallbacks
- ITURHFProp hybrid propagation predictions
- Ionosonde real-time corrections

## [3.7.0] - 2025-01-25

### Added
- Modular React architecture with Vite
- 13 extracted components, 12 custom hooks, 3 utility modules
- Railway deployment support
- Docker support

### Changed
- Complete rewrite from monolithic HTML to modular React

## [3.0.0] - 2025-01-15

### Added
- Initial modular extraction from monolithic codebase
- React + Vite build system
- Express backend for API proxying
- Three themes: Dark, Light, Legacy

---

## Version History

- **15.x** — N0NBH band conditions, user profiles, concurrent user tracking, auto-refresh, CI fixes
- **3.12.x** — PSKReporter fixes, state persistence, satellite filtering, WSPR improvements, lunar phase
- **3.11.x** — PSKReporter integration, bandwidth optimization
- **3.10.x** — Environment configuration, themes, layouts
- **3.9.x** — DX filtering, satellites, map improvements
- **3.8.x** — Propagation predictions, reliability improvements
- **3.7.x** — Modular React architecture
- **3.0.x** — Initial modular version
- **2.x** — Monolithic HTML version (archived)
- **1.x** — Original HamClock fork
