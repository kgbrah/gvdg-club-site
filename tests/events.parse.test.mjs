// Plain Node test for the events hub pure helpers. Run with:
//   node --test tests/events.parse.test.mjs
// (from the repo root). No network, no DOM — exercises normalize/bucket/group
// and the defensive date formatter against inline fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VALID_STATUSES,
  VALID_TYPES,
  normalizeEvent,
  bucketEvents,
  groupPlayersByDivision,
  parseEventDate,
  formatEventDate,
  typeLabel,
  statusLabel,
  buildCourseIndex,
  courseNameFor,
  playFormatForDisplay,
  scoringFormatForDisplay,
  isTeamRound,
  roundFormatLabel,
  liveStandingsForDisplay,
} from '../events.js';

// --- normalizeEvent -----------------------------------------------------------
test('normalizeEvent fills safe defaults for a sparse object', () => {
  const ev = normalizeEvent({ id: 7 });
  assert.equal(ev.id, '7'); // coerced to string
  assert.equal(ev.name, 'Untitled Event');
  assert.equal(ev.status, 'scheduled'); // default
  assert.equal(ev.date, null);
  assert.deepEqual(ev.players, []);
});

test('normalizeEvent is null-safe', () => {
  const ev = normalizeEvent(null);
  assert.equal(ev.name, 'Untitled Event');
  assert.equal(ev.notes, '');
  assert.deepEqual(ev.players, []);
  assert.equal(ev.layout_id, ''); // T4: layout_id default is the empty string
});

test('normalizeEvent passes through the selected layout_id as a string (T4 tee-sign render)', () => {
  assert.equal(normalizeEvent({ id: 1, layout_id: 99 }).layout_id, '99');
  assert.equal(normalizeEvent({ id: 1 }).layout_id, '');
});

test('normalizeEvent preserves play_format for event detail format labels', () => {
  assert.equal(normalizeEvent({ id: 1, format: 'matchplay', play_format: 'doubles' }).play_format, 'doubles');
  assert.equal(normalizeEvent({ id: 1 }).play_format, '');
});

test('round format helpers split play format from scoring format', () => {
  const ev = normalizeEvent({ id: 1, format: 'matchplay', play_format: 'doubles' });
  assert.equal(playFormatForDisplay(ev), 'doubles');
  assert.equal(scoringFormatForDisplay(ev), 'matchplay');
  assert.equal(isTeamRound(ev), true);
  assert.equal(roundFormatLabel(ev), 'Doubles · Matchplay');
  assert.equal(roundFormatLabel(normalizeEvent({ id: 2 })), '');
});

test('liveStandingsForDisplay adds doubles side player names without changing standings order', () => {
  const rows = liveStandingsForDisplay({
    format: 'matchplay',
    playFormat: 'doubles',
    teamRequired: true,
    players: [
      { name: 'Red 1', team: 'Red' },
      { name: 'Red 2', team: 'Red' },
      { name: 'Blue 1', team: 'Blue' },
      { name: 'Blue 2', team: 'Blue' },
    ],
    standings: [
      { name: 'Red', team: 'Red', matchLabel: '1 Up' },
      { name: 'Blue', team: 'Blue', matchLabel: '1 Down' },
    ],
  });
  assert.equal(rows[0].playersText, 'Red 1 / Red 2');
  assert.equal(rows[1].playersText, 'Blue 1 / Blue 2');
});

test('normalizeEvent preserves an unknown status verbatim', () => {
  const ev = normalizeEvent({ id: 1, status: 'postponed' });
  assert.equal(ev.status, 'postponed');
});

// --- enum labels --------------------------------------------------------------
test('typeLabel / statusLabel map known enums and pass unknowns through', () => {
  assert.equal(typeLabel('league_round'), 'League Round');
  assert.equal(typeLabel('tournament'), 'Tournament');
  assert.equal(typeLabel('something_new'), 'something_new');
  assert.equal(typeLabel(null), 'Event');
  assert.equal(statusLabel('live'), 'Live');
  assert.equal(statusLabel('final'), 'Final');
  assert.equal(statusLabel(null), '');
  // Every documented enum has a label.
  for (const t of VALID_TYPES) assert.notEqual(typeLabel(t), undefined);
  for (const s of VALID_STATUSES) assert.notEqual(statusLabel(s), undefined);
});

// --- date handling ------------------------------------------------------------
test('parseEventDate tolerates ISO, date-only, null and junk', () => {
  assert.ok(parseEventDate('2026-07-04') instanceof Date);
  assert.ok(parseEventDate('2026-07-04T17:30:00Z') instanceof Date);
  assert.equal(parseEventDate(null), null);
  assert.equal(parseEventDate(''), null);
  assert.equal(parseEventDate('not a date'), null);
});

test('formatEventDate never throws and labels missing dates', () => {
  assert.equal(formatEventDate(null), 'Date TBD');
  assert.equal(formatEventDate('garbage'), 'Date TBD');
  const out = formatEventDate('2026-07-04');
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
  // Date-only renders without a time component.
  assert.ok(!/\d:\d\d/.test(out), `expected no time in "${out}"`);
});

// --- bucketEvents -------------------------------------------------------------
const SAMPLE = [
  { id: 'a', name: 'Live Now', status: 'live', date: '2026-06-23' },
  { id: 'b', name: 'Soon', status: 'scheduled', date: '2026-07-10' },
  { id: 'c', name: 'Sooner', status: 'scheduled', date: '2026-06-30' },
  { id: 'd', name: 'No Date', status: 'scheduled', date: null },
  { id: 'e', name: 'Older Final', status: 'final', date: '2026-01-01' },
  { id: 'f', name: 'Recent Final', status: 'final', date: '2026-05-01' },
  { id: 'g', name: 'Called Off', status: 'cancelled', date: '2026-04-01' },
  { id: 'h', name: 'Weird', status: 'mystery', date: '2026-08-01' },
];

test('bucketEvents splits by status (unknown status -> upcoming)', () => {
  const { live, upcoming, past, cancelled } = bucketEvents(SAMPLE);
  assert.deepEqual(live.map((e) => e.id), ['a']);
  assert.deepEqual(past.map((e) => e.id), ['f', 'e']); // most recent first
  assert.deepEqual(cancelled.map((e) => e.id), ['g']);
  // upcoming = scheduled + unknown status, soonest first, date-less last.
  assert.deepEqual(upcoming.map((e) => e.id), ['c', 'b', 'h', 'd']);
});

test('bucketEvents is empty-safe', () => {
  const out = bucketEvents(null);
  assert.deepEqual(out, { live: [], upcoming: [], past: [], cancelled: [] });
});

// --- groupPlayersByDivision ---------------------------------------------------
test('groupPlayersByDivision preserves first-seen order; null division -> Open', () => {
  const players = [
    { id: 1, name: 'MA1 player', division: 'MA1' },
    { id: 2, name: 'MPO player', division: 'MPO' },
    { id: 3, name: 'second MA1', division: 'MA1' },
    { id: 4, name: 'no division' },
  ];
  const grouped = groupPlayersByDivision(players);
  assert.deepEqual(grouped.map((g) => g.division), ['MA1', 'MPO', 'Open']);
  assert.equal(grouped[0].players.length, 2);
  assert.equal(grouped[2].players[0].name, 'no division');
});

test('groupPlayersByDivision is array-safe', () => {
  assert.deepEqual(groupPlayersByDivision(undefined), []);
  assert.deepEqual(groupPlayersByDivision([]), []);
});

// --- course index -------------------------------------------------------------
test('courseNameFor resolves ids and falls back gracefully', () => {
  const index = buildCourseIndex([
    { id: 1, name: 'River Park North' },
    { id: 2, name: 'Bradford Creek' },
  ]);
  assert.equal(courseNameFor(index, 1), 'River Park North');
  assert.equal(courseNameFor(index, '2'), 'Bradford Creek');
  assert.equal(courseNameFor(index, 99), ''); // unknown id -> blank
  assert.equal(courseNameFor(index, null), ''); // no course on event
});
