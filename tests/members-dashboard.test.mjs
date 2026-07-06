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

test('member dashboard React registration panel includes casual round posts', () => {
  const panel = readFileSync('src/members-app/registration-panel.js', 'utf8');
  const casual = readFileSync('src/members-app/registration-casual.js', 'utf8');
  assert.match(panel, /requestJson\("\/casual-rounds"/);
  assert.match(panel, /casualRequests/);
  assert.match(casual, /CasualRoundCard/);
});

test('member dashboard React board panel owns board loading and posting', () => {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const panel = readFileSync('src/members-app/board-panel.js', 'utf8');
  const markdown = readFileSync('src/members-app/board-markdown.js', 'utf8');
  assert.match(html, /id="membersReactBoardPanel"/);
  assert.match(html, /members-react-board-ready/);
  assert.match(html, /id="legacyBoardPanel"/);
  assert.match(html, /reactBoardReady/);
  assert.match(panel, /requestJson\("\/board"/);
  assert.match(panel, /request\("\/board", \{ method: "POST"/);
  assert.match(panel, /data-react-board-panel/);
  assert.match(panel, /MarkdownBlocks/);
  assert.ok(markdown.includes('https?:\\/\\/'));
});

test('member dashboard React tee signs panel owns upload and captured sign display', () => {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const panel = readFileSync('src/members-app/tee-signs-panel.js', 'utf8');
  const utils = readFileSync('src/members-app/tee-signs-utils.js', 'utf8');
  assert.match(html, /id="membersReactTeeSignsPanel"/);
  assert.match(html, /members-react-tee-signs-ready/);
  assert.match(html, /id="legacyTeeSignsPanel"/);
  assert.match(html, /reactTeeSignsReady/);
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
  const clubPanel = readFileSync('src/members-app/club-panel.js', 'utf8');
  const data = readFileSync('src/members-app/club-directory-data.js', 'utf8');
  const directory = readFileSync('src/members-app/club-directory-panel.js', 'utf8');
  const doublesData = readFileSync('src/members-app/doubles-league-data.js', 'utf8');
  const doubles = readFileSync('src/members-app/doubles-league-panel.js', 'utf8');
  const minuteData = readFileSync('src/members-app/meeting-minutes-data.js', 'utf8');
  const minutes = readFileSync('src/members-app/meeting-minutes-panel.js', 'utf8');
  assert.match(html, /id="membersReactClubPanel"/);
  assert.match(html, /members-react-club-ready/);
  assert.match(html, /club: \['#membersReactClubPanel'\]/);
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
  assert.match(app, /createRoot\(clubMount\)\.render/);
  assert.match(app, /members-react-club-ready/);
  assert.match(data, /export const CLUB_MEMBERS/);
  assert.match(data, /export const CLUB_YEAR_DATA/);
  assert.match(data, /export const CLUB_DIRECTORY_DATA/);
  assert.match(data, /"lastName": "Faison"/);
  assert.match(clubPanel, /data-react-club-panel/);
  assert.match(clubPanel, /clubDirectoryData/);
  assert.match(clubPanel, /DoublesLeaguePanel/);
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

test('member dashboard React registration section stays available for logged-in members', () => {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const panel = readFileSync('src/members-app/registration-panel.js', 'utf8');
  const casual = readFileSync('src/members-app/registration-casual.js', 'utf8');
  assert.match(html, /id="membersReactRegistrationPanel"/);
  assert.match(html, /members-react-registration-ready/);
  assert.match(html, /id="legacyRegisterTitle"/);
  assert.match(panel, /visibleParent\(token\)/);
  assert.match(casual, /data-react-casual-form/);
});

test('member dashboard React registration panel surfaces live events and lists every registered event', () => {
  const events = readFileSync('src/members-app/registration-events.js', 'utf8');
  assert.match(events, /liveToJoin = openToJoin\.filter\(\(event\) => event\.status === "live"\)/);
  assert.match(events, /"Live now"/);
  assert.match(events, /"My events"/); // ALL registrations render, not just the open ones
  assert.match(events, /eventFromRegistration/); // registrations no longer in the open list still render
  assert.match(readFileSync('src/members-app/registration-panel.js', 'utf8'), /requestJson\("\/my-registrations"/);
});

test('member dashboard can post a casual round and jump to a live scorecard', () => {
  const casual = readFileSync('src/members-app/registration-casual.js', 'utf8');
  const events = readFileSync('src/members-app/registration-events.js', 'utf8');
  assert.match(casual, /function CasualRoundForm/);
  assert.match(casual, /request\("\/casual-rounds", \{/);
  assert.match(events, /score\.html\?event=/); // live registered events link to their scorecard
});

test('legacy registration loader remains as a fallback when React registration does not mount', () => {
  const source = registerLoaderSource();
  assert.match(source, /api\('\/casual-rounds'/);
  assert.match(source, /casualRegisterCard/);
  assert.match(readFileSync('gvdg-members.html', 'utf8'), /score\.html\?event=/); // live registered events link to their scorecard
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

test('member dashboard mounts the React shell as a fallback-safe island', () => {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const app = readFileSync('src/members-app/main.js', 'utf8');
  const overview = readFileSync('src/members-app/overview-dashboard.js', 'utf8');
  const pdga = readFileSync('src/members-app/pdga-dashboard.js', 'utf8');
  const ratings = readFileSync('src/members-app/club-ratings.js', 'utf8');
  const activity = readFileSync('src/members-app/activity-panels.js', 'utf8');
  const registration = readFileSync('src/members-app/registration-panel.js', 'utf8');
  const board = readFileSync('src/members-app/board-panel.js', 'utf8');
  const teeSigns = readFileSync('src/members-app/tee-signs-panel.js', 'utf8');
  const club = readFileSync('src/members-app/club-panel.js', 'utf8');
  assert.match(html, /id="membersReactDashboardShell"/);
  assert.match(html, /id="membersReactOverviewPanel"/);
  assert.match(html, /id="membersReactRegistrationPanel"/);
  assert.match(html, /id="membersReactBoardPanel"/);
  assert.match(html, /id="membersReactTeeSignsPanel"/);
  assert.match(html, /id="membersReactClubPanel"/);
  assert.match(html, /id="legacyPdgaDashboard"/);
  assert.match(html, /id="legacyDashboardHead"/);
  assert.match(html, /id="legacyDashboardActions"/);
  assert.match(html, /<script type="module" src="members-app\/members-app\.js"><\/script>/);
  assert.match(html, /window\.addEventListener\('gvdg:select-dashboard-tab'/);
  assert.match(html, /window\.dispatchEvent\(new CustomEvent\('gvdg:member-profile-updated'/);
  assert.match(html, /emitDashboardState\('gvdg:dashboard-tab-selected'\)/);
  assert.match(app, /createRoot\(shellMount\)\.render/);
  assert.match(app, /createRoot\(overviewMount\)\.render/);
  assert.match(app, /createRoot\(registrationMount\)\.render/);
  assert.match(app, /createRoot\(boardMount\)\.render/);
  assert.match(app, /createRoot\(teeSignsMount\)\.render/);
  assert.match(app, /createRoot\(clubMount\)\.render/);
  assert.match(app, /members-react-overview-ready/);
  assert.match(app, /members-react-registration-ready/);
  assert.match(app, /members-react-board-ready/);
  assert.match(app, /members-react-tee-signs-ready/);
  assert.match(app, /members-react-club-ready/);
  assert.match(overview, /data-react-overview-dashboard/);
  assert.match(overview, /data-react-dashboard-actions/);
  assert.match(pdga, /id: "membersReactRatingPanel"/);
  assert.match(pdga, /data-react-pdga-dashboard/);
  assert.match(pdga, /data-react-live-rating/);
  assert.match(pdga, /\/pdga-stats\?pdga=/);
  assert.match(ratings, /\/my-ratings\?/);
  assert.match(ratings, /data-react-club-ratings/);
  assert.match(activity, /\/my-live-rounds/);
  assert.match(activity, /\/shop\/wallet/);
  assert.match(activity, /\/leagues\/active/);
  assert.match(activity, /data-react-live-scoring/);
  assert.match(activity, /data-react-wallet/);
  assert.match(registration, /data-react-registration-panel/);
  assert.match(registration, /EventRegistrationSections/);
  assert.match(registration, /CasualRoundsSection/);
  assert.match(board, /data-react-board-panel/);
  assert.match(teeSigns, /data-react-tee-signs-panel/);
  assert.match(club, /data-react-club-panel/);
});
