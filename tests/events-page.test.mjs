import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function renderPageSource() {
  const html = readFileSync('events.html', 'utf8');
  const start = html.indexOf('function renderPage(feed, d1events)');
  const end = html.indexOf('async function loadHub');
  assert.notEqual(start, -1, 'renderPage function should exist');
  assert.notEqual(end, -1, 'loadHub should follow renderPage');
  return html.slice(start, end);
}

test('public Events page pins Live Now to the top section, above the schedule feed', () => {
  const source = renderPageSource();
  const liveIndex = source.indexOf("liveNowEl.appendChild(section('Live Now', live, { live: true }))");
  const feedIndex = source.indexOf('calendarEl.appendChild(feedList(feedEvents))');
  assert.notEqual(liveIndex, -1, 'Live Now should render into the dedicated top liveNow section');
  assert.notEqual(feedIndex, -1, 'schedule feed should still render inside the Events group');
  assert.ok(liveIndex < feedIndex, 'Live Now should be rendered before the schedule feed');
  assert.equal(source.includes("calendarEl.appendChild(section('Live Now'"), false, 'Live Now should no longer render inside the calendar group');
  assert.equal(source.includes("hubEl.appendChild(section('Live Now'"), false, 'Live Now should not be rendered below the schedule feed');
});

test('public Events page hides past events behind previous results', () => {
  const source = readFileSync('events.html', 'utf8');
  // Only current/upcoming render in the main flow; previous results stay collapsed on the same page.
  assert.match(source, /function splitFeedByDate\(items\)/);
  assert.match(source, /function isArchivedClubEvent\(raw\)/);
  assert.match(source, /function renderPreviousResults\(results\)/);
  assert.match(source, /See previous results/);
  assert.match(source, /Hide previous results/);
  assert.match(source, /previous-results-toggle/);
  assert.doesNotMatch(source, /function renderPastSection\(past\)/);
  assert.doesNotMatch(source, /past-toggle/);
  assert.doesNotMatch(source, /function renderArchiveCta\(archivedCount\)/);
  assert.doesNotMatch(source, /archive-cta/);
  assert.equal(source.includes("hubEl.appendChild(section('Club-scored — Past'"), false, 'past events should not render inline in the hub');
  // Casual posting/joining moved to the member dashboard — no Events-page signpost remains.
  assert.doesNotMatch(source, /function renderCasualCta\(\)/);
  assert.doesNotMatch(source, /casualCta/);
  assert.doesNotMatch(source, /casual-cta/);
  assert.doesNotMatch(source, /async function loadCasualRounds\(\)/);
});

test('public Events page parses feed dates before archiving rows', () => {
  const source = readFileSync('events.html', 'utf8');
  assert.match(source, /function feedDateInfo\(item\)/);
  assert.match(source, /Number\(item && item\.epoch\)/);
  assert.match(source, /parseHomepageEventDate\(String\(\(item && item\.date\) \|\| ''\)\)/);
  assert.match(source, /function isPastFeedItem\(item\)/);
  assert.match(source, /isPastFeedItem\(item\) \? archived : active/);
});

test('public Events previous results include load more and show less controls', () => {
  const source = readFileSync('events.html', 'utf8');
  assert.match(source, /const PREVIOUS_RESULTS_INITIAL = 3/);
  assert.match(source, /const PREVIOUS_RESULTS_PAGE_SIZE = 12/);
  assert.match(source, /Load more/);
  assert.match(source, /Show less/);
  assert.match(source, /previousResultsVisible = PREVIOUS_RESULTS_INITIAL/);
  assert.match(source, /previousResultTime\(b\) - previousResultTime\(a\)/);
});

test('public registration cards post pair label only for doubles config', () => {
  const source = readFileSync('events.html', 'utf8');
  assert.match(source, /function registrationLiveConfig\(ev\)/);
  assert.match(source, /ev\.liveScoringConfig \|\| ev\.live_scoring_config/);
  assert.match(source, /raw == null && ev\.play_format === 'doubles'/);
  assert.match(source, /if \(isDoublesRegistration\(ev\)\)/);
  assert.match(source, /pairInput\.setAttribute\('data-register-pair', 'team'\)/);
  assert.match(source, /if \(pairInput\) body\.team = pairInput\.value\.trim\(\)/);
  assert.match(source, /Currently Registering/);
  assert.match(source, /registerEl\.hidden = true/);
});

test('Ryder Cup schedule cards link to the league route', () => {
  const eventsSource = readFileSync('events.html', 'utf8');
  const homeSource = readFileSync('home-feeds.js', 'utf8');
  const ryderSource = readFileSync('ryder-cup.html', 'utf8');
  assert.match(eventsSource, /const RYDER_CUP_LEAGUE_ID = '4'/);
  assert.match(eventsSource, /function ryderCupFeedHash\(item\)/);
  assert.match(eventsSource, /function ryderCupEventHash\(ev\)/);
  assert.match(eventsSource, /League \/ Results/);
  assert.match(homeSource, /const RYDER_CUP_LEAGUE_URL = 'events\.html#league\/4'/);
  assert.match(ryderSource, /events\.html#league\/4/);
});

test('archive subdomain redirect is not part of the Events page flow', () => {
  const eventsSource = readFileSync('events.html', 'utf8');
  const archiveSource = readFileSync('archive.html', 'utf8');
  const indexSource = readFileSync('index.html', 'utf8');
  assert.doesNotMatch(eventsSource, /ARCHIVE_BASE_URL/);
  assert.doesNotMatch(eventsSource, /archive\.html/);
  assert.doesNotMatch(indexSource, /archive\.gvdgclub\.com/);
  assert.match(archiveSource, /events\.html#previousResultsSection/);
  assert.doesNotMatch(archiveSource, /const INITIAL_VISIBLE = 3/);
});
