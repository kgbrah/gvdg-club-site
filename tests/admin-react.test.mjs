import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('admin page chrome is rendered by the admin React bundle', () => {
  const html = readFileSync('admin.html', 'utf8');
  const main = readFileSync('src/admin-app/main.js', 'utf8');
  const chrome = readFileSync('src/admin-app/page-chrome.js', 'utf8');

  assert.match(html, /id="adminReactPageChromeApp"/);
  assert.match(html, /<script type="module" src="admin-app\/admin-app\.js"><\/script>/);
  assert.doesNotMatch(html, /<header>[\s\S]*class="menu-toggle"/);
  assert.doesNotMatch(html, /class="theme-icon"|const themeToggle|const menuToggle|themeIcon\.textContent|document\.querySelector\('\.menu-toggle'\)|document\.querySelector\('header'\)|document\.querySelectorAll\('\.logout-link'\)/);
  assert.match(main, /import \{ AdminPageChrome \} from "\.\/page-chrome\.js"/);
  assert.match(main, /const pageChromeMount = document\.getElementById\("adminReactPageChromeApp"\)/);
  assert.match(main, /createRoot\(pageChromeMount\)\.render\(h\(AdminPageChrome\)\)/);
  assert.match(chrome, /export function AdminPageChrome/);
  assert.match(chrome, /data-react-admin-chrome/);
  assert.match(chrome, /aria-expanded/);
  assert.match(chrome, /aria-current/);
  assert.match(chrome, /aria-pressed/);
  assert.match(chrome, /className: current \? "active" : undefined/);
  assert.match(chrome, /Menu, MoonStar, Sun, X/);
  assert.match(chrome, /window\.requestAnimationFrame\(update\)/);
  assert.match(chrome, /localStorage\.getItem\("theme"\)/);
  assert.match(chrome, /localStorage\.setItem\("theme", theme\)/);
  assert.match(chrome, /sessionStorage\.removeItem\(key\)/);
  assert.doesNotMatch(chrome, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️/);
});

test('admin order badge updates through React instead of DOM text mutation', () => {
  const html = readFileSync('admin.html', 'utf8');
  const main = readFileSync('src/admin-app/main.js', 'utf8');
  const badge = readFileSync('src/admin-app/orders-badge.js', 'utf8');
  const setBadge = html.match(/function setOrdersBadge\(n\) \{[\s\S]*?\n        \}/)?.[0];

  assert.match(html, /id="ordersBadgeReactApp"/);
  assert.doesNotMatch(html, /id="ordersBadge" class="orders-badge" hidden/);
  assert.ok(setBadge);
  assert.match(setBadge, /window\.__gvdgAdminOrdersBadgeCount = count/);
  assert.match(setBadge, /new CustomEvent\('gvdg:admin-orders-badge', \{ detail: \{ count \} \}\)/);
  assert.doesNotMatch(setBadge, /textContent|hidden|getElementById/);
  assert.match(html, /async function refreshOrdersBadge\(\) \{[\s\S]*setOrdersBadge\(0\);[\s\S]*catch \(e\) \{ setOrdersBadge\(0\); \}/);
  assert.match(main, /import \{ AdminOrdersBadge \} from "\.\/orders-badge\.js"/);
  assert.match(main, /const ordersBadgeMount = document\.getElementById\("ordersBadgeReactApp"\)/);
  assert.match(main, /createRoot\(ordersBadgeMount\)\.render\(h\(AdminOrdersBadge\)\)/);
  assert.match(badge, /export function AdminOrdersBadge/);
  assert.match(badge, /gvdg:admin-orders-badge/);
  assert.match(badge, /window\.__gvdgAdminOrdersBadgeCount/);
  assert.match(badge, /className: "orders-badge"/);
  assert.match(badge, /if \(count <= 0\) return null/);
  assert.doesNotMatch(badge, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️/);
});
