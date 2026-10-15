/**
 * End-to-end: two operators share one EmComm incident, in a real browser.
 *
 *   npm run build && node server.js            # production build, any port
 *   OHC_URL=http://127.0.0.1:3000 node scripts/e2e/incident-two-operators.mjs [screenshot-dir]
 *
 * Two Chromium contexts (separate storage = two stations) walk the whole
 * flow: create, invite link, join, check-in propagation, OUT, board edit
 * (admin) and its absence for an operator, an admin deletion, the offline
 * buffer flushing on reconnect, reload without duplicates, join-key
 * rotation, and leave. Screenshots of the EmComm rail at desktop width and
 * at 390×844 go to the screenshot directory (default: ./e2e-shots).
 *
 * Exits non-zero on the first failed check. Uses the server's incident
 * store, so point it at a throwaway instance (set INCIDENT_FILE).
 */
/* global document, window, location -- used inside page.evaluate / waitForFunction callbacks, which run in the browser */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.OHC_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const SHOTS = process.argv[2] || 'e2e-shots';
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const T = 20_000;

mkdirSync(SHOTS, { recursive: true });

let step = 0;
const log = (msg) => console.log(`${String(++step).padStart(2, '0')}  ${msg}`);
function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`    ✓ ${msg}`);
}

/** A fresh station: its own storage, callsign and layout. */
async function station(browser, { call, layout = 'emcomm', viewport = { width: 1440, height: 900 } }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(
    ({ call, layout, version }) => {
      if (sessionStorage.getItem('e2e-seeded')) return;
      sessionStorage.setItem('e2e-seeded', '1');
      localStorage.setItem(
        'openhamclock_config',
        JSON.stringify({
          callsign: call,
          locator: 'EN34IX',
          location: { lat: 44.9, lon: -93.2 },
          layout,
          theme: 'dark',
        }),
      );
      localStorage.setItem('openhamclock_lastSeenVersion', version);
      localStorage.setItem('ohc_startrekday_2026_dismissed', '1');
      localStorage.setItem('openhamclock_mobileLayoutSuggested', '1');
    },
    { call, layout, version: VERSION },
  );
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.log(`    [${call} page error] ${e.message}`));
  return { context, page, call };
}

const status = (page) => page.getByTestId('incident-status');
const waitLive = (page) => status(page).filter({ hasText: 'LIVE' }).waitFor({ timeout: T });
const rosterRow = (page, call) => page.locator(`[data-testid="roster-row"][data-call="${call}"]`);
const eventRows = (page, text) => page.getByTestId('event-row').filter({ hasText: text });
const participants = (page) => page.getByTestId('incident-participants');

async function railShot(page, file) {
  // The rail is the scrolling sidebar holding the Incident panel.
  const rail = page.getByTestId('incident-panel').or(page.getByTestId('incident-panel-local')).first();
  await rail.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, file), type: 'jpeg', quality: 80 });
}

async function main() {
  const browser = await chromium.launch();
  const a = await station(browser, { call: 'K0CJH' });
  // B starts in another layout: the invite link must switch it to EmComm.
  const b = await station(browser, { call: 'W1AW', layout: 'modern' });
  try {
    log('A opens EmComm and creates an incident');
    await a.page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const local = a.page.getByTestId('incident-panel-local');
    await local.waitFor({ timeout: T });
    await local.getByRole('button', { name: 'Create', exact: true }).click();
    await a.page.locator('input[name="incident-name"]').fill('E2E River Flood');
    await a.page.locator('input[name="incident-ic"]').fill('K0CJH');
    await a.page.locator('input[name="incident-netfreq"]').fill('146.520');
    await a.page.locator('input[name="incident-site"]').fill('EOC North');
    await local.locator('button[type="submit"]').click();
    await waitLive(a.page);
    check((await a.page.getByTestId('incident-role').textContent()).includes('ADMIN'), 'creator is ADMIN');

    log('A opens Invite: id, join key and a QR code');
    await a.page.getByRole('button', { name: 'Invite', exact: true }).click();
    const id = (await a.page.getByTestId('incident-id').textContent()).replace(/-/g, '');
    const joinKey = (await a.page.getByTestId('incident-join-key').textContent()).replace(/-/g, '');
    check(/^[A-Z2-9]{8}$/.test(id) && /^[A-Z2-9]{16}$/.test(joinKey), `id ${id} and a 16-char join key shown`);
    check((await a.page.locator('[data-testid="incident-panel"] svg').count()) > 0, 'QR code rendered');

    log('B opens the invite link (in another layout) and joins');
    await b.page.goto(`${BASE}/#incident=${id}&key=${joinKey}`, { waitUntil: 'domcontentloaded' });
    const bLocal = b.page.getByTestId('incident-panel-local');
    await bLocal.waitFor({ timeout: T });
    check(!(await b.page.evaluate(() => location.hash)), 'key taken out of the address bar');
    check((await b.page.locator('input[name="incident-id"]').inputValue()) === id, 'join form pre-filled');
    await b.page.locator('input[name="incident-site"]').fill('EOC South');
    await bLocal.locator('button[type="submit"]').click();
    await waitLive(b.page);
    check((await b.page.getByTestId('incident-role').textContent()).includes('OPERATOR'), 'joiner is OPERATOR');
    await participants(a.page).filter({ hasText: '2 connected' }).waitFor({ timeout: T });
    check(true, 'A sees 2 connected');
    const streamUrls = [];
    b.page.on('request', (r) => /\/api\/incident\/[^/]+\/stream/.test(r.url()) && streamUrls.push(r.url()));

    log('B checks in a voice station; A sees it live');
    await b.page.locator('input[name="checkin-call"]').fill('KD0ABC');
    await b.page.locator('input[name="checkin-status"]').fill('At shelter [Beds 30/100]');
    await b.page.getByRole('button', { name: 'Check in', exact: true }).click();
    await rosterRow(a.page, 'KD0ABC').waitFor({ timeout: T });
    check((await rosterRow(a.page, 'KD0ABC').textContent()).includes('@EOC South'), 'roster row tagged with B’s site');
    await eventRows(a.page, 'KD0ABC').first().waitFor({ timeout: T });
    check(true, 'check-in event in A’s shared log');

    log('A checks the station OUT; it leaves B’s roster');
    await rosterRow(a.page, 'KD0ABC').getByRole('button', { name: 'OUT', exact: true }).click();
    await rosterRow(b.page, 'KD0ABC').waitFor({ state: 'detached', timeout: T });
    check(true, 'gone from B’s roster');

    log('A (admin) edits the board; B (operator) has no Edit');
    check(
      (await b.page.getByTestId('incident-panel').getByRole('button', { name: 'Edit', exact: true }).count()) === 0,
      'no Edit button for the operator',
    );
    await a.page.getByTestId('incident-panel').getByRole('button', { name: 'Edit', exact: true }).click();
    await a.page.locator('textarea[name="board-notes"]').fill('Shelter open at the high school');
    await a.page.getByRole('button', { name: 'Save', exact: true }).click();
    await b.page
      .getByTestId('incident-board')
      .filter({ hasText: 'Shelter open at the high school' })
      .waitFor({ timeout: T });
    check(true, 'board change reached B');
    await railShot(a.page, 'incident-rail-desktop.jpg');
    // Close-up of the Incident panel (header included) for the manual.
    await a.page
      .getByTestId('incident-panel')
      .locator('xpath=../..')
      .screenshot({ path: join(SHOTS, 'emcomm-incident.jpg'), type: 'jpeg', quality: 85 });

    log('A starts a voice net in Net Control; B sees the same running net');
    await a.page.getByLabel('Net name (e.g. County ARES Weekly Net)').fill('E2E ARES Net');
    await a.page.getByRole('button', { name: /Start net/ }).click();
    await a.page.getByLabel('Check in a station').fill('W9NET');
    await a.page.getByLabel('Check in a station').press('Enter');
    await b.page.getByText('E2E ARES Net').first().waitFor({ timeout: T });
    await b.page.getByText('W9NET').first().waitFor({ timeout: T });
    check(true, 'B’s Net Control shows A’s running net and its check-in');
    check(
      (await a.page.getByText(/Also open in another tab or panel/).count()) === 0,
      'the incident bridge is not counted as another Net Control panel',
    );

    log('B goes offline, checks in; the update waits and flushes on reconnect');
    await b.context.setOffline(true);
    await b.page.locator('input[name="checkin-call"]').fill('N0OFF');
    await b.page.getByRole('button', { name: 'Check in', exact: true }).click();
    await b.page.getByTestId('incident-pending').waitFor({ timeout: T });
    check(true, `B shows "${(await b.page.getByTestId('incident-pending').textContent()).trim()}"`);
    await a.page.waitForTimeout(3000);
    check((await rosterRow(a.page, 'N0OFF').count()) === 0, 'A does not have it while B is offline');
    await b.context.setOffline(false);
    await rosterRow(a.page, 'N0OFF').waitFor({ timeout: 40_000 });
    await b.page.getByTestId('incident-pending').waitFor({ state: 'detached', timeout: T });
    check(true, 'flushed on reconnect; B’s buffer empty');

    log('A (admin) deletes B’s N0OFF check-in event for everyone');
    const before = await eventRows(b.page, 'N0OFF').count();
    check(before >= 1, `B sees the N0OFF event (${before})`);
    await eventRows(a.page, 'N0OFF')
      .first()
      .getByRole('button', { name: /Delete this entry/ })
      .click();
    await b.page.waitForFunction(
      (n) =>
        [...document.querySelectorAll('[data-testid="event-row"]')].filter((r) => r.textContent.includes('N0OFF'))
          .length < n,
      before,
      { timeout: T },
    );
    check(true, 'deleted on B too');

    log('B reloads: no duplicates');
    const countKd = await eventRows(b.page, 'KD0ABC').count();
    const countAll = await b.page.getByTestId('event-row').count();
    await b.page.reload({ waitUntil: 'domcontentloaded' });
    await waitLive(b.page);
    await b.page.waitForTimeout(3000);
    check((await eventRows(b.page, 'KD0ABC').count()) === countKd, `KD0ABC events unchanged (${countKd})`);
    check((await b.page.getByTestId('event-row').count()) === countAll, `log length unchanged (${countAll})`);
    console.log(`    (incident stream requests: ${streamUrls.map((u) => u.replace(BASE, '')).join(', ')})`);
    check(
      streamUrls.length > 0 && streamUrls.every((u) => !u.includes(joinKey) && u.includes('ticket=')),
      'incident stream URLs carry a ticket, never the key',
    );

    log('Phone-width screenshot (390×844)');
    const phone = await station(browser, { call: 'KD0PHN', viewport: { width: 390, height: 844 } });
    await phone.page.goto(`${BASE}/#incident=${id}&key=${joinKey}`, { waitUntil: 'domcontentloaded' });
    await phone.page.getByTestId('incident-panel-local').locator('button[type="submit"]').click();
    await waitLive(phone.page);
    await railShot(phone.page, 'incident-rail-390.jpg');
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    console.log(`    (phone: horizontal overflow ${overflow}px)`);
    await phone.page.getByRole('button', { name: 'Leave', exact: true }).click();
    await phone.page.getByTestId('incident-panel-local').waitFor({ timeout: T });
    await phone.context.close();

    log('A rotates the join key: B is disconnected and asked to rejoin');
    await a.page.getByRole('button', { name: 'New key', exact: true }).click();
    await b.page.getByTestId('incident-panel-local').waitFor({ timeout: T });
    check((await b.page.locator('input[name="incident-id"]').inputValue()) === id, 'B’s join form keeps the id');
    await a.page.waitForFunction(
      (old) =>
        (document.querySelector('[data-testid="incident-join-key"]')?.textContent || '').replace(/-/g, '') !== old,
      joinKey,
      { timeout: T },
    );
    const newKey = (await a.page.getByTestId('incident-join-key').textContent()).replace(/-/g, '');
    check(newKey !== joinKey, 'A shows the new key');
    await b.page.locator('input[name="incident-key"]').fill(newKey);
    await b.page.getByTestId('incident-panel-local').locator('button[type="submit"]').click();
    await waitLive(b.page);
    check(true, 'B rejoined with the new key');

    log('B leaves; A’s count drops');
    await b.page.getByRole('button', { name: 'Leave', exact: true }).click();
    await b.page.getByTestId('incident-panel-local').waitFor({ timeout: T });
    await status(b.page).filter({ hasText: 'LOCAL' }).waitFor({ timeout: T });
    await participants(a.page).filter({ hasText: '1 connected' }).waitFor({ timeout: T });
    check(true, 'B is LOCAL and A shows 1 connected');

    console.log('\nAll checks passed.');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
