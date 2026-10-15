'use strict';
/**
 * gpio-logic.js — pure state machine behind the GPIO plugin.
 *
 * Everything here is deterministic and hardware-free so it can be unit
 * tested: the pin map (HamClock-compatible defaults), the output logic that
 * turns indicator state into pin levels (including the satellite pulse
 * patterns), input debouncing, and parsers for the libgpiod CLI tools.
 *
 * Pin numbers are BCM GPIO numbers (what libgpiod and sysfs use), not
 * header positions. HEADER_TO_BCM documents the 40-pin header for the
 * manual and lets users type a header pin as "P37".
 */

/** Raspberry Pi 40-pin header → BCM GPIO number (power/ground pins omitted). */
const HEADER_TO_BCM = {
  3: 2,
  5: 3,
  7: 4,
  8: 14,
  10: 15,
  11: 17,
  12: 18,
  13: 27,
  15: 22,
  16: 23,
  18: 24,
  19: 10,
  21: 9,
  22: 25,
  23: 11,
  24: 8,
  26: 7,
  27: 0,
  28: 1,
  29: 5,
  31: 6,
  32: 12,
  33: 13,
  35: 19,
  36: 16,
  37: 26,
  38: 20,
  40: 21,
};

/**
 * Default pin map — matches HamClock's header assignments (manual p.24):
 *   countdown: switch pin 37 (BCM 26), green LED pin 33 (BCM 13), red LED
 *              pin 35 (BCM 19); pin 17 is the 3V3 feed for the switch
 *   satellite alarm: pin 38 (BCM 20)
 *   on-air: pin 40 (BCM 21)
 *   alarm clock: output pin 31 (BCM 6), reset switch pin 29 (BCM 5)
 * HamClock has no PTT *input*; we add one on pin 36 (BCM 16).
 */
const DEFAULT_PINS = {
  pttIn: 16, // header 36 — PTT / ON-AIR sense, active low
  countdownResetIn: 26, // header 37 — countdown restart button, active low
  alarmSilenceIn: 5, // header 29 — alarm silence button, active low
  onAirOut: 21, // header 40 — ON-AIR LED
  alarmOut: 6, // header 31 — alarm ringing
  countdownGreenOut: 13, // header 33 — countdown running
  countdownRedOut: 19, // header 35 — countdown expired
  satOut: 20, // header 38 — satellite visible / AOS warning
};

const INPUT_NAMES = ['pttIn', 'countdownResetIn', 'alarmSilenceIn'];
const OUTPUT_NAMES = ['onAirOut', 'alarmOut', 'countdownGreenOut', 'countdownRedOut', 'satOut'];

/**
 * Parse one pin value: BCM number, "P37" header reference, or -1/''/null to
 * disable the function. Returns null for disabled.
 */
function parsePin(v) {
  if (v == null || v === '' || v === false) return null;
  if (typeof v === 'string') {
    const m = /^\s*[Pp](?:in)?\s*(\d{1,2})\s*$/.exec(v);
    if (m) {
      const bcm = HEADER_TO_BCM[parseInt(m[1], 10)];
      return bcm == null ? null : bcm;
    }
    v = parseInt(v, 10);
  }
  if (!Number.isInteger(v) || v < 0 || v > 57) return null;
  return v;
}

/**
 * Merge user config over the defaults; returns { inputs: {name: bcm}, outputs:
 * {name: bcm}, conflicts: [name...] }. A BCM number used twice disables the
 * later one and reports it.
 */
function resolvePinMap(userPins = {}) {
  const inputs = {};
  const outputs = {};
  const used = new Map();
  const conflicts = [];
  for (const name of [...INPUT_NAMES, ...OUTPUT_NAMES]) {
    const raw = Object.prototype.hasOwnProperty.call(userPins, name) ? userPins[name] : DEFAULT_PINS[name];
    const bcm = parsePin(raw);
    if (bcm == null) continue;
    if (used.has(bcm)) {
      conflicts.push(name);
      continue;
    }
    used.set(bcm, name);
    (INPUT_NAMES.includes(name) ? inputs : outputs)[name] = bcm;
  }
  return { inputs, outputs, conflicts };
}

/** Square wave: true during the high half-period of an `hz` pulse train. */
function pulse(nowMs, hz) {
  const half = 1000 / hz / 2;
  return Math.floor(nowMs / half) % 2 === 0;
}

const COUNTDOWN_STATES = new Set(['off', 'running', 'expired']);

/**
 * Normalise the indicator payload the browser POSTs to /api/indicators.
 * Unknown keys are dropped; wrong types fall back to "off".
 */
function sanitizeIndicators(body) {
  const b = body && typeof body === 'object' ? body : {};
  const n = (v) =>
    Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null;
  return {
    satVisible: b.satVisible === true,
    satAosInSec: n(b.satAosInSec),
    satLosInSec: n(b.satLosInSec),
    alarm: b.alarm === true,
    countdown: COUNTDOWN_STATES.has(b.countdown) ? b.countdown : 'off',
  };
}

/**
 * Compute desired output levels (true = asserted) from the current state.
 *
 * @param {object} s
 * @param {boolean} s.ptt        rig PTT from the radio plugin
 * @param {boolean} s.pttIn      PTT sense input active
 * @param {object}  s.indicators sanitized indicators from the browser
 * @param {boolean} s.indicatorsStale  browser hasn't refreshed in a while
 * @param {boolean} s.alarmSilenced    silence button pressed since alarm began
 * @param {number}  nowMs
 */
function computeOutputs(s, nowMs) {
  const ind = s.indicators || sanitizeIndicators(null);
  const live = !s.indicatorsStale;
  const onAir = !!(s.ptt || s.pttIn);
  const alarm = live && ind.alarm && !s.alarmSilenced;
  const countdownGreen = live && ind.countdown === 'running';
  const countdownRed = live && ind.countdown === 'expired';

  // Satellite: 1 Hz the minute before AOS, steady during the pass, 2 Hz for
  // the last minute before LOS.
  let sat = false;
  if (live) {
    if (ind.satVisible) {
      sat = ind.satLosInSec != null && ind.satLosInSec <= 60 ? pulse(nowMs, 2) : true;
    } else if (ind.satAosInSec != null && ind.satAosInSec >= 0 && ind.satAosInSec <= 60) {
      sat = pulse(nowMs, 1);
    }
  }
  return {
    onAirOut: onAir,
    alarmOut: alarm,
    countdownGreenOut: countdownGreen,
    countdownRedOut: countdownRed,
    satOut: sat,
  };
}

/**
 * Debounced edge detector for a switch input.
 * `sample(rawLevel, nowMs)` → 'press' | 'release' | null. Active-low by
 * default (switch to ground with a pull-up).
 */
class InputDebouncer {
  constructor({ activeLow = true, debounceMs = 50 } = {}) {
    this.activeLow = activeLow;
    this.debounceMs = debounceMs;
    this.active = false; // debounced logical state
    this._candidate = null;
    this._candidateSince = 0;
  }

  _logical(raw) {
    const high = raw === 1 || raw === true || raw === '1';
    return this.activeLow ? !high : high;
  }

  sample(raw, nowMs) {
    const logical = this._logical(raw);
    if (logical === this.active) {
      this._candidate = null;
      return null;
    }
    if (this._candidate !== logical) {
      this._candidate = logical;
      this._candidateSince = nowMs;
      if (this.debounceMs <= 0) return this._commit(logical);
      return null;
    }
    if (nowMs - this._candidateSince >= this.debounceMs) return this._commit(logical);
    return null;
  }

  _commit(logical) {
    this.active = logical;
    this._candidate = null;
    return logical ? 'press' : 'release';
  }
}

/** libgpiod major version from `gpioset --version` output, or null. */
function parseGpiodVersion(text) {
  const m = /\bv?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Parse one `gpiomon` line into { offset, rising }.
 * Formats seen in the wild:
 *   v1 default : "event: FALLING EDGE offset: 26 timestamp: [1234.567]"
 *   v1 --format="%e %o": "0 26"  (0 = falling, 1 = rising)
 *   v2 default : "1697000000.123 falling gpiochip0 26" (tab or space separated)
 *   v2 --format="%e %o": "falling 26" or "0 26"
 */
function parseGpiomonLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  let m = /^event:\s+(RISING|FALLING)\s+EDGE\s+offset:\s+(\d+)/i.exec(s);
  if (m) return { offset: parseInt(m[2], 10), rising: m[1].toUpperCase() === 'RISING' };
  m = /^(?:\S+\s+)?(rising|falling|[01])\s+(?:\S*gpiochip\d+\s+)?(\d+)\b/i.exec(s);
  if (m) {
    const e = m[1].toLowerCase();
    return { offset: parseInt(m[2], 10), rising: e === 'rising' || e === '1' };
  }
  return null;
}

/** Parse `gpioget` output ("1 0 1" or "active inactive active") into 0/1 values. */
function parseGpiogetOutput(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const t = tok
        .toLowerCase()
        .replace(/^"?\d+"?=/, '')
        .replace(/"/g, '');
      if (t === '1' || t === 'active') return 1;
      if (t === '0' || t === 'inactive') return 0;
      return null;
    })
    .filter((v) => v !== null);
}

module.exports = {
  HEADER_TO_BCM,
  DEFAULT_PINS,
  INPUT_NAMES,
  OUTPUT_NAMES,
  parsePin,
  resolvePinMap,
  pulse,
  sanitizeIndicators,
  computeOutputs,
  InputDebouncer,
  parseGpiodVersion,
  parseGpiomonLine,
  parseGpiogetOutput,
};
