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

test('home React bundle owns the course modal instead of inline DOM injection', () => {
  const html = readFileSync('index.html', 'utf8');
  const main = readFileSync('src/home-app/main.js', 'utf8');
  const courseModal = readFileSync('src/home-app/course-modal.js', 'utf8');

  assert.match(html, /id="homeReactCourseModalApp"/);
  assert.doesNotMatch(html, /insertAdjacentHTML\('beforeend',mh\)|modalCourseName|modalUdisc|modalDirections|modalYoutube|id="courseModal"/);
  assert.match(main, /createRoot\(courseModalMount\)\.render\(h\(CourseModal\)\)/);
  assert.match(courseModal, /export function CourseModal/);
  assert.match(courseModal, /data-react-course-modal/);
  assert.match(courseModal, /role: "dialog"/);
  assert.match(courseModal, /aria-disabled/);
  assert.match(courseModal, /safeExternalUrl/);
  assert.match(courseModal, /MapPin/);
  assert.match(courseModal, /Navigation/);
  assert.doesNotMatch(courseModal, /innerHTML|insertAdjacentHTML|document\.createElement|replaceChildren|modalCourseName|modalUdisc|modalDirections|modalYoutube/);
  assert.doesNotMatch(courseModal, /📍|▶|→/);
});

test('home React bundle owns theme and back-to-top controls', () => {
  const html = readFileSync('index.html', 'utf8');
  const main = readFileSync('src/home-app/main.js', 'utf8');
  const controls = readFileSync('src/home-app/page-controls.js', 'utf8');

  assert.match(html, /id="homeReactThemeToggleApp"/);
  assert.match(html, /id="homeReactBackToTopApp"/);
  assert.doesNotMatch(html, /class="theme-icon"|id="backToTop"|themeIcon\.textContent|getElementById\('backToTop'\)/);
  assert.match(main, /createRoot\(themeToggleMount\)\.render\(h\(HomeThemeToggle\)\)/);
  assert.match(main, /createRoot\(backToTopMount\)\.render\(h\(HomeBackToTop\)\)/);
  assert.match(controls, /export function HomeThemeToggle/);
  assert.match(controls, /export function HomeBackToTop/);
  assert.match(controls, /aria-pressed/);
  assert.match(controls, /localStorage\.setItem\("theme", theme\)/);
  assert.match(controls, /window\.scrollTo\(\{ top: 0, behavior: "smooth" \}\)/);
  assert.match(controls, /MoonStar/);
  assert.match(controls, /Sun/);
  assert.match(controls, /ArrowUp/);
  assert.doesNotMatch(controls, /innerHTML|insertAdjacentHTML|document\.createElement|replaceChildren|themeIcon|backToTop|☀️|🌙|↑/);
});
