import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function scoreSetupSource() {
  const source = readFileSync('src/score-app/score-legacy.js', 'utf8');
  const start = source.indexOf('async function renderLayoutPick(course)');
  const end = source.indexOf('async function addGuestPrompt()');
  assert.notEqual(start, -1, 'renderLayoutPick function should exist');
  assert.notEqual(end, -1, 'addGuestPrompt should follow createRound');
  return source.slice(start, end);
}

test('casual round flow shows setup after layout selection', () => {
  const source = scoreSetupSource();
  assert.match(source, /function renderSetupPick\(course, layout\)/);
  assert.match(source, /renderSetupPick\(course, L\)/);
  assert.match(source, /data-score-setup', 'casual-format'/);
  assert.match(source, /data-group-format/);
  assert.match(source, /data-scoring-style/);
  assert.match(source, /Group format/);
  assert.match(source, /Scoring style/);
  assert.match(source, /Singles/);
  assert.match(source, /Doubles/);
  assert.match(source, /Stroke play/);
  assert.match(source, /Match play/);
});

test('createRound sends explicit live scoring config defaults and selections', () => {
  const source = scoreSetupSource();
  assert.match(source, /return \{ groupFormat: 'singles', scoringStyle: 'stroke' \};/);
  assert.match(source, /selected\[group\.key\] = opt\.value; refresh\(\);/);
  assert.match(source, /createRound\(course, layout, selected\)/);
  assert.match(source, /const liveScoringConfig = config \|\| defaultLiveScoringConfig\(\);/);
  assert.match(source, /body: \{ course_id: course\.id, layout_id: layout\.id, liveScoringConfig: \{ groupFormat: liveScoringConfig\.groupFormat, scoringStyle: liveScoringConfig\.scoringStyle \} \}/);
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
  assert.match(source, /savePairLabels\(pairInputs, overlay\)/);
});

test('player leaderboard renders matchplay and pair labels without primary to-par ranking', () => {
  const source = readFileSync('src/score-app/score-legacy.js', 'utf8');
  assert.match(source, /const resultHead = isMatchplayScoring\(\) \? 'Match' : 'To par'/);
  assert.ok(source.includes("s.members.join(' / ')"));
  assert.match(source, /s\.match && s\.match\.status/);
  assert.match(source, /Pair changes are blocked after scoring starts/);
});
