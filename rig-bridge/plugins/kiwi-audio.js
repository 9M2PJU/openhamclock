'use strict';
/**
 * kiwi-audio.js — relay a KiwiSDR's demodulated audio to the browser
 *
 * Feeds the OpenHamClock Decoder panel (CW decoder + waterfall) with what a
 * KiwiSDR actually hears. The browser cannot talk to a Kiwi itself (the
 * hosted site is HTTPS, Kiwis are plain ws://, and the Kiwi protocol needs a
 * handshake), so the bridge holds the Kiwi socket and streams raw PCM over a
 * plain HTTP response.
 *
 * ON DEMAND ONLY: nothing connects to the receiver until a browser opens
 * /api/kiwi-audio/stream, and the Kiwi socket is closed the moment that
 * response ends. One stream at a time — a new request replaces the old one,
 * so a forgotten tab never holds two receiver slots.
 *
 * Config section: config.kiwiAudio
 *   enabled:  boolean (default false)
 *   host:     KiwiSDR host (no scheme) — falls back to beaconMonitor.host
 *   port:     number (default 8073)  — falls back to beaconMonitor.port
 *   password: Kiwi user password     — falls back to beaconMonitor.password
 *
 * Routes:
 *   GET  /api/kiwi-audio/status                     (open — no secrets in it)
 *   GET  /api/kiwi-audio/stream?freq=<kHz>&mode=cw  (token) → 200 application/octet-stream
 *        headers X-Sample-Rate (Hz, may be fractional) and X-Audio-Format: s16be;
 *        body = 16-bit big-endian mono PCM, continuously, until either side closes.
 *   POST /api/kiwi-audio/tune  { freqKHz, mode }     (token) retune the live stream
 *   POST /api/kiwi-audio/stop                        (token) end the live stream
 */

const { KiwiConnection } = require('../lib/kiwi-connection');

const READY_TIMEOUT_MS = 15000;

/** Passband per mode (audio Hz). CW is wide so neighbouring signals show on the waterfall. */
const PASSBANDS = {
  cw: { lowCut: 200, highCut: 1200 },
  usb: { lowCut: 200, highCut: 2800 },
  lsb: { lowCut: -2800, highCut: -200 },
  am: { lowCut: -4000, highCut: 4000 },
};

let _currentInstance = null;

function parseTune(freq, mode) {
  const freqKHz = Number(freq);
  if (!Number.isFinite(freqKHz) || freqKHz < 10 || freqKHz > 32000) return { error: 'freq must be 10–32000 kHz' };
  const m = String(mode || 'cw').toLowerCase();
  if (!PASSBANDS[m]) return { error: `mode must be one of ${Object.keys(PASSBANDS).join(', ')}` };
  return { freqKHz, mode: m, ...PASSBANDS[m] };
}

function receiverConfig(config) {
  const a = config.kiwiAudio || {};
  const b = config.beaconMonitor || {};
  const host = String(a.host || b.host || '').trim();
  const usesBeacon = !String(a.host || '').trim() && !!host;
  const port = Number(a.port) || (usesBeacon ? Number(b.port) : 0) || 8073;
  const password = a.password != null && a.password !== '' ? a.password : usesBeacon ? b.password || '' : '';
  return { host, port, password, usesBeacon };
}

const descriptor = {
  id: 'kiwi-audio',
  name: 'KiwiSDR Audio (Decoder panel)',
  category: 'monitor',
  configKey: 'kiwiAudio',

  registerRoutes(app) {
    app.get('/api/kiwi-audio/status', (req, res) => {
      if (!_currentInstance) return res.json({ enabled: false, running: false, streaming: false });
      res.json(_currentInstance.getStatus());
    });
  },

  registerAuthRoutes(app, requireAuth) {
    app.get('/api/kiwi-audio/stream', requireAuth, (req, res) => {
      if (!_currentInstance) {
        return res.status(503).json({ error: 'KiwiSDR audio is not enabled in Rig Bridge' });
      }
      const t = parseTune(req.query.freq, req.query.mode);
      if (t.error) return res.status(400).json({ error: t.error });
      _currentInstance.startStream(req, res, t);
    });

    app.post('/api/kiwi-audio/tune', requireAuth, (req, res) => {
      if (!_currentInstance) return res.status(503).json({ error: 'KiwiSDR audio is not enabled in Rig Bridge' });
      const body = req.body || {};
      const t = parseTune(body.freqKHz, body.mode);
      if (t.error) return res.status(400).json({ error: t.error });
      const ok = _currentInstance.tune(t);
      res.json({ success: ok, tuning: _currentInstance.getStatus().tuning });
    });

    app.post('/api/kiwi-audio/stop', requireAuth, (req, res) => {
      if (_currentInstance) _currentInstance.stopStream('stopped by request');
      res.json({ success: true });
    });
  },

  create(config, services = {}) {
    const log = (msg) => console.log(`[KiwiAudio] ${msg}`);
    const ConnectionImpl = services.KiwiConnection || KiwiConnection;
    let running = false;
    let stream = null; // { conn, res, tuning, startedAt, bytes, dropped }
    let lastError = null;

    function stopStream(reason) {
      const s = stream;
      stream = null;
      if (!s) return;
      try {
        s.conn.removeAllListeners();
        s.conn.on('error', () => {});
        s.conn.close();
      } catch (e) {}
      if (s.timer) clearTimeout(s.timer);
      try {
        if (!s.res.headersSent) s.res.status(503).json({ error: reason || 'stream closed' });
        else s.res.end();
      } catch (e) {}
      if (reason) log(`stream ended (${reason})`);
    }

    function startStream(req, res, tuning) {
      const rx = receiverConfig(config);
      if (!rx.host) {
        return res.status(503).json({ error: 'No KiwiSDR host configured (kiwiAudio.host or beaconMonitor.host)' });
      }
      // One receiver slot at a time: a new listener replaces the old one.
      if (stream) stopStream('replaced by a new stream');

      const conn = new ConnectionImpl({
        host: rx.host,
        port: rx.port,
        password: rx.password,
        ident: 'OpenHamClock decoder',
        tuning: { freqKHz: tuning.freqKHz, mode: tuning.mode, lowCut: tuning.lowCut, highCut: tuning.highCut },
        reconnect: { enabled: true, minMs: 2000, maxMs: 30000 },
        log: (m) => log(m),
      });
      const s = { conn, res, tuning, startedAt: Date.now(), bytes: 0, dropped: 0, blocked: false, timer: null };
      stream = s;

      s.timer = setTimeout(() => {
        if (stream === s && !res.headersSent) {
          lastError = conn.lastError || 'KiwiSDR did not answer';
          stream = null;
          try {
            conn.close();
          } catch (e) {}
          res.status(504).json({ error: lastError });
        }
      }, READY_TIMEOUT_MS);

      conn.on('ready', ({ sampleRate }) => {
        if (stream !== s || res.headersSent) return;
        clearTimeout(s.timer);
        s.timer = null;
        lastError = null;
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Sample-Rate': String(sampleRate),
          'X-Audio-Format': 's16be',
          'Access-Control-Expose-Headers': 'X-Sample-Rate, X-Audio-Format',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        log(`streaming ${tuning.freqKHz} kHz ${tuning.mode} from ${rx.host}:${rx.port} @ ${sampleRate} Hz`);
      });
      conn.on('audio', ({ pcm }) => {
        if (stream !== s || !res.headersSent) return;
        // Live audio: never queue behind a slow client — drop until it drains.
        if (s.blocked) {
          s.dropped += pcm.length;
          return;
        }
        s.bytes += pcm.length;
        if (!res.write(pcm)) {
          s.blocked = true;
          res.once('drain', () => (s.blocked = false));
        }
      });
      conn.on('rejected', (ev) => {
        lastError = ev.reason;
        if (stream === s) stopStream(`rejected by KiwiSDR: ${ev.reason}`);
      });
      conn.on('error', (err) => {
        lastError = err && err.message ? err.message : String(err);
      });
      req.on('close', () => {
        if (stream === s) stopStream('listener disconnected');
      });
      conn.connect();
    }

    function tune(t) {
      if (!stream) return false;
      stream.tuning = t;
      return stream.conn.tune(t.freqKHz, { mode: t.mode, lowCut: t.lowCut, highCut: t.highCut });
    }

    function getStatus() {
      const rx = receiverConfig(config);
      return {
        enabled: !!(config.kiwiAudio && config.kiwiAudio.enabled),
        running,
        configured: !!rx.host,
        host: rx.host || null,
        port: rx.port,
        sharedWithBeaconMonitor: rx.usesBeacon,
        streaming: !!stream,
        connected: !!(stream && stream.conn.connected),
        sampleRate: stream ? stream.conn.sampleRate : null,
        tuning: stream ? { freqKHz: stream.tuning.freqKHz, mode: stream.tuning.mode } : null,
        startedAt: stream ? stream.startedAt : null,
        bytes: stream ? stream.bytes : 0,
        lastError,
      };
    }

    const instance = {
      connect() {
        running = true;
        log('ready — connects to the KiwiSDR only while a Decoder panel listens');
      },
      disconnect() {
        running = false;
        stopStream('plugin stopped');
        if (_currentInstance === instance) _currentInstance = null;
      },
      startStream,
      stopStream,
      tune,
      getStatus,
    };
    _currentInstance = instance;
    return instance;
  },
};

module.exports = descriptor;
module.exports.parseTune = parseTune;
module.exports.receiverConfig = receiverConfig;
