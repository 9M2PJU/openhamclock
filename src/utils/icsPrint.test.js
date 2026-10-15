/**
 * Tests for icsPrint — in-page printing mounts only for the duration of the
 * print and injects the page setup (landscape for the ICS 205).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { printIcsHtml, printPageCss } from './icsPrint.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('printPageCss', () => {
  it('sets margins, and landscape only when asked', () => {
    expect(printPageCss()).toBe('@page { margin: 10mm; }');
    expect(printPageCss({ landscape: true })).toBe('@page { margin: 10mm; size: landscape; }');
  });
});

describe('printIcsHtml', () => {
  it('mounts the form and page style during print and removes them on afterprint', () => {
    let during = null;
    vi.spyOn(window, 'print').mockImplementation(() => {
      during = {
        root: document.querySelector('.ics-print-root')?.innerHTML,
        printing: document.body.classList.contains('ics-printing'),
        style: document.querySelector('style[data-ics-print]')?.textContent,
        title: document.title,
      };
    });
    document.title = 'OpenHamClock';
    printIcsHtml('<section class="ics-form">X</section>', { title: 'ICS-205-test', landscape: true });
    expect(during).toEqual({
      root: '<section class="ics-form">X</section>',
      printing: true,
      style: '@media print { @page { margin: 10mm; size: landscape; } }',
      title: 'ICS-205-test',
    });
    window.dispatchEvent(new Event('afterprint'));
    expect(document.querySelector('.ics-print-root')).toBeNull();
    expect(document.querySelector('style[data-ics-print]')).toBeNull();
    expect(document.body.classList.contains('ics-printing')).toBe(false);
    expect(document.title).toBe('OpenHamClock');
  });

  it('cleans up by timer when the engine never fires afterprint', () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'print').mockImplementation(() => {});
    printIcsHtml('<p>Y</p>');
    expect(document.querySelector('.ics-print-root')).not.toBeNull();
    vi.advanceTimersByTime(60 * 1000);
    expect(document.querySelector('.ics-print-root')).toBeNull();
  });
});
