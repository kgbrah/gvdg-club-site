import assert from 'node:assert/strict';
import test from 'node:test';
import {
  feedDateInfo,
  isClubEvent,
  parseCsvLine,
  parseHomepageEventCsv,
  parseHomepageEventDate,
  parseTournamentCsv,
  parseTournamentDate,
  upcomingTournaments,
} from '../src/shared/home-feed-parse.js';

test('isClubEvent flags club business but keeps tournaments/league rounds', () => {
  assert.equal(isClubEvent({ title: 'Club Meeting', description: 'At Local Oak Brewing' }), true);
  assert.equal(isClubEvent({ title: 'Course Cleanup Fundraiser', description: '' }), true);
  assert.equal(isClubEvent({ title: 'GVDG Summer Doubles League', description: 'Farmville' }), false);
  assert.equal(isClubEvent({ title: 'Ryder Cup Matchplay', description: '' }), false);
});

test('parseCsvLine handles quoted commas and escaped quotes', () => {
  assert.deepEqual(parseCsvLine('"One, Two","He said ""go""",Plain'), ['One, Two', 'He said "go"', 'Plain']);
});

test('parseTournamentCsv maps sheet columns into tournament cards', () => {
  const csv = 'date,name,location,tier,url\n"Aug 3, 2026","Throwdown, East",Greenville,C,https://example.com';
  assert.deepEqual(parseTournamentCsv(csv), [
    { date: 'Aug 3, 2026', name: 'Throwdown, East', location: 'Greenville', tier: 'C', url: 'https://example.com' },
  ]);
});

test('parseTournamentDate handles short month dates', () => {
  const now = new Date(2026, 8, 18);
  const dated = parseTournamentDate('Aug 3, 2026', now);
  assert.equal(dated.month, 'Aug');
  assert.equal(dated.day, 3);
  assert.equal(dated.year, 2026);
  assert.equal(dated.isPast, true);
  const upcoming = parseTournamentDate('Oct 23, 2026', now);
  assert.equal(upcoming.isPast, false);
  const undated = parseTournamentDate('Aug 3', new Date(2026, 0, 1));
  assert.equal(undated.month, 'Aug');
  assert.equal(undated.day, 3);
  assert.equal(undated.year, 2026);
  assert.equal(parseTournamentDate('TBD'), null);
});

test('upcomingTournaments hides past dates and sorts soonest first', () => {
  const now = new Date(2026, 8, 18);
  const list = upcomingTournaments([
    { date: 'May 24, 2026', name: 'Ladies Craven Chains' },
    { date: 'Oct 23, 2026', name: 'Down East Players Cup' },
    { date: 'Sep 12, 2026', name: 'Joel Smith Memorial' },
    { date: 'Sep 19, 2026', name: 'The Global at Creekside' },
    { date: 'Dec 12, 2026', name: 'Scorpion Match Play' },
    { date: 'Sep 18, 2026', name: 'Today still counts' },
  ], now);
  assert.deepEqual(list.map((row) => row.name), [
    'Today still counts',
    'The Global at Creekside',
    'Down East Players Cup',
    'Scorpion Match Play',
  ]);
});

test('upcomingTournaments drops a fully elapsed sheet', () => {
  const now = new Date(2026, 8, 18);
  assert.deepEqual(upcomingTournaments([
    { date: 'May 24, 2026', name: 'Ladies Craven Chains' },
    { date: 'Sep 12, 2026', name: 'Joel Smith Memorial' },
  ], now), []);
});

test('parseHomepageEventCsv filters inactive and blank events', () => {
  const csv = 'title,date,description,url,active\nWeekly Doubles,2026-08-01,Bring tags,https://example.com,TRUE\nOld Hidden,2026-08-02,,https://example.com,FALSE\nNo Date,,Missing date,,TRUE';
  assert.deepEqual(parseHomepageEventCsv(csv), [
    { title: 'Weekly Doubles', date: '2026-08-01', description: 'Bring tags', url: 'https://example.com', active: 'TRUE' },
  ]);
});

test('parseHomepageEventDate handles common sheet date formats', () => {
  const now = new Date('2026-03-20T12:00:00Z');
  assert.equal(parseHomepageEventDate('2026-08-01', now).month, 'Aug');
  assert.equal(parseHomepageEventDate('8/1/26', now).year, 2026);
  assert.equal(parseHomepageEventDate('01/15', now).year, 2026);
  assert.equal(parseHomepageEventDate('01/15', now).isPast, true);
  assert.equal(parseHomepageEventDate('8/1', now).year, 2026);
  assert.equal(parseHomepageEventDate('TBD', now).isTBD, true);
  const december = new Date('2026-12-01T12:00:00Z');
  assert.equal(parseHomepageEventDate('1/5', december).year, 2027);
  assert.equal(parseHomepageEventDate('1/5', december).isPast, false);
});

test('yearless homepage sheet dates stay in this year so old league nights drop off', () => {
  const now = new Date('2026-09-20T12:00:00-04:00');
  const rows = ['5/14', '6/1', '8/3', '9/13', '9/20', '10/5'];
  const upcoming = rows
    .map((date) => parseHomepageEventDate(date, now))
    .filter((info) => !info.isPast && !info.isTBD)
    .map((info) => `${info.month} ${info.day} ${info.year}`);
  assert.deepEqual(upcoming, ['Sep 20 2026', 'Oct 5 2026']);
});

test('feedDateInfo prefers an explicit-year calendar date over a last-updated epoch', () => {
  const now = new Date('2026-09-12T12:00:00Z');
  const teeSign = feedDateInfo({ date: '2026-06-01', epoch: now.getTime() }, now);
  assert.equal(teeSign.isPast, true);
  assert.equal(teeSign.dateObj.getFullYear(), 2026);
  assert.equal(teeSign.dateObj.getMonth(), 5);
  assert.equal(teeSign.dateObj.getDate(), 1);

  const meeting = feedDateInfo({ date: '5/14', epoch: Date.UTC(2027, 4, 14) }, now);
  assert.equal(meeting.isPast, false);
  assert.equal(meeting.dateObj.getUTCFullYear(), 2027);
  assert.equal(meeting.dateObj.getUTCMonth(), 4);

  const undated = feedDateInfo({ date: '9/13', epoch: Date.UTC(2026, 8, 13) }, now);
  assert.equal(undated.isPast, false);
  assert.equal(undated.dateObj.getUTCMonth(), 8);
  assert.equal(undated.dateObj.getUTCDate(), 13);
});
