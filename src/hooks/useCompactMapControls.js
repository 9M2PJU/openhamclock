import { useEffect, useState } from 'react';

/** Below this viewport width the map's own controls switch to their compact form. */
export const COMPACT_MAP_CONTROLS_MAX_WIDTH = 600;

/**
 * Below this map width the controls go compact on any screen — a small map
 * panel in the Dockable layout, a tiny kiosk display. Kept well under the
 * smallest desktop map sizes in normal use (Modern at 1280×720 is ~600 px,
 * Dockable/Classic at 1024×768 ~535–585 px) so those keep the full controls.
 */
export const COMPACT_MAP_MIN_MAP_WIDTH = 480;

/**
 * Pure decision: an explicit `true`/`false` prop wins; otherwise compact
 * controls turn on for a phone-sized viewport or a small map. A map width of
 * 0 means "not measured yet" and never triggers compact.
 */
export function shouldUseCompactMapControls(prop, viewportWidth, mapWidth = 0) {
  if (prop === true || prop === false) return prop;
  if (viewportWidth > 0 && viewportWidth < COMPACT_MAP_CONTROLS_MAX_WIDTH) return true;
  return mapWidth > 0 && mapWidth < COMPACT_MAP_MIN_MAP_WIDTH;
}

/**
 * WorldMap's compact-controls switch. `prop` is the WorldMap
 * `compactControls` prop (true forces on, false forces off, undefined = auto);
 * `containerRef` is the map's root element, watched with a ResizeObserver so
 * a map panel resized inside a dock layout switches live.
 */
export default function useCompactMapControls(prop, containerRef) {
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1200));
  const [mapWidth, setMapWidth] = useState(0);
  const forced = prop === true || prop === false;

  useEffect(() => {
    if (forced) return undefined;
    const onResize = () => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [forced]);

  useEffect(() => {
    if (forced) return undefined;
    const el = containerRef?.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    // Only the side of the threshold matters, so whole pixels are plenty
    const update = (w) => setMapWidth((prev) => (Math.round(w) === prev ? prev : Math.round(w)));
    update(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) update(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [forced, containerRef]);

  return shouldUseCompactMapControls(prop, viewportWidth, mapWidth);
}
