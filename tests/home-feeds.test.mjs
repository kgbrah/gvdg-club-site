import assert from 'node:assert/strict';
import test from 'node:test';
import {
  feedDateInfo,
  isClubEvent,
  parseCsvLine,
  parseHomepageEventCsv,
  parseHomepageEventDate,
  parseTournamentDate,
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

test('feedDateInfo uses the sheet calendar date, not a rolled-forward epoch', () => {
  const now = new Date('2026-09-12T12:00:00Z');
  const teeSign = feedDateInfo({ date: '2026-06-01', epoch: now.getTime() }, now);
  assert.equal(teeSign.isPast, true);
  assert.equal(teeSign.dateObj.getFullYear(), 2026);
  assert.equal(teeSign.dateObj.getMonth(), 5);
  assert.equal(teeSign.dateObj.getDate(), 1);

  const meeting = feedDateInfo({ date: '5/14', epoch: Date.UTC(2027, 4, 14) }, now);
  assert.equal(meeting.isPast, true);
  assert.equal(meeting.dateObj.getFullYear(), 2026);
  assert.equal(meeting.dateObj.getMonth(), 4);
  assert.equal(meeting.dateObj.getDate(), 14);

  const upcoming = feedDateInfo({ date: '9/13', epoch: Date.UTC(2027, 8, 13) }, now);
  assert.equal(upcoming.isPast, false);
  assert.equal(upcoming.dateObj.getFullYear(), 2026);
  assert.equal(upcoming.dateObj.getMonth(), 8);
  assert.equal(upcoming.dateObj.getDate(), 13);

  const epochOnly = feedDateInfo({ date: '', epoch: Date.UTC(2026, 11, 12) }, now);
  assert.equal(epochOnly.isPast, false);
  assert.equal(epochOnly.dateObj.getUTCMonth(), 11);
});

// PDGA's tech team: the public Area Tournaments list PDGA-sanctioned events, so it reads PDGA's API and links each
// name to its pdga.com event page (not Disc Golf Scene).
test('areaTournamentsFromPdga keeps events within 60 miles with their pdga.com pages', async () => {
  const { areaTournamentsFromPdga } = await import('../src/home-app/feed-panels.js');
  const rows = areaTournamentsFromPdga({ events: [
    { name: 'Pitt County Winter Open', date: 'Dec 13, 2026', tier: 'C-tier', place: 'Greenville, NC', miles: 3.2,
      url: 'https://www.discgolfscene.com/tournaments/x', pdgaUrl: 'https://www.pdga.com/tour/event/90001' },
    { name: 'Club Classic', date: 'Jan 9, 2027', tier: 'C-tier', place: 'Greenville, NC', miles: 0.4,
      url: '/events#event/12', pdgaUrl: 'https://www.pdga.com/tour/event/90002', clubEventId: 12 },
    { name: 'Raleigh Far Away', date: 'Dec 20, 2026', tier: 'B-tier', place: 'Raleigh, NC', miles: 78.5, pdgaUrl: 'https://www.pdga.com/tour/event/90003' },
    { name: 'Odd Link', date: 'Dec 27, 2026', miles: null, pdgaUrl: 'javascript:alert(1)' },
  ] });
  assert.deepEqual(rows.map((row) => [row.name, row.pdgaUrl, row.clubEventId]), [
    ['Pitt County Winter Open', 'https://www.pdga.com/tour/event/90001', null],
    ['Club Classic', 'https://www.pdga.com/tour/event/90002', 12],
    ['Odd Link', '', null],
  ]);
  assert.equal(rows[0].location, 'Greenville, NC');
  assert.deepEqual(areaTournamentsFromPdga(null), []);
});
