import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { eventFromRegistration, pickUpNext } from '../src/members-app/registration-utils.js';
import { formatEventDay } from '../src/members-app/format.js';

test('member dashboard React registration panel includes casual round posts', () => {
  const panel = readFileSync('src/members-app/registration-panel.js', 'utf8');
  const casual = readFileSync('src/members-app/registration-casual.js', 'utf8');
  assert.match(panel, /requestJson\("\/casual-rounds"/);
  assert.match(panel, /casualRequests/);
  assert.match(panel, /export function RegistrationProvider/);
  assert.match(casual, /CasualRoundCard/);
  assert.match(casual, /h\("details", \{ className: "dash-collapse"/);
  assert.match(casual, /Casual rounds/);
});

test('member dashboard React board panel owns board loading and posting', () => {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const dashboardApp = readFileSync('src/members-app/dashboard-app.js', 'utf8');
  const panel = readFileSync('src/members-app/board-panel.js', 'utf8');
  const markdown = readFileSync('src/members-app/board-markdown.js', 'utf8');
  assert.match(html, /id="membersReactDashboardApp"/);
  assert.match(dashboardApp, /id: "membersReactBoardPanel"/);
  assert.match(html, /#membersReactBoardPanel:not\(:empty\)/);
  assert.doesNotMatch(html, /id="legacyBoardPanel"/);
  assert.doesNotMatch(html, /reactBoardReady/);
  assert.doesNotMatch(html, /async function loadBoard\(/);
  assert.match(panel, /requestJson\("\/board"/);
  assert.match(panel, /request\("\/board", \{ method: "POST"/);
  assert.match(panel, /data-react-board-panel/);
  assert.match(panel, /MarkdownBlocks/);
  assert.ok(markdown.includes('https?:\\/\\/'));
});

test('member dashboard React tee signs panel owns upload and captured sign display', () => {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const dashboardApp = readFileSync('src/members-app/dashboard-app.js', 'utf8');
  const panel = readFileSync('src/members-app/tee-signs-panel.js', 'utf8');
  const utils = readFileSync('src/members-app/tee-signs-utils.js', 'utf8');
  assert.match(html, /id="membersReactDashboardApp"/);
  assert.match(dashboardApp, /id: "membersReactTeeSignsPanel"/);
  assert.match(html, /#membersReactTeeSignsPanel:not\(:empty\)/);
  assert.doesNotMatch(html, /id="legacyTeeSignsPanel"/);
  assert.doesNotMatch(html, /reactTeeSignsReady/);
  assert.doesNotMatch(html, /async function loadTeeSigns\(/);
  assert.doesNotMatch(html, /async function uploadTeeSign\(/);
  assert.match(panel, /requestJson\("\/my-tee-signs"/);
  assert.match(panel, /request\("\/tee-signs", \{ method: "POST"/);
  assert.match(panel, /\/tee-signs\/\$\{encodeURIComponent\(id\)\}\/image/);
  assert.match(panel, /data-react-tee-signs-panel/);
  assert.match(panel, /data-react-tee-file/);
  assert.match(utils, /resizeImageFile/);
  assert.match(utils, /TS_MAX_DATA_URL/);
});

test('member dashboard React club panel owns directory search, filters, load-more, and minutes', () => {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const app = readFileSync('src/members-app/main.js', 'utf8');
  const dashboardApp = readFileSync('src/members-app/dashboard-app.js', 'utf8');
  const router = readFileSync('src/members-app/dashboard-router.js', 'utf8');
  const clubPanel = readFileSync('src/members-app/club-panel.js', 'utf8');
  const data = readFileSync('src/members-app/club-directory-data.js', 'utf8');
  const directory = readFileSync('src/members-app/club-directory-panel.js', 'utf8');
  const doublesData = readFileSync('src/members-app/doubles-league-data.js', 'utf8');
  const doubles = readFileSync('src/members-app/doubles-league-panel.js', 'utf8');
  const minuteData = readFileSync('src/members-app/meeting-minutes-data.js', 'utf8');
  const minutes = readFileSync('src/members-app/meeting-minutes-panel.js', 'utf8');
  assert.match(html, /id="membersReactDashboardApp"/);
  assert.match(dashboardApp, /id: "membersReactClubPanel"/);
  assert.match(html, /body\[data-member-dashboard-tab="club"\] #membersReactClubPanel:not\(:empty\)/);
  assert.doesNotMatch(router, /querySelector|classList|dtab-off/);
  assert.doesNotMatch(html, /id="legacyClubDirectoryPanel"/);
  assert.doesNotMatch(html, /id="legacyMeetingMinutesPanel"/);
  assert.doesNotMatch(html, /id="doublesLeague"/);
  assert.doesNotMatch(html, /GVDG_CLUB_DIRECTORY_DATA/);
  assert.doesNotMatch(html, /gvdg:club-directory-data-ready/);
  assert.doesNotMatch(html, /initMembersPage/);
  assert.doesNotMatch(html, /initDoublesLeague/);
  assert.doesNotMatch(html, /DOUBLES_DATA_EMBEDDED/);
  assert.doesNotMatch(html, /id="doublesTable"/);
  assert.doesNotMatch(html, /id="seasonSelector"/);
  assert.match(app, /createRoot\(dashboardMount\)\.render\(h\(MemberDashboardApp\)\)/);
  assert.doesNotMatch(app, /createRoot\(clubMount\)\.render/);
  assert.doesNotMatch(app, /members-react-(shell|overview|ratings|registration|board|tee-signs|club)-ready|classList/);
  assert.match(data, /export const CLUB_MEMBERS/);
  assert.match(data, /export const CLUB_YEAR_DATA/);
  assert.match(data, /export const CLUB_DIRECTORY_DATA/);
  assert.match(data, /"lastName": "Faison"/);
  assert.match(clubPanel, /data-react-club-panel/);
  assert.match(clubPanel, /clubDirectoryData/);
  assert.match(clubPanel, /CourseConditionsPanel/);
  assert.match(clubPanel, /DoublesLeaguePanel/);
  const conditions = readFileSync('src/members-app/course-conditions-panel.js', 'utf8');
  assert.match(conditions, /data-react-course-conditions/);
  assert.match(conditions, /\/courses\/\$\{id\}\/conditions/);
  assert.match(conditions, /COURSE_CONDITION_STATUSES/);
  assert.doesNotMatch(conditions, /innerHTML|insertAdjacentHTML/);
  assert.match(directory, /data-react-member-directory/);
  assert.match(directory, /Search members by name or PDGA #/);
  assert.match(directory, /PDGA Members/);
  assert.match(directory, /Show More/);
  assert.match(doublesData, /export const DOUBLES_LEAGUE_DATA/);
  assert.match(doublesData, /"seasonOrder"/);
  assert.match(doublesData, /"Summer 2025"/);
  assert.match(doublesData, /"Juan Martinez"/);
  assert.match(doubles, /data-react-doubles-league/);
  assert.match(doubles, /Doubles League Records/);
  assert.match(doubles, /All-Time Leaders/);
  assert.match(doubles, /Season Results/);
  assert.match(doubles, /Search player name/);
  assert.match(minuteData, /export const MEETING_MINUTES/);
  assert.match(minuteData, /January 12, 2026/);
  assert.match(minuteData, /Future Course Improvements - Ayden/);
  assert.match(minutes, /data-react-meeting-minutes/);
  assert.match(minutes, /MEETING_MINUTES/);
  assert.doesNotMatch(minutes, /readMinutesFromLegacyDom/);
  assert.match(minutes, /Download full minutes/);
});

test('member dashboard mounts a personal season page from existing member APIs', () => {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const dashboardApp = readFileSync('src/members-app/dashboard-app.js', 'utf8');
  const page = readFileSync('src/members-app/season-page.js', 'utf8');
  const model = readFileSync('src/members-app/season-page-model.js', 'utf8');
  assert.match(dashboardApp, /id: "membersReactSeasonPanel"/);
  assert.match(html, /body\[data-member-dashboard-tab="season"\] #mySeason/);
  assert.match(page, /data-react-season-page/);
  assert.match(page, /\/my-results\?all=1/);
  assert.match(model, /export function buildSeasonPage/);
  assert.doesNotMatch(page, /\/admin\//);
  assert.doesNotMatch(page, /createMember|isAdmin/);
});

test('member dashboard React registration section stays available for logged-in members', () => {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const dashboardApp = readFileSync('src/members-app/dashboard-app.js', 'utf8');
  const panel = readFileSync('src/members-app/registration-panel.js', 'utf8');
  const casual = readFileSync('src/members-app/registration-casual.js', 'utf8');
  assert.match(html, /id="membersReactDashboardApp"/);
  assert.match(dashboardApp, /id: "membersReactRegistrationPanel"/);
  assert.match(html, /#membersReactRegistrationPanel:not\(:empty\)/);
  assert.doesNotMatch(html, /id="legacyRegisterTitle"/);
  assert.doesNotMatch(html, /id="registerList"/);
  assert.doesNotMatch(html, /async function loadRegister\(/);
  assert.doesNotMatch(html, /id="clubRegister"[^>]*style="display:\s*none;?"/);
  assert.doesNotMatch(panel, /visibleParent|style\.display|getElementById\("clubRegister"\)/);
  assert.match(casual, /data-react-casual-form/);
});

test('overview dashboard is a compact home and keeps registration on Events', () => {
  const overview = readFileSync('src/members-app/overview-dashboard.js', 'utf8');
  const more = readFileSync('src/members-app/more-page.js', 'utf8');
  const activity = readFileSync('src/members-app/activity-panels.js', 'utf8');
  const shell = readFileSync('src/members-app/dashboard-shell.js', 'utf8');
  const html = readFileSync('gvdg-members.html', 'utf8');
  assert.doesNotMatch(overview, /MemberRegistrationPanel/);
  assert.match(overview, /data-react-home-hero/);
  assert.match(overview, /LiveScoringPanel, \{ token, compact: true/);
  assert.match(overview, /WalletPanel, \{ token, compact: true/);
  assert.match(overview, /selectDashboardTab\("events"\)/);
  assert.match(overview, /EventScheduleFacts/);
  assert.match(overview, /data-react-home-next/);
  assert.match(overview, /pickUpNext\(events, registrations\)/);
  assert.match(overview, /You're registered/);
  assert.doesNotMatch(overview, /Nothing open to register for right now/);
  assert.match(more, /Club directory/);
  assert.match(more, /Message board/);
  assert.match(more, /Tee signs/);
  assert.match(more, /href: "score.html"/);
  assert.match(more, /WalletPanel/);
  assert.match(activity, /href: live \? live.href : "score.html"/);
  assert.match(shell, /label: "Home"/);
  assert.match(shell, /player-app-nav/);
  assert.match(html, /body\[data-member-dashboard-tab="more"\] #playerMore/);
  assert.match(html, /\.dash-collapse-summary \{ cursor: pointer; \}/);
  assert.doesNotMatch(html, /body\[data-member-dashboard-tab="overview"\] #clubRegister/);
  assert.match(html, /body\[data-member-dashboard-tab="events"\] #clubRegister/);
});

test('overview dashboard collapses recent tournaments, casual rounds, and live scoring', () => {
  const pdga = readFileSync('src/members-app/pdga-dashboard.js', 'utf8');
  const casual = readFileSync('src/members-app/registration-casual.js', 'utf8');
  const activity = readFileSync('src/members-app/activity-panels.js', 'utf8');
  assert.match(pdga, /h\("details", \{ className: "dash-collapse", key: "events" \}/);
  assert.match(casual, /h\("details", \{ className: "dash-collapse"/);
  assert.match(activity, /h\("details", \{ className: "club-board react-live-scoring dash-collapse"/);
  assert.doesNotMatch(pdga, /h\("h4", \{ className: "dash-subtitle", key: "title" \}, "Recent Tournaments"\)/);
  assert.doesNotMatch(activity, /h\("h3", \{ className: "my-dashboard-title", key: "title" \}, "Live Scoring"\)/);
  const browserQa = readFileSync("scripts/qa/members-dashboard-browser-qa.mjs", "utf8");
  const stagingQa = readFileSync("scripts/qa/staging-member-dashboard-e2e.mjs", "utf8");
  assert.match(browserQa, /overview: \["#myDashboard"\]/);
  assert.match(stagingQa, /overview: \["#myDashboard"\]/);
  assert.match(browserQa, /async function openCasualRounds/);
  assert.match(stagingQa, /async function openCasualRounds/);
  assert.match(browserQa, /#clubRegister \[data-react-registration-panel="ready"\]/);
  assert.match(stagingQa, /#clubRegister \[data-react-registration-panel="ready"\]/);
});

test('member dashboard React registration panel surfaces live events and lists every registered event', () => {
  const events = readFileSync('src/members-app/registration-events.js', 'utf8');
  assert.match(events, /liveToJoin = openToJoin\.filter\(\(event\) => event\.status === "live"\)/);
  assert.match(events, /"Live now"/);
  assert.match(events, /"My events"/); // ALL registrations render, not just the open ones
  assert.match(events, /eventFromRegistration/); // registrations no longer in the open list still render
  assert.match(events, /EventScheduleFacts/);
  assert.match(readFileSync('src/members-app/registration-panel.js', 'utf8'), /requestJson\("\/my-registrations"/);
});

test('eventFromRegistration copies joined schedule timestamps onto the synth event', () => {
  const event = eventFromRegistration({
    event_id: 9,
    event_name: 'Sunday Dubs',
    event_date: '2026-09-13',
    event_status: 'scheduled',
    event_starts_at: '2026-09-13T17:30:00.000Z',
    event_registration_deadline: '2026-09-13T16:00:00.000Z',
    event_checkin_deadline: '2026-09-13T17:00:00.000Z',
  });
  assert.equal(event.starts_at, '2026-09-13T17:30:00.000Z');
  assert.equal(event.registration_deadline, '2026-09-13T16:00:00.000Z');
  assert.equal(event.checkin_deadline, '2026-09-13T17:00:00.000Z');
  assert.equal(eventFromRegistration({ event_id: 9 }).starts_at, null);
});

test('pickUpNext prefers a registered event over an open Register CTA', () => {
  const open = [{ id: 12, name: 'The boys test', status: 'scheduled' }];
  const mine = [{ event_id: 12, event_name: 'The boys test', event_status: 'scheduled' }];
  const next = pickUpNext(open, mine);
  assert.equal(next.event.name, 'The boys test');
  assert.equal(next.registration.event_id, 12);

  const otherOpen = [{ id: 3, name: 'Some other open round', status: 'scheduled' }, ...open];
  assert.equal(pickUpNext(otherOpen, mine).event.id, 12);
  assert.equal(pickUpNext(open, []).registration, null);
  assert.equal(pickUpNext([], mine).registration.event_id, 12);
});

test('formatEventDay renders club calendar dates in Eastern without a UTC day shift', () => {
  assert.match(formatEventDay('2026-07-04'), /Jul 4/);
  assert.doesNotMatch(formatEventDay('2026-07-04'), /Jul 3/);
  assert.doesNotMatch(formatEventDay('2026-07-04'), /\d:\d\d/);
  assert.match(formatEventDay('2026-07-04T12:00:00.000Z'), /Jul 4/);
});

test('member dashboard can post a casual round and jump to a live scorecard', () => {
  const casual = readFileSync('src/members-app/registration-casual.js', 'utf8');
  const events = readFileSync('src/members-app/registration-events.js', 'utf8');
  assert.match(casual, /function CasualRoundForm/);
  assert.match(casual, /request\("\/casual-rounds", \{/);
  assert.match(events, /score\.html\?event=/); // live registered events link to their scorecard
});

test('member dashboard registration cards post pair label only for doubles events', () => {
  const events = readFileSync('src/members-app/registration-events.js', 'utf8');
  const utils = readFileSync('src/members-app/registration-utils.js', 'utf8');
  assert.match(utils, /function registrationLiveConfig\(event\)/);
  assert.match(utils, /event\.liveScoringConfig \|\| event\.live_scoring_config/);
  assert.match(events, /isDoublesRegistration\(event\)/);
  assert.match(events, /"data-register-pair": "team"/);
  assert.match(events, /body\.team = team\.trim\(\)/);
});

test('more page mounts a player theme builder', () => {
  const more = readFileSync('src/members-app/more-page.js', 'utf8');
  const theme = readFileSync('src/members-app/dashboard-theme.js', 'utf8');
  const html = readFileSync('gvdg-members.html', 'utf8');
  const worker = readFileSync('auth-worker/src/index.ts', 'utf8');
  assert.match(more, /DashboardThemeBuilder/);
  assert.match(theme, /\/me\/dashboard-theme/);
  assert.match(theme, /Apply Theme/);
  assert.match(theme, /"Dashboard theme"/);
  assert.match(theme, /Cloud save failed/);
  assert.match(theme, /editedRef/);
  assert.match(theme, /paletteEditedRef/);
  assert.match(theme, /persistGen/);
  assert.match(theme, /pendingTheme/);
  assert.doesNotMatch(theme, /Aether|AETHER/);
  assert.match(html, /#members\.player-theme-active/);
  assert.match(html, /body\.player-theme-page::before/);
  assert.match(html, /body\.player-theme-active/);
  assert.match(html, /body\.player-theme-page footer \{ color: var\(--player-theme-footer\)/);
  assert.match(html, /body\.player-theme-page footer a \{ color: var\(--player-theme-link\)/);
  assert.match(html, /\.board-avatar \{[^}]*background: var\(--primary-strong\)/);
  assert.match(html, /\.admin-portal-link:hover\{background:var\(--primary-strong\)/);
  assert.match(html, /\.dash-theme-palette/);
  assert.match(html, /\.dash-theme-preset-grid/);
  assert.match(html, /\.dash-theme-header/);
  assert.match(html, /\.dash-theme-sidebar/);
  assert.match(html, /\.dash-theme-actionbar/);
  assert.doesNotMatch(html, /\.aether-/);
  assert.match(worker, /\/me\/dashboard-theme/);
});

