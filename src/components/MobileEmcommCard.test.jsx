/**
 * The Mobile layout's EmComm card: polls only while mounted, and summarises
 * alerts (worst first), the nearest shelters and the net roster.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const emcommCalls = [];
vi.mock('../hooks/useEmcommData.js', () => ({
  useEmcommData: (opts) => {
    emcommCalls.push(opts);
    return {
      alerts: [
        { id: 'a1', severity: 'Minor', event: 'Frost Advisory', headline: 'Frost tonight' },
        {
          id: 'a2',
          severity: 'Severe',
          event: 'Severe Thunderstorm Warning',
          headline: 'Storms',
          instruction: 'Go inside',
        },
      ],
      shelters: [
        { id: 's-far', name: 'Far School', lat: 45.5, lon: -93, status: 'OPEN' },
        { id: 's-near', name: 'Town Hall', lat: 44.38, lon: -93.04, status: 'FULL' },
      ],
      disasters: [],
      loading: false,
    };
  },
}));

import MobileEmcommCard from './MobileEmcommCard.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  emcommCalls.length = 0;
});

describe('MobileEmcommCard', () => {
  it('summarises alerts, shelters and the roster, and stops polling when unmounted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        roster: [
          { call: 'W0OLD', netName: 'ARES', age: 95, stale: true },
          { call: 'K0NEW', netName: 'ARES', age: 1 },
        ],
      }),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<MobileEmcommCard location={{ lat: 44.37, lon: -93.04 }} allUnits={{ dist: 'metric' }} />);
    });

    expect(emcommCalls.at(-1)).toMatchObject({
      enabled: true,
      includeDisasters: false,
      location: { lat: 44.37, lon: -93.04 },
    });
    expect(fetchSpy).toHaveBeenCalledWith('/api/aprs/net');

    const text = container.textContent;
    // worst alert first
    expect(text.indexOf('Severe Thunderstorm Warning')).toBeLessThan(text.indexOf('Frost Advisory'));
    // nearest shelter first, with distance
    expect(text.indexOf('Town Hall')).toBeLessThan(text.indexOf('Far School'));
    expect(text).toContain('1 km');
    // roster, most recent first
    expect(text.indexOf('K0NEW')).toBeLessThan(text.indexOf('W0OLD'));

    act(() => root.unmount());
    container.remove();
    const callsAfterUnmount = fetchSpy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy.mock.calls.length).toBe(callsAfterUnmount);
  });
});
