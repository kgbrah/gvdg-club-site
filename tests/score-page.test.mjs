import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function scoreSetupSource() {
  const source = readFileSync('src/score-app/setup-flow.js', 'utf8');
  return source;
}

function scoreLegacySetupSource() {
  const source = readFileSync('src/score-app/score-legacy.js', 'utf8');
  const start = source.indexOf('async function renderLayoutPick(course)');
  const end = source.indexOf('async function addGuestPrompt()');
  assert.notEqual(start, -1, 'renderLayoutPick function should exist');
  assert.notEqual(end, -1, 'addGuestPrompt should follow createRound');
  return source.slice(start, end);
}

function scoreLeaderboardSource() {
  return readFileSync('src/score-app/leaderboard-sheet.js', 'utf8');
}

function scoreManagePlayersSource() {
  return readFileSync('src/score-app/manage-players-sheet.js', 'utf8');
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
  const fullLegacy = readFileSync('src/score-app/score-legacy.js', 'utf8');
  assert.match(fullLegacy, /if \(!setupFlow \|\| typeof setupFlow\.render !== 'function'\) throw new Error\('Missing score setup renderer'\)/);
  assert.doesNotMatch(legacy, /const row = el\('button', 'tap-row'\)/);
  assert.doesNotMatch(legacy, /const btn = el\('button', 'setup-option'\)/);
  assert.doesNotMatch(legacy, /selected\[group\.key\] = opt\.value/);
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
  assert.match(legacy, /createLeaderboardSheetRenderer\(\)/);
  assert.match(legacy, /leaderboardSheet\.render\(\{/);
  assert.match(leaderboard, /function LeaderboardSheet\(props\)/);
  assert.match(leaderboard, /createRoot\(host\)/);
  assert.doesNotMatch(legacy, /const overlay = el\('div', 'overlay'\)/);
  assert.doesNotMatch(legacy, /const table = el\('table', 'lb'\)/);
  assert.doesNotMatch(legacy, /sheet\.appendChild\(el\('h2', 'section', 'Live Leaderboard'\)\)/);
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
