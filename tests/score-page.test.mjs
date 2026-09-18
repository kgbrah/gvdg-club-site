import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

function scoreControllerSource() {
  return readFileSync('src/score-app/score-controller.js', 'utf8');
}

function scoreViewModelSource() {
  return readFileSync('src/score-app/score-view-model.js', 'utf8');
}

function scoreControllerSetupSource() {
  const source = scoreControllerSource();
  const start = source.indexOf('async function renderLayoutPick(course)');
  const end = source.indexOf('async function addGuestPrompt()');
  assert.notEqual(start, -1, 'renderLayoutPick function should exist');
  assert.notEqual(end, -1, 'addGuestPrompt should follow createRound');
  return source.slice(start, end);
}

function scoreControllerAuthSource() {
  const source = scoreControllerSource();
  const start = source.indexOf('// ---------- passkey login + forced PIN change');
  const end = source.indexOf('function holeMeta(idx)');
  assert.notEqual(start, -1, 'auth section should exist');
  assert.notEqual(end, -1, 'hole meta should follow auth section');
  return source.slice(start, end);
}

function scoreControllerStatusSource() {
  const source = scoreControllerSource();
  const start = source.indexOf('function renderStatusView(props)');
  const end = source.indexOf('// ---------- passkey login + forced PIN change');
  assert.notEqual(start, -1, 'status section should exist');
  assert.notEqual(end, -1, 'auth section should follow status section');
  return source.slice(start, end);
}

function scoreControllerNotificationSource() {
  const source = scoreControllerSource();
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

function scoreControllerLeaderboardSource() {
  const source = scoreControllerSource();
  const start = source.indexOf('// ---------- leaderboard sheet ----------');
  const end = source.indexOf('async function agreeFinish(');
  assert.notEqual(start, -1, 'leaderboard section should exist');
  assert.notEqual(end, -1, 'finish confirm should follow leaderboard section');
  return source.slice(start, end);
}

function scoreControllerManagePlayersSource() {
  const source = scoreControllerSource();
  const start = source.indexOf('// Manage players: remove someone');
  const end = source.indexOf('function shareRound()');
  assert.notEqual(start, -1, 'manage players section should exist');
  assert.notEqual(end, -1, 'share round should follow manage players section');
  return source.slice(start, end);
}

function scoreControllerHoleSource() {
  const source = scoreControllerSource();
  const start = source.indexOf('function liveTeeSignView(h, players)');
  const end = source.indexOf('// ---------- leaderboard sheet ----------');
  assert.notEqual(start, -1, 'scorecard section should exist');
  assert.notEqual(end, -1, 'leaderboard section should follow scorecard section');
  return source.slice(start, end);
}

test('score app imports the controller without a score-legacy shim', () => {
  const main = scoreMainSource();
  const html = readFileSync('score.html', 'utf8');
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  assert.match(main, /from "\.\/score-controller\.js"/);
  assert.equal(existsSync('src/score-app/score-controller.js'), true);
  assert.equal(existsSync('src/score-app/score-legacy.js'), false);
  assert.doesNotMatch(html, /matchplay-colors\.js/);
  assert.match(controller, /from "\.\.\/shared\/matchplay-colors\.js"/);
  assert.match(controller, /holeWinners\(\[\{ hole: h\.hole \}\], players \|\| S\.cardmates\)/);
  assert.doesNotMatch(controller, /window\.GVDGMatchplay/);
  assert.doesNotMatch(main, /score-legacy/);
});

test('casual round flow shows setup after layout selection', () => {
  const setup = scoreSetupSource();
  const legacy = scoreControllerSetupSource();
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
  const legacy = scoreControllerSetupSource();
  assert.match(legacy, /return \{ groupFormat: 'singles', scoringStyle: 'stroke' \};/);
  assert.match(setup, /setSelected\(\(current\) => \(\{ \.\.\.current, \[group\.key\]: option\.value \}\)\)/);
  assert.match(setup, /onCreate\(selected\)/);
  assert.match(legacy, /const liveScoringConfig = config \|\| defaultLiveScoringConfig\(\);/);
  assert.match(legacy, /body: \{ course_id: course\.id, layout_id: layout\.id, liveScoringConfig: \{ groupFormat: liveScoringConfig\.groupFormat, scoringStyle: liveScoringConfig\.scoringStyle \} \}/);
});

test('score setup screens are React-owned without legacy DOM fallbacks', () => {
  const legacy = scoreControllerSetupSource();
  const setup = scoreSetupSource();
  const main = scoreMainSource();
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  assert.match(controller, /renderScoreBody\('setup', props\)/);
  assert.match(main, /ScoreSetupFlow/);
  assert.match(setup, /Watch this round/);
  assert.match(setup, /onWatch\(joinCode\)/);
  assert.match(controller, /onWatch: watchRoundCode/);
  assert.match(setup, /export function ScoreSetupFlow\(props\)/);
  assert.doesNotMatch(legacy, /const row = el\('button', 'tap-row'\)/);
  assert.doesNotMatch(legacy, /const btn = el\('button', 'setup-option'\)/);
  assert.doesNotMatch(legacy, /selected\[group\.key\] = opt\.value/);
  assert.doesNotMatch(setup, /createRoot|getElementById\("app"\)|replaceChildren/);
});

test('score auth screens are React-owned without legacy DOM fallbacks', () => {
  const auth = scoreAuthSource();
  const main = scoreMainSource();
  const legacy = scoreControllerAuthSource();
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  assert.match(controller, /renderScoreBody\('auth', props\)/);
  assert.match(main, /ScoreAuthFlow/);
  assert.match(auth, /function OpenPlayView\(props\)/);
  assert.match(auth, /Play without an account/);
  assert.match(auth, /mode === "openPlay"/);
  assert.match(controller, /\/rounds\/open-play/);
  assert.match(controller, /openPlayAvailable: MODE !== 'event'/);
  assert.match(controller, /function startOpenPlay\(/);
  assert.match(controller, /if \(MODE === 'home'\) \{ renderHome\(\); return; \}/);
  assert.match(controller, /readOpenPlayToken/);
  assert.doesNotMatch(controller, /casual\s+rounds are members-only/);
  assert.match(auth, /KeyRound/);
  assert.doesNotMatch(legacy, /const c = el\('div', 'card stack'\)/);
  assert.doesNotMatch(legacy, /const idL = el\('label', 'lbl', 'PDGA # or UDisc username'\)/);
  assert.doesNotMatch(legacy, /const pkb = el\('button', 'btn secondary'/);
  assert.doesNotMatch(legacy, /np\.placeholder = 'New 4-digit PIN'/);
  assert.doesNotMatch(auth, /createRoot|getElementById\("app"\)|replaceChildren/);
});

test('open play session is stored off the member token', () => {
  const session = readFileSync('src/score-app/open-play-session.js', 'utf8');
  const setup = scoreSetupSource();
  assert.match(session, /export const OPEN_PLAY_TOKEN_KEY = "gvdg_open_play_token"/);
  assert.match(session, /export function writeOpenPlaySession/);
  assert.doesNotMatch(session, /gvdg_member_token/);
  assert.match(setup, /No club login needed/);
  assert.match(setup, /Sign in with a club account/);
  assert.match(setup, /signedIn/);
});

test('score status screens are React-owned without legacy message DOM fallbacks', () => {
  const status = scoreStatusSource();
  const main = scoreMainSource();
  const legacy = scoreControllerStatusSource();
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  assert.match(controller, /renderScoreBody\('status', props\)/);
  assert.match(main, /StatusView/);
  assert.match(status, /function LoadingView\(\)/);
  assert.match(status, /function MessageView\(props\)/);
  assert.match(status, /export function StatusView\(props\)/);
  assert.match(status, /View live leaderboard/);
  assert.doesNotMatch(legacy, /const c = el\('div', 'card center stack'\)/);
  assert.doesNotMatch(controller, /function spinner\(\)/);
  assert.doesNotMatch(controller, /shell\(spinner\(\)\)/);
  assert.doesNotMatch(controller, /🏆 View live leaderboard/);
  assert.doesNotMatch(status, /createRoot|getElementById\("app"\)|replaceChildren/);
});

test('score notifications are React-owned without legacy body DOM fallbacks', () => {
  const html = readFileSync('score.html', 'utf8');
  const notifications = scoreNotificationsSource();
  const legacy = scoreControllerNotificationSource();
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  assert.match(html, /id="scoreReactNotificationsApp"/);
  assert.match(controller, /createScoreNotificationsRenderer\(\)/);
  assert.match(legacy, /notifications\.showToast\(msg\)/);
  assert.match(legacy, /notifications\.showConflict\(text\)/);
  assert.match(controller, /notifications\.setOnline\(on\)/);
  assert.match(notifications, /function ScoreNotifications\(props\)/);
  assert.match(notifications, /function ToastItem\(props\)/);
  assert.match(notifications, /document\.getElementById\("scoreReactNotificationsApp"\)/);
  assert.match(notifications, /createRoot\(host\)/);
  assert.match(notifications, /Offline - scores sync when reconnected/);
  assert.doesNotMatch(notifications, /document\.createElement|document\.body\.appendChild|host\.remove\(\)/);
  assert.doesNotMatch(controller, /function el\(/);
  assert.doesNotMatch(controller, /document\.body\.appendChild/);
  assert.doesNotMatch(controller, /offlineBar/);
  assert.doesNotMatch(controller, /toast conflict/);
});

test('score dialogs replace native score prompts and confirms', () => {
  const html = readFileSync('score.html', 'utf8');
  const dialogs = scoreDialogsSource();
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  assert.match(html, /id="scoreReactDialogsApp"/);
  assert.match(controller, /createScoreDialogRenderer\(\)/);
  assert.match(controller, /dialogs\.prompt\(\{/);
  assert.match(controller, /dialogs\.confirm\(\{/);
  assert.match(dialogs, /function ScoreDialog\(props\)/);
  assert.match(dialogs, /role: "dialog"/);
  assert.match(dialogs, /document\.getElementById\("scoreReactDialogsApp"\)/);
  assert.match(dialogs, /createRoot\(host\)/);
  assert.doesNotMatch(dialogs, /document\.createElement|document\.body\.appendChild|host\.remove\(\)/);
  assert.doesNotMatch(controller, /window\.prompt/);
  assert.doesNotMatch(controller, /window\.confirm/);
  assert.doesNotMatch(controller, /if \(!confirm\(/);
});

test('score shell owns topbar state without legacy DOM mutations', () => {
  const main = scoreMainSource();
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  assert.match(main, /const \[header, setHeader\] = React\.useState/);
  assert.match(main, /const \[bodyView, setBodyView\] = React\.useState/);
  assert.match(main, /function ScoreBody\(\{ view \}\)/);
  assert.match(main, /body: bodyController/);
  assert.match(main, /setLeaderboardHandler\(handler\)/);
  assert.match(main, /hidden: !header\.showLeaderboard/);
  assert.match(main, /InstallCoachBanner/);
  assert.match(main, /bodyView\.kind === "watch" \|\| bodyView\.kind === "scorecard" \? null : h\(InstallCoachBanner/);
  assert.match(main, /usePlayerThemeSession/);
  assert.match(main, /onClick: onToggleTheme/);
  assert.match(controller, /renderScoreBody\(kind, props\)/);
  assert.match(controller, /scoreShell\.setHeader/);
  assert.match(controller, /scoreShell\.setLeaderboardHandler\(openLeaderboard\)/);
  assert.doesNotMatch(controller, /document\.getElementById\('lbBtn'\)/);
  assert.doesNotMatch(controller, /document\.getElementById\('barTitle'\)/);
  assert.doesNotMatch(controller, /document\.getElementById\('barSub'\)/);
  assert.doesNotMatch(controller, /document\.getElementById\('themeBtn'\)/);
  assert.doesNotMatch(controller, /createScore(AuthFlow|SetupFlow|StatusView|cardView)Renderer/);
});

test('player score page supports pair target rows and target-id offline replay', () => {
  const source = readFileSync('src/score-app/score-controller.js', 'utf8');
  const viewModel = scoreViewModelSource();
  assert.match(viewModel, /export function scoreRows\(state\)/);
  assert.match(viewModel, /target\.type === "pair"/);
  assert.match(source, /let flushQueuePromise = null/);
  assert.match(source, /if \(flushQueuePromise\) return flushQueuePromise/);
  assert.match(source, /body\.targetId = item\.targetId/);
  assert.match(source, /body\.targetId = row\.targetId/);
  assert.match(source, /qAdd\(row\.targetId \?/);
  assert.match(source, /function savePairLabels\(assignments\)/);
});

test('score controller delegates scorecard derivation to a pure view model', () => {
  const controller = scoreControllerSource();
  const viewModel = scoreViewModelSource();
  assert.match(controller, /buildScorecardViewState\(\{/);
  assert.match(controller, /finalizeBlockers\(S\)/);
  assert.match(controller, /udiscExportData\(S\)/);
  assert.match(controller, /scoreTargetForPlayer\(S, index\)/);
  assert.match(viewModel, /export function buildScorecardViewState/);
  assert.match(viewModel, /export function yourTurnHint\(state\)/);
  assert.match(viewModel, /export function scoreRows\(state\)/);
  assert.match(viewModel, /export function applyTeeOrder/);
  assert.match(viewModel, /export function activeHoleIndex/);
  assert.match(viewModel, /export function fieldActiveHoleIndex/);
  assert.match(viewModel, /export function strokesForRow/);
  assert.match(viewModel, /export function finalizeBlockers\(state\)/);
  assert.match(viewModel, /export function playOrderStep/);
  assert.match(viewModel, /export function startingHoleForState/);
  assert.match(controller, /playOrderStep\(S\.holes, S\.holeIdx, startingHoleForState\(S\), 1\)/);
  assert.match(controller, /readMemberToken/);
  assert.match(controller, /createWakeLock/);
  assert.match(controller, /readMineCache\(currentMineKey\(\)\)/);
  assert.match(controller, /wakeLock\.start\(\)/);
  assert.doesNotMatch(scoreLeaderboardSource(), /Every member on the card must enter matching scores/);
  assert.doesNotMatch(controller, /function scoreRows\(\)|function strokesFor\(|function strokesForRow\(|function conflictForRow\(|function holeHasConflict\(|function isMatchDormie\(|function matchStatusText\(|function myScoreRow\(|function udiscExportData\(\)|function finalizeBlockers\(\)/);
});

test('score view model derives rows, totals, conflicts, blockers, and UDisc export data', async () => {
  const {
    buildScorecardViewState,
    finalizeBlockers,
    finishRoundHint,
    matchStatusText,
    playOrderStep,
    scoreRows,
    startingHoleForState,
    udiscExportData,
    yourTurnHint,
  } = await import(new URL('../src/score-app/score-view-model.js', import.meta.url));
  const state = {
    holes: [{ hole: 1, par: 3, distance_ft: 250 }, { hole: 2, par: 4 }],
    cardmates: [
      { index: 0, name: 'Ava King', division: 'MA1', isMe: true, scores: { 1: 2 }, scorecards: { 1: { 'player:0': 2 } } },
      { index: 1, name: 'Milo Chen', division: 'MA1', scores: { 1: 5 }, scorecards: { 1: { 'player:0': 5 } } },
    ],
    conflicts: [{ cardId: 'card-a', playerIndex: 1, playerName: 'Milo Chen', hole: 1, values: [4, 5] }],
    missing: [{ cardId: 'card-a', playerName: 'Ava King', hole: 2 }],
    holeIdx: 0,
    myIndex: 0,
    roundConfig: { groupFormat: 'singles', scoringStyle: 'stroke' },
    scoreTargets: [],
    scoreTargetError: null,
    snap: { standings: [] },
    udiscCourseId: '123',
    weather: null,
    pots: {
      acePot: { total_cents: 2500, contributors: 5, status: "active" },
      ctps: [{ id: 1, hole: 1, prize: "Disc" }],
    },
  };

  const view = buildScorecardViewState({ state, mode: 'round', roundCode: 'QA1234', scorerIndex: 0, teeSign: null });
  assert.equal(scoreRows(state).length, 2);
  assert.equal(view.rows[0].currentScore, 2);
  assert.equal(view.rows[0].isMe, true);
  assert.deepEqual(view.selfMark, { index: 0, initials: "AK" });
  assert.equal(view.rows[0].teePosition, 1);
  assert.equal(view.rows[0].honors, false);
  assert.equal(view.teeOrderHint, 'Tee order: Ava King · then Milo Chen');
  assert.equal(view.rows[0].relative.text, '-1');
  assert.equal(view.rows[1].conflictText.includes('4 vs 5'), true);
  assert.deepEqual(view.totals, [
    { label: 'Thru', value: '1/2' },
    { label: 'Total', value: '2' },
    { label: 'To par', value: '-1' },
  ]);
  assert.equal(view.holeGrid[0].done, true);
  assert.equal(view.holeGrid[0].score, 2);
  assert.equal(view.holeGrid[0].relative.text, 'birdie');
  assert.equal(view.holeGrid[0].relative.className, 'under');
  assert.equal(view.solo, false);
  assert.equal(view.formatLabel, 'Singles · Stroke');
  assert.equal(view.holes.length, 2);
  const soloView = buildScorecardViewState({
    state: {
      ...state,
      cardmates: [state.cardmates[0]],
      conflicts: [],
      missing: [],
    },
    mode: 'round',
    roundCode: 'QA1234',
    scorerIndex: 0,
    teeSign: null,
  });
  assert.equal(soloView.solo, true);
  assert.equal(soloView.rows.length, 1);
  assert.equal(view.holeGrid[1].score, null);
  assert.equal(view.holeGrid[1].relative, null);
  assert.equal(view.holeGrid[0].ctp, true);
  assert.equal(view.showPots, true);
  assert.equal(view.ctpBadge, "Disc");
  assert.match(view.pots.aceLine, /\$25 in the pot/);
  assert.equal(view.show, true);
  assert.equal(view.yourTurn, '');
  assert.equal(yourTurnHint({
    ...state,
    holeIdx: 0,
    cardmates: [
      { index: 0, name: 'Ava King', division: 'MA1', isMe: true, scores: {}, scorecards: {} },
      { index: 1, name: 'Milo Chen', division: 'MA1', scores: { 1: 5 }, scorecards: { 1: { 'player:1': 5 } } },
    ],
  }), 'Card is waiting on you — hole 1');
  assert.deepEqual(udiscExportData(state), { courseId: '123', scorecard: [{ hole: 1, par: 3, strokes: 2 }] });
  assert.equal(finalizeBlockers(state).ready, false);
  assert.match(finishRoundHint(finalizeBlockers(state), 'round'), /disagreeing scores/);
  assert.match(finishRoundHint({ ready: true, conflicts: [], missing: [], lines: [] }, 'round'), /Anyone on this card can finish/);
  assert.match(finishRoundHint({ ready: true, conflicts: [], missing: [], lines: [] }, 'event'), /Anyone on this card can submit/);
  assert.match(finishRoundHint({ ready: true, conflicts: [], missing: [], lines: [] }, 'event', true), /submitted/);
  assert.equal(view.finish.canFinish, false);
  assert.equal(view.finish.ready, false);
  assert.equal(view.finish.blocker.kind, 'conflict');
  assert.match(view.finish.blocker.text, /4 vs 5/);
  const missingOnCurrent = buildScorecardViewState({
    state: { ...state, conflicts: [], missing: [{ cardId: 'card-a', playerName: 'Ava King', hole: 1 }], holeIdx: 0 },
    mode: 'round',
    roundCode: 'QA1234',
    scorerIndex: 0,
    teeSign: null,
  });
  assert.equal(missingOnCurrent.finish.blocker, null);
  assert.deepEqual(missingOnCurrent.finish.skipped, []);
  const missingAhead = buildScorecardViewState({
    state: { ...state, conflicts: [], missing: [{ cardId: 'card-a', playerName: 'Ava King', hole: 2 }], holeIdx: 0 },
    mode: 'round',
    roundCode: 'QA1234',
    scorerIndex: 0,
    teeSign: null,
  });
  assert.equal(missingAhead.finish.blocker, null);
  assert.deepEqual(missingAhead.finish.skipped, []);
  const missingBehind = buildScorecardViewState({
    state: { ...state, conflicts: [], missing: [{ cardId: 'card-a', playerName: 'Ava King', hole: 1 }], holeIdx: 1 },
    mode: 'round',
    roundCode: 'QA1234',
    scorerIndex: 0,
    teeSign: null,
  });
  assert.equal(missingBehind.finish.blocker.kind, 'missing');
  assert.equal(missingBehind.finish.blocker.hole, 1);
  assert.equal(missingBehind.finish.skipped.length, 1);
  const shotgunHoles = Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 3 }));
  const shotgunBase = {
    ...state,
    holes: shotgunHoles,
    conflicts: [],
    missing: [{ hole: 10 }, { hole: 9 }],
    cardmates: [{ index: 0, name: 'Ava King', isMe: true, startingHole: 10, scores: {}, scorecards: {} }],
  };
  const shotgunOnStart = buildScorecardViewState({
    state: { ...shotgunBase, holeIdx: 9 },
    mode: 'round',
    roundCode: 'QA1234',
    scorerIndex: 0,
    teeSign: null,
  });
  assert.equal(shotgunOnStart.finish.blocker, null);
  const shotgunPastStart = buildScorecardViewState({
    state: { ...shotgunBase, holeIdx: 10 },
    mode: 'round',
    roundCode: 'QA1234',
    scorerIndex: 0,
    teeSign: null,
  });
  assert.equal(shotgunPastStart.finish.blocker.kind, 'missing');
  assert.equal(shotgunPastStart.finish.blocker.hole, 10);
  assert.equal(matchStatusText({
    ...state,
    roundConfig: { groupFormat: 'singles', scoringStyle: 'matchplay' },
    snap: {
      standings: [
        { targetId: 'player:0', name: 'Alex Schwarga', scoringGroup: { label: 'Blue' }, match: { status: '1 down', outcome: 'trailing' } },
        { targetId: 'player:1', name: 'TJ Braley', scoringGroup: { label: 'Red' }, match: { status: '1 up', outcome: 'leading' } },
      ],
    },
  }), 'Match: Red 1 up');
  assert.equal(matchStatusText({
    ...state,
    roundConfig: { groupFormat: 'singles', scoringStyle: 'matchplay' },
    snap: {
      standings: [
        { targetId: 'player:0', name: 'Alex Schwarga', scoringGroup: { label: 'Blue' }, match: { status: 'won 2&1', outcome: 'lost' } },
        { targetId: 'player:1', name: 'TJ Braley', scoringGroup: { label: 'Red' }, match: { status: 'won 2&1', outcome: 'won' } },
      ],
    },
  }), 'Match: Red won 2&1');
  assert.equal(matchStatusText({
    ...state,
    roundConfig: { groupFormat: 'singles', scoringStyle: 'matchplay' },
    snap: {
      standings: [
        { targetId: 'player:0', name: 'Alex Schwarga', scoringGroup: { label: 'Blue' }, match: { status: '1 up', outcome: 'trailing' } },
      ],
    },
  }), 'Match: Blue 1 down');
  const guestVote = buildScorecardViewState({
    state: {
      ...state,
      cardId: 'c0',
      cardmates: [
        { index: 0, name: 'Ava King', division: 'MA1', isMe: true, ctpEligible: true, scores: {}, scorecards: {} },
        { index: 1, name: 'Guest', division: 'MA1', ctpEligible: true, scores: {}, scorecards: {} },
        { index: 2, name: 'Skip', division: 'MA1', ctpEligible: false, scores: {}, scorecards: {} },
      ],
      snap: {
        liveCtps: [{
          id: 1,
          hole: 1,
          myVote: 0,
          cards: [{
            cardId: 'c0',
            votes: [
              { playerIndex: 0, nomineeIndex: 0 },
            ],
          }],
        }],
      },
    },
    mode: 'round',
    roundCode: 'QA1234',
    scorerIndex: 1,
    teeSign: null,
  });
  assert.equal(guestVote.ctpClaim.ctps[0].myVote, null);
  assert.deepEqual(guestVote.ctpClaim.ctps[0].nominees.map((row) => row.index), [0, 1]);
});

test('shotgun hole pager follows play order instead of layout index', async () => {
  const { buildScorecardViewState, nextPlayHole, playOrderStep, startingHoleForState } = await import(new URL('../src/score-app/score-view-model.js', import.meta.url));
  const shotgunHoles = [{ hole: 1, par: 3 }, { hole: 2, par: 3 }, { hole: 3, par: 3 }];
  assert.equal(startingHoleForState({ cardmates: [{ isMe: true, startingHole: 8 }] }), 8);
  assert.equal(playOrderStep(shotgunHoles, 2, 3, 1), 0);
  assert.equal(playOrderStep(shotgunHoles, 2, 3, -1), 2);
  assert.equal(playOrderStep(shotgunHoles, 0, 2, 1), 0);
  assert.equal(nextPlayHole(shotgunHoles, 2, 3).hole, 1);
  assert.equal(nextPlayHole(shotgunHoles, 1, 3), null);
  const shotgunView = buildScorecardViewState({
    state: {
      holes: shotgunHoles,
      holeIdx: 1,
      cardmates: [{ index: 0, name: 'Ava', isMe: true, startingHole: 3, scores: {}, scorecards: {} }],
      conflicts: [],
      missing: [],
      roundConfig: { groupFormat: 'singles', scoringStyle: 'stroke' },
      scoreTargets: [],
      snap: { standings: [] },
    },
    mode: 'round',
    roundCode: 'QA1234',
    scorerIndex: 0,
    teeSign: null,
  });
  assert.equal(shotgunView.atEnd, true);
  assert.equal(shotgunView.nextHole, null);
  assert.equal(shotgunView.atStart, false);
});

test('player leaderboard renders matchplay and pair labels without primary to-par ranking', () => {
  const source = scoreLeaderboardSource();
  assert.match(source, /const resultHead = isMatchplay \? "Match" : "To par"/);
  assert.ok(source.includes('standing.members.join(" / ")'));
  assert.match(source, /from "\.\.\/shared\/match-status\.js"/);
  assert.match(source, /displayMatchStatus\(standing\.match\)/);
  assert.match(readFileSync('src/score-app/score-controller.js', 'utf8'), /Pair changes are blocked after scoring starts/);
});

test('player leaderboard sheet is React-owned without legacy overlay DOM construction', () => {
  const legacy = scoreControllerLeaderboardSource();
  const leaderboard = scoreLeaderboardSource();
  const sharedUdisc = scoreUdiscExportSource();
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  const html = readFileSync('score.html', 'utf8');
  assert.match(html, /id="scoreReactLeaderboardSheetApp"/);
  assert.match(legacy, /createLeaderboardSheetRenderer\(\)/);
  assert.match(legacy, /leaderboardSheet\.render\(\{/);
  assert.match(leaderboard, /function LeaderboardSheet\(props\)/);
  assert.match(leaderboard, /document\.getElementById\("scoreReactLeaderboardSheetApp"\)/);
  assert.match(leaderboard, /createRoot\(host\)/);
  assert.match(leaderboard, /root\.render\(null\)/);
  assert.match(leaderboard, /UDiscExportDetails/);
  assert.match(sharedUdisc, /export function UDiscExportDetails\(props\)/);
  assert.match(sharedUdisc, /export function udiscDeepLink\(courseId\)/);
  assert.match(sharedUdisc, /export function parseUdiscScorecard\(scorecard\)/);
  assert.match(controller, /udiscExportData\(S\)/);
  assert.match(scoreViewModelSource(), /return \{ courseId: state\.udiscCourseId, scorecard \};/);
  assert.equal(existsSync('udisc-export.js'), false);
  assert.doesNotMatch(legacy, /const overlay = el\('div', 'overlay'\)/);
  assert.doesNotMatch(legacy, /const table = el\('table', 'lb'\)/);
  assert.doesNotMatch(legacy, /sheet\.appendChild\(el\('h2', 'section', 'Live Leaderboard'\)\)/);
  assert.doesNotMatch(leaderboard, /UDiscExportMount/);
  assert.doesNotMatch(leaderboard, /replaceChildren/);
  assert.doesNotMatch(leaderboard, /appendChild\(node\)/);
  assert.doesNotMatch(leaderboard, /document\.createElement|document\.body\.appendChild|host\.remove\(\)/);
  assert.doesNotMatch(controller, /window\.UDiscExport/);
  assert.doesNotMatch(html, /udisc-export\.js/);
});

test('manage players sheet is React-owned without legacy overlay DOM construction', () => {
  const html = readFileSync('score.html', 'utf8');
  const legacy = scoreControllerManagePlayersSource();
  const manage = scoreManagePlayersSource();
  assert.match(html, /id="scoreReactManagePlayersSheetApp"/);
  assert.match(legacy, /createManagePlayersSheetRenderer\(\)/);
  assert.match(legacy, /managePlayersSheet\.render\(\{/);
  assert.match(manage, /function ManagePlayersSheet\(props\)/);
  assert.match(manage, /function PairEditor\(\{ players, onSavePairs \}\)/);
  assert.match(manage, /document\.getElementById\("scoreReactManagePlayersSheetApp"\)/);
  assert.match(manage, /createRoot\(host\)/);
  assert.match(manage, /root\.render\(null\)/);
  assert.doesNotMatch(legacy, /const overlay = el\('div', 'overlay'\)/);
  assert.doesNotMatch(legacy, /const sheet = el\('div', 'sheet'\)/);
  assert.doesNotMatch(legacy, /pairInputs\.push/);
  assert.doesNotMatch(legacy, /overlay\.appendChild\(sheet\)/);
  assert.doesNotMatch(manage, /document\.createElement|document\.body\.appendChild|host\.remove\(\)/);
});

test('scorecard view is React-owned without legacy hole DOM construction', () => {
  const legacy = scoreControllerHoleSource();
  const scorecard = scorecardViewSource();
  const main = scoreMainSource();
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  assert.match(controller, /renderScoreBody\('scorecard', \{/);
  assert.match(controller, /buildScorecardViewState\(\{/);
  assert.match(main, /ScorecardView/);
  assert.match(scorecard, /function ScorecardView\(props\)/);
  assert.match(scorecard, /function ScoreRow\(props\)/);
  assert.match(scorecard, /nextHoleScore/);
  assert.match(scorecard, /Clear \$\{row\.label\} on hole/);
  assert.match(scorecard, /tee-order-hint/);
  assert.doesNotMatch(scorecard, /honors-chip/);
  assert.doesNotMatch(scorecard, /Throws first/);
  assert.match(scorecard, /function FinishCard\(props\)/);
  assert.match(scorecard, /function FinishDockBar\(props\)/);
  assert.match(scorecard, /score-glove-finish-dismiss/);
  assert.match(scorecard, /"aria-label": "Dismiss"/);
  assert.match(scorecard, /function ConfirmScoresSheet\(props\)/);
  assert.match(scorecard, /Finish card/);
  assert.match(scorecard, /Looks good — lock card/);
  assert.match(scorecard, /Anyone on this card can confirm/);
  assert.doesNotMatch(scorecard, /Agree — /);
  assert.match(scorecard, /score-glove-finish/);
  assert.match(scorecard, /useAccessibleDialog/);
  assert.match(scorecard, /createPortal/);
  assert.match(scorecard, /ScorePad/);
  assert.match(scorecard, /hole-media-chip/);
  assert.match(scorecard, /compact: true/);
  assert.match(scorecard, /HoleMap/);
  assert.match(scorecard, /score-glove-layout/);
  assert.match(scorecard, /players-/);
  assert.match(scorecard, /function LiveRoundStats\(props\)/);
  assert.match(scorecard, /function ScorePlayerRail\(props\)/);
  assert.match(scorecard, /collapsed-others/);
  assert.match(scorecard, /liveRoundStatsFromCard/);
  assert.match(scorecard, /readAllThrows/);
  assert.match(scorecard, /Live stats/);
  assert.match(scorecard, /LIVE_STATS_PEEK_IDS/);
  assert.match(scorecard, /aria-expanded/);
  assert.match(scorecard, /Minimize live stats/);
  assert.match(scorecard, /Expand live stats/);
  assert.doesNotMatch(scorecard, /if \(!props\.solo\) return null/);
  assert.match(scorecard, /export function SoloScorecardPreview/);
  assert.match(main, /SoloScorecardPreview/);
  assert.match(main, /get\("preview"\) === "solo-stats"/);
  assert.match(scorecard, /score-glove-dock/);
  assert.match(scorecard, /score-glove-scores/);
  assert.match(scorecard, /Share scorecard/);
  assert.match(scorecard, /showManage/);
  assert.doesNotMatch(scorecard, /if \(!props\.show\) return null/);
  assert.match(controller, /buildShareCard\(S/);
  assert.match(controller, /shareCardPng/);
  assert.match(controller, /canShareFiles/);
  assert.doesNotMatch(scorecard, /Your card is not ready yet/);
  assert.match(controller, /LIVE \+ '\/finish-card'/);
  assert.match(scorecard, /function HoleGrid\(props\)/);
  assert.match(scorecard, /onJumpHole/);
  assert.match(scorecard, /holegrid-rel/);
  assert.match(scorecard, /holegrid-score/);
  assert.match(controller, /onJumpHole: function \(index\)/);
  assert.match(scorecard, /export function ScorecardView\(props\)/);
  assert.match(scorecard, /WeatherStrip/);
  assert.match(scorecard, /HoleMap/);
  assert.match(scorecard, /your-turn-hint/);
  const holeMap = readFileSync('src/shared/hole-map.js', 'utf8');
  const holeMapModel = readFileSync('src/shared/hole-map-model.js', 'utf8');
  const html = readFileSync('score.html', 'utf8');
  assert.match(holeMap, /hole-map-satellite/);
  assert.match(holeMap, /SATELLITE_CREDIT/);
  assert.match(holeMap, /safeExternalUrl/);
  assert.match(holeMap, /compact/);
  assert.match(holeMap, /playerMarksOnMap/);
  assert.match(holeMap, /preserveAspectRatio: "xMidYMid meet"/);
  assert.match(holeMap, /hole-map-tee-pad/);
  assert.match(holeMap, /hole-map-tee-pad-front/);
  assert.match(holeMap, /teeRotationDeg/);
  assert.doesNotMatch(holeMap, /180 - heading/);
  assert.match(holeMap, /hole-map-basket-mark/);
  assert.match(holeMap, /hole-map-basket-flag/);
  assert.match(holeMap, /hole-map-basket-chain-body/);
  assert.match(holeMap, /compact \? 0\.6375 : 0\.75/);
  assert.match(holeMap, /hole-map-c1/);
  assert.match(holeMap, /hole-map-c2/);
  assert.match(holeMap, /function LieMark/);
  assert.match(holeMap, /onMapPoint/);
  assert.match(scorecard, /gpsErrorPolicy/);
  assert.match(scorecard, /visibilitychange/);
  assert.match(scorecard, /GPS_WATCH_OPTIONS/);
  assert.match(controller, /gpsErrorPolicy/);
  assert.match(controller, /GPS_WATCH_OPTIONS/);
  assert.match(controller, /locRetryTimer/);
  assert.match(scorecard, /gpsHudPrompt/);
  assert.match(scorecard, /withSelfLocation\(props\.playerLocations, props\.gpsFix, props\.selfMark\)/);
  assert.match(scorecard, /hole-range-hud-btn/);
  assert.match(html, /hole-range-hud-btn/);
  assert.match(html, /hole-range-hud-gps/);
  assert.match(html, /hole-map-player\.self/);
  assert.match(holeMap, /relClass === "self"/);
  assert.match(scorecard, /currentRangeHud/);
  assert.match(holeMapModel, /GPS_REMAINING_MAX_FT = 2500/);
  assert.doesNotMatch(holeMapModel, /primary\.ft > GPS_REMAINING_MAX_FT/);
  assert.match(scorecard, /getCurrentPosition/);
  assert.match(scorecard, /hud: h\(RangeHud/);
  assert.match(scorecard, /compact: true, key: "owner"/);
  assert.match(holeMap, /props\.hud/);
  assert.match(html, /score-glove-tools \.scorecard-owner/);
  assert.match(scorecard, /function RangeHud/);
  assert.match(scorecard, /hole-range-hud-len/);
  assert.match(scorecard, /hud\.holeFt/);
  assert.match(holeMap, /function ThrowMark/);
  assert.match(holeMap, /function FlyingDisc/);
  assert.match(holeMap, /hole-map-disc-flight/);
  assert.match(holeMap, /scoreFlight/);
  assert.match(holeMap, /hole-map-throw-line/);
  assert.match(holeMap, /Lie /);
  assert.match(holeMap, /Undo/);
  assert.match(scorecard, /addThrow/);
  assert.match(scorecard, /onUndoThrow/);
  assert.match(scorecard, /setScoreFlight/);
  assert.match(scorecard, /holeStatChips/);
  assert.match(scorecard, /onThrows/);
  assert.match(controller, /LIVE \+ '\/throws'/);
  assert.match(scorecard, /lastThrowHud/);
  assert.match(html, /hole-map-lie-actions/);
  assert.match(html, /@keyframes gvdg-disc-fly/);
  assert.match(html, /hole-map-disc-flight/);
  assert.match(html, /hole-range-hud-throw/);
  assert.match(holeMap, /focus: props\.focus/);
  assert.match(scorecard, /resolveMapFocus/);
  assert.match(scorecard, /nextTeeHud/);
  assert.match(scorecard, /onMarkLie/);
  assert.match(html, /hole-map-focus-btn/);
  assert.match(html, /hole-range-hud-next/);
  assert.match(holeMapModel, /function boundsForFocus/);
  assert.match(scorecard, /hole-range-hud/);
  assert.match(scorecard, /onMapPoint/);
  assert.match(scorecard, /aria-pressed/);
  assert.match(html, /\.hole-map-tee-pad-front \{/);
  assert.match(html, /\.hole-map-basket-flag \{/);
  assert.match(html, /\.hole-map-c1 \{/);
  assert.match(html, /\.hole-map-c2 \{/);
  assert.match(html, /\.hole-range-hud \{/);
  assert.match(html, /\.hole-range-hud-len \{/);
  assert.match(html, /\.score-glove-tool\.active \{/);
  assert.match(html, /\.round-tools \{/);
  assert.match(html, /grid-template-columns: repeat\(auto-fit, minmax\(0, 1fr\)\)/);
  assert.match(html, /\.score-glove-dock \{/);
  assert.match(html, /\.score-glove-finish \{/);
  assert.match(html, /\.score-glove-finish-dismiss \{/);
  assert.match(html, /\.confirm-score-row \{/);
  assert.match(html, /flex: 0 1 auto; max-height: min\(38dvh, 20rem\)/);
  assert.match(html, /\.score-glove-layout\.solo \.score-glove-stage \.hole-map-frame \{/);
  assert.match(html, /\.score-player-rail \{/);
  assert.match(html, /\.score-player-chip \{/);
  assert.match(html, /\.live-round-stats \{/);
  assert.match(html, /overflow: hidden;/);
  assert.match(html, /\.score-glove-layout:not\(\.solo\) \.live-round-stats/);
  assert.match(html, /\.live-round-stats\.compact:not\(\.open\)/);
  assert.match(html, /\.live-round-stats-toggle/);
  assert.match(html, /\.score-glove-stage \.hole-map-lie-actions/);
  assert.match(html, /\.score-glove-stage \.hole-range-hud \{/);
  assert.match(html, /\.live-stats-mix-legend \{/);
  assert.match(html, /\.live-stats-grid \{/);
  assert.match(html, /grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(html, /display-mode: browser/);
  assert.match(html, /height: 100svh/);
  assert.match(html, /\.score-glove-scores \{/);
  assert.match(html, /\.holegrid \{ display: grid; grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(html, /\.weather-strip-compact \{/);
  assert.match(html, /display: flex; align-items: center;/);
  assert.match(html, /\.weather-compact-copy/);
  assert.match(html, /\.weather-strip-compact \.weather-graphic/);
  assert.match(html, /\.weather-strip-compact \.weather-wind,/);
  assert.match(html, /max-height: min\(28dvh, 13rem\)/);
  assert.match(html, /justify-content: center;/);
  assert.match(html, /width: auto; grid-column: auto;/);
  const weather = scoreWeatherSource();
  assert.match(weather, /weather-compact-copy/);
  assert.match(weather, /weather-wind-compact/);
  assert.match(weather, /WeatherGraphic/);
  assert.match(weather, /graphic: summary && summary.graphic/);
  assert.doesNotMatch(weather, /if \(weather && weather\.current\) void enableCompass\(\)/);
  assert.match(main, /requestCrottsHelp/);
  assert.match(main, /CrottsWidget/);
  assert.doesNotMatch(scorecard, /disabled: current == null/);
  assert.match(scorecard, /Set \$\{row\.label\} on hole \$\{props\.hole\.hole\} to \$\{nextMinus\}/);
  assert.doesNotMatch(html, /\.round-code \{ flex: 1 1 7\.5rem;/);
  assert.doesNotMatch(scorecard, /className: "round-code"/);
  assert.match(scorecard, /compact: true/);
  assert.match(html, /\.holegrid-rel/);
  assert.match(html, /\.score-glove-stage \.holegrid \{/);
  assert.match(html, /\.holegrid button\.even \{[^}]*var\(--accent\)/s);
  assert.match(html, /\.holegrid button\.over \{[^}]*var\(--team-red\)/s);
  assert.match(html, /\.holegrid button\.under \{[^}]*var\(--under\)/s);
  assert.match(html, /\.holegrid button\.cur\.over \{[^}]*var\(--team-red\)/s);
  assert.match(html, /\.holegrid button\.cur\.under \{[^}]*var\(--under\)/s);
  assert.match(html, /\.holegrid button\.cur\.even \{[^}]*var\(--accent\)/s);
  assert.doesNotMatch(html, /\.holegrid button\.over:not\(\.cur\)/);
  assert.match(html, /\.rel\.even \{ color: var\(--accent\)/);
  assert.match(html, /\.rel\.over \{ color: var\(--team-red\)/);
  assert.match(html, /\.hole-map-satellite/);
  assert.match(html, /\.hole-map-frame/);
  assert.match(html, /\.tee-order-hint/);
  assert.match(html, /\.tee-pos/);
  assert.doesNotMatch(html, /\.honors-chip/);
  assert.match(html, /\.hole-map-compact/);
  assert.match(html, /\.hole-map-player/);
  assert.match(html, /\.hole-map-player-dot/);
  assert.doesNotMatch(legacy, /const head = el\('div', 'hole-head'\)/);
  assert.doesNotMatch(legacy, /const box = el\('div', 'card'\)/);
  assert.doesNotMatch(legacy, /const row = el\('div', 'prow'/);
  assert.doesNotMatch(legacy, /const grid = el\('div', 'holegrid'\)/);
  assert.doesNotMatch(legacy, /document\.createElement\('select'\)/);
  assert.doesNotMatch(scorecard, /createRoot|getElementById\("app"\)|replaceChildren/);
});

test('PDGA tee order puts the previous-hole winner first and keeps ties stable', async () => {
  const { applyTeeOrder, buildScorecardViewState, scoreRows } = await import(new URL('../src/score-app/score-view-model.js', import.meta.url));
  const base = {
    holes: [{ hole: 1, par: 3 }, { hole: 2, par: 3 }, { hole: 3, par: 3 }],
    cardmates: [
      { index: 0, name: 'Kevin', isMe: true, scores: { 1: 3, 2: 4 } },
      { index: 1, name: 'Aaron', scores: { 1: 2, 2: 4 } },
      { index: 2, name: 'Tyler', scores: { 1: 3, 2: 3 } },
    ],
    myIndex: 0,
    roundConfig: { groupFormat: 'singles', scoringStyle: 'stroke' },
    scoreTargets: [],
    snap: { standings: [] },
  };

  const listed = scoreRows({ ...base, holeIdx: 0 });
  const firstTee = applyTeeOrder(base, listed, 0, 0);
  assert.deepEqual(firstTee.rows.map((row) => row.label), ['Kevin (you)', 'Aaron', 'Tyler']);
  assert.equal(firstTee.honorsReady, false);
  assert.equal(firstTee.hint, 'Tee order: Kevin · then Aaron, Tyler');

  const hole2 = applyTeeOrder(base, listed, 1, 0);
  assert.deepEqual(hole2.rows.map((row) => row.label), ['Aaron', 'Kevin (you)', 'Tyler']);
  assert.equal(hole2.honorsReady, true);
  assert.equal(hole2.hint, 'Honors: Aaron · then Kevin, Tyler');

  const hole3 = applyTeeOrder(base, listed, 2, 0);
  assert.deepEqual(hole3.rows.map((row) => row.label), ['Tyler', 'Aaron', 'Kevin (you)']);
  assert.equal(hole3.hint, 'Honors: Tyler · then Aaron, Kevin');

  const waiting = applyTeeOrder({
    ...base,
    cardmates: [
      { index: 0, name: 'Kevin', isMe: true, scores: { 1: 3 } },
      { index: 1, name: 'Aaron', scores: { 1: 2 } },
      { index: 2, name: 'Tyler', scores: { 1: 3 } },
    ],
  }, listed, 2, 0);
  assert.deepEqual(waiting.rows.map((row) => row.label), ['Aaron', 'Kevin (you)', 'Tyler']);
  assert.equal(waiting.honorsReady, false);
  assert.equal(waiting.hint, 'Tee order after hole 2 scores');

  const view = buildScorecardViewState({
    state: { ...base, holeIdx: 1, conflicts: [], missing: [], scoreTargetError: null, weather: null, pots: null },
    mode: 'round',
    roundCode: 'QA1234',
    scorerIndex: 0,
    teeSign: null,
  });
  assert.equal(view.rows[0].label, 'Aaron');
  assert.equal(view.rows[0].honors, true);
  assert.equal(view.rows[0].teePosition, 1);
  assert.equal(view.rows[1].label, 'Kevin (you)');
  assert.equal(view.teeOrderHint, 'Honors: Aaron · then Kevin, Tyler');

  const doubles = applyTeeOrder({
    holes: [{ hole: 1, par: 3 }, { hole: 2, par: 3 }],
    cardmates: [
      { index: 0, name: 'A', scores: { 1: 4 } },
      { index: 1, name: 'B', scores: { 1: 4 } },
      { index: 2, name: 'C', scores: { 1: 3 } },
      { index: 3, name: 'D', scores: { 1: 3 } },
    ],
    roundConfig: { groupFormat: 'doubles', scoringStyle: 'stroke' },
    scoreTargets: [
      { id: 'pair:red', type: 'pair', label: 'Red', members: ['A', 'B'], playerIndexes: [0, 1] },
      { id: 'pair:blue', type: 'pair', label: 'Blue', members: ['C', 'D'], playerIndexes: [2, 3] },
    ],
  }, [
    { type: 'pair', targetId: 'pair:red', label: 'Red', playerIndexes: [0, 1] },
    { type: 'pair', targetId: 'pair:blue', label: 'Blue', playerIndexes: [2, 3] },
  ], 1, 0);
  assert.deepEqual(doubles.rows.map((row) => row.label), ['Blue', 'Red']);
  assert.equal(doubles.hint, 'Honors: Blue · then Red');
});

test('scorecard and watch open on the hole in progress', async () => {
  const {
    activeHoleIndex,
    cardHoleComplete,
    fieldActiveHoleIndex,
  } = await import(new URL('../src/score-app/score-view-model.js', import.meta.url));
  const holes = Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 3 }));
  function completeFromScores(scores) {
    return (hole) => typeof scores[hole] === 'number';
  }

  assert.equal(activeHoleIndex({ holes, startingHole: 1, isHoleComplete: () => false }), 0);
  assert.equal(activeHoleIndex({
    holes,
    startingHole: 1,
    isHoleComplete: completeFromScores({ 1: 3, 2: 3, 3: 4, 4: 3 }),
  }), 4);

  const shotgun = { 8: 3, 9: 3, 10: 4 };
  assert.equal(activeHoleIndex({
    holes,
    startingHole: 8,
    isHoleComplete: completeFromScores(shotgun),
  }), 10);

  assert.equal(activeHoleIndex({
    holes,
    startingHole: 17,
    isHoleComplete: completeFromScores({ 17: 3, 18: 3, 1: 2 }),
  }), 1);

  const finished = {};
  for (let hole = 1; hole <= 18; hole++) finished[hole] = 3;
  assert.equal(activeHoleIndex({
    holes,
    startingHole: 1,
    isHoleComplete: completeFromScores(finished),
  }), 17);
  assert.equal(activeHoleIndex({
    holes,
    startingHole: 8,
    isHoleComplete: completeFromScores(finished),
  }), 6);

  const cardState = {
    holes,
    cardmates: [
      { index: 0, name: 'Kevin', isMe: true, scores: { 1: 3, 2: 4 } },
      { index: 1, name: 'Aaron', scores: { 1: 2 } },
    ],
    roundConfig: { groupFormat: 'singles', scoringStyle: 'stroke' },
    scoreTargets: [],
  };
  assert.equal(cardHoleComplete(cardState, 1, 0), true);
  assert.equal(cardHoleComplete(cardState, 2, 0), false);
  assert.equal(activeHoleIndex({
    holes,
    startingHole: 1,
    isHoleComplete: (hole) => cardHoleComplete(cardState, hole, 0),
  }), 1);

  assert.equal(fieldActiveHoleIndex({
    holes,
    players: [
      { name: 'A', startingHole: 1, scores: { 1: 3, 2: 3, 3: 3, 4: 3, 5: 3 } },
      { name: 'B', startingHole: 1, scores: { 1: 3, 2: 3, 3: 3, 4: 3, 5: 4 } },
      { name: 'C', startingHole: 1, scores: { 1: 3, 2: 3, 3: 3, 4: 3, 5: 3 } },
      { name: 'D', startingHole: 1, scores: { 1: 4 } },
    ],
  }), 5);

  const controller = scoreControllerSource();
  const watch = readFileSync('src/score-app/watch-view.js', 'utf8');
  assert.match(controller, /activeHoleIndex\(/);
  assert.match(controller, /fieldActiveHoleIndex\(/);
  assert.match(controller, /cardHoleComplete\(S, hole, S\.scorerIndex\)/);
  assert.match(watch, /props\.activeHoleIndex/);
  assert.match(watch, /followLive/);
});

test('stepper minus from blank sets birdie; minus from 1 clears the hole', async () => {
  const { nextHoleScore } = await import(new URL('../src/score-app/score-view-model.js', import.meta.url));
  assert.equal(nextHoleScore(null, 3, 'plus'), 3);
  assert.equal(nextHoleScore(null, 3, 'minus'), 2);
  assert.equal(nextHoleScore(null, 4, 'minus'), 3);
  assert.equal(nextHoleScore(null, 2, 'minus'), 1);
  assert.equal(nextHoleScore(2, 3, 'minus'), 1);
  assert.equal(nextHoleScore(1, 3, 'minus'), null);
  assert.equal(nextHoleScore(1, 3, 'plus'), 2);
  const controller = scoreControllerSource();
  assert.match(controller, /if \(strokes == null\) delete cm\.scores\[hole\]/);
});

test('live CTP and ace pot strip uses public event reads without scoring writes', () => {
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  const scorecard = scorecardViewSource();
  const watch = readFileSync('src/score-app/watch-view.js', 'utf8');
  const pots = readFileSync('src/score-app/pots-strip.js', 'utf8');
  const model = readFileSync('src/shared/live-pots-model.js', 'utf8');
  const html = readFileSync('score.html', 'utf8');
  assert.match(controller, /\/events\/' \+ EVENT_ID \+ '\/ctps'/);
  assert.match(controller, /\/events\/' \+ EVENT_ID \+ '\/ace-pot'/);
  assert.match(controller, /LIVE \+ '\/ctp'/);
  assert.match(controller, /auth: false, guest: false/);
  assert.match(controller, /startPotsPolling\(\)/);
  assert.doesNotMatch(controller, /\/admin\/events\/.*\/ctps/);
  assert.doesNotMatch(controller, /store-credit/);
  assert.match(scorecard, /PotsStrip/);
  assert.match(scorecard, /function CtpClaim/);
  assert.match(scorecard, /ctp-badge/);
  assert.match(watch, /PotsStrip/);
  assert.match(pots, /data-react-live-pots/);
  assert.match(model, /export function buildLivePots/);
  assert.match(html, /\.pots-strip/);
  assert.match(html, /\.holegrid button\.ctp/);
});

test('spectator watch mode loads the public snapshot and never joins the card', () => {
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  const main = scoreMainSource();
  const watch = readFileSync('src/score-app/watch-view.js', 'utf8');
  const shared = readFileSync('src/shared/live-watch.js', 'utf8');
  assert.match(shared, /export function liveWatchHref/);
  assert.match(controller, /const ROUND_CODE = liveRoundCodeFromSearch\(params\)/);
  assert.match(controller, /const WATCH = isLiveWatchRequest\(params\)/);
  assert.match(controller, /async function loadWatch\(\)/);
  assert.match(controller, /api\(LIVE, \{ auth: false, guest: false \}\)/);
  assert.match(controller, /if \(WATCH && \(EVENT_ID \|\| ROUND_CODE\)\)/);
  assert.match(controller, /if \(WATCH\) return;/);
  assert.match(main, /WatchView/);
  assert.match(watch, /data-react-live-watch/);
  assert.match(watch, /Copy watch link/);
  assert.match(watch, /HoleMap/);
  assert.match(watch, /function WatchHoles/);
  assert.match(watch, /props\.activeHoleIndex/);
  assert.match(watch, /followLive/);
  assert.match(watch, /function WatchTeeSign/);
  assert.match(watch, /playerLocations/);
  assert.match(watch, /function WatchMatchCards/);
  assert.match(watch, /function WatchStrokeStrip/);
  assert.match(watch, /watchHoleScoreChips/);
  assert.match(watch, /watchStrokeHoleChips/);
  assert.match(watch, /watchMatchCards/);
  assert.match(controller, /function watchHoleViews\(\)/);
  assert.match(controller, /holes: watchHoleViews\(\)/);
  assert.match(controller, /players: Array.isArray\(snap\.players\)/);
  const html = readFileSync('score.html', 'utf8');
  assert.match(html, /\.hole-map-score-chip/);
  assert.match(html, /\.watch-match-card/);
  assert.match(html, /\.watch-stroke-strip/);
  assert.match(controller, /LIVE \+ '\/location'/);
  assert.match(controller, /watchPosition/);
  assert.match(controller, /function applyPlayerLocations/);
  assert.match(controller, /function locationStamp/);
  const watchBoot = controller.slice(controller.indexOf('async function loadWatch'), controller.indexOf('function watchRoundCode'));
  assert.doesNotMatch(watchBoot, /\/join/);
});

test('live scoring paints the signed-in player dashboard theme onto the score page', () => {
  const html = readFileSync('score.html', 'utf8');
  const main = scoreMainSource();
  const controller = scoreControllerSource();
  const session = readFileSync('src/shared/player-theme-session.js', 'utf8');
  assert.match(html, /body\.player-theme-page/);
  assert.match(html, /body\.player-theme-active/);
  assert.match(html, /--player-theme-image/);
  assert.match(main, /from "\.\.\/shared\/player-theme-chrome\.js"/);
  assert.match(main, /usePlayerThemeSession/);
  const chrome = readFileSync('src/shared/player-theme-chrome.js', 'utf8');
  assert.match(chrome, /togglePlayerThemeMode/);
  assert.match(chrome, /playerTheme\.mode === "dark"/);
  assert.match(controller, /notifyScoreAuthChanged/);
  assert.match(session, /\/me\/dashboard-theme/);
  assert.match(session, /gvdg:score-auth/);
});

test('score weather strip is React-owned without legacy DOM replacement', () => {
  const controller = readFileSync('src/score-app/score-controller.js', 'utf8');
  const scorecard = scorecardViewSource();
  const weather = scoreWeatherSource();
  const sharedWeather = readFileSync('src/shared/weather-model.js', 'utf8');
  assert.match(scorecard, /import \{ WeatherStrip \} from "\.\/weather-strip\.js"/);
  assert.match(scorecard, /h\(WeatherStrip, \{ compact: true, key: "weather"/);
  assert.match(controller, /extrasChanged\) renderHole\(\); return;/);
  assert.match(scoreViewModelSource(), /weather: state\.weather/);
  assert.match(weather, /export function WeatherStrip\(props\)/);
  assert.match(weather, /from "\.\.\/shared\/weather-model\.js"/);
  assert.doesNotMatch(weather, /weatherApi|GVDGWeather/);
  assert.doesNotMatch(sharedWeather, /GVDGWeather|createElement|appendChild|replaceChildren/);
  assert.match(sharedWeather, /currentWeatherSummary/);
  assert.match(sharedWeather, /windArrowModel/);
  assert.match(sharedWeather, /subscribeCompass/);
  assert.doesNotMatch(scorecard, /WeatherSlot/);
  assert.doesNotMatch(controller, /function roundWeatherNode\(\)/);
  assert.doesNotMatch(controller, /function refreshWeatherStrip\(\)/);
  assert.doesNotMatch(controller, /querySelector\('\.weather-strip'\)/);
  assert.doesNotMatch(controller, /replaceWith\(fresh\)/);
  assert.doesNotMatch(controller, /GVDGWeather\.buildWeatherStrip\(document/);
});
