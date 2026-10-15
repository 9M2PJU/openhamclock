/**
 * cwDecoder.js — pure-JS CW (Morse) decoder core.
 *
 * Pipeline:  PCM → ToneDetector (Goertzel at the sidetone pitch, Hann window,
 *            75 % overlap) → tone power per hop → CWDecoder (dit-matched
 *            post-detection smoothing, adaptive threshold with hysteresis,
 *            glitch/dropout filter, dit-length tracking, dot/dash/gap
 *            classification, Morse table) → text.
 *
 * ToneFinder scans a pitch range and reports the strongest keyed tone so the
 * panel can "auto-find" a signal instead of asking the operator to guess.
 *
 * IMPORTANT: this file has NO imports and touches no DOM/Web Audio API — it
 * runs inside the AudioWorkletGlobalScope (src/worklets/cwDecoderWorklet.js
 * imports it; Vite bundles the pair via `?worker&url`) as well as in vitest.
 */

// ── Morse table ───────────────────────────────────────────────────────────
export const MORSE_TABLE = {
  '.-': 'A',
  '-...': 'B',
  '-.-.': 'C',
  '-..': 'D',
  '.': 'E',
  '..-.': 'F',
  '--.': 'G',
  '....': 'H',
  '..': 'I',
  '.---': 'J',
  '-.-': 'K',
  '.-..': 'L',
  '--': 'M',
  '-.': 'N',
  '---': 'O',
  '.--.': 'P',
  '--.-': 'Q',
  '.-.': 'R',
  '...': 'S',
  '-': 'T',
  '..-': 'U',
  '...-': 'V',
  '.--': 'W',
  '-..-': 'X',
  '-.--': 'Y',
  '--..': 'Z',
  '-----': '0',
  '.----': '1',
  '..---': '2',
  '...--': '3',
  '....-': '4',
  '.....': '5',
  '-....': '6',
  '--...': '7',
  '---..': '8',
  '----.': '9',
  '.-.-.-': '.',
  '--..--': ',',
  '..--..': '?',
  '-..-.': '/',
  '-...-': '=',
  '.-.-.': '+',
  '-....-': '-',
  '.--.-.': '@',
  '---...': ':',
  '.----.': "'",
  '-.--.': '(',
  '-.--.-': ')',
  '..--.-': '_',
  '.-..-.': '"',
  '...-..-': '$',
  '-.-.--': '!',
  '.-...': '<AS>',
  '...-.-': '<SK>',
  '-.-.-': '<KA>',
};

/** Reverse table: character → dots/dashes (used by the synthesizer/tests). */
export const CHAR_TO_MORSE = (() => {
  const out = {};
  for (const [code, ch] of Object.entries(MORSE_TABLE)) if (!(ch in out)) out[ch] = code;
  return out;
})();

export const CW_MIN_WPM = 5;
export const CW_MAX_WPM = 45;
export const CW_DEFAULT_TONE_HZ = 600;
export const CW_DEFAULT_BANDWIDTH_HZ = 100;

/** PARIS timing: one dit in ms at a given WPM. */
export function ditMsForWpm(wpm) {
  return 1200 / wpm;
}

/** Inverse of ditMsForWpm. */
export function wpmForDitMs(ditMs) {
  return 1200 / ditMs;
}

// ── Goertzel ──────────────────────────────────────────────────────────────

/**
 * Goertzel power of `length` samples starting at `start`, at `freq` Hz.
 * `window` (optional Float32Array of `length`) is multiplied in. The result
 * is normalised so a full-amplitude-A sine returns ≈ A² (with a Hann window
 * the coherent gain is 0.5, so pass `windowGain` = 0.5 to compensate).
 */
export function goertzelPower(samples, start, length, sampleRate, freq, window, windowGain = 1) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  if (window) {
    for (let i = 0; i < length; i++) {
      const s0 = samples[start + i] * window[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
  } else {
    for (let i = 0; i < length; i++) {
      const s0 = samples[start + i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  const norm = (length * windowGain) / 2;
  return power / (norm * norm);
}

/** Hann window of n samples (coherent gain 0.5, noise bandwidth 1.5 bins). */
export function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// ── ToneDetector: PCM → tone power per hop ────────────────────────────────

/**
 * Narrow bandpass energy detector built on Goertzel. Accepts PCM chunks of
 * any length, keeps a ring buffer of one analysis window and emits one power
 * value every `hop` samples (75 % overlap, Hann window).
 *
 * `bandwidth` is the filter's equivalent noise bandwidth in Hz: the window
 * length is 1.5·sampleRate/bandwidth (a Hann window spans 1.5 bins of noise).
 * Narrower = better weak-signal copy but less tuning tolerance (±bw/2).
 */
export class ToneDetector {
  constructor({ sampleRate = 48000, tone = CW_DEFAULT_TONE_HZ, bandwidth = CW_DEFAULT_BANDWIDTH_HZ } = {}) {
    this.sampleRate = sampleRate;
    this.tone = tone;
    this.setBandwidth(bandwidth);
  }

  setTone(hz) {
    this.tone = hz;
  }

  setBandwidth(bandwidth) {
    this.bandwidth = bandwidth;
    // Window length a multiple of 4 (so the hop is an integer), ≥ 32 samples
    const n = Math.max(32, Math.round((1.5 * this.sampleRate) / bandwidth / 4) * 4);
    this.n = n;
    this.hop = n / 4;
    this.hopMs = (this.hop / this.sampleRate) * 1000;
    this.window = hannWindow(n);
    this.ring = new Float32Array(n);
    this.linear = new Float32Array(n);
    this.writePos = 0;
    this.sinceHop = 0;
    this.filled = 0;
  }

  /**
   * Feed PCM. `onPower(power, dtMs)` is called once per hop with the tone
   * power (≈ amplitude²) over the last window and the hop duration in ms.
   */
  process(chunk, onPower) {
    const { n, hop } = this;
    for (let i = 0; i < chunk.length; i++) {
      this.ring[this.writePos] = chunk[i];
      this.writePos = (this.writePos + 1) % n;
      if (this.filled < n) this.filled++;
      if (++this.sinceHop >= hop && this.filled >= n) {
        this.sinceHop = 0;
        // Unroll the ring into a linear buffer (oldest sample first)
        const tail = n - this.writePos;
        this.linear.set(this.ring.subarray(this.writePos), 0);
        this.linear.set(this.ring.subarray(0, this.writePos), tail);
        const p = goertzelPower(this.linear, 0, n, this.sampleRate, this.tone, this.window, 0.5);
        onPower(p, this.hopMs);
      }
    }
  }
}

// ── ToneFinder: where is the strongest keyed tone? ────────────────────────

/**
 * Scans [minHz, maxHz] in `stepHz` steps over a long window and keeps a
 * peak-hold (with decay) per candidate so a keyed signal's pitch survives
 * the gaps between elements. `best()` returns the current winner.
 */
export class ToneFinder {
  constructor({ sampleRate = 48000, minHz = 300, maxHz = 1200, stepHz = 10, windowMs = 85, decayDbPerSec = 3 } = {}) {
    this.sampleRate = sampleRate;
    this.minHz = minHz;
    this.maxHz = maxHz;
    this.stepHz = stepHz;
    this.n = Math.max(256, Math.round((sampleRate * windowMs) / 1000) & ~1);
    this.window = hannWindow(this.n);
    this.buf = new Float32Array(this.n);
    this.fill = 0;
    this.freqs = [];
    for (let f = minHz; f <= maxHz + 1e-6; f += stepHz) this.freqs.push(f);
    this.held = new Float64Array(this.freqs.length).fill(-120);
    this.decayDb = (decayDbPerSec * this.n) / sampleRate; // per analysis window
    this.updates = 0;
  }

  reset() {
    this.held.fill(-120);
    this.fill = 0;
    this.updates = 0;
  }

  /** Feed PCM; analyses every full window. Returns true when an analysis ran. */
  process(chunk) {
    let analysed = false;
    let i = 0;
    while (i < chunk.length) {
      const take = Math.min(chunk.length - i, this.n - this.fill);
      this.buf.set(chunk.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === this.n) {
        this.analyse();
        this.fill = 0;
        analysed = true;
      }
    }
    return analysed;
  }

  analyse() {
    for (let k = 0; k < this.freqs.length; k++) {
      const p = goertzelPower(this.buf, 0, this.n, this.sampleRate, this.freqs[k], this.window, 0.5);
      const db = 10 * Math.log10(p + 1e-12);
      const decayed = this.held[k] - this.decayDb;
      this.held[k] = db > decayed ? db : decayed;
    }
    this.updates++;
  }

  /**
   * Strongest candidate: { freq, db, snrDb } where snrDb is the margin over
   * the median of all candidates (a rough "is there really a tone?" figure).
   */
  best() {
    let bestK = 0;
    for (let k = 1; k < this.held.length; k++) if (this.held[k] > this.held[bestK]) bestK = k;
    const sorted = Array.from(this.held).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    // Parabolic interpolation between neighbours for sub-step accuracy
    let freq = this.freqs[bestK];
    if (bestK > 0 && bestK < this.held.length - 1) {
      const a = this.held[bestK - 1];
      const b = this.held[bestK];
      const c = this.held[bestK + 1];
      const denom = a - 2 * b + c;
      if (denom < 0) freq += ((0.5 * (a - c)) / denom) * this.stepHz;
    }
    return { freq: Math.round(freq), db: this.held[bestK], snrDb: this.held[bestK] - median };
  }
}

// ── helpers for the timing machine ────────────────────────────────────────

/**
 * Two-means split of a list of durations. Returns { lo, hi, loN, hiN } or
 * null when the values do not separate into two clusters at least `minRatio`
 * apart.
 */
export function twoMeans(values, minRatio = 1.6) {
  if (values.length < 2) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max < min * minRatio) return null;
  let lo = min;
  let hi = max;
  let loN = 0;
  let hiN = 0;
  for (let iter = 0; iter < 8; iter++) {
    const split = (lo + hi) / 2;
    let loSum = 0;
    let hiSum = 0;
    loN = 0;
    hiN = 0;
    for (const v of values) {
      if (v < split) {
        loSum += v;
        loN++;
      } else {
        hiSum += v;
        hiN++;
      }
    }
    if (!loN || !hiN) return null;
    lo = loSum / loN;
    hi = hiSum / hiN;
  }
  if (hi < lo * minRatio) return null;
  return { lo, hi, loN, hiN };
}

// ── CWDecoder: tone power → keyed state → symbols → text ──────────────────

/**
 * @typedef {Object} CWDecoderOptions
 * @property {(text: string) => void} [onText]   decoded characters (may be several)
 * @property {number} [initialWpm=20]             starting dit estimate
 * @property {number} [minWpm=5]
 * @property {number} [maxWpm=45]
 * @property {number} [minSnrDb=7]                squelch: below this peak-to-noise ratio nothing is keyed
 * @property {number} [smoothDits=0.4]            post-detection integration, in dits
 */
export class CWDecoder {
  constructor(options = {}) {
    this.onText = options.onText || (() => {});
    this.minWpm = options.minWpm ?? CW_MIN_WPM;
    this.maxWpm = options.maxWpm ?? CW_MAX_WPM;
    this.ditMin = ditMsForWpm(this.maxWpm);
    this.ditMax = ditMsForWpm(this.minWpm);
    this.minSnrDb = options.minSnrDb ?? 6;
    this.squelchDevs = options.squelchDevs ?? 5;
    this.smoothDits = options.smoothDits ?? 0.3;
    this.initialDit = this.clampDit(ditMsForWpm(options.initialWpm ?? 20));
    this.reset();
  }

  clampDit(ms) {
    return Math.min(this.ditMax, Math.max(this.ditMin, ms));
  }

  reset() {
    // Level stage (linear power)
    this.smooth = new Float64Array(64);
    this.smoothPos = 0;
    this.smoothLen = 0;
    this.power = 0;
    this.noise = 0;
    this.peak = 0;
    this.noiseAmp = 0;
    this.noiseDev = 0;
    this.peakAmp = 0;
    this.clock = 0;
    this.holdUntil = 0;
    this.strongRun = 0;
    this.primed = false;
    this.keyed = false;
    // Timing machine
    this.dit = this.initialDit;
    this.marks = []; // recent mark durations (ms) for dit tracking
    this.gaps = []; // recent inter-character/word gaps (ms) for spacing tracking
    this.on = false;
    this.markDur = 0;
    this.gapDur = 1e9; // "long silence" before the first mark
    this.pending = 0; // last confirmed mark (ms), awaiting the gap that follows it
    this.havePending = false;
    this.gapHandled = true; // the current gap already closed the character
    this.wordPending = false; // a character has been printed since the last space
    this.charMarks = [];
    this.decodedChars = 0;
  }

  get wpm() {
    return Math.round(wpmForDitMs(this.dit));
  }

  /** Peak-to-noise ratio in dB (signal meter). */
  get snrDb() {
    if (!this.primed || this.noise <= 0) return 0;
    return Math.max(0, 10 * Math.log10(this.peak / this.noise));
  }

  /** Current state snapshot for meters. */
  getState() {
    return {
      wpm: this.wpm,
      ditMs: this.dit,
      snrDb: this.snrDb,
      levelDb: 10 * Math.log10(this.power + 1e-12),
      noiseDb: 10 * Math.log10(this.noise + 1e-12),
      keyed: this.keyed,
      chars: this.decodedChars,
    };
  }

  /**
   * Feed one tone-power sample (≈ amplitude², linear) covering `dtMs`.
   * Smooths over ~0.4 dit, tracks noise (mean while unkeyed) and peak
   * (instant attack, slow decay), and keys with hysteresis at 50 % / 35 %
   * of the way from noise to peak in linear power — symmetric crossings, so
   * mark and space lengths survive the smoothing.
   */
  processLevel(power, dtMs) {
    // Boxcar over K hops of power, K tied to the current dit estimate
    const len = this.smooth.length;
    const k = Math.max(1, Math.min(len, Math.round((this.smoothDits * this.dit) / dtMs)));
    this.smooth[this.smoothPos] = power;
    this.smoothPos = (this.smoothPos + 1) % len;
    if (this.smoothLen < len) this.smoothLen++;
    let sum = 0;
    const n = Math.min(k, this.smoothLen);
    for (let i = 1; i <= n; i++) sum += this.smooth[(this.smoothPos - i + len) % len];
    const p = sum / n;
    this.power = p;
    // Thresholds work on amplitude: a Goertzel's amplitude ramps (nearly)
    // linearly through an edge, so mid-scale crossings preserve durations.
    const a = Math.sqrt(p);

    if (!this.primed) {
      this.primed = true;
      this.noiseAmp = a || 1e-7;
      this.noiseDev = this.noiseAmp * 0.5;
      this.peakAmp = this.noiseAmp;
    }
    const dtSec = dtMs / 1000;
    if (!this.keyed) {
      // Noise: mean and mean-absolute-deviation of the unkeyed amplitude.
      // Falls fast (a signal ended / QSB), rises slowly (a signal started).
      // The first 200 ms converge fast both ways (no history yet).
      const warm = this.clock < 200;
      const al = a < this.noiseAmp || warm ? Math.min(1, dtSec / (warm ? 0.04 : 0.1)) : Math.min(1, dtSec / 0.5);
      this.noiseAmp += (a - this.noiseAmp) * al;
      this.noiseDev += (Math.abs(a - this.noiseAmp) - this.noiseDev) * Math.min(1, dtSec / 0.5);
    } else {
      // +0.5 dB/s while keyed, so a stuck carrier eventually unkeys
      this.noiseAmp *= 10 ** ((0.5 * dtSec) / 20);
    }
    if (this.noiseAmp < 1e-7) this.noiseAmp = 1e-7;
    // Peak: instant attack, −6 dB/s decay, never below noise
    if (a > this.peakAmp) this.peakAmp = a;
    else this.peakAmp = Math.max(this.noiseAmp, this.peakAmp * 10 ** ((-6 * dtSec) / 20));
    this.noise = this.noiseAmp * this.noiseAmp;
    this.peak = this.peakAmp * this.peakAmp;

    // Squelch with hysteresis: the peak must clear the noise both in ratio
    // and in spread. Opening takes `squelchDevs` (5) noise deviations — random
    // noise practically never gets there, so it does not print E's — and once
    // a real signal has done that, the squelch holds at 70 % of that margin
    // for 4 s after each strong element so weak copy is not chopped.
    this.clock += dtMs;
    const strong = this.noiseAmp + this.squelchDevs * this.noiseDev;
    // "Strong" must persist for 0.6 dit: real elements last ≥ 1 dit, noise
    // spikes last about one analysis window.
    if (a >= strong && a >= this.noiseAmp * 10 ** (this.minSnrDb / 20)) this.strongRun += dtMs;
    else this.strongRun = 0;
    if (this.strongRun >= this.dit * 0.4) this.holdUntil = this.clock + 4000;
    const devs = this.clock < this.holdUntil ? this.squelchDevs * 0.7 : this.squelchDevs;
    let keyed = false;
    const open =
      this.peakAmp >= this.noiseAmp * 10 ** (this.minSnrDb / 20) &&
      this.peakAmp >= this.noiseAmp + devs * this.noiseDev;
    if (open) {
      const span = this.peakAmp - this.noiseAmp;
      keyed = this.keyed ? a > this.noiseAmp + span * 0.4 : a > this.noiseAmp + span * 0.5;
    }
    this.keyed = keyed;
    this.processEnvelope(keyed, dtMs);
  }

  /**
   * Feed a keyed/unkeyed state covering `dtMs` (what processLevel produces,
   * exposed so tests and other front ends can drive the timing machine).
   */
  processEnvelope(isOn, dtMs) {
    if (isOn) {
      if (!this.on) {
        this.on = true;
        this.markDur = 0;
      }
      this.markDur += dtMs;
      return;
    }
    if (this.on) {
      this.on = false;
      this.endMark(this.markDur);
    }
    this.gapDur += dtMs;
    this.checkTimeouts();
  }

  /** Force out whatever is pending (end of stream / source change). */
  flush() {
    if (this.on) {
      this.on = false;
      this.endMark(this.markDur);
    }
    if (this.havePending && !this.gapHandled) {
      this.appendElement(this.pending);
      this.havePending = false;
      this.gapHandled = true;
    }
    this.flushChar();
    this.gapDur = 1e9;
  }

  // ── internals ──

  endMark(mark) {
    const glitch = Math.max(5, this.dit * 0.3);
    if (mark < glitch) {
      // Noise spike: its time belongs to the surrounding gap
      this.gapDur += mark;
      return;
    }
    if (mark > this.ditMax * 5) {
      // A carrier (tune-up, beacon dash, stuck key) — not Morse. Drop it.
      this.charMarks = [];
      this.havePending = false;
      this.gapHandled = true;
      this.gapDur = 0;
      return;
    }
    const gap = this.gapDur;
    if (this.havePending && !this.gapHandled && gap < Math.max(5, this.dit * 0.3)) {
      // Dropout inside a mark (fading/QSB): merge
      this.pending += gap + mark;
      this.gapDur = 0;
      return;
    }
    // A mark far longer than a dash at the current estimate means the sender
    // is much slower than we think — rescale before classifying anything.
    if (mark > this.dit * 5) this.dit = this.clampDit(mark / 3);
    if (this.havePending) {
      this.appendElement(this.pending);
      if (!this.gapHandled) this.classifyGap(gap);
    }
    if (gap < this.ditMax * 20) this.noteGap(gap);
    this.pending = mark;
    this.havePending = true;
    this.gapHandled = false;
    this.gapDur = 0;
  }

  checkTimeouts() {
    if (this.havePending && !this.gapHandled && this.gapDur >= this.charGapThreshold()) {
      this.appendElement(this.pending);
      this.havePending = false;
      this.gapHandled = true;
      this.flushChar();
    }
    if (this.wordPending && this.gapDur >= this.wordGapThreshold()) {
      this.wordPending = false;
      this.emit(' ');
    }
  }

  charGapThreshold() {
    return this.dit * 2;
  }

  /**
   * Word-space threshold. Two-means over recent character/word gaps: with
   * both clusters present the split sits between them; with one cluster it
   * is assumed to be character spacing (most gaps in text are). Never below
   * 4.5 dits, so standard PARIS spacing (3 / 7) splits at ≥ 5 dits.
   */
  wordGapThreshold() {
    const base = this.dit * 5;
    if (this.gaps.length < 4) return base;
    const split = twoMeans(this.gaps, 1.6);
    let t;
    if (split) t = Math.max(split.lo * 1.5, (split.lo + split.hi) / 2);
    else {
      const mean = this.gaps.reduce((a, b) => a + b, 0) / this.gaps.length;
      t = mean * 1.6;
    }
    return Math.max(this.dit * 4.5, Math.min(t, this.dit * 20));
  }

  noteGap(ms) {
    if (ms < this.dit * 2) return; // intra-character
    this.gaps.push(ms);
    if (this.gaps.length > 16) this.gaps.shift();
  }

  classifyGap(ms) {
    if (ms < this.charGapThreshold()) return; // intra-character
    this.flushChar();
    if (this.wordPending && ms >= this.wordGapThreshold()) {
      this.wordPending = false;
      this.emit(' ');
    }
  }

  appendElement(ms) {
    this.marks.push(ms);
    if (this.marks.length > 24) this.marks.shift();
    this.updateDit();
    // Durations are kept raw and classified when the character closes, with
    // the dit estimate that already includes this character's own elements —
    // so the first letter after a speed change still decodes.
    this.charMarks.push(ms);
    if (this.charMarks.length > 8) this.flushChar();
  }

  flushChar() {
    if (!this.charMarks.length) return;
    let code = '';
    for (const ms of this.charMarks) code += ms >= this.dit * 2 ? '-' : '.';
    this.charMarks = [];
    const ch = MORSE_TABLE[code] || '*';
    this.decodedChars++;
    this.wordPending = true;
    this.emit(ch);
  }

  emit(text) {
    this.onText(text);
  }

  /**
   * Dit-length tracking: two-means clustering of recent mark durations.
   * When marks split into dots and dashes, the dit is the blend of the dot
   * cluster and a third of the dash cluster. With only one cluster visible
   * (EEEE / TTTT) it is assigned to whichever of dot or dash is nearer the
   * current estimate — that ambiguity is inherent to Morse.
   */
  updateDit() {
    const m = this.marks;
    if (m.length < 2) return;
    const split = twoMeans(m, 2);
    let est;
    if (split) est = (split.lo * split.loN + (split.hi / 3) * split.hiN) / (split.loN + split.hiN);
    else {
      const mean = m.reduce((a, b) => a + b, 0) / m.length;
      est = Math.abs(Math.log(mean / this.dit)) <= Math.abs(Math.log(mean / 3 / this.dit)) ? mean : mean / 3;
    }
    if (!Number.isFinite(est)) return;
    // Smooth a little so one odd element cannot yank the estimate around
    this.dit = this.clampDit(this.dit * 0.3 + est * 0.7);
  }
}

// ── CWPipeline: everything from PCM to text in one object ─────────────────

/** Auto filter width for a dit length: the window spans ≈ ½ dit. */
export function autoBandwidthForDit(ditMs) {
  const bw = 3000 / ditMs; // ENBW of a Hann window of ditMs/2
  return Math.max(50, Math.min(200, Math.round(bw / 10) * 10));
}

/**
 * PCM in, text out. Wraps ToneDetector + CWDecoder (+ an optional
 * ToneFinder) and, with `bandwidth: 'auto'`, re-sizes the Goertzel window to
 * about half a dit as the speed estimate moves — narrow (better weak-signal
 * copy) for slow senders, wide enough not to smear fast ones. This is the
 * object the AudioWorklet runs.
 */
export class CWPipeline {
  constructor({
    sampleRate = 48000,
    tone = CW_DEFAULT_TONE_HZ,
    bandwidth = 'auto',
    onText,
    initialWpm = 20,
    minSnrDb,
    findTone = false,
  } = {}) {
    this.sampleRate = sampleRate;
    this.autoBandwidth = bandwidth === 'auto';
    this.decoder = new CWDecoder({ onText, initialWpm, minSnrDb });
    const bw = this.autoBandwidth ? autoBandwidthForDit(this.decoder.dit) : bandwidth;
    this.detector = new ToneDetector({ sampleRate, tone, bandwidth: bw });
    this.finder = findTone ? new ToneFinder({ sampleRate }) : null;
    this.onPower = (p, dt) => this.decoder.processLevel(p, dt);
  }

  get tone() {
    return this.detector.tone;
  }

  get bandwidth() {
    return this.detector.bandwidth;
  }

  setTone(hz) {
    if (Number.isFinite(hz) && hz > 0 && hz < this.sampleRate / 2) this.detector.setTone(hz);
  }

  setBandwidth(bw) {
    this.autoBandwidth = bw === 'auto';
    this.detector.setBandwidth(this.autoBandwidth ? autoBandwidthForDit(this.decoder.dit) : bw);
  }

  setSquelch(minSnrDb) {
    if (Number.isFinite(minSnrDb)) this.decoder.minSnrDb = minSnrDb;
  }

  enableToneFinder(on) {
    if (on && !this.finder) this.finder = new ToneFinder({ sampleRate: this.sampleRate });
    if (!on) this.finder = null;
  }

  process(chunk) {
    this.detector.process(chunk, this.onPower);
    if (this.finder) this.finder.process(chunk);
    if (this.autoBandwidth) {
      const want = autoBandwidthForDit(this.decoder.dit);
      if (Math.abs(want - this.detector.bandwidth) / this.detector.bandwidth > 0.25) this.detector.setBandwidth(want);
    }
  }

  flush() {
    this.decoder.flush();
  }

  reset() {
    this.decoder.reset();
    if (this.autoBandwidth) this.detector.setBandwidth(autoBandwidthForDit(this.decoder.dit));
    if (this.finder) this.finder.reset();
  }

  getState() {
    return { ...this.decoder.getState(), tone: this.detector.tone, bandwidth: this.detector.bandwidth };
  }
}

// ── Callsign extraction ───────────────────────────────────────────────────

/**
 * Amateur callsign pattern for decoded text: optional prefix/, a 1–3
 * character prefix containing a letter, one digit, a 1–4 letter suffix and
 * an optional /suffix (5Z4/OZ6ABL, W1AW/7, VK2ABC/P, 9A1A).
 */
export const CALLSIGN_RE =
  /(?:^|[^A-Z0-9/])((?:[A-Z0-9]{1,3}\/)?(?:[A-Z][A-Z0-9]?|[0-9][A-Z])[0-9][A-Z]{1,4}(?:\/[A-Z0-9]{1,3})?)(?![A-Z0-9])/g;

// Q-codes / abbreviations that happen to match the callsign shape
const NOT_CALLS = new Set(['5NN', 'TU5NN']);

/**
 * Find amateur callsigns in decoded text. Returns unique calls in order of
 * first appearance with their character offsets.
 */
export function findCallsigns(text) {
  const out = [];
  const seen = new Set();
  for (const run of tokenizeCallsigns(text)) {
    if (run.call && !seen.has(run.call)) {
      seen.add(run.call);
      out.push({ call: run.call, index: run.index });
    }
  }
  return out;
}

/**
 * Split text into [{ text, call?, index? }] runs so a renderer can make
 * callsigns clickable. The runs concatenate back to the original text.
 */
export function tokenizeCallsigns(text) {
  const src = text || '';
  const upper = src.toUpperCase();
  const runs = [];
  const re = new RegExp(CALLSIGN_RE.source, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(upper))) {
    const call = m[1];
    const start = m.index + m[0].length - call.length;
    // The match may have consumed the delimiter only; step back so the next
    // search can reuse it as its own leading delimiter.
    re.lastIndex = start + call.length;
    if (call.length < 3 || call.length > 12 || NOT_CALLS.has(call)) continue;
    if (start > last) runs.push({ text: src.slice(last, start) });
    runs.push({ text: src.slice(start, start + call.length), call, index: start });
    last = start + call.length;
  }
  if (last < src.length) runs.push({ text: src.slice(last) });
  return runs;
}
