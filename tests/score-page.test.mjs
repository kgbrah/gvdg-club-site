import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function scoreSetupSource() {
  const source = readFileSync('src/score-app/setup-flow.js', 'utf8');
  return source;
}

function scoreAuthSource() {
  return readFileSync('src/score-app/auth-flow.js', 'utf8');
}

function scoreStatusSource() {
  return readFileSync('src/score-app/status-view.js', 'utf8');
}

function scoreNotificationsSource() {
  return readFileSync('src/score-app/notifications.js', 'utf8');
}

function scoreDialogsSource() {
  return readFileSync('src/score-app/dialogs.js', 'utf8');
}

function scoreMainSource() {
  return readFileSync('src/score-app/main.js', 'utf8');
}

function scoreLegacySetupSource() {
  const source = readFileSync('src/score-app/score-legacy.js', 'utf8');
  const start = source.indexOf('async function renderLayoutPick(course)');
  const end = source.indexOf('async function addGuestPrompt()');
  assert.notEqual(start, -1, 'renderLayoutPick function should exist');
  assert.notEqual(end, -1, 'addGuestPrompt should follow createRound');
  return source.slice(start, end);
}

function scoreLegacyAuthSource() {
  const source = readFileSync('src/score-app/score-legacy.js', 'utf8');
  const start = source.indexOf('// ---------- passkey login + forced PIN change');
  const end = source.indexOf('function holeMeta(idx)');
  assert.notEqual(start, -1, 'auth section should exist');
  assert.notEqual(end, -1, 'hole meta should follow auth section');
  return source.slice(start, end);
}

function scoreLegacyStatusSource() {
  const source = readFileSync('src/score-app/score-legacy.js', 'utf8');
  const start = source.indexOf('function renderStatusView(props)');
  const end = source.indexOf('// ---------- passkey login + forced PIN change');
  assert.notEqual(start, -1, 'status section should exist');
  assert.notEqual(end, -1, 'auth section should follow status section');
  return source.slice(start, end);
}

function scoreLegacyNotificationSource() {
  const source = readFileSync('src/score-app/score-legacy.js', 'utf8');
  const start = source.indexOf('function toast(msg)');
  const end = source.indexOf('function setShellHeader(nextHeader)');
  assert.notEqual(start, -1, 'notification section should exist');
  assert.notEqual(end, -1, 'shell header section should follow notification section');
  return source.slice(start, end);
}

function scoreLeaderboardSource() {
  return readFileSync('src/score-app/leaderboard-sheet.js', 'utf8');
}

function scoreManagePlayersSource() {
  return readFileSync('src/score-app/manage-players-sheet.js', 'utf8');
}

function scorecardViewSource() {
  return readFileSync('src/score-app/scorecard-view.js', 'utf8');
}

function scoreWeatherSource() {
  return readFileSync('src/score-app/weather-strip.js', 'utf8');
}

function scoreUdiscExportSource() {
  return readFileSync('src/shared/udisc-export.js', 'utf8');
}

function scoreLegacyLeaderboardSource() {
  const source = readFileSync('src/score-app/score-legacy.js', 'utf8');
  const start = source.indexOf('// ---------- leaderboard sheet ----------');
  const end = source.indexOf('// What (if anything) is stopping this card from finalizing');
  assert.notEqual(start, -1, 'leaderboard section should exist');
  assert.notEqual(end, -1, 'finalize blockers should follow leaderboard section');
  return source.slice(start, end);
}

function scoreLegacyManagePlayersSource() {
  const source = readFileSync('src/score-app/score-legacy.js', 'utf8');
  const start = source.indexOf('// Manage players: remove someone');
  const end = source.indexOf('function shareRound()');
  assert.notEqual(start, -1, 'manage players section should exist');
  assert.notEqual(end, -1, 'share round should follow manage players section');
  return source.slice(start, end);
}

function scoreLegacyHoleSource() {
  const source = readFileSync('src/score-app/score-legacy.js', 'utf8');
  const start = source.indexOf('function liveTeeSignView(h)');
  const end = source.indexOf('// ---------- leaderboard sheet ----------');
  assert.notEqual(start, -1, 'scorecard section should exist');
  assert.notEqual(end, -1, 'leaderboard section should follow scorecard section');
  return source.slice(start, end);
}

test('casual round flow shows setup after layout selection', () => {
  const setup = scoreSetupSource();
  const legacy = scoreLegacySetupSource();
  assert.match(legacy, /function renderSetupPick\(course, layout\)/);
  assert.match(legacy, /onSelect: function \(layout\) \{ renderSetupPick\(course, layout\); \}/);
  assert.match(legacy, /renderSetupFlow\(\{\s*view: 'setupPick'/);
  assert.doesNotMatch(legacy, /data-score-setup', 'casual-format'/);
  assert.match(setup, /"data-score-setup": "casual-format"/);
  assert.match(setup, /data-group-format/);
  assert.match(setup, /data-scoring-style/);
  assert.match(setup, /Group format/);
  assert.match(setup, /Scoring style/);
  assert.match(setup, /Singles/);
  assert.match(setup, /Doubles/);
  assert.match(setup, /Stroke play/);
  assert.match(setup, /Match play/);
});

test('createRound sends explicit live scoring config defaults and selections', () => {
  const setup = scoreSetupSource();
  const legacy = scoreLegacySetupSource();
  assert.match(legacy, /return \{ groupFormat: 'singles', scoringStyle: 'stroke' \};/);
  assert.match(setup, /setSelected\(\(current\) => \(\{ \.\.\.current, \[group\.key\]: option\.value \}\)\)/);
  assert.match(setup, /onCreate\(selected\)/);
  assert.match(legacy, /const liveScoringConfig = config \|\| defaultLiveScoringConfig\(\);/);
  assert.match(legacy, /body: \{ course_id: course\.id, layout_id: layout\.id, liveScoringConfig: \{ groupFormat: liveScoringConfig\.groupFormat, scoringStyle: liveScoringConfig\.scoringStyle \} \}/);
});

test('score setup screens are React-owned without legacy DOM fallbacks', () => {
  const legacy = scoreLegacySetupSource();
  const setup = scoreSetupSource();
  const main = scoreMainSource();
  const fullLegacy = readFileSync('src/score-app/score-legacy.js', 'utf8');
  assert.match(fullLegacy, /renderScoreBody\('setup', props\)/);
  assert.match(main, /ScoreSetupFlow/);
  assert.match(setup, /export function ScoreSetupFlow\(props\)/);
  assert.doesNotMatch(legacy, /const row = el\('button', 'tap-row'\)/);
  assert.doesNotMatch(legacy, /const btn = el\('button', 'setup-option'\)/);
  assert.doesNotMatch(legacy, /selected\[group\.key\] = opt\.value/);
  assert.doesNotMatch(setup, /createRoot|getElementById\("app"\)|replaceChildren/);
});

test('score auth screens are React-owned without legacy DOM fallbacks', () => {
  const auth = scoreAuthSource();
  const main = scoreMainSource();
  const legacy = scoreLegacyAuthSource();
  const fullLegacy = readFileSync('src/score-app/score-legacy.js', 'utf8');
  assert.match(fullLegacy, /renderScoreBody\('auth', props\)/);
  assert.match(main, /ScoreAuthFlow/);
  assert.match(auth, /function LoginView\(props\)/);
  assert.match(auth, /function SetPinView\(props\)/);
  assert.match(auth, /export function ScoreAuthFlow\(props\)/);
  assert.match(auth, /KeyRound/);
  assert.doesNotMatch(legacy, /const c = el\('div', 'card stack'\)/);
  assert.doesNotMatch(legacy, /const idL = el\('label', 'lbl', 'PDGA # or UDisc username'\)/);
  assert.doesNotMatch(legacy, /const pkb = el\('button', 'btn secondary'/);
  assert.doesNotMatch(legacy, /np\.placeholder = 'New 4-digit PIN'/);
  assert.doesNotMatch(auth, /createRoot|getElementById\("app"\)|replaceChildren/);
});

test('score status screens are React-owned without legacy message DOM fallbacks', () => {
  const status = scoreStatusSource();
  const main = scoreMainSource();
  const legacy = scoreLegacyStatusSource();
  const fullLegacy = readFileSync('src/score-app/score-legacy.js', 'utf8');
  assert.match(fullLegacy, /renderScoreBody\('status', props\)/);
  assert.match(main, /StatusView/);
  assert.match(status, /function LoadingView\(\)/);
  assert.match(status, /function MessageView\(props\)/);
  assert.match(status, /export function StatusView\(props\)/);
  assert.match(status, /View live leaderboard/);
  assert.doesNotMatch(legacy, /const c = el\('div', 'card center stack'\)/);
  assert.doesNotMatch(fullLegacy, /function spinner\(\)/);
  assert.doesNotMatch(fullLegacy, /shell\(spinner\(\)\)/);
  assert.doesNotMatch(fullLegacy, /🏆 View live leaderboard/);
  assert.doesNotMatch(status, /createRoot|getElementById\("app"\)|replaceChildren/);
});

test('score notifications are React-owned without legacy body DOM fallbacks', () => {
  const notifications = scoreNotificationsSource();
  const legacy = scoreLegacyNotificationSource();
  const fullLegacy = readFileSync('src/score-app/score-legacy.js', 'utf8');
  assert.match(fullLegacy, /createScoreNotificationsRenderer\(\)/);
  assert.match(legacy, /notifications\.showToast\(msg\)/);
  assert.match(legacy, /notifications\.showConflict\(text\)/);
  assert.match(fullLegacy, /notifications\.setOnline\(on\)/);
  assert.match(notifications, /function ScoreNotifications\(props\)/);
  assert.match(notifications, /function ToastItem\(props\)/);
  assert.match(notifications, /createRoot\(host\)/);
  assert.match(notifications, /Offline - scores sync when reconnected/);
  assert.doesNotMatch(fullLegacy, /function el\(/);
  assert.doesNotMatch(fullLegacy, /document\.body\.appendChild/);
  assert.doesNotMatch(fullLegacy, /offlineBar/);
  assert.doesNotMatch(fullLegacy, /toast conflict/);
});

test('score dialogs replace native score prompts and confirms', () => {
  const dialogs = scoreDialogsSource();
  const fullLegacy = readFileSync('src/score-app/score-legacy.js', 'utf8');
  assert.match(fullLegacy, /createScoreDialogRenderer\(\)/);
  assert.match(fullLegacy, /dialogs\.prompt\(\{/);
  assert.match(fullLegacy, /dialogs\.confirm\(\{/);
  assert.match(dialogs, /function ScoreDialog\(props\)/);
  assert.match(dialogs, /role: "dialog"/);
  assert.match(dialogs, /createRoot\(host\)/);
  assert.doesNotMatch(fullLegacy, /window\.prompt/);
  assert.doesNotMatch(fullLegacy, /window\.confirm/);
  assert.doesNotMatch(fullLegacy, /if \(!confirm\(/);
});

test('score shell owns topbar state without legacy DOM mutations', () => {
  const main = scoreMainSource();
  const fullLegacy = readFileSync('src/score-app/score-legacy.js', 'utf8');
  assert.match(main, /const \[header, setHeader\] = React\.useState/);
  assert.match(main, /const \[bodyView, setBodyView\] = React\.useState/);
  assert.match(main, /function ScoreBody\(\{ view \}\)/);
  assert.match(main, /body: bodyController/);
  assert.match(main, /setLeaderboardHandler\(handler\)/);
  assert.match(main, /hidden: !header\.showLeaderboard/);
  assert.match(main, /setDarkTheme\(\(current\) => !current\)/);
  assert.match(fullLegacy, /renderScoreBody\(kind, props\)/);
  assert.match(fullLegacy, /scoreShell\.setHeader/);
  assert.match(fullLegacy, /scoreShell\.setLeaderboardHandler\(openLeaderboard\)/);
  assert.doesNotMatch(fullLegacy, /document\.getElementById\('lbBtn'\)/);
  assert.doesNotMatch(fullLegacy, /document\.getElementById\('barTitle'\)/);
  assert.doesNotMatch(fullLegacy, /document\.getElementById\('barSub'\)/);
  assert.doesNotMatch(fullLegacy, /document\.getElementById\('themeBtn'\)/);
  assert.doesNotMatch(fullLegacy, /createScore(AuthFlow|SetupFlow|StatusView|cardView)Renderer/);
});

test('player score page supports pair target rows and target-id offline replay', () => {
  const source = readFileSync('src/score-app/score-legacy.js', 'utf8');
  assert.match(source, /function scoreRows\(\)/);
  assert.match(source, /target\.type === 'pair'/);
  assert.match(source, /let flushQueuePromise = null/);
  assert.match(source, /if \(flushQueuePromise\) return flushQueuePromise/);
  assert.match(source, /body\.targetId = item\.targetId/);
  assert.match(source, /body\.targetId = row\.targetId/);
  assert.match(source, /qAdd\(row\.targetId \?/);
  assert.match(source, /function savePairLabels\(assignments\)/);
});

test('player leaderboard renders matchplay and pair labels without primary to-par ranking', () => {
  const source = scoreLeaderboardSource();
  assert.match(source, /const resultHead = isMatchplay \? "Match" : "To par"/);
  assert.ok(source.includes('standing.members.join(" / ")'));
  assert.match(source, /standing\.match && standing\.match\.status/);
  assert.match(readFileSync('src/score-app/score-legacy.js', 'utf8'), /Pair changes are blocked after scoring starts/);
});

test('player leaderboard sheet is React-owned without legacy overlay DOM construction', () => {
  const legacy = scoreLegacyLeaderboardSource();
  const leaderboard = scoreLeaderboardSource();
  const sharedUdisc = scoreUdiscExportSource();
  const fullLegacy = readFileSync('src/score-app/score-legacy.js', 'utf8');
  const html = readFileSync('score.html', 'utf8');
  assert.match(legacy, /createLeaderboardSheetRenderer\(\)/);
  assert.match(legacy, /leaderboardSheet\.render\(\{/);
  assert.match(leaderboard, /function LeaderboardSheet\(props\)/);
  assert.match(leaderboard, /createRoot\(host\)/);
  assert.match(leaderboard, /UDiscExportDetails/);
  assert.match(sharedUdisc, /export function UDiscExportDetails\(props\)/);
  assert.match(sharedUdisc, /export function udiscDeepLink\(courseId\)/);
  assert.match(sharedUdisc, /export function parseUdiscScorecard\(scorecard\)/);
  assert.match(fullLegacy, /return \{ courseId: S\.udiscCourseId, scorecard: scorecard \};/);
  assert.doesNotMatch(legacy, /const overlay = el\('div', 'overlay'\)/);
  assert.doesNotMatch(legacy, /const table = el\('table', 'lb'\)/);
  assert.doesNotMatch(legacy, /sheet\.appendChild\(el\('h2', 'section', 'Live Leaderboard'\)\)/);
  assert.doesNotMatch(leaderboard, /UDiscExportMount/);
  assert.doesNotMatch(leaderboard, /replaceChildren/);
  assert.doesNotMatch(leaderboard, /appendChild\(node\)/);
  assert.doesNotMatch(fullLegacy, /window\.UDiscExport/);
  assert.doesNotMatch(html, /udisc-export\.js/);
});

test('manage players sheet is React-owned without legacy overlay DOM construction', () => {
  const legacy = scoreLegacyManagePlayersSource();
  const manage = scoreManagePlayersSource();
  assert.match(legacy, /createManagePlayersSheetRenderer\(\)/);
  assert.match(legacy, /managePlayersSheet\.render\(\{/);
  assert.match(manage, /function ManagePlayersSheet\(props\)/);
  assert.match(manage, /function PairEditor\(\{ players, onSavePairs \}\)/);
  assert.match(manage, /createRoot\(host\)/);
  assert.doesNotMatch(legacy, /const overlay = el\('div', 'overlay'\)/);
  assert.doesNotMatch(legacy, /const sheet = el\('div', 'sheet'\)/);
  assert.doesNotMatch(legacy, /pairInputs\.push/);
  assert.doesNotMatch(legacy, /overlay\.appendChild\(sheet\)/);
});

test('scorecard view is React-owned without legacy hole DOM construction', () => {
  const legacy = scoreLegacyHoleSource();
  const scorecard = scorecardViewSource();
  const main = scoreMainSource();
  const fullLegacy = readFileSync('src/score-app/score-legacy.js', 'utf8');
  assert.match(fullLegacy, /renderScoreBody\('scorecard', \{/);
  assert.match(main, /ScorecardView/);
  assert.match(scorecard, /function ScorecardView\(props\)/);
  assert.match(scorecard, /function ScoreRow\(props\)/);
  assert.match(scorecard, /function HoleGrid\(props\)/);
  assert.match(scorecard, /export function ScorecardView\(props\)/);
  assert.match(scorecard, /WeatherStrip/);
  assert.doesNotMatch(legacy, /const head = el\('div', 'hole-head'\)/);
  assert.doesNotMatch(legacy, /const box = el\('div', 'card'\)/);
  assert.doesNotMatch(legacy, /const row = el\('div', 'prow'/);
  assert.doesNotMatch(legacy, /const grid = el\('div', 'holegrid'\)/);
  assert.doesNotMatch(legacy, /document\.createElement\('select'\)/);
  assert.doesNotMatch(scorecard, /createRoot|getElementById\("app"\)|replaceChildren/);
});

test('score weather strip is React-owned without legacy DOM replacement', () => {
  const fullLegacy = readFileSync('src/score-app/score-legacy.js', 'utf8');
  const scorecard = scorecardViewSource();
  const weather = scoreWeatherSource();
  const sharedWeather = readFileSync('weather-display.js', 'utf8');
  assert.match(scorecard, /import \{ WeatherStrip \} from "\.\/weather-strip\.js"/);
  assert.match(scorecard, /h\(WeatherStrip, \{ key: "weather"/);
  assert.match(fullLegacy, /weatherChanged\) renderHole\(\); return;/);
  assert.match(fullLegacy, /weather: S\.weather/);
  assert.match(weather, /export function WeatherStrip\(props\)/);
  assert.match(weather, /currentWeatherSummary/);
  assert.match(weather, /windArrowModel/);
  assert.match(weather, /subscribeCompass/);
  assert.match(sharedWeather, /currentWeatherSummary/);
  assert.match(sharedWeather, /windArrowModel/);
  assert.match(sharedWeather, /subscribeCompass/);
  assert.doesNotMatch(scorecard, /WeatherSlot/);
  assert.doesNotMatch(fullLegacy, /function roundWeatherNode\(\)/);
  assert.doesNotMatch(fullLegacy, /function refreshWeatherStrip\(\)/);
  assert.doesNotMatch(fullLegacy, /querySelector\('\.weather-strip'\)/);
  assert.doesNotMatch(fullLegacy, /replaceWith\(fresh\)/);
  assert.doesNotMatch(fullLegacy, /GVDGWeather\.buildWeatherStrip\(document/);
});
