import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function renderPageSource() {
  const html = readFileSync('events.html', 'utf8');
  const start = html.indexOf('function renderPage(feed, d1events)');
  const end = html.indexOf('async function loadMoreClubEvents()');
  assert.notEqual(start, -1, 'renderPage function should exist');
  assert.notEqual(end, -1, 'loadMoreClubEvents should follow renderPage');
  return html.slice(start, end);
}

test('public Events page renders Live Now before the schedule feed', () => {
  const source = renderPageSource();
  const liveIndex = source.indexOf("calendarEl.appendChild(section('Live Now', live, { live: true }))");
  const feedIndex = source.indexOf('calendarEl.appendChild(feedList(feedEvents))');
  assert.notEqual(liveIndex, -1, 'Live Now should render inside the Events group');
  assert.notEqual(feedIndex, -1, 'schedule feed should still render inside the Events group');
  assert.ok(liveIndex < feedIndex, 'Live Now should appear above scheduled feed cards');
  assert.equal(source.includes("hubEl.appendChild(section('Live Now'"), false, 'Live Now should not be rendered below the schedule feed');
});

test('public registration cards post pair label only for doubles config', () => {
  const source = readFileSync('events.html', 'utf8');
  assert.match(source, /function registrationLiveConfig\(ev\)/);
  assert.match(source, /ev\.liveScoringConfig \|\| ev\.live_scoring_config/);
  assert.match(source, /raw == null && ev\.play_format === 'doubles'/);
  assert.match(source, /if \(isDoublesRegistration\(ev\)\)/);
  assert.match(source, /pairInput\.setAttribute\('data-register-pair', 'team'\)/);
  assert.match(source, /if \(pairInput\) body\.team = pairInput\.value\.trim\(\)/);
});
