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
  isTeamRound,
  liveStandingsForDisplay,
  parseEventDate,
  formatEventDate,
  roundFormatLabel,
  typeLabel,
  statusLabel,
  buildCourseIndex,
  courseNameFor,
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

test('normalizeEvent preserves live round play-format metadata', () => {
  const ev = normalizeEvent({ id: 1, format: 'matchplay', play_format: 'doubles', teamRequired: true });
  assert.equal(ev.format, 'matchplay');
  assert.equal(ev.play_format, 'doubles');
  assert.equal(ev.playFormat, 'doubles');
  assert.equal(ev.teamRequired, true);
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

test('roundFormatLabel separates play format from scoring format', () => {
  assert.equal(roundFormatLabel({ format: 'matchplay', playFormat: 'doubles' }), 'Doubles · Matchplay');
  assert.equal(roundFormatLabel({ format: 'stroke', play_format: 'singles' }), 'Singles · Stroke play');
  assert.equal(roundFormatLabel({ format: 'doubles' }), 'Doubles · Stroke play');
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

// --- live display helpers -----------------------------------------------------
test('liveStandingsForDisplay rolls a doubles card up to team rows', () => {
  const snap = {
    format: 'matchplay',
    playFormat: 'doubles',
    teamRequired: true,
    holes: [{ hole: 1, par: 3 }, { hole: 2, par: 4 }],
    players: [
      { name: 'TJ Braley', team: 'Blue', division: 'MPO', scores: { 1: 3, 2: 4 } },
      { name: 'Jane Doe', team: 'Blue', division: 'MPO', scores: { 1: 3, 2: 4 } },
      { name: 'Sam Smith', team: 'Red', division: 'MPO', scores: { 1: 4, 2: 5 } },
      { name: 'Riley Jones', team: 'Red', division: 'MPO', scores: { 1: 4, 2: 5 } },
    ],
  };

  assert.equal(isTeamRound(snap), true);
  assert.deepEqual(
    liveStandingsForDisplay(snap).map((row) => ({
      name: row.name,
      playersText: row.playersText,
      thru: row.thru,
      total: row.total,
      toPar: row.toPar,
    })),
    [
      { name: 'Blue', playersText: 'TJ Braley / Jane Doe', thru: 2, total: 7, toPar: 0 },
      { name: 'Red', playersText: 'Sam Smith / Riley Jones', thru: 2, total: 9, toPar: 2 },
    ],
  );
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
