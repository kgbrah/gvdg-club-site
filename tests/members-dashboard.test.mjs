import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function registerLoaderSource() {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const start = html.indexOf('async function loadRegister()');
  const end = html.indexOf('function dollars(c)');
  assert.notEqual(start, -1, 'loadRegister function should exist');
  assert.notEqual(end, -1, 'dollars helper should follow loadRegister');
  return html.slice(start, end);
}

test('member dashboard registration loader includes casual round posts', () => {
  const source = registerLoaderSource();
  assert.match(source, /api\('\/casual-rounds'/);
  assert.match(source, /casualRequests/);
  assert.match(source, /casualRegisterCard/);
});

test('member dashboard registration section is always shown for logged-in members (casual posting available)', () => {
  const source = registerLoaderSource();
  // No "hide when there are no events/posts" early return — the panel must stay so the post form is reachable.
  assert.doesNotMatch(source, /if \(!events\.length && !casualRequests\.length\)/);
  assert.match(source, /casualPostForm\(\)/); // the post form is always appended
  assert.match(source, /wrap\.style\.display = ''/); // and the panel is revealed unconditionally
});

test('member dashboard registration loader surfaces live events and lists every registered event', () => {
  const source = registerLoaderSource();
  assert.match(source, /liveToJoin = openToJoin\.filter\(\(ev\) => ev\.status === 'live'\)/);
  assert.match(source, /'Live now'/);
  assert.match(source, /'My events'/); // ALL registrations render, not just the open ones
  assert.match(source, /regAsEvent/); // registrations no longer in the open list still render
  assert.match(source, /api\('\/my-registrations'/);
});

test('member dashboard can post a casual round and jump to a live scorecard', () => {
  const source = readFileSync('gvdg-members.html', 'utf8');
  assert.match(source, /async function casualPostForm\(\)/);
  assert.match(source, /api\('\/casual-rounds', \{ method: 'POST'/);
  assert.match(source, /score\.html\?event=/); // live registered events link to their scorecard
});

test('member dashboard registration cards post pair label only for doubles events', () => {
  const source = readFileSync('gvdg-members.html', 'utf8');
  assert.match(source, /function registrationLiveConfig\(ev\)/);
  assert.match(source, /ev\.liveScoringConfig \|\| ev\.live_scoring_config/);
  assert.match(source, /if \(isDoublesRegistration\(ev\)\)/);
  assert.match(source, /pairInput\.setAttribute\('data-register-pair', 'team'\)/);
  assert.match(source, /if \(pairInput\) body\.team = pairInput\.value\.trim\(\)/);
});

test('member dashboard mounts the React shell as a fallback-safe island', () => {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const app = readFileSync('src/members-app/main.js', 'utf8');
  assert.match(html, /id="membersReactDashboardShell"/);
  assert.match(html, /<script type="module" src="members-app\/members-app\.js"><\/script>/);
  assert.match(html, /window\.addEventListener\('gvdg:select-dashboard-tab'/);
  assert.match(html, /emitDashboardState\('gvdg:dashboard-tab-selected'\)/);
  assert.match(app, /createRoot\(mount\)\.render/);
  assert.match(app, /gvdg:select-dashboard-tab/);
  assert.match(app, /gvdg:dashboard-tab-selected/);
});
