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

test('member dashboard registration section stays visible for casual-only posts', () => {
  const source = registerLoaderSource();
  assert.match(source, /if \(!events\.length && !casualRequests\.length\)/);
});

test('member dashboard registration loader separates live events first', () => {
  const source = registerLoaderSource();
  assert.match(source, /liveEvents = events\.filter\(\(ev\) => ev\.status === 'live'\)/);
  assert.match(source, /'LIVE NOW'/);
});

test('member dashboard registration cards post pair label only for doubles events', () => {
  const source = readFileSync('gvdg-members.html', 'utf8');
  assert.match(source, /function registrationLiveConfig\(ev\)/);
  assert.match(source, /ev\.liveScoringConfig \|\| ev\.live_scoring_config/);
  assert.match(source, /if \(isDoublesRegistration\(ev\)\)/);
  assert.match(source, /pairInput\.setAttribute\('data-register-pair', 'team'\)/);
  assert.match(source, /if \(pairInput\) body\.team = pairInput\.value\.trim\(\)/);
});
