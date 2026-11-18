import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarDaysBetween,
  minusWallMinutes,
  nextWeeklyDate,
  pickRepeatEvent,
  renameForDate,
  seriesName,
  repeatLabel,
  shiftWallByDays,
} from "../src/admin-app/repeat-draft.js";

test("next weekly date keeps the weekday and lands after today", () => {
  assert.equal(nextWeeklyDate("2026-10-24", "2026-11-02"), "2026-11-07");
  assert.equal(nextWeeklyDate("2026-11-07", "2026-11-02"), "2026-11-14");
  assert.equal(calendarDaysBetween("2026-10-24", "2026-11-07"), 14);
});

test("wall clocks shift by whole days and check-in can sit 15 minutes earlier", () => {
  assert.equal(shiftWallByDays("2026-10-24T09:00", 14), "2026-11-07T09:00");
  assert.equal(minusWallMinutes("2026-11-07T09:00", 15), "2026-11-07T08:45");
  assert.equal(minusWallMinutes("2026-11-07T00:10", 15), "2026-11-06T23:55");
});

test("repeat prefers the latest past league night", () => {
  const events = [
    { date: "2026-11-14", name: "Future tournament", status: "scheduled", type: "tournament" },
    { date: "2026-10-31", name: "Saturday league", status: "final", type: "league_round" },
    { date: "2026-10-24", name: "Older league", status: "final", type: "league_round" },
    { date: "2026-11-01", name: "Cancelled", status: "cancelled", type: "league_round" },
  ];
  const picked = pickRepeatEvent(events, "2026-11-02");
  assert.equal(picked.name, "Saturday league");
  assert.match(repeatLabel(picked, "2026-11-07"), /Same as Saturday league/);
});

test("a copied event's name carries the new date, written the same way", () => {
  assert.equal(renameForDate("Sunday Baggers - Sunday Baggers Nov 15th", "2026-11-15", "2026-11-22"), "Sunday Baggers - Sunday Baggers Nov 22nd");
  assert.equal(renameForDate("Doubles November 1st", "2026-11-01", "2026-11-08"), "Doubles November 8th");
  assert.equal(renameForDate("Ace race Nov 30, 2026", "2026-11-30", "2026-12-07"), "Ace race Dec 7, 2026");
  assert.equal(renameForDate("League night 11/15", "2026-11-15", "2026-11-22"), "League night 11/22");
  assert.equal(renameForDate("League night 11/15/26", "2026-11-15", "2026-11-22"), "League night 11/22/26");
  assert.equal(renameForDate("Tag round Dec 28th", "2026-12-28", "2027-01-04"), "Tag round Jan 4th");
  assert.equal(renameForDate("Glow league 3/11", "2026-11-15", "2026-11-22"), "Glow league 3/11", "a date that isn't this one stays");
  assert.equal(renameForDate("Saturday league", "2026-10-31", "2026-11-07"), "Saturday league");
});

test("a league's name without its date", () => {
  assert.equal(seriesName("Sunday Baggers - Sunday Baggers Nov 15th"), "Sunday Baggers");
  assert.equal(seriesName("League night 11/15"), "League night");
  assert.equal(seriesName("Saturday league"), "Saturday league");
});
