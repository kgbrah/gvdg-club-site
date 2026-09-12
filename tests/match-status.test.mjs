import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { displayMatchStatus } from '../src/shared/match-status.js';

test('displayMatchStatus: AS when missing, empty, or all square', () => {
  assert.equal(displayMatchStatus(null), 'AS');
  assert.equal(displayMatchStatus({}), 'AS');
  assert.equal(displayMatchStatus({ status: '', outcome: 'draw' }), 'AS');
  assert.equal(displayMatchStatus({ status: 'AS', outcome: 'draw' }), 'AS');
});

test('displayMatchStatus: leader stays N up; trailer is N down', () => {
  assert.equal(displayMatchStatus({ status: '1 up', outcome: 'leading' }), '1 up');
  assert.equal(displayMatchStatus({ status: '1 down', outcome: 'trailing' }), '1 down');
  assert.equal(displayMatchStatus({ status: '1 up', outcome: 'trailing' }), '1 down');
  assert.equal(displayMatchStatus({ status: '2 up (dormie)', outcome: 'leading' }), '2 up (dormie)');
  assert.equal(displayMatchStatus({ status: '2 up (dormie)', outcome: 'trailing' }), '2 down (dormie)');
  assert.equal(displayMatchStatus({ status: '2 down (dormie)', outcome: 'trailing' }), '2 down (dormie)');
});

test('displayMatchStatus: closed match remaps won N&M to lost for the trailer', () => {
  assert.equal(displayMatchStatus({ status: 'won 3&2', outcome: 'won' }), 'won 3&2');
  assert.equal(displayMatchStatus({ status: 'won 3&2', outcome: 'lost' }), 'lost 3&2');
  assert.equal(displayMatchStatus({ status: 'lost 3&2', outcome: 'lost' }), 'lost 3&2');
});

test('matchplay status helper stays module-only without a root shim', () => {
  const shared = readFileSync('src/shared/match-status.js', 'utf8');
  assert.equal(existsSync('match-status.js'), false);
  assert.doesNotMatch(shared, /window\./);
});

test('every matchplay score surface uses displayMatchStatus', () => {
  const surfaces = {
    'src/public-app/events-detail-app.js': /from "\.\.\/shared\/match-status\.js"/,
    'src/members-app/club-ratings.js': /from "\.\.\/shared\/match-status\.js"/,
    'src/members-app/activity-panels.js': /from "\.\.\/shared\/match-status\.js"/,
    'src/score-app/leaderboard-sheet.js': /from "\.\.\/shared\/match-status\.js"/,
    'src/score-app/score-view-model.js': /from "\.\.\/shared\/match-status\.js"/,
    'src/admin-app/scoring-scorecard.js': /from "\.\.\/shared\/match-status\.js"/,
  };
  for (const [path, pattern] of Object.entries(surfaces)) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, pattern, path);
    assert.match(source, /displayMatchStatus/, path);
    assert.doesNotMatch(source, /replace\(\/\^won /, `${path} should not inline the won→lost remap`);
  }
});
