import { describe, it, expect } from 'vitest';
import { shouldUseCompactMapControls, COMPACT_MAP_CONTROLS_MAX_WIDTH } from './useCompactMapControls.js';

describe('shouldUseCompactMapControls', () => {
  it('turns on automatically below the phone breakpoint only', () => {
    expect(shouldUseCompactMapControls(undefined, 390)).toBe(true);
    expect(shouldUseCompactMapControls(undefined, 360)).toBe(true);
    expect(shouldUseCompactMapControls(undefined, COMPACT_MAP_CONTROLS_MAX_WIDTH)).toBe(false);
    expect(shouldUseCompactMapControls(undefined, 768)).toBe(false);
    expect(shouldUseCompactMapControls(undefined, 1440)).toBe(false);
    expect(shouldUseCompactMapControls(undefined, 0)).toBe(false);
  });

  it('an explicit prop wins over the viewport', () => {
    expect(shouldUseCompactMapControls(true, 1440)).toBe(true);
    expect(shouldUseCompactMapControls(false, 390)).toBe(false);
  });
});
