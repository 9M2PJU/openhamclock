import { describe, it, expect } from 'vitest';
import {
  shouldUseCompactMapControls,
  COMPACT_MAP_CONTROLS_MAX_WIDTH,
  COMPACT_MAP_MIN_MAP_WIDTH,
} from './useCompactMapControls.js';

describe('shouldUseCompactMapControls', () => {
  it('turns on automatically below the phone breakpoint', () => {
    expect(shouldUseCompactMapControls(undefined, 390)).toBe(true);
    expect(shouldUseCompactMapControls(undefined, 360)).toBe(true);
    expect(shouldUseCompactMapControls(undefined, COMPACT_MAP_CONTROLS_MAX_WIDTH)).toBe(false);
    expect(shouldUseCompactMapControls(undefined, 768)).toBe(false);
    expect(shouldUseCompactMapControls(undefined, 1440)).toBe(false);
    expect(shouldUseCompactMapControls(undefined, 0)).toBe(false);
  });

  it('turns on for a small map on a big screen (a Dockable map panel)', () => {
    expect(shouldUseCompactMapControls(undefined, 1440, 420)).toBe(true);
    expect(shouldUseCompactMapControls(undefined, 1440, COMPACT_MAP_MIN_MAP_WIDTH)).toBe(false);
  });

  it('leaves normal desktop map sizes alone', () => {
    // measured: Modern 1440x900 → 820, Dockable 769, Classic 1000;
    // Dockable 1024x768 → 535, Classic 584, Modern 1280x720 → 601
    for (const w of [820, 769, 1000, 535, 584, 601])
      expect(shouldUseCompactMapControls(undefined, 1440, w)).toBe(false);
  });

  it('an unmeasured map never triggers compact', () => {
    expect(shouldUseCompactMapControls(undefined, 1440, 0)).toBe(false);
  });

  it('an explicit prop wins over everything', () => {
    expect(shouldUseCompactMapControls(true, 1440, 900)).toBe(true);
    expect(shouldUseCompactMapControls(false, 390, 300)).toBe(false);
  });
});
