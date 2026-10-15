import { useEffect, useState } from 'react';

/** Below this viewport width the map's own controls switch to their compact form. */
export const COMPACT_MAP_CONTROLS_MAX_WIDTH = 600;

/**
 * Pure decision: an explicit `true`/`false` prop wins; otherwise compact
 * controls turn on automatically on narrow (phone-sized) viewports.
 */
export function shouldUseCompactMapControls(prop, viewportWidth) {
  if (prop === true || prop === false) return prop;
  return viewportWidth > 0 && viewportWidth < COMPACT_MAP_CONTROLS_MAX_WIDTH;
}

/**
 * WorldMap's compact-controls switch. `prop` is the WorldMap
 * `compactControls` prop (true forces on, false forces off, undefined = auto).
 * Wide viewports with no prop never change, so desktop rendering is untouched.
 */
export default function useCompactMapControls(prop) {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1200));
  useEffect(() => {
    if (prop === true || prop === false) return undefined;
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [prop]);
  return shouldUseCompactMapControls(prop, width);
}
