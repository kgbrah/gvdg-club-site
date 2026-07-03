import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

const STALE_EVENTS_JS = `
export function bucketEvents() { return { live: [], upcoming: [], past: [], cancelled: [] }; }
export function normalizeEvent(raw) { return raw || {}; }
export function groupPlayersByDivision() { return []; }
export function buildCourseIndex() { return new Map(); }
export function courseNameFor() { return ''; }
export function formatEventDate() { return 'Date TBD'; }
export function roundFormatLabel() { return ''; }
export function typeLabel() { return 'Event'; }
export function statusLabel() { return ''; }
`;

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

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

function serviceWorkerCacheName() {
  const match = readFileSync('sw.js', 'utf8').match(/const CACHE = "([^"]+)"/);
  assert.ok(match, 'service worker cache name must be declared');
  return match[1];
}

async function installApiRoutes(page) {
  await page.route(`${API_BASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/events') {
      return route.fulfill(json({
        events: [
          {
            id: 6,
            type: 'tournament',
            name: 'Doubles Matchplay Live',
            status: 'live',
            format: 'matchplay',
            play_format: 'doubles',
            date: '2026-07-04',
            course_id: 7,
            layout_id: 9,
          },
        ],
      }));
    }
    if (url.pathname === '/club-feed') return route.fulfill(json({ events: [], clubEvents: [] }));
    if (url.pathname === '/courses') return route.fulfill(json({ courses: [{ id: 7, name: 'West Meadowbrook' }] }));
    if (url.pathname === '/registration/open') return route.fulfill(json({ events: [] }));
    if (url.pathname === '/leagues') return route.fulfill(json({ leagues: [] }));
    if (url.pathname === '/casual-rounds') return route.fulfill(json({ rounds: [] }));
    if (url.pathname === '/fundraisers') return route.fulfill(json({ fundraisers: [] }));
    if (url.pathname === '/meetings') return route.fulfill(json({ meetings: [] }));
    return route.fulfill(json({ ok: true }));
  });
}

test('events page ignores stale service-worker cached events helper and renders current events', async () => {
  const { server, base } = await staticServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    await installApiRoutes(page);
    await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
    const cacheName = serviceWorkerCacheName();
    await page.evaluate(async ({ body, cacheName }) => {
      await navigator.serviceWorker.ready;
      const cache = await caches.open(cacheName);
      await cache.put(new Request(new URL('/events.js', location.origin).href), new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/javascript' },
      }));
    }, { body: STALE_EVENTS_JS, cacheName });

    await page.goto(`${base}/events.html`, { waitUntil: 'networkidle' });
    const cards = await page.locator('.event-card').count();
    const bodyText = await page.locator('body').textContent();

    assert.equal(cards > 0, true, `expected event cards to render; body=${JSON.stringify((bodyText || '').slice(0, 400))} errors=${JSON.stringify(consoleErrors)}`);
    assert.match(bodyText || '', /Doubles Matchplay Live/);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('events page first service-worker install renders without refreshing the active page', async () => {
  const { server, base } = await staticServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const navigations = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && frame.url().startsWith(`${base}/events.html`)) {
      navigations.push(frame.url());
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    await installApiRoutes(page);
    await page.goto(`${base}/events.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('.event-card').first().waitFor({ timeout: 5000 });
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.waitForTimeout(750);

    const cards = await page.locator('.event-card').count();
    const bodyText = await page.locator('body').textContent();

    assert.equal(cards > 0, true, `expected first-install event cards to render; body=${JSON.stringify((bodyText || '').slice(0, 400))} errors=${JSON.stringify(consoleErrors)}`);
    assert.match(bodyText || '', /Doubles Matchplay Live/);
    assert.deepEqual(navigations, [`${base}/events.html`]);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('events page desktop assistant button stays clear of the casual rounds heading', async () => {
  const { server, base } = await staticServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    await installApiRoutes(page);
    await page.goto(`${base}/events.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('.event-card').first().waitFor({ timeout: 5000 });
    await page.locator('#casualRoundsSection .events-group-head').waitFor({ timeout: 5000 });
    await page.locator('#crotts-fab').waitFor({ timeout: 5000 });

    const layout = await page.evaluate(() => {
      const fab = document.querySelector('#crotts-fab');
      const heading = document.querySelector('#casualRoundsSection .events-group-head');
      if (!fab || !heading) return { missing: true };
      const f = fab.getBoundingClientRect();
      const h = heading.getBoundingClientRect();
      const overlaps = !(f.right <= h.left || f.left >= h.right || f.bottom <= h.top || f.top >= h.bottom);
      return {
        missing: false,
        overlaps,
        fab: { left: f.left, right: f.right, top: f.top, bottom: f.bottom },
        heading: { left: h.left, right: h.right, top: h.top, bottom: h.bottom },
        fabDisplay: getComputedStyle(fab).display,
      };
    });

    assert.equal(layout.missing, false, `expected Crotts button and Casual Rounds heading; layout=${JSON.stringify(layout)}`);
    assert.notEqual(layout.fabDisplay, 'none', `expected desktop assistant button to remain available; layout=${JSON.stringify(layout)}`);
    assert.equal(layout.overlaps, false, `assistant button overlaps Casual Rounds heading; layout=${JSON.stringify(layout)}`);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
