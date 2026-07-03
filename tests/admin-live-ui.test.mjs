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

function liveSnapshot() {
  return {
    status: 'live',
    eventId: 2,
    format: 'matchplay',
    playFormat: 'doubles',
    teamRequired: true,
    courseName: 'West Meadowbrook',
    layoutName: 'Gold',
    weather: null,
    holes: [{ hole: 1, par: 3 }, { hole: 2, par: 4 }],
    players: [
      { index: 0, cardId: 'c0', name: 'Red 1', team: 'Red', division: 'MA1', startingHole: null, scores: { 1: 3 }, scorecards: {} },
      { index: 1, cardId: 'c0', name: 'Red 2', team: 'Red', division: 'MA1', startingHole: null, scores: { 1: 3 }, scorecards: {} },
      { index: 2, cardId: 'c0', name: 'Blue 1', team: 'Blue', division: 'MA1', startingHole: null, scores: { 1: 4 }, scorecards: {} },
      { index: 3, cardId: 'c0', name: 'Blue 2', team: 'Blue', division: 'MA1', startingHole: null, scores: { 1: 4 }, scorecards: {} },
    ],
    conflicts: [],
    missing: [],
    standings: [
      { name: 'Red', team: 'Red', division: null, thru: 1, total: 3, toPar: 0, holesWon: 1, holesLost: 0, holesTied: 0, matchPoints: 1, matchLabel: '1 Up' },
      { name: 'Blue', team: 'Blue', division: null, thru: 1, total: 4, toPar: 1, holesWon: 0, holesLost: 1, holesTied: 0, matchPoints: -1, matchLabel: '1 Down' },
    ],
  };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition_timeout');
}

async function installApiRoutes(page, calls) {
  const event = {
    id: 2,
    type: 'tournament',
    name: 'Doubles Matchplay QA',
    status: 'scheduled',
    format: 'matchplay',
    play_format: 'doubles',
    date: '2026-07-04',
    course_id: 1,
    layout_id: null,
  };
  const snap = liveSnapshot();
  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON?.() ?? {};

    if (path === '/me') return route.fulfill(json({ isAdmin: true, name: 'QA Admin' }));
    if (path === '/events' && method === 'GET') return route.fulfill(json({ events: [event] }));
    if (path === '/courses' && method === 'GET') return route.fulfill(json({ courses: [{ id: 1, name: 'West Meadowbrook' }] }));
    if (path === '/leagues' && method === 'GET') return route.fulfill(json({ leagues: [] }));
    if (path === '/shop/orders/new-count' && method === 'GET') return route.fulfill(json({ count: 0 }));
    if (path === '/courses/1/layouts' && method === 'GET') return route.fulfill(json({ layouts: [{ id: 10, name: 'Gold', total_par: 7, holes: '[]' }] }));
    if (path === '/admin/events/2' && method === 'PATCH') {
      calls.layoutPatch.push(body);
      event.layout_id = body.layout_id;
      return route.fulfill(json({ event }));
    }
    if (path === '/events/2/live/start' && method === 'POST') {
      event.status = 'live';
      return route.fulfill(json(snap));
    }
    if (path === '/events/2/live' && method === 'GET') return route.fulfill(json(snap));
    if (path === '/courses/1/tee-signs' && method === 'GET') return route.fulfill(json({ teeSigns: [] }));
    if (path === '/events/2/live/score' && method === 'POST') {
      calls.scores.push(body);
      const player = snap.players.find((row) => row.index === body.index);
      if (player) player.scores[body.hole] = body.strokes;
      return route.fulfill(json(snap));
    }
    return route.fulfill(json({ ok: true }));
  });
}

test('admin live scoring confirms layout updates and posts authoritative doubles side scores', async () => {
  const { server, base } = await staticServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const calls = { layoutPatch: [], scores: [] };
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !/WebSocket connection to .*127\.0\.0\.1:8788.*ERR_CONNECTION_REFUSED/.test(text)) consoleErrors.push(text);
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    await installApiRoutes(page, calls);
    await page.addInitScript(() => sessionStorage.setItem('gvdg_member_token', 'qa-token'));
    await page.goto(`${base}/admin.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#adminPanel', { state: 'visible' });
    await page.locator('[data-atab="scoring"]').first().evaluate((button) => button.click());
    await page.locator('#scEvent').selectOption('2');
    await page.locator('#scLayout').selectOption('10');
    await page.locator('#scStartBtn').click();
    await page.waitForSelector('#scGrid.sc-team-grid tbody tr');

    assert.deepEqual(calls.layoutPatch, [{ layout_id: 10, confirm_event_details_update: true }]);

    const rows = await page.locator('#scGrid tbody tr').evaluateAll((elements) => elements.map((row) => Array.from(row.children).slice(0, 3).map((cell) => cell.textContent?.trim())));
    assert.deepEqual(rows, [
      ['Red', 'Red 1 / Red 2', '—'],
      ['Blue', 'Blue 1 / Blue 2', '—'],
    ]);
    assert.deepEqual(await page.evaluate(() => scScoreGroups().map((group) => group.players.map((player) => player.index))), [[0, 1], [2, 3]]);

    const firstRedHole = page.locator('#scGrid tbody tr').first().locator('input').first();
    await firstRedHole.evaluate((input) => {
      input.value = '4';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    try {
      await waitUntil(() => calls.scores.length === 2);
    } catch (error) {
      throw new Error(`score_posts_timeout calls=${JSON.stringify(calls.scores)} errors=${JSON.stringify(consoleErrors)} ${error.message}`);
    }
    await page.waitForFunction(() => document.querySelector('#scBoard')?.textContent?.includes('Red'));

    assert.deepEqual(calls.scores, [
      { index: 0, hole: 1, strokes: 4, authoritative: true },
      { index: 1, hole: 1, strokes: 4, authoritative: true },
    ]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
