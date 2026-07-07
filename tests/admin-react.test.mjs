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
  const nav = readFileSync('src/admin-app/navigation.js', 'utf8');
  const badge = readFileSync('src/admin-app/orders-badge.js', 'utf8');
  const setBadge = html.match(/function setOrdersBadge\(n\) \{[\s\S]*?\n        \}/)?.[0];

  assert.match(html, /id="adminNavigationReactApp"/);
  assert.doesNotMatch(html, /id="ordersBadgeReactApp"/);
  assert.doesNotMatch(html, /id="ordersBadge" class="orders-badge" hidden/);
  assert.ok(setBadge);
  assert.match(setBadge, /window\.__gvdgAdminOrdersBadgeCount = count/);
  assert.match(setBadge, /new CustomEvent\('gvdg:admin-orders-badge', \{ detail: \{ count \} \}\)/);
  assert.doesNotMatch(setBadge, /textContent|hidden|getElementById/);
  assert.match(html, /async function refreshOrdersBadge\(\) \{[\s\S]*setOrdersBadge\(0\);[\s\S]*catch \(e\) \{ setOrdersBadge\(0\); \}/);
  assert.doesNotMatch(main, /ordersBadgeMount|ordersBadgeReactApp/);
  assert.match(nav, /import \{ AdminOrdersBadge \} from "\.\/orders-badge\.js"/);
  assert.match(nav, /\{ tab: "orders", label: "Orders", badge: "orders" \}/);
  assert.match(nav, /h\(AdminOrdersBadge, \{ key: "badge" \}\)/);
  assert.match(badge, /export function AdminOrdersBadge/);
  assert.match(badge, /gvdg:admin-orders-badge/);
  assert.match(badge, /window\.__gvdgAdminOrdersBadgeCount/);
  assert.match(badge, /setCount\(Number\(window\.__gvdgAdminOrdersBadgeCount \|\| 0\)\)/);
  assert.match(badge, /className: "orders-badge"/);
  assert.match(badge, /if \(count <= 0\) return null/);
  assert.doesNotMatch(badge, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️/);
});

test('admin auth gate is rendered by React from auth state events', () => {
  const html = readFileSync('admin.html', 'utf8');
  const main = readFileSync('src/admin-app/main.js', 'utf8');
  const gate = readFileSync('src/admin-app/auth-gate.js', 'utf8');
  const showPanel = html.match(/function showAdminPanel\(\) \{[\s\S]*?\n        \}/)?.[0];
  const showGate = html.match(/function showGate\(message, withMembersLink\) \{[\s\S]*?\n        \}/)?.[0];

  assert.match(html, /id="adminAuthGateReactApp"/);
  assert.doesNotMatch(html, /id="adminStatus"|id="adminGate"/);
  assert.match(html, /function setAdminAuthGateState\(state\) \{[\s\S]*window\.__gvdgAdminAuthGateState = state;[\s\S]*gvdg:admin-auth-gate/);
  assert.ok(showPanel);
  assert.match(showPanel, /setAdminAuthGateState\(\{ status: 'panel' \}\)/);
  assert.doesNotMatch(showPanel, /adminStatus|adminGate|hidden/);
  assert.ok(showGate);
  assert.match(showGate, /setAdminAuthGateState\(\{ status: 'gate', message, withMembersLink: Boolean\(withMembersLink\) \}\)/);
  assert.doesNotMatch(showGate, /replaceChildren|appendChild|textContent|hidden|adminStatus|adminGate/);
  assert.match(main, /import \{ AdminAuthGate \} from "\.\/auth-gate\.js"/);
  assert.match(main, /const authGateMount = document\.getElementById\("adminAuthGateReactApp"\)/);
  assert.match(main, /createRoot\(authGateMount\)\.render\(h\(AdminAuthGate\)\)/);
  assert.match(gate, /export function AdminAuthGate/);
  assert.match(gate, /data-react-admin-auth-gate/);
  assert.match(gate, /gvdg:admin-auth-gate/);
  assert.match(gate, /window\.__gvdgAdminAuthGateState/);
  assert.match(gate, /setState\(currentState\(\)\)/);
  assert.match(gate, /LockKeyhole/);
  assert.match(gate, /role: "status"/);
  assert.match(gate, /href: "gvdg-members\.html"/);
  assert.match(gate, /if \(state\.status === "panel"\) return null/);
  assert.doesNotMatch(gate, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🔒|🌙|☀️/);
});

test('admin navigation is rendered by React and drives legacy pane switching through events', () => {
  const html = readFileSync('admin.html', 'utf8');
  const main = readFileSync('src/admin-app/main.js', 'utf8');
  const nav = readFileSync('src/admin-app/navigation.js', 'utf8');
  const adminSwitch = html.match(/function adminSwitch\(tab\) \{[\s\S]*?if \(tab === 'data-archive'\) adminLoadDataArchiveDestinations\(\);\n        \}/)?.[0];
  const initAdmin = html.match(/function initAdmin\(\) \{[\s\S]*?\$\('adminCreateForm'\)\.addEventListener/)?.[0];

  assert.match(html, /id="adminNavigationReactApp"/);
  assert.doesNotMatch(html, /<nav class="admin-sidebar"|<div class="admin-mobile-nav" role="group"/);
  assert.doesNotMatch(html, /document\.querySelectorAll\('\.admin-tab'\)|document\.querySelectorAll\('\.admin-mnav'\)/);
  assert.ok(adminSwitch);
  assert.match(adminSwitch, /window\.__gvdgAdminActiveTab = tab/);
  assert.match(adminSwitch, /gvdg:admin-active-tab/);
  assert.match(adminSwitch, /document\.querySelectorAll\('\.admin-pane'\)/);
  assert.doesNotMatch(adminSwitch, /\.admin-tab|\.admin-mnav/);
  assert.ok(initAdmin);
  assert.match(initAdmin, /window\.addEventListener\('gvdg:admin-tab-request'/);
  assert.match(initAdmin, /adminSwitch\(tab\)/);
  assert.match(main, /import \{ AdminNavigation \} from "\.\/navigation\.js"/);
  assert.match(main, /const navigationMount = document\.getElementById\("adminNavigationReactApp"\)/);
  assert.match(main, /createRoot\(navigationMount\)\.render\(h\(AdminNavigation\)\)/);
  assert.match(nav, /export const ADMIN_NAV_GROUPS/);
  assert.match(nav, /export function AdminNavigation/);
  assert.match(nav, /className: "admin-mobile-nav"/);
  assert.match(nav, /className: "admin-sidebar"/);
  assert.match(nav, /aria-current/);
  assert.match(nav, /gvdg:admin-tab-request/);
  assert.match(nav, /gvdg:admin-active-tab/);
  assert.match(nav, /window\.__gvdgAdminActiveTab/);
  assert.match(nav, /setActiveTab\(initialTab\(\)\)/);
  assert.match(nav, /value: selectValue\(group\)/);
  assert.doesNotMatch(nav, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🔒|🌙|☀️/);
});

test('admin message surface is rendered by React from adminMsg events', () => {
  const html = readFileSync('admin.html', 'utf8');
  const main = readFileSync('src/admin-app/main.js', 'utf8');
  const message = readFileSync('src/admin-app/message.js', 'utf8');
  const adminMsg = html.match(/function adminMsg\(text, ok\) \{[\s\S]*?\n        \}/)?.[0];

  assert.match(html, /id="adminMessageReactApp"/);
  assert.doesNotMatch(html, /id="adminMsg"/);
  assert.match(html, /\.admin-msg\.err \{ color: var\(--over\); \}/);
  assert.match(html, /function setAdminMessageState\(state\) \{[\s\S]*window\.__gvdgAdminMessageState = state;[\s\S]*gvdg:admin-message/);
  assert.ok(adminMsg);
  assert.match(adminMsg, /const message = text \|\| ''/);
  assert.match(adminMsg, /setAdminMessageState\(\{ text: message, ok: message \? ok === true : null \}\)/);
  assert.doesNotMatch(adminMsg, /textContent|className|getElementById|\$\('adminMsg'\)/);
  assert.match(main, /import \{ AdminMessage \} from "\.\/message\.js"/);
  assert.match(main, /const messageMount = document\.getElementById\("adminMessageReactApp"\)/);
  assert.match(main, /createRoot\(messageMount\)\.render\(h\(AdminMessage\)\)/);
  assert.match(message, /export function AdminMessage/);
  assert.match(message, /data-react-admin-message/);
  assert.match(message, /gvdg:admin-message/);
  assert.match(message, /window\.__gvdgAdminMessageState/);
  assert.match(message, /setMessage\(normalizeMessage\(currentMessage\(\)\)\)/);
  assert.match(message, /role = hasText \? \(message\.ok \? "status" : "alert"\) : undefined/);
  assert.match(message, /className: `admin-msg\$\{statusClass\}`/);
  assert.doesNotMatch(message, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🔒|🌙|☀️/);
});

test('admin events list is rendered by React from adminLoadEvents state', () => {
  const html = readFileSync('admin.html', 'utf8');
  const main = readFileSync('src/admin-app/main.js', 'utf8');
  const eventsList = readFileSync('src/admin-app/events-list.js', 'utf8');
  const adminLoadEvents = html.match(/async function adminLoadEvents\(\) \{[\s\S]*?\n        \}/)?.[0];
  const initAdmin = html.match(/function initAdmin\(\) \{[\s\S]*?\$\('adminCreateForm'\)\.addEventListener/)?.[0];

  assert.match(html, /id="adminEventsListReactApp"/);
  assert.doesNotMatch(html, /id="adminEventsList"/);
  assert.match(html, /function setAdminEventsListState\(state\) \{[\s\S]*window\.__gvdgAdminEventsListState = state;[\s\S]*gvdg:admin-events-list/);
  assert.ok(adminLoadEvents);
  assert.match(adminLoadEvents, /setAdminEventsListState\(\{ status: 'loading', events: \[\] \}\)/);
  assert.match(adminLoadEvents, /setAdminEventsListState\(\{ status: 'ready', events \}\)/);
  assert.doesNotMatch(adminLoadEvents, /adminEventsList|textContent|appendChild|document\.createElement|elx\('div', 'admin-evrow'\)|addEventListener/);
  assert.ok(initAdmin);
  assert.match(initAdmin, /gvdg:admin-event-edit-request/);
  assert.match(initAdmin, /aeEditEvent\(ev\)/);
  assert.match(initAdmin, /gvdg:admin-event-status-request/);
  assert.match(initAdmin, /adminApi\('\/admin\/events\/' \+ ev\.id, \{ method: 'PATCH', body: \{ status \} \}\)/);
  assert.match(initAdmin, /gvdg:admin-event-delete-request/);
  assert.match(initAdmin, /adminApi\('\/admin\/events\/' \+ ev\.id, \{ method: 'DELETE' \}\)/);
  assert.match(initAdmin, /if \(r\.ok\) adminLoadEvents\(\)/);
  assert.match(main, /import \{ AdminEventsList \} from "\.\/events-list\.js"/);
  assert.match(main, /const eventsListMount = document\.getElementById\("adminEventsListReactApp"\)/);
  assert.match(main, /createRoot\(eventsListMount\)\.render\(h\(AdminEventsList\)\)/);
  assert.match(eventsList, /export function AdminEventsList/);
  assert.match(eventsList, /data-react-admin-events-list/);
  assert.match(eventsList, /gvdg:admin-events-list/);
  assert.match(eventsList, /gvdg:admin-event-edit-request/);
  assert.match(eventsList, /gvdg:admin-event-status-request/);
  assert.match(eventsList, /gvdg:admin-event-delete-request/);
  assert.match(eventsList, /window\.__gvdgAdminEventsListState/);
  assert.match(eventsList, /setState\(normalizeState\(currentState\(\)\)\)/);
  assert.match(eventsList, /EVENT_STATUSES = \["scheduled", "live", "final", "cancelled"\]/);
  assert.match(eventsList, /className: "admin-evrow"/);
  assert.match(eventsList, /className: `admin-badge \$\{event\.status\}`/);
  assert.match(eventsList, /role: "status"/);
  assert.doesNotMatch(eventsList, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🔒|🌙|☀️/);
});

test('admin courses list is rendered by React while legacy code keeps course selects populated', () => {
  const html = readFileSync('admin.html', 'utf8');
  const main = readFileSync('src/admin-app/main.js', 'utf8');
  const coursesList = readFileSync('src/admin-app/courses-list.js', 'utf8');
  const adminLoadCourses = html.match(/async function adminLoadCourses\(\) \{[\s\S]*?\n        \}/)?.[0];

  assert.match(html, /id="adminCoursesListReactApp"/);
  assert.doesNotMatch(html, /id="adminCoursesList"/);
  assert.match(html, /function setAdminCoursesListState\(state\) \{[\s\S]*window\.__gvdgAdminCoursesListState = state;[\s\S]*gvdg:admin-courses-list/);
  assert.ok(adminLoadCourses);
  assert.match(adminLoadCourses, /adminCoursesCache = courses/);
  assert.match(adminLoadCourses, /const sel = \$\('aeCourse'\); sel\.length = 1/);
  assert.match(adminLoadCourses, /const lsel = \$\('alCourse'\); lsel\.length = 1/);
  assert.match(adminLoadCourses, /document\.createElement\('option'\)/);
  assert.match(adminLoadCourses, /setAdminCoursesListState\(\{ courses \}\)/);
  assert.doesNotMatch(adminLoadCourses, /adminCoursesList|list\.textContent|list\.appendChild|elx\('div', 'admin-cand'/);
  assert.match(main, /import \{ AdminCoursesList \} from "\.\/courses-list\.js"/);
  assert.match(main, /const coursesListMount = document\.getElementById\("adminCoursesListReactApp"\)/);
  assert.match(main, /createRoot\(coursesListMount\)\.render\(h\(AdminCoursesList\)\)/);
  assert.match(coursesList, /export function AdminCoursesList/);
  assert.match(coursesList, /data-react-admin-courses-list/);
  assert.match(coursesList, /gvdg:admin-courses-list/);
  assert.match(coursesList, /window\.__gvdgAdminCoursesListState/);
  assert.match(coursesList, /setState\(normalizeState\(currentState\(\)\)\)/);
  assert.match(coursesList, /className: "admin-cand"/);
  assert.doesNotMatch(coursesList, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🔒|🌙|☀️/);
});
