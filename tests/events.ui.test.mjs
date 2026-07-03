import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const API_ORIGIN = 'http://127.0.0.1:8788';

const LIVE_EVENT = {
  id: 91,
  name: 'Live Doubles Matchplay',
  type: 'league_round',
  status: 'live',
  date: '2026-07-03T22:00:00Z',
  format: 'matchplay',
  play_format: 'doubles',
  course_id: 7,
  layout_id: 3,
  course_name: 'West Meadowbrook',
  layout_name: 'Longs',
};

const UPCOMING_EVENT = {
  id: 92,
  name: 'Saturday Flex',
  type: 'tournament',
  status: 'scheduled',
  date: '2026-07-11T14:00:00Z',
  format: 'stroke',
  play_format: 'singles',
  course_id: 7,
  layout_id: 3,
};

const COURSE = { id: 7, name: 'West Meadowbrook', location: 'Greenville, NC', udisc_course_id: '12345' };
const LAYOUT = { id: 3, name: 'Longs', total_par: 7 };

const LIVE_SNAPSHOT = {
  status: 'live',
  eventId: 91,
  format: 'matchplay',
  playFormat: 'doubles',
  teamRequired: true,
  courseName: 'West Meadowbrook',
  layoutName: 'Longs',
  holes: [{ hole: 1, par: 3 }, { hole: 2, par: 4 }],
  players: [
    { index: 0, name: 'TJ Braley', team: 'Blue', division: 'MPO', scores: { 1: 3, 2: 4 } },
    { index: 1, name: 'Jane Doe', team: 'Blue', division: 'MPO', scores: { 1: 3, 2: 4 } },
    { index: 2, name: 'Sam Smith', team: 'Red', division: 'MPO', scores: { 1: 4, 2: 5 } },
    { index: 3, name: 'Riley Jones', team: 'Red', division: 'MPO', scores: { 1: 4, 2: 5 } },
  ],
  standings: [],
};

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

let server;
let baseUrl;

after(async () => {
  if (!server) return;
  await new Promise((resolveClose) => server.close(resolveClose));
});

function safeAssetPath(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, 'http://local').pathname);
  const candidate = resolve(ROOT, pathname === '/' ? 'index.html' : `.${pathname}`);
  return candidate === ROOT || candidate.startsWith(ROOT + sep) ? candidate : null;
}

async function startStaticServer() {
  if (baseUrl) return baseUrl;
  server = createServer(async (req, res) => {
    const assetPath = safeAssetPath(req.url || '/');
    if (!assetPath) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const body = await readFile(assetPath);
      res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(assetPath)] || 'application/octet-stream' });
      res.end(body);
    } catch (_err) {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  return baseUrl;
}

function jsonRoute(payload, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  };
}

function routePayload(url) {
  const path = url.pathname;
  if (path === '/courses') {
    return { courses: [COURSE] };
  }
  if (path === '/courses/7/layouts') return { layouts: [LAYOUT] };
  if (path === '/club-feed') return { events: [], clubEvents: [] };
  if (path === '/events' && url.searchParams.get('status') === 'live') return { events: [LIVE_EVENT] };
  if (path === '/events') return { events: [LIVE_EVENT, UPCOMING_EVENT] };
  if (path === '/events/91') return { event: { ...LIVE_EVENT, players: [] } };
  if (path === '/events/91/live') return LIVE_SNAPSHOT;
  if (path === '/registration/open') return { events: [] };
  if (path === '/my-registrations') return { registrations: [] };
  if (path === '/my-live-rounds') return { rounds: [{ ...LIVE_EVENT, division: 'MPO' }] };
  if (path === '/shop/wallet') return { balance_cents: 0, transactions: [] };
  if (path === '/my-results') return { results: [] };
  if (path === '/meetings') return { meetings: [] };
  if (path === '/board') return { posts: [], authors: {} };
  if (path === '/my-tee-signs') return { teeSigns: [] };
  if (path === '/casual-rounds') return { requests: [] };
  if (path === '/fundraisers') return { fundraisers: [] };
  if (path === '/leagues') return { leagues: [] };
  if (path === '/payments/config') return { enabled: false };
  if (path === '/me') {
    return {
      name: 'Jane Member',
      sub: 'm_jane',
      mustChangePin: false,
      isAdmin: false,
      pdgaNo: null,
    };
  }
  return {};
}

async function mockApi(page, observed = {}) {
  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/rounds') {
      observed.roundCreate = request.postDataJSON();
      await route.fulfill(jsonRoute({ code: 'RND123' }, 201));
      return;
    }
    const payload = routePayload(url);
    await route.fulfill(jsonRoute(payload));
  });
}

function fakeToken() {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ sub: 'm_jane' })}.sig`;
}

test('events page pins Live Now above the event feed and renders team matchplay scoring', async () => {
  const appUrl = await startStaticServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await mockApi(page);
  await page.addInitScript(() => {
    window.WebSocket = class {
      constructor() {
        throw new Error('WebSocket disabled in this browser test');
      }
    };
  });
  try {
    await page.goto(`${appUrl}/events.html`);
    await page.locator('#liveEvents .events-section-title', { hasText: 'Live Now' }).waitFor();

    const liveBox = await page.locator('#liveEvents').boundingBox();
    const calendarBox = await page.locator('#calendarEvents').boundingBox();
    assert.ok(liveBox && calendarBox);
    assert.ok(liveBox.y < calendarBox.y, 'Live Now should render above the regular event feed');
    await assertVisible(page.locator('#liveEvents').getByText('Doubles · Matchplay'));

    await page.getByRole('button', { name: /Live Doubles Matchplay/ }).click();
    await page.locator('.live-round-summary').getByText('Doubles · Matchplay').waitFor();
    await assertVisible(page.locator('.live-round-summary').getByText('4 players'));
    await assertVisible(page.locator('.live-round-summary').getByText(/2 teams/));
    await assertVisible(page.locator('.lb-table th', { hasText: 'Team' }));
    await assertVisible(page.locator('.lb-name-main', { hasText: 'Blue' }));
    await assertVisible(page.getByText('TJ Braley / Jane Doe'));
  } finally {
    await browser.close();
  }
});

test('member dashboard shows public Live Now events before personal scorecards', async () => {
  const appUrl = await startStaticServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await mockApi(page);
  await page.addInitScript((token) => {
    sessionStorage.setItem('gvdg_member_token', token);
    sessionStorage.setItem('gvdg_member_name', 'Jane Member');
  }, fakeToken());
  try {
    await page.goto(`${appUrl}/gvdg-members.html`);
    const panel = page.locator('#liveScoring');
    await panel.getByText('Live Now & Scorecards').waitFor();

    const liveCard = panel.locator('.live-round-card.live-now');
    await assertVisible(liveCard.getByText('Live now'));
    await assertVisible(liveCard.getByText('Live Doubles Matchplay'));
    await assertVisible(liveCard.getByText(/West Meadowbrook/));
    await assertVisible(liveCard.getByText(/Longs/));
    await assertVisible(liveCard.getByText(/Doubles · Matchplay/));
    assert.equal(await liveCard.getByRole('link', { name: 'View event' }).getAttribute('href'), 'events.html#event/91');

    await assertVisible(panel.getByRole('heading', { name: 'My Active Scorecards' }));
    await assertVisible(panel.getByRole('link', { name: 'Rejoin scorecard' }));
  } finally {
    await browser.close();
  }
});

test('casual scorecard setup submits play format separately from scoring format', async () => {
  const appUrl = await startStaticServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const observed = {};
  await mockApi(page, observed);
  await page.addInitScript((token) => {
    sessionStorage.setItem('gvdg_member_token', token);
    sessionStorage.setItem('gvdg_member_name', 'Jane Member');
  }, fakeToken());
  try {
    await page.goto(`${appUrl}/score.html`);
    await page.getByRole('button', { name: /Start a casual round/ }).click();
    await page.getByRole('button', { name: /West Meadowbrook/ }).click();
    await page.getByRole('button', { name: /Longs/ }).click();
    await page.locator('select.field').nth(0).selectOption('doubles');
    await page.locator('select.field').nth(1).selectOption('matchplay');
    await page.locator('input.field').fill('Blue');
    await page.getByRole('button', { name: 'Start round' }).click();

    await page.waitForFunction(() => location.search.includes('round=RND123'));
    assert.deepEqual(observed.roundCreate, {
      course_id: COURSE.id,
      layout_id: LAYOUT.id,
      format: 'matchplay',
      playFormat: 'doubles',
      team: 'Blue',
    });
  } finally {
    await browser.close();
  }
});

async function assertVisible(locator) {
  await locator.waitFor({ state: 'visible' });
  assert.equal(await locator.isVisible(), true);
}
