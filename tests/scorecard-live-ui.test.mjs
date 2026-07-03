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

async function waitUntil(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition_timeout');
}

function liveMine() {
  return {
    status: 'live',
    eventId: 6,
    casual: false,
    cardId: 'c0',
    playerIndex: 0,
    format: 'matchplay',
    playFormat: 'doubles',
    teamRequired: true,
    courseName: 'West Meadowbrook',
    layoutName: 'Gold',
    udiscCourseId: null,
    weather: null,
    holes: [{ hole: 1, par: 3 }, { hole: 2, par: 4 }],
    cardmates: [
      { index: 0, cardId: 'c0', name: 'Red 1', team: 'Red', division: 'MA1', scores: {}, scorecards: {}, isMe: true, canEnterScorecard: true },
      { index: 1, cardId: 'c0', name: 'Red 2', team: 'Red', division: 'MA1', scores: {}, scorecards: {}, isMe: false, canEnterScorecard: false },
      { index: 2, cardId: 'c0', name: 'Blue 1', team: 'Blue', division: 'MA1', scores: {}, scorecards: {}, isMe: false, canEnterScorecard: false },
      { index: 3, cardId: 'c0', name: 'Blue 2', team: 'Blue', division: 'MA1', scores: {}, scorecards: {}, isMe: false, canEnterScorecard: false },
    ],
    conflicts: [],
    missing: [],
  };
}

function liveSnapshot(mine) {
  return {
    status: mine.status,
    eventId: mine.eventId,
    format: mine.format,
    playFormat: mine.playFormat,
    teamRequired: mine.teamRequired,
    courseName: mine.courseName,
    layoutName: mine.layoutName,
    weather: null,
    holes: mine.holes,
    players: mine.cardmates.map((p) => ({ ...p, isMe: undefined, canEnterScorecard: undefined })),
    conflicts: [],
    missing: [],
    standings: [
      { name: 'Red', team: 'Red', thru: 1, matchPoints: 1, matchLabel: '1 Up' },
      { name: 'Blue', team: 'Blue', thru: 1, matchPoints: -1, matchLabel: '1 Down' },
    ],
    rev: Date.now(),
  };
}

async function installApiRoutes(page, calls) {
  const mine = liveMine();
  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON?.() ?? {};

    if (path === '/events/6/live/mine' && method === 'GET') return route.fulfill(json(mine));
    if (path === '/events/6/live/score' && method === 'POST') {
      calls.scores.push(body);
      const player = mine.cardmates.find((row) => row.index === body.index);
      if (player) {
        player.scores[body.hole] = body.strokes;
        player.scorecards[body.hole] = { [`player:${body.scorerIndex}`]: body.strokes };
      }
      return route.fulfill(json(liveSnapshot(mine)));
    }
    return route.fulfill(json({ ok: true }));
  });
}

test('player scorecard renders doubles matchplay as side scoring and posts both partner scores', async () => {
  const { server, base } = await staticServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const calls = { scores: [] };
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !/WebSocket connection to .*127\.0\.0\.1:8788.*ERR_CONNECTION_REFUSED/.test(text)) consoleErrors.push(text);
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    await installApiRoutes(page, calls);
    await page.addInitScript(() => sessionStorage.setItem('gvdg_member_token', 'qa-token'));
    await page.goto(`${base}/score.html?event=6`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.prow');

    assert.match(await page.locator('#app').textContent(), /Doubles\s+·\s+Matchplay/);
    const rows = await page.locator('.prow').evaluateAll((elements) =>
      elements.map((row) => Array.from(row.querySelectorAll('.pname,.pmeta')).map((cell) => cell.textContent?.trim()))
    );
    assert.deepEqual(rows.slice(0, 2), [
      ['Red', 'Red 1 (you) / Red 2', 'MA1'],
      ['Blue', 'Blue 1 / Blue 2', 'MA1'],
    ]);

    const firstRedPlus = page.locator('.prow').first().locator('button.plus');
    await firstRedPlus.click();
    await page.waitForFunction(() => document.querySelector('.prow .n')?.textContent === '3');
    await waitUntil(() => calls.scores.length === 2);

    assert.deepEqual(calls.scores, [
      { index: 0, scorerIndex: 0, hole: 1, strokes: 3 },
      { index: 1, scorerIndex: 0, hole: 1, strokes: 3 },
    ]);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
