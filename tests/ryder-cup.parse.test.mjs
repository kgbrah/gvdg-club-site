// Plain Node test for the Ryder Cup CSV parsers. Run with:
//   node --test tests/ryder-cup.parse.test.mjs
// (from the repo root). Fixtures are copied into tests/fixtures/ so this is
// fully self-contained and runs headless — no network, no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseCsv,
  parseMatchGrid,
  parseMatchGridRows,
  parseScoreboard,
} from '../ryder-cup.js';

const here = dirname(fileURLToPath(import.meta.url));
const gridCsv = readFileSync(join(here, 'fixtures', 'ryder-grid.csv'), 'utf8');
const scoreboardCsv = readFileSync(
  join(here, 'fixtures', 'ryder-scoreboard.csv'),
  'utf8'
);

// --- CSV line parser ----------------------------------------------------------
test('parseCsv handles quoted fields, embedded commas and escaped quotes', () => {
  const rows = parseCsv('a,"b,c","d""e",f\n1,2,3,4');
  assert.deepEqual(rows[0], ['a', 'b,c', 'd"e', 'f']);
  assert.deepEqual(rows[1], ['1', '2', '3', '4']);
});

test('parseCsv tolerates CRLF line endings', () => {
  const rows = parseCsv('x,y\r\nz,w\r\n');
  assert.deepEqual(rows, [
    ['x', 'y'],
    ['z', 'w'],
  ]);
});

// --- Match grid ---------------------------------------------------------------
test('parseMatchGrid: nine week groups including the Finale', () => {
  const { weeks } = parseMatchGrid(gridCsv);
  assert.equal(weeks.length, 9);
  assert.deepEqual(
    weeks.map((w) => w.label),
    ['Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5', 'Week 6', 'Week 7', 'Week 8', 'Finale']
  );
  // Finale carries a date in the Dates row.
  assert.equal(weeks[8].dates, '8/22');
});

test('parseMatchGrid: Week 1 has 12 matchups', () => {
  const { weeks } = parseMatchGrid(gridCsv);
  assert.equal(weeks[0].matches.length, 12);
  // Matchup numbers run 1..12 in order.
  assert.deepEqual(
    weeks[0].matches.map((m) => m.num),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  );
});

test('parseMatchGrid: known matchup 1 (Juan Martinez vs Jesus, 1&0, winner not derivable)', () => {
  const { weeks } = parseMatchGrid(gridCsv);
  const m1 = weeks[0].matches[0];
  assert.equal(m1.num, 1);
  assert.equal(m1.red, 'Juan Martinez');
  assert.equal(m1.blue, 'Jesus');
  assert.equal(m1.score, '1&0');
  // The A&B score does not encode the winning color, so winner stays null.
  assert.equal(m1.winner, null);
});

test('parseMatchGridRows: green-filled player cells mark the winning side', () => {
  const rows = parseCsv(gridCsv);
  rows[5][3] = { text: rows[5][3], fill: 'FF00FF00' };
  const { weeks } = parseMatchGridRows(rows);
  assert.equal(weeks[0].matches[0].winner, 'blue');
});

test('parseMatchGrid: unplayed matchups have empty score and null winner', () => {
  const { weeks } = parseMatchGrid(gridCsv);
  // Matchups 2 and 3 in Week 1 have no score recorded.
  const m2 = weeks[0].matches[1];
  assert.equal(m2.num, 2);
  assert.equal(m2.score, '');
  assert.equal(m2.winner, null);
  // Later weeks have no Score sub-column yet -> every match is unplayed.
  for (const m of weeks[1].matches) {
    assert.equal(m.score, '');
    assert.equal(m.winner, null);
  }
});

test('parseMatchGrid: team points come from the official "Points Scored" row (Red 8 / Blue 12)', () => {
  const { teamPoints } = parseMatchGrid(gridCsv);
  // Authoritative organizer tally — NOT re-derived from the per-match A&B scores.
  assert.equal(teamPoints.red, 8);
  assert.equal(teamPoints.blue, 12);
});

test('winnerFromScore: 0-up is a tie; team totals stay authoritative regardless of match scores', () => {
  // Tweaking a single match score to "0&3" must NOT change the official team totals,
  // proving totals are read from the "Points Scored" row, not summed from matches.
  const tweaked = gridCsv.replace('"","1","Juan Martinez","Jesus","1&0"', '"","1","Juan Martinez","Jesus","0&3"');
  const { weeks, teamPoints } = parseMatchGrid(tweaked);
  assert.equal(weeks[0].matches[0].winner, 'tie');
  assert.equal(teamPoints.red, 8);
  assert.equal(teamPoints.blue, 12);
});

// --- Scoreboard ---------------------------------------------------------------
test('parseScoreboard: team names parse to "Juan Team" / "Jesus Team"', () => {
  const sb = parseScoreboard(scoreboardCsv);
  assert.equal(sb.red.name, 'Juan Team');
  assert.equal(sb.blue.name, 'Jesus Team');
});

test('parseScoreboard: full 12-player rosters with quoted nicknames intact', () => {
  const sb = parseScoreboard(scoreboardCsv);
  assert.equal(sb.red.players.length, 12);
  assert.equal(sb.blue.players.length, 12);
  // Nested escaped quotes survive the CSV parse.
  assert.equal(sb.red.players[0], 'Juan "Him" Martinez');
  assert.equal(sb.blue.players[0], 'Jesus');
  assert.equal(sb.red.players[11], 'Eric Davis');
  assert.equal(sb.blue.players[11], 'Leo Hernandez');
});
