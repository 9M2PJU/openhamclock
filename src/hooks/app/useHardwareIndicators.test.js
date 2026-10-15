import { describe, it, expect } from 'vitest';
import { deriveSatIndicators } from './useHardwareIndicators.js';

const now = 1_000_000_000_000;

describe('deriveSatIndicators', () => {
  it('reports no satellite when nothing is tracked', () => {
    expect(deriveSatIndicators([], now)).toEqual({ satVisible: false, satAosInSec: null, satLosInSec: null });
    expect(deriveSatIndicators(null, now).satVisible).toBe(false);
  });

  it('seconds to the earliest upcoming AOS across satellites', () => {
    const sats = [
      { name: 'A', isVisible: false, nextPassStartTimes: [now - 1000, now + 90_000, now + 400_000] },
      { name: 'B', isVisible: false, nextPassStartTimes: [now + 45_000] },
    ];
    expect(deriveSatIndicators(sats, now)).toEqual({ satVisible: false, satAosInSec: 45, satLosInSec: null });
  });

  it('visible satellite: LOS from the first end time still ahead', () => {
    const sats = [
      { name: 'A', isVisible: true, nextPassStartTimes: [now - 300_000], nextPassEndTimes: [now - 10, now + 30_000] },
      { name: 'B', isVisible: false, nextPassStartTimes: [now + 20_000] },
    ];
    expect(deriveSatIndicators(sats, now)).toEqual({ satVisible: true, satAosInSec: 20, satLosInSec: 30 });
  });

  it('ignores unparsable times', () => {
    const sats = [{ name: 'A', isVisible: false, nextPassStartTimes: ['garbage', null] }];
    expect(deriveSatIndicators(sats, now).satAosInSec).toBeNull();
  });
});
