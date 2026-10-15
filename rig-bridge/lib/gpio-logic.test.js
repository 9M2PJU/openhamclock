import { describe, it, expect } from 'vitest';
import {
  HEADER_TO_BCM,
  DEFAULT_PINS,
  parsePin,
  resolvePinMap,
  pulse,
  sanitizeIndicators,
  mergeIndicators,
  computeOutputs,
  physicalLevel,
  OUTPUT_NAMES,
  SUGGESTED_LIGHTNING_PIN,
  InputDebouncer,
  parseGpiodVersion,
  parseGpiomonLine,
  parseGpiogetOutput,
} from './gpio-logic.js';

describe('pin map', () => {
  it('defaults follow HamClock header pins', () => {
    expect(HEADER_TO_BCM[40]).toBe(DEFAULT_PINS.onAirOut); // OA pin 40
    expect(HEADER_TO_BCM[38]).toBe(DEFAULT_PINS.satOut); // SA pin 38
    expect(HEADER_TO_BCM[31]).toBe(DEFAULT_PINS.alarmOut); // AL out pin 31
    expect(HEADER_TO_BCM[29]).toBe(DEFAULT_PINS.alarmSilenceIn); // AL reset pin 29
    expect(HEADER_TO_BCM[33]).toBe(DEFAULT_PINS.countdownGreenOut); // CD pins 33/35/37
    expect(HEADER_TO_BCM[35]).toBe(DEFAULT_PINS.countdownRedOut);
    expect(HEADER_TO_BCM[37]).toBe(DEFAULT_PINS.countdownResetIn);
  });
  it('parses BCM numbers and header references', () => {
    expect(parsePin(21)).toBe(21);
    expect(parsePin('21')).toBe(21);
    expect(parsePin('P40')).toBe(21);
    expect(parsePin('pin 37')).toBe(26);
    expect(parsePin('P1')).toBeNull(); // 3V3 — not a GPIO
    expect(parsePin(-1)).toBeNull();
    expect(parsePin('')).toBeNull();
    expect(parsePin(null)).toBeNull();
    expect(parsePin(99)).toBeNull();
  });
  it('merges user overrides and reports conflicts', () => {
    const map = resolvePinMap({ pttIn: 'P40', satOut: -1 });
    expect(map.inputs.pttIn).toBe(21);
    expect(map.conflicts).toEqual(['onAirOut']); // 21 already taken by pttIn
    expect(map.outputs.satOut).toBeUndefined();
    expect(map.outputs.alarmOut).toBe(6);
  });
});

describe('indicators + outputs', () => {
  it('sanitizes the browser payload', () => {
    expect(sanitizeIndicators({ satVisible: 'yes', satAosInSec: '45', countdown: 'bogus', alarm: 1 })).toEqual({
      satVisible: false,
      satAosInSec: 45,
      satLosInSec: null,
      alarm: false,
      countdown: 'off',
      lightning: null,
      lightningRelay: null,
    });
    expect(sanitizeIndicators(null).countdown).toBe('off');
  });

  it('ON-AIR follows rig PTT or the PTT input', () => {
    const base = { indicators: sanitizeIndicators({}), indicatorsStale: true };
    expect(computeOutputs({ ...base, ptt: false, pttIn: false }, 0).onAirOut).toBe(false);
    expect(computeOutputs({ ...base, ptt: true, pttIn: false }, 0).onAirOut).toBe(true);
    expect(computeOutputs({ ...base, ptt: false, pttIn: true }, 0).onAirOut).toBe(true);
  });

  it('countdown LEDs and alarm follow indicators (and go dark when stale)', () => {
    const run = computeOutputs({ indicators: sanitizeIndicators({ countdown: 'running', alarm: true }) }, 0);
    expect(run.countdownGreenOut).toBe(true);
    expect(run.countdownRedOut).toBe(false);
    expect(run.alarmOut).toBe(true);
    const exp = computeOutputs({ indicators: sanitizeIndicators({ countdown: 'expired' }) }, 0);
    expect(exp.countdownGreenOut).toBe(false);
    expect(exp.countdownRedOut).toBe(true);
    const stale = computeOutputs(
      {
        indicators: sanitizeIndicators({ countdown: 'running', alarm: true, satVisible: true }),
        indicatorsStale: true,
      },
      0,
    );
    expect(stale.countdownGreenOut).toBe(false);
    expect(stale.alarmOut).toBe(false);
    expect(stale.satOut).toBe(false);
  });

  it('alarm silence suppresses the alarm output', () => {
    const o = computeOutputs({ indicators: sanitizeIndicators({ alarm: true }), alarmSilenced: true }, 0);
    expect(o.alarmOut).toBe(false);
  });

  it('satellite: steady during pass, 1 Hz before AOS, 2 Hz last minute', () => {
    const during = (t) => computeOutputs({ indicators: sanitizeIndicators({ satVisible: true, satLosInSec: 300 }) }, t);
    expect(during(0).satOut).toBe(true);
    expect(during(250).satOut).toBe(true);
    expect(during(750).satOut).toBe(true);

    const pre = (t) => computeOutputs({ indicators: sanitizeIndicators({ satVisible: false, satAosInSec: 30 }) }, t);
    expect(pre(0).satOut).toBe(true); // 1 Hz: high 0–500 ms
    expect(pre(499).satOut).toBe(true);
    expect(pre(500).satOut).toBe(false);
    expect(pre(999).satOut).toBe(false);
    expect(pre(1000).satOut).toBe(true);

    const far = computeOutputs({ indicators: sanitizeIndicators({ satVisible: false, satAosInSec: 90 }) }, 0);
    expect(far.satOut).toBe(false);

    const last = (t) => computeOutputs({ indicators: sanitizeIndicators({ satVisible: true, satLosInSec: 45 }) }, t);
    expect(last(0).satOut).toBe(true); // 2 Hz: high 0–250 ms
    expect(last(249).satOut).toBe(true);
    expect(last(250).satOut).toBe(false);
    expect(last(500).satOut).toBe(true);
  });

  it('pulse() produces a 50 % duty cycle at the requested rate', () => {
    let highs = 0;
    for (let t = 0; t < 2000; t += 10) if (pulse(t, 2)) highs++;
    expect(highs).toBe(100);
  });
});

describe('InputDebouncer', () => {
  it('reports press/release only after the debounce window (active low)', () => {
    const d = new InputDebouncer({ activeLow: true, debounceMs: 50 });
    expect(d.sample(1, 0)).toBeNull(); // idle high = released
    expect(d.sample(0, 10)).toBeNull(); // candidate press
    expect(d.sample(0, 40)).toBeNull(); // not yet
    expect(d.sample(0, 60)).toBe('press');
    expect(d.active).toBe(true);
    expect(d.sample(0, 70)).toBeNull(); // held
    expect(d.sample(1, 80)).toBeNull();
    expect(d.sample(0, 90)).toBeNull(); // bounce — candidate reset
    expect(d.sample(1, 100)).toBeNull();
    expect(d.sample(1, 160)).toBe('release');
  });
  it('active-high and zero debounce', () => {
    const d = new InputDebouncer({ activeLow: false, debounceMs: 0 });
    expect(d.sample(1, 0)).toBe('press');
    expect(d.sample(0, 1)).toBe('release');
  });
});

describe('libgpiod CLI parsing', () => {
  it('detects versions', () => {
    expect(parseGpiodVersion('gpioset (libgpiod) v1.6.3')).toBe(1);
    expect(parseGpiodVersion('gpioset (libgpiod) v2.1.3\nCopyright')).toBe(2);
    expect(parseGpiodVersion('')).toBeNull();
  });
  it('parses gpiomon lines in v1 and v2 formats', () => {
    expect(parseGpiomonLine('event: FALLING EDGE offset: 26 timestamp: [1234.567890]')).toEqual({
      offset: 26,
      rising: false,
    });
    expect(parseGpiomonLine('event:  RISING EDGE offset: 5 timestamp: [1.0]')).toEqual({ offset: 5, rising: true });
    expect(parseGpiomonLine('0 26')).toEqual({ offset: 26, rising: false });
    expect(parseGpiomonLine('1 16')).toEqual({ offset: 16, rising: true });
    expect(parseGpiomonLine('1697000000.123456789\tfalling\tgpiochip0\t26')).toEqual({ offset: 26, rising: false });
    expect(parseGpiomonLine('1697000000.123 rising gpiochip0 5')).toEqual({ offset: 5, rising: true });
    expect(parseGpiomonLine('falling 16')).toEqual({ offset: 16, rising: false });
    expect(parseGpiomonLine('')).toBeNull();
    expect(parseGpiomonLine('gpiomon: error')).toBeNull();
  });
  it('parses gpioget output', () => {
    expect(parseGpiogetOutput('1 0 1\n')).toEqual([1, 0, 1]);
    expect(parseGpiogetOutput('active inactive')).toEqual([1, 0]);
    expect(parseGpiogetOutput('"16"=active "26"=inactive')).toEqual([1, 0]);
    expect(parseGpiogetOutput('')).toEqual([]);
  });
});

describe('lightningOut (lightning antenna-protection relay)', () => {
  it('is an output that stays unassigned unless configured', () => {
    expect(OUTPUT_NAMES).toContain('lightningOut');
    expect(DEFAULT_PINS.lightningOut).toBeNull();
    expect(resolvePinMap({}).outputs.lightningOut).toBeUndefined();
    expect(resolvePinMap({ lightningOut: -1 }).outputs.lightningOut).toBeUndefined();
    expect(resolvePinMap({ lightningOut: SUGGESTED_LIGHTNING_PIN }).outputs.lightningOut).toBe(25);
    expect(resolvePinMap({ lightningOut: 'P22' }).outputs.lightningOut).toBe(25);
    // A pin already taken by another line is refused, not shared
    expect(resolvePinMap({ lightningOut: 21 }).conflicts).toEqual(['lightningOut']);
  });

  it('sanitizes the tri-state lightning fields', () => {
    expect(sanitizeIndicators({ lightning: 'alarm', lightningRelay: true })).toMatchObject({
      lightning: 'alarm',
      lightningRelay: true,
    });
    expect(sanitizeIndicators({ lightning: 'storm', lightningRelay: 'yes' })).toMatchObject({
      lightning: null,
      lightningRelay: null,
    });
    expect(sanitizeIndicators({ lightningRelay: false }).lightningRelay).toBe(false);
  });

  it('a report without lightning fields keeps the relay another display requested', () => {
    let { indicators, lightningReported } = mergeIndicators(null, { lightning: 'alarm', lightningRelay: true });
    expect(lightningReported).toBe(true);
    ({ indicators, lightningReported } = mergeIndicators(indicators, { countdown: 'running' }));
    expect(lightningReported).toBe(false);
    expect(indicators.countdown).toBe('running');
    expect(indicators.lightningRelay).toBe(true);
    expect(indicators.lightning).toBe('alarm');
    ({ indicators, lightningReported } = mergeIndicators(indicators, { lightning: 'clear', lightningRelay: false }));
    expect(lightningReported).toBe(true);
    expect(indicators.lightningRelay).toBe(false);
  });

  it('follows the request and holds it when reports stop (unless told not to)', () => {
    const on = sanitizeIndicators({ lightning: 'alarm', lightningRelay: true });
    expect(computeOutputs({ indicators: on }, 0).lightningOut).toBe(true);
    expect(computeOutputs({ indicators: sanitizeIndicators({ lightningRelay: false }) }, 0).lightningOut).toBe(false);
    expect(computeOutputs({ indicators: sanitizeIndicators({}) }, 0).lightningOut).toBe(false);
    // Browser gone quiet: hold by default …
    expect(computeOutputs({ indicators: on, indicatorsStale: true }, 0).lightningOut).toBe(true);
    expect(computeOutputs({ indicators: on, lightningStale: true }, 0).lightningOut).toBe(true);
    // … release only when holding is switched off
    expect(
      computeOutputs({ indicators: on, lightningStale: true, lightningHoldWhenStale: false }, 0).lightningOut,
    ).toBe(false);
    // Other outputs still go dark when stale; the relay does not depend on them
    const stale = computeOutputs({ indicators: { ...on, alarm: true }, indicatorsStale: true }, 0);
    expect(stale.alarmOut).toBe(false);
    expect(stale.lightningOut).toBe(true);
  });

  it('physical level: active-low inverts every line, fail-safe inverts only the relay', () => {
    expect(physicalLevel('lightningOut', true)).toBe(1);
    expect(physicalLevel('lightningOut', false)).toBe(0);
    expect(physicalLevel('lightningOut', true, { lightningFailSafe: true })).toBe(0); // protect = released
    expect(physicalLevel('lightningOut', false, { lightningFailSafe: true })).toBe(1); // safe = energised
    expect(physicalLevel('satOut', true, { lightningFailSafe: true })).toBe(1);
    expect(physicalLevel('satOut', true, { outputActiveLow: true })).toBe(0);
    expect(physicalLevel('lightningOut', true, { outputActiveLow: true, lightningFailSafe: true })).toBe(1);
  });
});
