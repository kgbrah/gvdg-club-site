import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('homepage feeds are rendered by the home React bundle', () => {
  const html = readFileSync('index.html', 'utf8');
  const packageJson = readFileSync('package.json', 'utf8');
  const legacyFeed = readFileSync('home-feeds.js', 'utf8');

  assert.match(packageJson, /"build:home": "vite build --config vite\.home\.config\.mjs"/);
  assert.match(packageJson, /"build": "npm run build:home && npm run build:score && npm run build:members"/);
  assert.ok(existsSync('vite.home.config.mjs'));
  assert.match(html, /id="homeReactEventsApp"/);
  assert.match(html, /id="homeReactTournamentsApp"/);
  assert.match(html, /<script type="module" src="home-app\/home-app\.js"><\/script>/);
  assert.doesNotMatch(html, /<script type="module" src="home-feeds\.js"><\/script>/);
  assert.doesNotMatch(legacyFeed, /document\.createElement|getElementById|replaceChildren|addEventListener/);
});

test('home React feed components own events and tournaments without DOM fallbacks', () => {
  const main = readFileSync('src/home-app/main.js', 'utf8');
  const panels = readFileSync('src/home-app/feed-panels.js', 'utf8');

  assert.match(main, /createRoot\(eventsMount\)\.render\(h\(HomeEventsFeed\)\)/);
  assert.match(main, /createRoot\(tournamentsMount\)\.render\(h\(AreaTournamentsFeed\)\)/);
  assert.match(panels, /export function HomeEventsFeed/);
  assert.match(panels, /export function AreaTournamentsFeed/);
  assert.match(panels, /data-react-home-events/);
  assert.match(panels, /data-react-home-tournaments/);
  assert.match(panels, /safeExternalUrl/);
  assert.match(panels, /ChevronDown/);
  assert.match(panels, /MapPin/);
  assert.doesNotMatch(panels, /document\.|innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement/);
  assert.doesNotMatch(panels, /📍|🏆|🥏/);
});
