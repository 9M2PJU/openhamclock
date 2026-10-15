/**
 * NetControlPanel smoke test — start a net, check stations in from the
 * keyboard, survive a remount (reload), close the net and get the report,
 * with the voice roster mirrored for the EmComm Net Roster.
 * Uses react-dom/client + act (no @testing-library needed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) =>
      String((opts && opts.defaultValue) || key).replace(/\{\{(\w+)\}\}/g, (_, k) => (opts?.[k] ?? '').toString()),
  }),
}));

import NetControlPanel from './NetControlPanel.jsx';
import { getNetControlRoster, NET_CONTROL_KEY } from '../utils/netControl.js';
import { getEvents, _resetForTests } from '../utils/emcommEventLog.js';

let container;
let root;

const render = () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<NetControlPanel callsign="K0CJH" />));
};
const unmount = () => {
  act(() => root.unmount());
  container.remove();
};

const setValue = (el, value) => {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const byLabel = (label) => container.querySelector(`[aria-label="${label}"]`);
const buttonWithText = (text) => [...container.querySelectorAll('button')].find((b) => b.textContent.includes(text));
const pressEnter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

beforeEach(() => {
  localStorage.clear();
  _resetForTests();
  globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null } }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('NetControlPanel', () => {
  it('runs a net from start to report', async () => {
    render();
    act(() => setValue(byLabel('Net name (e.g. County ARES Weekly Net)'), 'Tuesday ARES Net'));
    act(() => buttonWithText('Start net').click());
    expect(container.textContent).toContain('Tuesday ARES Net');
    expect(container.textContent).toContain('NCS K0CJH');

    const box = byLabel('Check in a station');
    act(() => setValue(box, 'w1aw t'));
    await act(async () => pressEnter(box));
    act(() => setValue(box, 'ke8plm/m'));
    await act(async () => pressEnter(box));
    expect(container.textContent).toContain('W1AW');
    expect(container.textContent).toContain('KE8PLM');
    expect(container.textContent).toContain('TRAFFIC (1)');

    // A reload keeps the running net
    expect(JSON.parse(localStorage.getItem(NET_CONTROL_KEY)).stations).toHaveLength(2);
    unmount();
    render();
    expect(container.textContent).toContain('KE8PLM');
    expect(getNetControlRoster()).toMatchObject({ active: true, net: 'Tuesday ARES Net' });

    // Next → Passed logs the traffic
    act(() => buttonWithText('Next').click());
    expect(container.textContent).toContain('Whiskey One Alfa Whiskey');
    act(() => buttonWithText('Passed').click());

    act(() => buttonWithText('Close net').click());
    expect(container.textContent).toContain('Unique stations');
    expect(container.textContent).toContain('Copy text');
    expect(localStorage.getItem(NET_CONTROL_KEY)).toBeNull();
    expect(getNetControlRoster()).toMatchObject({ active: false });
    expect(getNetControlRoster().roster.map((r) => r.call)).toEqual(['W1AW', 'KE8PLM']);

    const types = getEvents().map((e) => e.type);
    expect(types).toEqual(['net_open', 'net_checkin', 'net_checkin', 'net_traffic', 'net_close']);
    unmount();
  });

  it('rejects input that is not a callsign', async () => {
    render();
    act(() => setValue(byLabel('Net name (e.g. County ARES Weekly Net)'), 'Test Net'));
    act(() => buttonWithText('Start net').click());
    const box = byLabel('Check in a station');
    act(() => setValue(box, 'hello'));
    await act(async () => pressEnter(box));
    expect(container.textContent).toContain('Not a callsign');
    unmount();
  });
});
