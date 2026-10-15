'use strict';
/**
 * cloud-relay.js — Rig Bridge Cloud Relay
 *
 * Bridges the gap between a locally-running rig-bridge and a cloud-hosted
 * OpenHamClock instance. Provides all rig-bridge features to cloud users
 * by relaying state and commands over HTTPS.
 *
 * How it works:
 *   1. LOCAL → CLOUD: Pushes rig state (freq, mode, PTT, WSJT-X decodes,
 *      APRS packets, etc.) to the cloud OHC instance periodically.
 *   2. CLOUD → LOCAL: Polls the cloud instance for pending commands (tune,
 *      PTT, WSJT-X reply, APRS message) and executes them locally.
 *
 * This means cloud-hosted OHC users get the same rig control capabilities
 * as local users — click-to-tune, PTT, WSJT-X decode replies, APRS messaging —
 * all proxied through this relay.
 *
 * Config section: config.cloudRelay
 *   enabled:        boolean  (default: false)
 *   url:            string   Cloud OHC URL (e.g. 'https://openhamclock.com')
 *   apiKey:         string   Authentication key for the relay
 *   session:        string   Browser session ID for per-user isolation
 *   pushInterval:   number   State push interval in ms (default: 2000)
 *   relayRig:       boolean  Relay rig state (default: true)
 *   relayWsjtx:     boolean  Relay WSJT-X decodes (default: true)
 *   relayAprs:      boolean  Relay APRS packets (default: true)
 *   relayFldigi:    boolean  Relay the fldigi plugin's status, receive text and
 *                            flmsg forms, and accept NBEMS commands (default: true)
 *   verbose:        boolean  Log all relay activity (default: false)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

let _currentInstance = null;

const descriptor = {
  id: 'cloud-relay',
  name: 'Rig Bridge Cloud Relay',
  category: 'integration',
  configKey: 'cloudRelay',

  registerRoutes(app) {
    app.get('/api/cloud-relay/status', (req, res) => {
      if (!_currentInstance) return res.json({ enabled: false, running: false });
      res.json(_currentInstance.getStatus());
    });
  },

  create(config, services) {
    const cfg = config.cloudRelay || {};
    const serverUrl = (cfg.url || '').replace(/\/$/, '');
    const apiKey = cfg.apiKey || '';
    const session = cfg.session || '';
    const pushInterval = cfg.pushInterval || 2000; // Fallback interval for data batches
    const { state, pluginBus, onStateChange, removeStateChangeListener } = services;

    let pushTimer = null;
    let pollRetryTimer = null; // Used only for error-backoff delays between long-poll attempts
    let pollAborted = false; // Set on disconnect to stop the long-poll loop
    let immediatePushTimer = null;
    let stateChangeHandler = null;
    let lastPttState = null; // Track PTT separately to detect PTT-specific changes
    let serverReachable = false;
    let credentialsInvalid = false; // Set permanently on 401/403 — stops all retry loops
    let totalPushed = 0;
    let totalCommands = 0;
    let totalDecodes = 0;
    let consecutiveErrors = 0;
    let lastState = {};
    let pendingDecodes = []; // Batched decodes to push
    let pendingAprs = []; // Batched APRS packets to push
    let pendingMeshCom = []; // Batched MeshCom packets to push
    let pendingHamAlerts = []; // Batched HamAlert spots to push
    // fldigi / NBEMS: latest status, accumulated receive text, forms and
    // command results — pushed as `pluginEvents` with the same
    // { event, source, data } shape the local /stream uses.
    let pendingFldigiStatus = null;
    let pendingFldigiRx = null; // { text, reset }
    let pendingFldigiOther = []; // nbems-form / fldigi-cmd-result
    let fldigiPushTimer = null;
    const FLDIGI_RX_MAX = 8000;

    function makeRequest(urlStr, method, body, callback, timeoutMs) {
      let parsed;
      try {
        parsed = new URL(urlStr);
      } catch (e) {
        if (callback) callback(new Error(`Invalid URL: ${urlStr}`));
        return;
      }

      const mod = parsed.protocol === 'https:' ? https : http;
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Relay-Session': session,
      };

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
      };

      const req = mod.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (callback) callback(null, res.statusCode, data);
        });
      });
      req.on('error', (err) => {
        if (callback) callback(err);
      });
      req.setTimeout(timeoutMs || 5000, () => {
        req.destroy(new Error('Timeout'));
      });
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    }

    // Called on 401/403 — permanently stops all relay loops so the user isn't
    // spammed with auth errors. They must re-run "Connect Cloud Relay" in OHC
    // Settings to generate fresh credentials.
    function handleCredentialsInvalid(status, data) {
      if (credentialsInvalid) return;
      credentialsInvalid = true;
      try {
        const msg = JSON.parse(data)?.error || data;
        console.error(`[CloudRelay] Authentication failed (${status}): ${msg}`);
      } catch {
        console.error(
          `[CloudRelay] Authentication failed (${status}) — re-run Connect Cloud Relay in OHC Settings → Rig Bridge`,
        );
      }
      console.error(
        '[CloudRelay] Stopping relay — re-run Connect Cloud Relay in OHC Settings → Rig Bridge to get fresh credentials, then restart rig-bridge',
      );
      // Stop push timer
      if (pushTimer) {
        clearInterval(pushTimer);
        pushTimer = null;
      }
      // Stop long-poll loop
      pollAborted = true;
      if (pollRetryTimer) {
        clearTimeout(pollRetryTimer);
        pollRetryTimer = null;
      }
      if (immediatePushTimer) {
        clearTimeout(immediatePushTimer);
        immediatePushTimer = null;
      }
    }

    // Push current rig state + batched decodes to cloud
    function pushState() {
      if (credentialsInvalid) return;
      const currentState = {
        freq: state.freq,
        mode: state.mode,
        ptt: state.ptt,
        connected: state.connected,
        width: state.width,
        timestamp: Date.now(),
      };

      const hasDecodes = pendingDecodes.length > 0;
      const hasAprs = pendingAprs.length > 0;
      const hasMeshCom = pendingMeshCom.length > 0;
      const hasHamAlerts = pendingHamAlerts.length > 0;
      const hasPluginEvents = !!(pendingFldigiStatus || pendingFldigiRx || pendingFldigiOther.length);
      const stateChanged =
        currentState.freq !== lastState.freq ||
        currentState.mode !== lastState.mode ||
        currentState.ptt !== lastState.ptt ||
        currentState.connected !== lastState.connected;

      // Only push if state changed or there's data to send
      if (!stateChanged && !hasDecodes && !hasAprs && !hasMeshCom && !hasHamAlerts && !hasPluginEvents) return;
      lastState = { ...currentState };

      // Include batched data in the push
      const payload = { ...currentState, session };
      if (hasDecodes) {
        payload.decodes = pendingDecodes.splice(0, 50);
        totalDecodes += payload.decodes.length;
      }
      if (hasAprs) {
        payload.aprsPackets = pendingAprs.splice(0, 50);
      }
      if (hasMeshCom) {
        payload.meshcomPackets = pendingMeshCom.splice(0, 50);
      }
      if (hasHamAlerts) {
        payload.hamAlerts = pendingHamAlerts.splice(0, 50);
      }
      let sentFldigi = null;
      if (hasPluginEvents) {
        sentFldigi = { status: pendingFldigiStatus, rx: pendingFldigiRx, other: pendingFldigiOther.splice(0, 20) };
        pendingFldigiStatus = null;
        pendingFldigiRx = null;
        payload.pluginEvents = [
          ...(sentFldigi.status ? [{ event: 'fldigi', source: 'fldigi', data: sentFldigi.status }] : []),
          ...(sentFldigi.rx ? [{ event: 'fldigi-rx', source: 'fldigi', data: sentFldigi.rx }] : []),
          ...sentFldigi.other,
        ];
      }

      makeRequest(`${serverUrl}/api/rig-bridge/relay/state`, 'POST', payload, (err, status, data) => {
        if (err) {
          if (serverReachable) console.error(`[CloudRelay] Push error: ${err.message}`);
          serverReachable = false;
          consecutiveErrors++;
          // Restore all batched data so it is retried on the next push cycle
          if (payload.decodes) pendingDecodes.unshift(...payload.decodes);
          if (payload.aprsPackets) pendingAprs.unshift(...payload.aprsPackets);
          if (payload.meshcomPackets) pendingMeshCom.unshift(...payload.meshcomPackets);
          if (payload.hamAlerts) pendingHamAlerts.unshift(...payload.hamAlerts);
          if (sentFldigi) {
            pendingFldigiStatus = pendingFldigiStatus || sentFldigi.status;
            if (sentFldigi.rx) {
              pendingFldigiRx = pendingFldigiRx
                ? pendingFldigiRx.reset
                  ? pendingFldigiRx
                  : {
                      text: (sentFldigi.rx.text + pendingFldigiRx.text).slice(-FLDIGI_RX_MAX),
                      reset: sentFldigi.rx.reset,
                    }
                : sentFldigi.rx;
            }
            pendingFldigiOther.unshift(...sentFldigi.other);
          }
          return;
        }
        if (status === 200) {
          serverReachable = true;
          consecutiveErrors = 0;
          totalPushed++;
          if (cfg.verbose) {
            const decodeInfo = payload.decodes ? ` + ${payload.decodes.length} decodes` : '';
            console.log(`[CloudRelay] Pushed state (${currentState.freq} Hz ${currentState.mode}${decodeInfo})`);
          }
        } else if (status === 401 || status === 403) {
          handleCredentialsInvalid(status, data);
        }
      });
    }

    // Long-poll loop — holds the connection open for up to LONG_POLL_WAIT ms.
    // The server resolves the request immediately when a command is queued,
    // so latency is ~network RTT rather than the push interval.
    // On timeout (no commands) it restarts immediately. On network error it
    // waits 1 s before retrying to avoid hammering a temporarily unreachable server.
    const LONG_POLL_WAIT = 28000; // ms to hold open (server caps at 30 s)

    function longPollCommands() {
      if (pollAborted) return;
      const url =
        `${serverUrl}/api/rig-bridge/relay/commands` + `?session=${encodeURIComponent(session)}&wait=${LONG_POLL_WAIT}`;

      makeRequest(
        url,
        'GET',
        null,
        (err, status, data) => {
          if (pollAborted) return;

          if (!err && status === 200) {
            try {
              const response = JSON.parse(data);
              const commands = response.commands || [];
              for (const cmd of commands) executeCommand(cmd);
            } catch (e) {}
            // Restart immediately — no delay when things are healthy
            longPollCommands();
          } else if (!err && (status === 401 || status === 403)) {
            // Invalid credentials — stop permanently, no retry
            handleCredentialsInvalid(status, data);
          } else {
            // Network error or unexpected status — back off 1 s before retry
            pollRetryTimer = setTimeout(longPollCommands, 1000);
          }
        },
        LONG_POLL_WAIT + 4000, // HTTP timeout = hold window + 4 s network buffer
      );
    }

    // Execute a command received from the cloud
    // Uses https when rig-bridge TLS is enabled, http otherwise.
    // All requests have an error handler to prevent unhandled-error crashes.
    function executeCommand(cmd) {
      totalCommands++;
      if (cfg.verbose) console.log(`[CloudRelay] Command: ${cmd.type} ${JSON.stringify(cmd.payload || {})}`);

      const localMod = config.tls?.enabled ? https : http;
      const localOptions = (path, body) => ({
        hostname: '127.0.0.1',
        port: config.port || 5555,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RigBridge-Token': config.apiToken || '' },
        // Skip cert verification for loopback self-signed cert
        rejectUnauthorized: false,
      });

      switch (cmd.type) {
        case 'setFreq':
          if (cmd.payload?.freq) {
            const freqReq = localMod.request(localOptions('/freq'), () => {});
            freqReq.on('error', (err) => {
              if (cfg.verbose) console.error(`[CloudRelay] setFreq dispatch error: ${err.message}`);
            });
            freqReq.write(JSON.stringify({ freq: cmd.payload.freq }));
            freqReq.end();
          }
          break;
        case 'setMode':
          if (cmd.payload?.mode) {
            const modeReq = localMod.request(localOptions('/mode'), () => {});
            modeReq.on('error', (err) => {
              if (cfg.verbose) console.error(`[CloudRelay] setMode dispatch error: ${err.message}`);
            });
            modeReq.write(JSON.stringify({ mode: cmd.payload.mode }));
            modeReq.end();
          }
          break;
        case 'setPTT':
          if (cmd.payload != null) {
            const pttReq = localMod.request(localOptions('/ptt'), () => {});
            pttReq.on('error', (err) => {
              if (cfg.verbose) console.error(`[CloudRelay] setPTT dispatch error: ${err.message}`);
            });
            pttReq.write(JSON.stringify({ ptt: !!cmd.payload.ptt }));
            pttReq.end();
          }
          break;
        case 'fldigi':
          runFldigiCommand(cmd.payload || {}, localMod, localOptions);
          break;
        case 'indicators':
          // Display indicator state (satellite, countdown, alarm, lightning
          // guard relay) from a browser in cloud-relay mode → the same local
          // /api/indicators the browser would POST to directly.
          if (cmd.payload && typeof cmd.payload === 'object') {
            const indReq = localMod.request(localOptions('/api/indicators'), () => {});
            indReq.on('error', (err) => {
              if (cfg.verbose) console.error(`[CloudRelay] indicators dispatch error: ${err.message}`);
            });
            indReq.write(JSON.stringify(cmd.payload));
            indReq.end();
          }
          break;
        default:
          if (cfg.verbose) console.log(`[CloudRelay] Unknown command type: ${cmd.type}`);
      }
    }

    // NBEMS commands from the browser: run against the local fldigi plugin
    // routes with the browser's own Rig Bridge API token — not the relay's —
    // so a hosted page still needs the token to key the transmitter. The
    // outcome goes back as a 'fldigi-cmd-result' plugin event.
    const FLDIGI_ACTIONS = new Set(['send', 'send-ics213', 'mode', 'abort']);
    function runFldigiCommand(p, localMod, localOptions) {
      const requestId = String(p.requestId || '')
        .replace(/[^A-Za-z0-9-]/g, '')
        .slice(0, 40);
      const done = (result) => {
        if (pluginBus && requestId) pluginBus.emit('fldigi-cmd-result', { requestId, ...result });
      };
      if (cfg.relayFldigi === false)
        return done({ ok: false, status: 403, error: 'fldigi relay is off in Rig Bridge' });
      if (!FLDIGI_ACTIONS.has(p.action)) return done({ ok: false, status: 400, error: 'Unknown fldigi action' });
      const body = JSON.stringify(p.body && typeof p.body === 'object' ? p.body : {});
      const opts = localOptions(`/api/fldigi/${p.action}`);
      opts.headers = { ...opts.headers, 'X-RigBridge-Token': typeof p.token === 'string' ? p.token : '' };
      const req = localMod.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(data);
          } catch (e) {}
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          done({ ...parsed, ok, status: res.statusCode });
        });
      });
      req.on('error', (err) => done({ ok: false, status: 502, error: err.message }));
      req.setTimeout(10000, () => req.destroy(new Error('Timeout')));
      req.write(body);
      req.end();
    }

    function connect() {
      if (!serverUrl || !apiKey || !session) {
        console.error('[CloudRelay] Cannot start: url, apiKey, and session are required');
        return;
      }

      console.log(`[CloudRelay] Starting relay to ${serverUrl}`);
      console.log(`[CloudRelay] Push interval: ${pushInterval}ms, Command delivery: long-poll`);

      // Initial health check
      makeRequest(`${serverUrl}/api/health`, 'GET', null, (err, status) => {
        if (!err && status === 200) {
          serverReachable = true;
          console.log(`[CloudRelay] Server reachable (${serverUrl})`);
        } else {
          console.error(`[CloudRelay] Server not reachable: ${err ? err.message : `HTTP ${status}`}`);
        }
      });

      // Push on state changes:
      //   PTT changes → push immediately (no debounce) — operators need instant TX feedback
      //   freq/mode/connected changes → 50ms debounce to collapse rapid VFO spinning
      if (typeof onStateChange === 'function') {
        stateChangeHandler = () => {
          const pttChanged = state.ptt !== lastPttState;
          if (pttChanged) {
            lastPttState = state.ptt;
            // Cancel any pending debounced push and push right now
            if (immediatePushTimer) clearTimeout(immediatePushTimer);
            immediatePushTimer = null;
            pushState();
          } else {
            if (immediatePushTimer) clearTimeout(immediatePushTimer);
            immediatePushTimer = setTimeout(pushState, 50);
          }
        };
        onStateChange(stateChangeHandler);
        console.log('[CloudRelay] Subscribed to immediate state changes');
      }

      // Fallback interval for batched data (decodes, APRS) even if state hasn't changed
      pushTimer = setInterval(pushState, pushInterval);

      // Start long-poll command loop — replaces the old fixed-interval poll.
      // Each iteration holds the server connection open until a command arrives
      // or the 28 s window expires, so commands are delivered within ~RTT.
      longPollCommands();

      // Subscribe to plugin bus — batch decodes, APRS, and MeshCom packets for push.
      // cfg.relayWsjtx and cfg.relayAprs default to true to preserve existing behaviour.
      // cfg.relayMeshCom defaults to true.
      if (pluginBus) {
        const relayWsjtx = cfg.relayWsjtx !== false;
        const relayAprs = cfg.relayAprs !== false;
        const relayMeshCom = cfg.relayMeshCom !== false;
        const subscribed = [];

        if (relayWsjtx) {
          pluginBus.on('decode', (msg) => {
            pendingDecodes.push({
              source: msg.source,
              message: msg.message,
              snr: msg.snr,
              deltaFreq: msg.deltaFreq,
              mode: msg.mode,
              time: msg.time?.formatted,
              timestamp: msg.timestamp,
            });
            // Cap pending queue
            if (pendingDecodes.length > 200) pendingDecodes.splice(0, pendingDecodes.length - 200);
          });
          subscribed.push('WSJT-X');
        }
        if (relayAprs) {
          pluginBus.on('aprs', (packet) => {
            pendingAprs.push(packet);
            if (pendingAprs.length > 200) pendingAprs.splice(0, pendingAprs.length - 200);
          });
          subscribed.push('APRS');
        }
        if (relayMeshCom) {
          pluginBus.on('meshcom', (packet) => {
            pendingMeshCom.push(packet);
            if (pendingMeshCom.length > 200) pendingMeshCom.splice(0, pendingMeshCom.length - 200);
          });
          subscribed.push('MeshCom');
        }
        if (cfg.relayHamAlert !== false) {
          pluginBus.on('hamalert', (alert) => {
            pendingHamAlerts.push(alert);
            if (pendingHamAlerts.length > 200) pendingHamAlerts.splice(0, pendingHamAlerts.length - 200);
          });
          subscribed.push('HamAlert');
        }
        if (cfg.relayFldigi !== false) {
          const soon = () => {
            if (fldigiPushTimer) return;
            fldigiPushTimer = setTimeout(() => {
              fldigiPushTimer = null;
              pushState();
            }, 250);
          };
          pluginBus.on('fldigi', (status) => {
            pendingFldigiStatus = status;
            soon();
          });
          pluginBus.on('fldigi-rx', (rx) => {
            const text = String(rx?.text ?? '');
            if (rx?.reset || !pendingFldigiRx) {
              pendingFldigiRx = { text: text.slice(-FLDIGI_RX_MAX), reset: !!rx?.reset };
            } else {
              pendingFldigiRx = {
                text: (pendingFldigiRx.text + text).slice(-FLDIGI_RX_MAX),
                reset: pendingFldigiRx.reset,
              };
            }
            soon();
          });
          for (const event of ['nbems-form', 'fldigi-cmd-result']) {
            pluginBus.on(event, (data) => {
              const { fields, ...slim } = data || {};
              pendingFldigiOther.push({ event, source: 'fldigi', data: slim });
              if (pendingFldigiOther.length > 50) pendingFldigiOther.splice(0, pendingFldigiOther.length - 50);
              soon();
            });
          }
          subscribed.push('fldigi');
        }
        console.log(`[CloudRelay] Subscribed to plugin bus (${subscribed.join(', ')})`);
      }
    }

    function disconnect() {
      if (pushTimer) {
        clearInterval(pushTimer);
        pushTimer = null;
      }
      // Signal the long-poll loop to stop; clear any pending error-backoff timer
      pollAborted = true;
      if (pollRetryTimer) {
        clearTimeout(pollRetryTimer);
        pollRetryTimer = null;
      }
      if (immediatePushTimer) {
        clearTimeout(immediatePushTimer);
        immediatePushTimer = null;
      }
      clearTimeout(fldigiPushTimer);
      fldigiPushTimer = null;
      if (stateChangeHandler && typeof removeStateChangeListener === 'function') {
        removeStateChangeListener(stateChangeHandler);
      }
      _currentInstance = null;
      console.log(`[CloudRelay] Stopped (pushed: ${totalPushed}, commands: ${totalCommands})`);
    }

    function getStatus() {
      return {
        enabled: !!(cfg.url && cfg.apiKey),
        running: pushTimer !== null,
        serverReachable,
        serverUrl,
        totalPushed,
        totalCommands,
        consecutiveErrors,
        pushInterval,
        commandDelivery: 'long-poll',
      };
    }

    const instance = { connect, disconnect, getStatus, _pushState: pushState, _executeCommand: executeCommand };
    _currentInstance = instance;
    return instance;
  },
};

module.exports = descriptor;
