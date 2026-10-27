/**
 * Smoke test: every focus layout must mount and unmount without throwing.
 *
 * Exists because a missing `useRef` import shipped a white-screen crash
 * that neither the build (esbuild does no scope analysis — bare
 * identifiers become runtime globals) nor the suite (nothing rendered
 * FocusLayout) could catch. Children are stubbed; this guards the layout
 * chassis itself: imports, the preset effect, prop destructuring.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Stub every UI child — this test is about the chassis, not the panels.
// (vi.mock is hoisted, so everything must live inside the factory.)
vi.mock('../components', () => {
  const Stub = () => null;
  return {
    Header: Stub,
    WorldMap: Stub,
    DXClusterPanel: Stub,
    PotaSotaPanel: Stub,
    WeatherPanel: Stub,
    SWPCAlertsPanel: Stub,
    POTAActivatorPanel: Stub,
    RBNMySignalPanel: Stub,
    RepeatersPanel: Stub,
    WorldClockPanel: Stub,
    SunMoonPanel: Stub,
    SpaceWxTrendsPanel: Stub,
    StopwatchPanel: Stub,
    AircraftNearbyPanel: Stub,
  };
});
vi.mock('../contexts/RigContext.jsx', () => ({ useRig: () => ({ tuneTo: () => {} }) }));
vi.mock('../hooks/app/useBreakpoint', () => ({ default: () => ({ breakpoint: 'desktop' }) }));
vi.mock('../utils/dxClusterSpotMatcher', () => ({ findDXPathForSpot: () => null }));

import FocusLayout, { FOCUS_LAYOUT_IDS } from './FocusLayout.jsx';

const emptyHook = {};
const baseProps = {
  config: { location: { lat: 39, lon: -94.5 }, callsign: 'K0CJH', allUnits: {} },
  t: (k, opts) => opts?.defaultValue || k,
  mapLayers: {},
  dxClusterData: emptyHook,
  potaSpots: emptyHook,
  wwffSpots: emptyHook,
  sotaSpots: emptyHook,
  wwbotaSpots: emptyHook,
  mySpots: emptyHook,
  dxLocation: { lat: 35, lon: 139 },
};

afterEach(() => {
  localStorage.clear();
});

describe('FocusLayout smoke', () => {
  for (const focus of FOCUS_LAYOUT_IDS) {
    it(`mounts and unmounts the ${focus} layout without throwing`, () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      expect(() => {
        act(() => {
          root.render(<FocusLayout {...baseProps} focus={focus} />);
        });
        act(() => {
          root.unmount();
        });
      }).not.toThrow();
      container.remove();
    });
  }
});
