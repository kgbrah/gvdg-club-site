import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function text(path) {
  return readFile(new URL('../' + path, import.meta.url), 'utf8');
}

async function json(path) {
  return JSON.parse(await text(path));
}

test('club dashboard manifest launches at the player dashboard with admin navigation shortcuts', async () => {
  const manifest = await json('club.webmanifest');
  assert.equal(manifest.name, 'GVDG Club');
  assert.equal(manifest.start_url, 'gvdg-members.html');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.icons.every((icon) => icon.src === 'img/logo2.png'), true);
  assert.deepEqual(
    manifest.shortcuts.map((shortcut) => shortcut.url),
    ['gvdg-members.html', 'score.html', 'admin.html', 'pro-shop.html'],
  );
});

test('player and admin dashboards advertise the installable dashboard app', async () => {
  const members = await text('gvdg-members.html');
  const admin = await text('admin.html');
  for (const html of [members, admin]) {
    assert.match(html, /<link rel="manifest" href="club\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="img\/logo2\.png">/);
    assert.match(html, /navigator\.serviceWorker\.register\('sw\.js'\)/);
  }
});

test('scorecard keeps its own score manifest entry point', async () => {
  const manifest = await json('site.webmanifest');
  const score = await text('score.html');
  assert.equal(manifest.name, 'GVDG Live Scoring');
  assert.equal(manifest.start_url, 'score.html');
  assert.match(score, /<link rel="manifest" href="site\.webmanifest">/);
  assert.match(score, /<link rel="apple-touch-icon" href="img\/logo2\.png">/);
});

test('service worker caches dashboard and score app shells', async () => {
  const worker = await text('sw.js');
  for (const asset of ['club.webmanifest', 'site.webmanifest', 'gvdg-members.html', 'admin.html', 'score.html', 'img/logo2.png']) {
    assert.match(worker, new RegExp(JSON.stringify(asset).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(worker, /const DEFAULT_SHELL = "gvdg-members\.html"/);
});
