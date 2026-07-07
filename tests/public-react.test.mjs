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
  assert.match(sw, /const CACHE = "gvdg-club-v58"/);
  assert.match(sw, /"public-app\/public-app\.js"/);
  assert.doesNotMatch(sw, /"nav\.js"/);
  assert.doesNotMatch(chrome, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️/);
});

test('Events previous results panel is rendered by the public React bundle', () => {
  const html = readFileSync('events.html', 'utf8');
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const app = readFileSync('src/public-app/events-previous-results-app.js', 'utf8');

  assert.match(html, /id="previousResultsSection"/);
  assert.match(html, /window\.dispatchEvent\(new CustomEvent\('gvdg:events-previous-results'/);
  assert.doesNotMatch(html, /function renderPreviousResults|function previousResultCard|previousResultsExpanded|previousResultsVisible/);
  assert.match(main, /createRoot\(eventsPreviousResultsMount\)\.render\(h\(EventsPreviousResultsApp\)\)/);
  assert.match(app, /export function EventsPreviousResultsApp/);
  assert.match(app, /data-react-events-previous-results/);
  assert.match(app, /PREVIOUS_RESULTS_INITIAL = 3/);
  assert.match(app, /PREVIOUS_RESULTS_PAGE_SIZE = 12/);
  assert.match(app, /CalendarDays, ChevronDown, ChevronUp, ExternalLink, Info/);
  assert.match(app, /aria-expanded/);
  assert.match(app, /safeHref/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️|📅|📍/);
});

test('Events hub schedule and club feed are rendered by the public React bundle', () => {
  const html = readFileSync('events.html', 'utf8');
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const app = readFileSync('src/public-app/events-hub-app.js', 'utf8');

  assert.match(html, /id="liveNowSection"/);
  assert.match(html, /id="calendarEvents"/);
  assert.match(html, /id="hub"/);
  assert.match(html, /id="clubEventsSection"/);
  assert.match(html, /new CustomEvent\('gvdg:events-hub'/);
  assert.doesNotMatch(html, /function groupHeading|function feedList|function eventCard|function section|liveNowEl\.replaceChildren|calendarEl\.appendChild|hubEl\.appendChild|clubEl\.appendChild/);
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
  assert.match(app, /safeHref/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️|📅|📍|🥏/);
});

test('Events status messages are rendered by the public React bundle', () => {
  const html = readFileSync('events.html', 'utf8');
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const app = readFileSync('src/public-app/events-status-app.js', 'utf8');

  assert.match(html, /id="status"/);
  assert.match(html, /new CustomEvent\('gvdg:events-status'/);
  assert.match(html, /function publishStatus\(status\)/);
  assert.match(html, /showStatus\(message, isError, onRetry\)/);
  assert.doesNotMatch(html, /statusEl\.className|statusEl\.replaceChildren|statusEl\.appendChild|document\.createElement|empty-icon', '🥏'/);
  assert.match(main, /const eventsStatusMount = document\.getElementById\("status"\)/);
  assert.match(main, /createRoot\(eventsStatusMount\)\.render\(h\(EventsStatusApp\)\)/);
  assert.match(app, /export function EventsStatusApp/);
  assert.match(app, /data-react-events-status/);
  assert.match(app, /CircleAlert, Disc3, RefreshCcw/);
  assert.match(app, /role = isError \? "alert" : "status"/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|dangerouslySetInnerHTML|☰|✕|🌙|☀️|📅|📍|🥏/);
});

test('Events leagues list is rendered by the public React bundle', () => {
  const html = readFileSync('events.html', 'utf8');
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const app = readFileSync('src/public-app/events-leagues-app.js', 'utf8');

  assert.match(html, /id="leaguesSection"/);
  assert.match(html, /new CustomEvent\('gvdg:events-leagues'/);
  assert.match(html, /publishLeagues\(leagues\)/);
  assert.doesNotMatch(html, /leaguesEl\.replaceChildren|leaguesEl\.appendChild/);
  assert.match(main, /import \{ EventsLeagueDetailApp, EventsLeaguesApp \} from "\.\/events-leagues-app\.js"/);
  assert.match(main, /const eventsLeaguesMount = document\.getElementById\("leaguesSection"\)/);
  assert.match(main, /createRoot\(eventsLeaguesMount\)\.render\(h\(EventsLeaguesApp\)\)/);
  assert.match(app, /export function EventsLeaguesApp/);
  assert.match(app, /data-react-events-leagues/);
  assert.match(app, /className: "league-card"/);
  assert.match(app, /disabled/);
  assert.match(app, /window\.location\.hash = `#league\/\$\{encodeURIComponent\(league\.id\)\}`/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️|📅|📍|🥏/);
});

test('Events league detail is rendered by the public React bundle', () => {
  const html = readFileSync('events.html', 'utf8');
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const app = readFileSync('src/public-app/events-leagues-app.js', 'utf8');

  assert.match(html, /id="leagueDetailSection"/);
  assert.match(html, /new CustomEvent\('gvdg:events-league-detail'/);
  assert.match(html, /publishLeagueDetail\(data\)/);
  assert.match(html, /setView\('league-detail'\)/);
  assert.doesNotMatch(html, /function renderLeague\(data\)|function scrollTable\(table\)/);
  assert.match(main, /const eventsLeagueDetailMount = document\.getElementById\("leagueDetailSection"\)/);
  assert.match(main, /createRoot\(eventsLeagueDetailMount\)\.render\(h\(EventsLeagueDetailApp\)\)/);
  assert.match(app, /export function EventsLeagueDetailApp/);
  assert.match(app, /data-react-events-league-detail/);
  assert.match(app, /function TeamStandingsTable/);
  assert.match(app, /function PlayerStandingsTable/);
  assert.match(app, /function LeagueRounds/);
  assert.match(app, /className: "lb-wrap"/);
  assert.match(app, /window\.location\.hash = `#event\/\$\{encodeURIComponent\(id\)\}`/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️|📅|📍|🥏|●/);
});

test('Events event detail is rendered by the public React bundle', () => {
  const html = readFileSync('events.html', 'utf8');
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const app = readFileSync('src/public-app/events-detail-app.js', 'utf8');

  assert.match(html, /id="detail"/);
  assert.match(html, /new CustomEvent\('gvdg:events-event-detail'/);
  assert.match(html, /publishEventDetail\(activeEventDetail\)/);
  assert.match(html, /setView\('detail'\)/);
  assert.match(html, /mountLiveLeaderboard\(seq, ev\.id\)/);
  assert.doesNotMatch(html, /udisc-export\.js|window\.UDiscExport/);
  assert.doesNotMatch(html, /function renderDetail|function renderFinalResults|function renderEventExtras|function renderTeeSigns|function renderStandings|detailEl\.appendChild|detailEl\.replaceChildren/);
  assert.match(main, /import \{ EventsEventDetailApp \} from "\.\/events-detail-app\.js"/);
  assert.match(main, /const eventsEventDetailMount = document\.getElementById\("detail"\)/);
  assert.match(main, /createRoot\(eventsEventDetailMount\)\.render\(h\(EventsEventDetailApp\)\)/);
  assert.match(app, /export function EventsEventDetailApp/);
  assert.match(app, /data-react-events-event-detail/);
  assert.match(app, /data-react-events-final-results/);
  assert.match(app, /function LivePanel/);
  assert.match(app, /function LiveStandings/);
  assert.match(app, /live-matchplay/);
  assert.match(app, /function FinalResults/);
  assert.match(app, /function EventExtras/);
  assert.match(app, /function TeeSigns/);
  assert.match(app, /function PlayerRoster/);
  assert.match(app, /WeatherStrip/);
  assert.match(app, /teeSignModel/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|document\.createElement|querySelector|classList|textContent\s*=|dangerouslySetInnerHTML|☰|✕|🌙|☀️|📅|📍|🥏|🏆|🪧|✏️|⚑/);
});

test('Events fundraisers and meetings are rendered by the public React bundle', () => {
  const html = readFileSync('events.html', 'utf8');
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const app = readFileSync('src/public-app/events-club-content-app.js', 'utf8');

  assert.match(html, /id="fundraisersSection"/);
  assert.match(html, /id="meetingsSection"/);
  assert.match(html, /new CustomEvent\('gvdg:events-fundraisers'/);
  assert.match(html, /new CustomEvent\('gvdg:events-meetings'/);
  assert.doesNotMatch(html, /function safeMd|function appendInline|function shareRow|fundraisersEl\.appendChild|meetingsEl\.appendChild|💚 Donate/);
  assert.match(main, /createRoot\(eventsFundraisersMount\)\.render\(h\(EventsFundraisersApp\)\)/);
  assert.match(main, /createRoot\(eventsMeetingsMount\)\.render\(h\(EventsMeetingsApp\)\)/);
  assert.match(app, /export function EventsFundraisersApp/);
  assert.match(app, /export function EventsMeetingsApp/);
  assert.match(app, /data-react-events-fundraisers/);
  assert.match(app, /data-react-events-meetings/);
  assert.match(app, /safeExternalUrl/);
  assert.match(app, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(app, /Heart, Mail/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️|💚/);
});

test('Events registration is rendered by the public React bundle', () => {
  const html = readFileSync('events.html', 'utf8');
  const main = readFileSync('src/public-app/main.js', 'utf8');
  const app = readFileSync('src/public-app/events-registration-app.js', 'utf8');

  assert.match(html, /id="registerSection"/);
  assert.match(html, /new CustomEvent\('gvdg:events-registration-refresh'/);
  assert.doesNotMatch(html, /function regCard|function addonCheckbox|function registrationLiveConfig|registerEl\.appendChild|registerEl\.replaceChildren|alert\(|confirm\(/);
  assert.match(main, /createRoot\(eventsRegistrationMount\)\.render\(h\(EventsRegistrationApp\)\)/);
  assert.match(app, /export function EventsRegistrationApp/);
  assert.match(app, /data-react-events-registration/);
  assert.match(app, /data-react-events-registration-card/);
  assert.match(app, /\/registration\/open/);
  assert.match(app, /\/my-registrations/);
  assert.match(app, /`\/events\/\$\{encodeURIComponent\(event\.id\)\}\/register/);
  assert.match(app, /gvdg_guest_regs/);
  assert.match(app, /Confirm withdraw/);
  assert.match(app, /CalendarDays, CheckCircle2/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|replaceChildren|document\.createElement|querySelector|classList|textContent\s*=|☰|✕|🌙|☀️|📅|📍|✅/);
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
