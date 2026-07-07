import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const publicPages = [
  'events.html',
  'ryder-cup.html',
  'pro-shop.html',
  'gvdg-blog.html',
];

const removedChromePatterns = [
  /<script src="nav\.js" defer><\/script>/,
  /class="menu-toggle" aria-label="Toggle menu">/,
  /class="theme-icon"/,
  /const themeToggle/,
  /const menuToggle/,
  /themeIcon/,
  /document\.querySelector\(['"]header['"]\)/,
  /☰|✕|🌙|☀️/,
];

test('public content pages mount the shared React page chrome', () => {
  for (const page of publicPages) {
    const html = readFileSync(page, 'utf8');
    assert.match(html, /id="publicReactPageChrome"/, page);
    assert.match(html, /<script type="module" src="public-app\/public-app\.js"><\/script>/, page);
    for (const pattern of removedChromePatterns) {
      assert.doesNotMatch(html, pattern, page);
    }
  }
});

test('public React page chrome owns menu, active link, theme, and scroll state', () => {
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const chrome = readFileSync('src/public-app/page-chrome.js', 'utf8');
  const packageJson = readFileSync('package.json', 'utf8');
  const deploy = readFileSync('scripts/gvdg-deploy.sh', 'utf8');
  const sw = readFileSync('sw.js', 'utf8');

  assert.match(packageJson, /"build:public": "vite build --config vite\.public\.config\.mjs"/);
  assert.match(packageJson, /"build": "npm run build:home && npm run build:public && npm run build:tee-sign-preview && npm run build:score && npm run build:members"/);
  assert.ok(existsSync('vite.public.config.mjs'));
  assert.match(main, /createRoot\(pageChromeMount\)\.render\(h\(PublicPageChrome\)\)/);
  assert.match(chrome, /export function PublicPageChrome/);
  assert.match(chrome, /data-react-public-chrome/);
  assert.match(chrome, /aria-expanded/);
  assert.match(chrome, /aria-current/);
  assert.match(chrome, /aria-pressed/);
  assert.match(chrome, /nav-donate/);
  assert.match(chrome, /Menu, MoonStar, Sun, X/);
  assert.match(chrome, /window\.requestAnimationFrame\(update\)/);
  assert.match(chrome, /localStorage\.getItem\("theme"\)/);
  assert.match(chrome, /localStorage\.setItem\("theme", theme\)/);
  assert.match(deploy, /home-app public-app tee-sign-preview-app members-app score-app/);
  assert.match(sw, /const CACHE = "gvdg-club-v51"/);
  assert.match(sw, /"public-app\/public-app\.js"/);
  assert.doesNotMatch(sw, /"nav\.js"/);
  assert.doesNotMatch(chrome, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️/);
});

test('Ryder Cup body results are rendered by the public React bundle', () => {
  const html = readFileSync('ryder-cup.html', 'utf8');
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const app = readFileSync('src/public-app/ryder-cup-app.js', 'utf8');

  assert.match(html, /id="ryderCupReactApp"/);
  assert.doesNotMatch(html, /id="scoreboard"|id="weeks"|id="status"|id="lastUpdated"|parseMatchGrid|parseRyderWorkbook|parseScoreboard|seedPairNames/);
  assert.match(main, /createRoot\(ryderCupMount\)\.render\(h\(RyderCupApp\)\)/);
  assert.match(app, /export function RyderCupApp/);
  assert.match(app, /data-react-ryder-cup/);
  assert.match(app, /data-react-ryder-scoreboard/);
  assert.match(app, /parseRyderWorkbook/);
  assert.match(app, /parseMatchGrid/);
  assert.match(app, /parseScoreboard/);
  assert.match(app, /seedPairNames/);
  assert.match(app, /events\.html#league\/4/);
  assert.match(app, /window\.setInterval\(\(\) => guardedLoad\(\{ quiet: true \}\), REFRESH_MS\)/);
  assert.match(app, /role: error \? "alert" : "status"/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️|🏆|⚠/);
});

test('Pro Shop body storefront is rendered by the public React bundle', () => {
  const html = readFileSync('pro-shop.html', 'utf8');
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const app = readFileSync('src/public-app/pro-shop-app.js', 'utf8');

  assert.match(html, /id="proShopReactApp"/);
  assert.doesNotMatch(html, /id="productGrid"|id="cartList"|id="checkoutBtn"|id="paypalRedirectBtn"|function renderProducts|function renderCart|LOCAL_AUTH_BASE/);
  assert.match(main, /createRoot\(proShopMount\)\.render\(h\(ProShopApp\)\)/);
  assert.match(app, /export function ProShopApp/);
  assert.match(app, /data-react-pro-shop/);
  assert.match(app, /\/shop\/products\?sort=brand/);
  assert.match(app, /\/shop\/wallet/);
  assert.match(app, /\/shop\/orders/);
  assert.match(app, /\/shop\/paypal-order/);
  assert.match(app, /\/shop\/pay\/create-order/);
  assert.match(app, /\/shop\/pay\/capture/);
  assert.match(app, /\/payments\/config/);
  assert.match(app, /window\.paypal\.Buttons/);
  assert.match(app, /document\.createElement\("script"\)/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️|📦/);
});
