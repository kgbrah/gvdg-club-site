import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const API_ORIGIN = 'http://127.0.0.1:8788';

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

async function mockApi(page, observed) {
  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/me') {
      await route.fulfill(jsonRoute({ name: 'Admin', sub: 'm_admin', mustChangePin: false, isAdmin: true }));
      return;
    }
    if (url.pathname === '/courses') {
      await route.fulfill(jsonRoute({ courses: [{ id: 7, name: 'West Meadowbrook', location: 'Greenville, NC' }] }));
      return;
    }
    if (url.pathname === '/courses/7/layouts') {
      await route.fulfill(jsonRoute({ layouts: [{ id: 3, name: 'Longs', total_par: 54 }] }));
      return;
    }
    if (url.pathname === '/admin/events' && request.method() === 'POST') {
      observed.eventCreate = request.postDataJSON();
      await route.fulfill(jsonRoute({ event: { id: 91, ...observed.eventCreate } }, 201));
      return;
    }
    if (url.pathname === '/events') {
      await route.fulfill(jsonRoute({ events: [] }));
      return;
    }
    if (url.pathname === '/leagues') {
      await route.fulfill(jsonRoute({ leagues: [] }));
      return;
    }
    if (url.pathname === '/admin/orders') {
      await route.fulfill(jsonRoute({ orders: [], unfulfilled: 0 }));
      return;
    }
    await route.fulfill(jsonRoute({}));
  });
}

function fakeToken() {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ sub: 'm_admin' })}.sig`;
}

test('admin new event form submits play format separately from scoring format', async () => {
  const appUrl = await startStaticServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const observed = {};
  await mockApi(page, observed);
  await page.addInitScript((token) => {
    sessionStorage.setItem('gvdg_member_token', token);
    sessionStorage.setItem('gvdg_member_name', 'Admin');
  }, fakeToken());

  try {
    await page.goto(`${appUrl}/admin.html`);
    await page.getByRole('button', { name: 'New Event' }).click();
    const form = page.locator('#adminCreateForm');
    await form.getByLabel('Type').selectOption('league_round');
    await form.getByLabel('Name').fill('Friday Doubles');
    await form.getByLabel('Play format').selectOption('doubles');
    await form.getByLabel('Scoring').selectOption('matchplay');
    await form.getByLabel('Course').selectOption('7');
    await form.getByLabel('Layout').selectOption('3');
    await form.getByRole('button', { name: 'Create event' }).click();

    await page.waitForFunction(() => document.querySelector('#adminMsg')?.textContent?.includes('Created'));
    assert.deepEqual(observed.eventCreate, {
      type: 'league_round',
      name: 'Friday Doubles',
      date: null,
      play_format: 'doubles',
      format: 'matchplay',
      course_id: 7,
      league_id: null,
      notes: null,
      status: 'scheduled',
      layout_id: 3,
      source: 'manual',
    });
  } finally {
    await browser.close();
  }
});
