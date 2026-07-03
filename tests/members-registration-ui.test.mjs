import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { test } from 'node:test';

import { chromium } from 'playwright';

const ROOT = process.cwd();
const API_BASE = 'http://127.0.0.1:8788';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
]);

function staticServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = normalize(join(ROOT, pathname));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME.get(extname(file)) || 'application/octet-stream' }).end(body);
    } catch (_error) {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server_address_missing');
      resolve({ server, base: `http://127.0.0.1:${address.port}` });
    });
  });
}

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function registrationRow(checkedIn, checkinDeadline) {
  return {
    id: 9,
    event_id: 5,
    member_id: 'm_jane',
    name: 'Jane Player',
    division: 'MA1',
    checked_in: checkedIn ? 1 : 0,
    addons: '{}',
    paid_entry: 0,
    event_name: 'July Flex Doubles',
    date: '2026-07-04',
    starts_at: '2026-07-04T13:00:00.000Z',
    registration_deadline: new Date(Date.now() - 3_600_000).toISOString(),
    checkin_deadline: checkinDeadline,
    type: 'tournament',
    status: 'scheduled',
    event_format: 'matchplay',
    course_id: 2,
    layout_id: 7,
    course_name: 'West Meadowbrook',
    layout_name: 'Gold',
    total_par: 54,
    entry_fee_cents: 1000,
    ctp_fee_cents: 0,
    ace_fee_cents: 0,
    divisions: '["MA1"]',
    play_format: 'doubles',
  };
}

async function installApiRoutes(page, calls) {
  let checkedIn = false;
  const checkinDeadline = new Date(Date.now() + 86_400_000).toISOString();
  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/me' && method === 'GET') return route.fulfill(json({ name: 'Jane Player', isAdmin: false, mustChangePin: false }));
    if (path === '/payments/config' && method === 'GET') return route.fulfill(json({ enabled: false }));
    if (path === '/registration/open' && method === 'GET') return route.fulfill(json({ events: [] }));
    if (path === '/my-registrations' && method === 'GET') return route.fulfill(json({ registrations: [registrationRow(checkedIn, checkinDeadline)] }));
    if (path === '/events/5/checkin' && method === 'POST') {
      checkedIn = true;
      calls.checkins += 1;
      return route.fulfill(json({ registration: registrationRow(true, checkinDeadline) }));
    }
    if (path === '/my-results' && method === 'GET') return route.fulfill(json({ results: [] }));
    if (path === '/my-live-rounds' && method === 'GET') return route.fulfill(json({ rounds: [] }));
    if (path === '/shop/wallet' && method === 'GET') return route.fulfill(json({ balance_cents: 0, transactions: [] }));
    if (path === '/meetings' && method === 'GET') return route.fulfill(json({ meetings: [] }));
    if (path === '/board' && method === 'GET') return route.fulfill(json({ posts: [], authors: {} }));
    if (path === '/my-tee-signs' && method === 'GET') return route.fulfill(json({ teeSigns: [] }));
    if (path === '/courses' && method === 'GET') return route.fulfill(json({ courses: [] }));
    return route.fulfill(json({ ok: true }));
  });
}

test('member registration card remains available for check-in after registration closes', async () => {
  const { server, base } = await staticServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const calls = { checkins: 0 };
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    await installApiRoutes(page, calls);
    await page.addInitScript(() => sessionStorage.setItem('gvdg_member_token', 'qa-token'));
    await page.goto(`${base}/gvdg-members.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#clubRegister:not(.dtab-off)', { state: 'visible' });
    await page.waitForSelector('.register-card');

    const cardText = await page.locator('.register-card').first().textContent();
    assert.match(cardText, /July Flex Doubles/);
    assert.match(cardText, /Date\s+Sat, Jul 4, 2026/);
    assert.match(cardText, /Start\s+Sat, Jul 4, 2026/);
    assert.match(cardText, /Register\s+/);
    assert.match(cardText, /Check-in\s+/);
    assert.match(cardText, /West Meadowbrook/);
    assert.match(cardText, /doubles/);
    assert.equal(await page.locator('.register-card button', { hasText: 'Register' }).count(), 0);

    await page.locator('.register-card button', { hasText: 'Check in' }).click();
    await page.waitForFunction(() => document.querySelector('.register-card')?.textContent?.includes('checked in'));

    assert.equal(calls.checkins, 1);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
