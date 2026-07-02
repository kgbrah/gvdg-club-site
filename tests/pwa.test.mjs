import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appPages = [
  'index.html',
  'events.html',
  'gvdg-members.html',
  'score.html',
  'pro-shop.html',
  'ryder-cup.html',
  'gvdg-blog.html',
  'admin.html',
];

function pngSize(path) {
  const buf = readFileSync(path);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('manifest is installable and launches members with app shortcuts', () => {
  const manifest = JSON.parse(readFileSync('site.webmanifest', 'utf8'));
  assert.equal(manifest.name, 'Greenville Disc Golf Club');
  assert.equal(manifest.short_name, 'GVDG Club');
  assert.equal(manifest.start_url, 'gvdg-members.html');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#FF6B35');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.purpose.includes('any')));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose.includes('any')));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose.includes('maskable')));
  assert.deepEqual(manifest.shortcuts.map((shortcut) => shortcut.url), [
    'gvdg-members.html',
    'score.html',
    'admin.html',
    'events.html',
    'pro-shop.html',
  ]);
});

test('manifest icons have the declared square dimensions', () => {
  assert.deepEqual(pngSize('img/icons/app-icon-192.png'), { width: 192, height: 192 });
  assert.deepEqual(pngSize('img/icons/app-icon-512.png'), { width: 512, height: 512 });
  assert.deepEqual(pngSize('img/icons/maskable-icon-512.png'), { width: 512, height: 512 });
  assert.deepEqual(pngSize('img/icons/apple-touch-icon.png'), { width: 180, height: 180 });
});

test('app entry pages link manifest, touch icon, theme color, and pwa registrar', () => {
  for (const page of appPages) {
    const html = readFileSync(page, 'utf8');
    assert.match(html, /<meta name="theme-color" content="#FF6B35">/, page);
    assert.match(html, /<link rel="manifest" href="site\.webmanifest">/, page);
    assert.match(html, /<link rel="apple-touch-icon" href="img\/icons\/apple-touch-icon\.png">/, page);
    assert.match(html, /<script src="pwa\.js" defer><\/script>/, page);
  }
});

test('live scoring links back to the members dashboard', () => {
  const html = readFileSync('score.html', 'utf8');
  assert.match(html, /Return to members/);
  assert.match(html, /membersLink\.href = 'gvdg-members\.html'/);
  assert.match(html, /<a class="top-link" href="gvdg-members\.html" aria-label="Return to members">Members<\/a>/);
  assert.match(html, /\.iconbtn\[hidden\] \{ display: none; \}/);
});

test('live scoring surfaces load the shared weather display formatter', () => {
  for (const path of ['score.html', 'events.html', 'admin.html']) {
    assert.match(readFileSync(path, 'utf8'), /weather-display\.js/);
  }
});

test('admin live scoring layout selector uses themed picker styles', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /<select id="scLayout"/);
  assert.match(html, /#alCourse,\s*#scEvent,\s*#scLayout,\s*#rgEvent\s*\{/);
});

test('admin registration bulk assignment controls confirm destructive changes', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /id="rgAssignCards"/);
  assert.match(html, /id="rgAssignTeams"/);
  assert.match(html, /id="rgTeamSize"/);
  assert.match(html, /confirm\([^)]*Existing/s);
  assert.match(html, /btn\.disabled = true; btn\.textContent = 'Assigning\.\.\.'/);
});

test('admin wallet adjustments confirm and carry retry keys', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /id="waSubmit"/);
  assert.match(html, /wallet-adjustment:/);
  assert.match(html, /idempotency_key: key/);
  assert.match(html, /confirm\('Post ' \+ dollarsFromCents\(amount\)/);
  assert.match(html, /btn\.disabled = true; btn\.textContent = 'Posting\.\.\.'/);
});

test('admin delete blockers surface dependent records', () => {
  const html = readFileSync('admin.html', 'utf8');
  assert.match(html, /DELETE_BLOCKER_LABELS/);
  assert.match(html, /course_layouts: 'layouts'/);
  assert.match(html, /round_ratings: 'round ratings'/);
  assert.match(html, /deleteBlockedMessage\('event', r\.status, d\)/);
  assert.match(html, /deleteBlockedMessage\('layout', r\.status, d\)/);
});

test('score course picker rows use themed text and app font', () => {
  const html = readFileSync('score.html', 'utf8');
  assert.match(html, /c\.appendChild\(el\('h2', 'section', 'Pick a course'\)\)/);
  assert.match(html, /\.tap-row\s*\{[^}]*color: var\(--text-primary\); font: inherit;/s);
});

test('shared service worker caches app install assets and member fallback', () => {
  const sw = readFileSync('sw.js', 'utf8');
  assert.match(sw, /const CACHE = "gvdg-club-v14"/);
  assert.match(sw, /const OFFLINE_PAGE = "gvdg-members\.html"/);
  assert.match(sw, /const STATIC_DESTINATIONS = new Set/);
  assert.match(sw, /if \(!staticAsset\(req, url\)\) return/);
  for (const asset of [
    'site.webmanifest',
    'pwa.js',
    'img/icons/app-icon-192.png',
    'img/icons/app-icon-512.png',
    'img/icons/maskable-icon-512.png',
    'img/icons/apple-touch-icon.png',
    'admin.html',
    'weather-display.js',
  ]) {
    assert.ok(sw.includes(`"${asset}"`), asset);
  }
  assert.match(readFileSync('pwa.js', 'utf8'), /serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
});
