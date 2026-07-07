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
  const html = readFileSync('events.html', 'utf8');
  const source = renderPageSource();
  const app = readFileSync('src/public-app/events-hub-app.js', 'utf8');
  assert.ok(html.indexOf('id="liveNowSection"') < html.indexOf('id="calendarEvents"'), 'Live Now mount should remain above the schedule feed mount');
  assert.match(source, /publishHub\(\{/);
  assert.match(source, /live: live\.map\(eventHubItem\)/);
  assert.match(source, /feedEvents: feedEvents\.map\(feedHubItem\)/);
  assert.match(app, /export function EventsLiveNowApp/);
  assert.match(app, /export function EventsScheduleFeedApp/);
  assert.match(app, /Live Now/);
  assert.doesNotMatch(source, /appendChild\(section\('Live Now'|appendChild\(feedList\(feedEvents\)|calendarEl\.appendChild|hubEl\.appendChild/);
});

test('public Events page hides past events behind previous results', () => {
  const source = readFileSync('events.html', 'utf8');
  const app = readFileSync('src/public-app/events-previous-results-app.js', 'utf8');
  // Only current/upcoming render in the main flow; previous results stay collapsed on the same page.
  assert.match(source, /function splitFeedByDate\(items\)/);
  assert.match(source, /function isArchivedClubEvent\(raw\)/);
  assert.match(source, /function publishPreviousResults\(results\)/);
  assert.match(source, /window\.dispatchEvent\(new CustomEvent\('gvdg:events-previous-results'/);
  assert.doesNotMatch(source, /function renderPreviousResults\(results\)/);
  assert.doesNotMatch(source, /function previousResultCard\(item\)/);
  assert.match(app, /See previous results/);
  assert.match(app, /Hide previous results/);
  assert.match(app, /previous-results-toggle/);
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
  const app = readFileSync('src/public-app/events-previous-results-app.js', 'utf8');
  assert.match(app, /const PREVIOUS_RESULTS_INITIAL = 3/);
  assert.match(app, /const PREVIOUS_RESULTS_PAGE_SIZE = 12/);
  assert.match(app, /Load more/);
  assert.match(app, /Show less/);
  assert.match(app, /setVisible\(PREVIOUS_RESULTS_INITIAL\)/);
  assert.match(source, /previousResultTime\(b\) - previousResultTime\(a\)/);
});

test('public Events club content publishes fundraisers and meetings to React', () => {
  const source = readFileSync('events.html', 'utf8');
  const app = readFileSync('src/public-app/events-club-content-app.js', 'utf8');

  assert.match(source, /async function loadFundraisers\(\)/);
  assert.match(source, /window\.__gvdgEventsFundraisers = active/);
  assert.match(source, /new CustomEvent\('gvdg:events-fundraisers'/);
  assert.match(source, /async function loadMeetings\(\)/);
  assert.match(source, /window\.__gvdgEventsMeetings = Array\.isArray\(items\) \? items : \[\]/);
  assert.match(source, /new CustomEvent\('gvdg:events-meetings'/);
  assert.doesNotMatch(source, /function safeMd|function appendInline|function shareRow/);
  assert.doesNotMatch(source, /fundraisersEl\.appendChild|meetingsEl\.appendChild|💚 Donate/);
  assert.match(app, /export function EventsFundraisersApp/);
  assert.match(app, /export function EventsMeetingsApp/);
  assert.match(app, /data-react-events-fundraisers/);
  assert.match(app, /data-react-events-meetings/);
  assert.match(app, /MarkdownBody/);
  assert.match(app, /ShareRow/);
});

test('public Events hub schedule and club feed publish to React', () => {
  const source = readFileSync('events.html', 'utf8');
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const app = readFileSync('src/public-app/events-hub-app.js', 'utf8');

  assert.match(source, /function publishHub\(hub\)/);
  assert.match(source, /new CustomEvent\('gvdg:events-hub'/);
  assert.match(source, /function eventHubItem\(raw\)/);
  assert.match(source, /function feedHubItem\(item\)/);
  assert.match(source, /hasMainContent/);
  assert.doesNotMatch(source, /function groupHeading|function feedList|function eventCard|function section/);
  assert.doesNotMatch(source, /liveNowEl\.replaceChildren|calendarEl\.replaceChildren|hubEl\.replaceChildren|clubEl\.replaceChildren|calendarEl\.appendChild|hubEl\.appendChild|clubEl\.appendChild/);
  assert.match(main, /createRoot\(eventsLiveNowMount\)\.render\(h\(EventsLiveNowApp\)\)/);
  assert.match(main, /createRoot\(eventsScheduleFeedMount\)\.render\(h\(EventsScheduleFeedApp\)\)/);
  assert.match(main, /createRoot\(eventsUpcomingMount\)\.render\(h\(EventsUpcomingApp\)\)/);
  assert.match(main, /createRoot\(eventsClubFeedMount\)\.render\(h\(EventsClubFeedApp\)\)/);
  assert.match(app, /export function EventsLiveNowApp/);
  assert.match(app, /export function EventsScheduleFeedApp/);
  assert.match(app, /export function EventsUpcomingApp/);
  assert.match(app, /export function EventsClubFeedApp/);
  assert.match(app, /data-react-events-hub/);
  assert.match(app, /CalendarDays, ExternalLink, MapPin/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️|📅|📍|🥏/);
});

test('public registration cards post pair label only for doubles config', () => {
  const source = readFileSync('events.html', 'utf8');
  const app = readFileSync('src/public-app/events-registration-app.js', 'utf8');
  const utils = readFileSync('src/members-app/registration-utils.js', 'utf8');

  assert.match(source, /function loadRegistration\(\)/);
  assert.match(source, /new CustomEvent\('gvdg:events-registration-refresh'\)/);
  assert.doesNotMatch(source, /function regCard|function addonCheckbox|function registrationLiveConfig|function clientOwed/);
  assert.doesNotMatch(source, /registerEl\.replaceChildren|registerEl\.appendChild|document\.createElement\('input'\)|pairInput\.setAttribute|alert\(|confirm\(/);
  assert.match(app, /export function EventsRegistrationApp/);
  assert.match(app, /data-react-events-registration/);
  assert.match(app, /data-react-events-registration-card/);
  assert.match(app, /REGISTRATION_REFRESH_EVENT = "gvdg:events-registration-refresh"/);
  assert.match(app, /isDoublesRegistration\(event\)/);
  assert.match(app, /"data-register-pair": "team"/);
  assert.match(app, /body\.team = team\.trim\(\)/);
  assert.match(app, /addons: body\.addons/);
  assert.match(app, /guestReg \? parseObject\(guestReg\.addons\) : \{\}/);
  assert.match(app, /Currently Registering/);
  assert.match(app, /Confirm withdraw/);
  assert.match(utils, /function registrationLiveConfig\(event\)/);
  assert.match(utils, /event\.liveScoringConfig \|\| event\.live_scoring_config/);
  assert.match(utils, /raw == null && event\.play_format === "doubles"/);
});

test('Ryder Cup schedule cards link to the league route', () => {
  const eventsSource = readFileSync('events.html', 'utf8');
  const homeSource = readFileSync('home-feeds.js', 'utf8');
  const ryderSource = readFileSync('src/public-app/ryder-cup-app.js', 'utf8');
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
  assert.doesNotMatch(archiveSource, /<script|location\.replace|document\./);
  assert.doesNotMatch(archiveSource, /const INITIAL_VISIBLE = 3/);
});
