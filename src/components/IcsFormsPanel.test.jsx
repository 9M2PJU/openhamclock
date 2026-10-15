/**
 * Smoke tests for IcsFormsPanel — every form tab renders, the 309 preview is
 * built from the event log, 214 imports log rows, 205 adds simplex rows, and
 * the 213 APRS send goes through the shared send path and logs an event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import '../lang/i18n.js';
import IcsFormsPanel from './IcsFormsPanel.jsx';
import { recordEvent, getEvents, _resetForTests } from '../utils/emcommEventLog.js';
import { ICS_DRAFTS_KEY } from '../utils/icsForms.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function render(ui) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root;
  act(() => {
    root = createRoot(container);
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const click = (el) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const tab = (container, id) => [...container.querySelectorAll('[role="tab"]')].find((b) => b.textContent === id);
const buttonByText = (container, text) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.includes(text));

function setInput(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

let fetchMock;
beforeEach(() => {
  localStorage.clear();
  _resetForTests();
  fetchMock = vi.fn(async (url) => {
    if (String(url).includes('tnc-status')) return { ok: true, status: 200, json: async () => ({ connected: true }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('IcsFormsPanel', () => {
  it('renders the 309 preview from the event log and fills the operator call from config', () => {
    recordEvent('net_checkin', { callsign: 'KE8PLM', summary: 'Checked into ARES' });
    const { container, unmount } = render(<IcsFormsPanel config={{ callsign: 'k0cjh' }} initialForm="309" />);
    const paper = container.querySelector('.ics-paper');
    expect(paper.innerHTML).toContain('COMMUNICATIONS LOG');
    expect(paper.innerHTML).toContain('KE8PLM');
    expect(paper.innerHTML).toContain('K0CJH');
    expect(container.textContent).toContain('Log entries in the operational period: 1');
    unmount();
  });

  it('switches between all four forms', () => {
    const { container, unmount } = render(<IcsFormsPanel config={{ callsign: 'K0CJH' }} initialForm="309" />);
    click(tab(container, '214'));
    expect(container.querySelector('.ics-paper').innerHTML).toContain('ACTIVITY LOG');
    click(tab(container, '213'));
    expect(container.querySelector('.ics-paper').innerHTML).toContain('GENERAL MESSAGE');
    click(tab(container, '205'));
    expect(container.querySelector('.ics-paper').innerHTML).toContain('INCIDENT RADIO COMMUNICATIONS PLAN');
    unmount();
  });

  it('214 imports event-log rows and 205 adds a simplex channel; drafts persist on unmount', () => {
    recordEvent('net_checkin', { callsign: 'KE8PLM', summary: 'Checked into ARES' });
    const { container, unmount } = render(<IcsFormsPanel config={{ callsign: 'K0CJH' }} initialForm="214" />);
    click(buttonByText(container, 'Import from event log'));
    const area = container.querySelector('textarea');
    expect(area.value).toContain('KE8PLM: Checked into ARES');
    click(tab(container, '205'));
    click(buttonByText(container, 'Simplex channel'));
    expect(container.querySelector('.ics-paper').innerHTML).toContain('Simplex');
    unmount();
    const saved = JSON.parse(localStorage.getItem(ICS_DRAFTS_KEY));
    expect(saved.ics214.rows.length).toBe(1);
    expect(saved.ics205.rows.length).toBe(1);
  });

  it('213 sends the message as APRS parts and records it in the event log', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container, unmount } = render(<IcsFormsPanel config={{ callsign: 'K0CJH' }} initialForm="213" />);
    const inputs = [...container.querySelectorAll('input')];
    const toCall = inputs.find((i) => i.maxLength === 9);
    setInput(toCall, 'n0eoc');
    const message = [...container.querySelectorAll('textarea')][0];
    setInput(message, 'Shelter 3 needs 200 gallons of potable water and 50 cots before 2200 local tonight please.');
    expect(container.textContent).toContain('2 APRS message(s)');
    await act(async () => {
      buttonByText(container, 'Send as APRS message').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const sends = fetchMock.mock.calls.filter(([url]) => url === '/api/aprs/message');
    expect(sends.length).toBe(2);
    expect(JSON.parse(sends[0][1].body)).toMatchObject({ to: 'N0EOC' });
    expect(JSON.parse(sends[0][1].body).message.startsWith('1/2 ')).toBe(true);
    const ev = getEvents().find((e) => e.type === 'ics213_sent');
    expect(ev.summary).toContain('N0EOC');
    unmount();
  });
});
