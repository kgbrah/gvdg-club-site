import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const removedMemberFallbacks = [
  /id="dashTabs"/,
  /id="legacyDashboardHead"/,
  /id="legacyPdgaDashboard"/,
  /id="legacyDashboardActions"/,
  /id="legacyRegisterTitle"/,
  /id="registerList"/,
  /id="legacyBoardPanel"/,
  /id="legacyTeeSignsPanel"/,
  /id="clubRatings"/,
  /id="clubWallet"/,
  /id="liveScoring"/,
  /id="clubMeetings"/,
  /async function loadDashboard\(/,
  /async function loadRegister\(/,
  /async function loadBoard\(/,
  /async function loadTeeSigns\(/,
  /async function loadMeetings\(/,
  /async function uploadTeeSign\(/,
  /function renderPayPal\(/,
  /async function submitPost\(/,
  /function renderEvents\(/,
  /function mdRender\(/,
  /const DASH_TABS/,
  /function selectDashTab/,
  /function revealDashboardSections/,
  /Member auth backed by the Cloudflare Worker/,
  /const TOKEN_KEY = 'gvdg_member_token'/,
  /function memberDashboardContext/,
  /function publishMemberProfile/,
  /function handleLogin/,
  /async function checkSession/,
  /function showProfileSetup/,
  /function b64urlToBuf/,
  /window\.addEventListener\('gvdg:member-login-requested'/,
  /document\.querySelector\('\.menu-toggle'\)\.addEventListener/,
];

function assertNoLegacyMemberFallbacks(html) {
  removedMemberFallbacks.forEach((pattern) => assert.doesNotMatch(html, pattern));
}

test('member dashboard mounts React-owned dashboard islands without legacy fallbacks', () => {
  const html = readFileSync('gvdg-members.html', 'utf8');
  const app = readFileSync('src/members-app/main.js', 'utf8');
  const authGate = readFileSync('src/members-app/auth-gate.js', 'utf8');
  const authController = readFileSync('src/members-app/member-auth-controller.js', 'utf8');
  const authDom = readFileSync('src/members-app/member-auth-dom.js', 'utf8');
  const authState = readFileSync('src/members-app/member-auth-state.js', 'utf8');
  const passkeys = readFileSync('src/members-app/member-passkeys.js', 'utf8');
  const profile = readFileSync('src/members-app/member-profile-controller.js', 'utf8');
  const pageChrome = readFileSync('src/members-app/page-chrome.js', 'utf8');
  const shell = readFileSync('src/members-app/dashboard-shell.js', 'utf8');
  const router = readFileSync('src/members-app/dashboard-router.js', 'utf8');
  const overview = readFileSync('src/members-app/overview-dashboard.js', 'utf8');
  const pdga = readFileSync('src/members-app/pdga-dashboard.js', 'utf8');
  const ratings = readFileSync('src/members-app/club-ratings.js', 'utf8');
  const activity = readFileSync('src/members-app/activity-panels.js', 'utf8');
  const registration = readFileSync('src/members-app/registration-panel.js', 'utf8');
  const board = readFileSync('src/members-app/board-panel.js', 'utf8');
  const teeSigns = readFileSync('src/members-app/tee-signs-panel.js', 'utf8');
  const club = readFileSync('src/members-app/club-panel.js', 'utf8');
  assert.match(html, /id="membersReactAuthGate"/);
  assert.match(html, /id="membersReactDashboardShell"/);
  assert.match(html, /id="membersReactOverviewPanel"/);
  assert.match(html, /id="membersReactRegistrationPanel"/);
  assert.match(html, /id="membersReactBoardPanel"/);
  assert.match(html, /id="membersReactTeeSignsPanel"/);
  assert.match(html, /id="membersReactClubPanel"/);
  assert.doesNotMatch(html, /id="loginForm"/);
  assert.doesNotMatch(html, /id="pinChangeForm"/);
  assert.doesNotMatch(html, /id="profileForm"/);
  assert.doesNotMatch(html, /id="profilePhotoPreview"/);
  assert.doesNotMatch(html, /id="photoInput"/);
  assert.doesNotMatch(html, /id="passkeyBtn"/);
  assert.doesNotMatch(html, /id="passkeyRow"/);
  assert.doesNotMatch(html, /id="enablePasskeyBtn"/);
  assert.doesNotMatch(html, /id="editProfileBtn"/);
  assert.doesNotMatch(html, /<div class="welcome-banner"/);
  assert.doesNotMatch(html, /id="logoutBtn"/);
  assert.doesNotMatch(html, /id="adminPortalLink"/);
  assert.doesNotMatch(html, /overview: \['#adminPortalLink'/);
  assert.doesNotMatch(html, /const DASH_TABS/);
  assert.doesNotMatch(html, /function selectDashTab/);
  assert.doesNotMatch(html, /function revealDashboardSections/);
  assert.doesNotMatch(html, /gvdg:member-login-requested/);
  assert.doesNotMatch(html, /gvdg:member-profile-updated/);
  assert.doesNotMatch(html, /gvdg:member-dashboard-opened/);
  assertNoLegacyMemberFallbacks(html);
  assert.match(html, /<script type="module" src="members-app\/members-app\.js"><\/script>/);
  assert.match(app, /createRoot\(authMount\)\.render/);
  assert.match(app, /installMemberPageChrome\(\)/);
  assert.match(app, /installMemberAuthController\(\)/);
  assert.match(app, /installDashboardRouter\(\)/);
  assert.match(app, /members-react-auth-ready/);
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
  assert.match(authGate, /data-react-auth-gate/);
  assert.match(authGate, /id: "loginForm"/);
  assert.match(authGate, /id: "pinChangeForm"/);
  assert.match(authGate, /id: "profileForm"/);
  assert.match(authGate, /id: "profilePhotoPreview"/);
  assert.match(authGate, /id: "photoInput"/);
  assert.match(authGate, /id: "passkeyBtn"/);
  assert.match(authGate, /gvdg:member-auth-ready/);
  assert.match(authGate, /gvdg:member-login-requested/);
  assert.match(authGate, /gvdg:member-pin-change-requested/);
  assert.match(authGate, /gvdg:member-profile-save-requested/);
  assert.match(authGate, /gvdg:member-profile-photo-chosen/);
  assert.match(authGate, /gvdg:member-passkey-login-requested/);
  assert.match(authController, /data\.mustChangePin/);
  assert.match(authController, /request\(path, options\)/);
  assert.match(authController, /\/login/);
  assert.match(authController, /\/set-pin/);
  assert.match(authController, /\/me/);
  assert.match(authController, /gvdg:member-login-requested/);
  assert.match(authController, /gvdg:member-pin-change-requested/);
  assert.match(authController, /gvdg:member-profile-save-requested/);
  assert.match(authController, /gvdg:member-profile-photo-chosen/);
  assert.match(authController, /gvdg:member-passkey-login-requested/);
  assert.match(authController, /gvdg:member-add-passkey-requested/);
  assert.match(authController, /gvdg:member-edit-profile-requested/);
  assert.match(authController, /gvdg:member-logout-requested/);
  assert.match(authController, /gvdg:member-auth-ready/);
  assert.match(authDom, /gvdg:member-auth-mode/);
  assert.match(authDom, /gvdg:member-dashboard-opened/);
  assert.match(authState, /gvdg:member-profile-updated/);
  assert.match(authState, /GVDG_MEMBER_DASHBOARD_CONTEXT/);
  assert.match(passkeys, /\/webauthn\/register\/options/);
  assert.match(passkeys, /\/webauthn\/auth\/verify/);
  assert.match(passkeys, /navigator\.credentials\.get/);
  assert.match(profile, /\/profile/);
  assert.match(profile, /profilePhotoPreview/);
  assert.match(pageChrome, /querySelector\("\.menu-toggle"\)/);
  assert.match(pageChrome, /localStorageGet\("theme"\)/);
  assert.match(shell, /data-react-member-banner/);
  assert.match(shell, /data-react-admin-portal/);
  assert.match(shell, /id: "logoutBtn"/);
  assert.match(shell, /id: "adminPortalLink"/);
  assert.match(shell, /readMemberContext/);
  assert.match(shell, /gvdg:member-profile-updated/);
  assert.match(shell, /gvdg:member-logout-requested/);
  assert.match(router, /const DASH_TABS/);
  assert.match(router, /gvdg:select-dashboard-tab/);
  assert.match(router, /gvdg:dashboard-tab-selected/);
  assert.match(router, /gvdg:member-dashboard-opened/);
  assert.match(router, /gvdg:member-dashboard-ready/);
  assert.match(overview, /data-react-overview-dashboard/);
  assert.match(overview, /data-react-dashboard-actions/);
  assert.match(overview, /data-react-account-tools/);
  assert.match(overview, /id: "enablePasskeyBtn"/);
  assert.match(overview, /id: "editProfileBtn"/);
  assert.match(overview, /gvdg:member-add-passkey-requested/);
  assert.match(overview, /gvdg:member-edit-profile-requested/);
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
