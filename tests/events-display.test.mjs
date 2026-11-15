import assert from "node:assert/strict";
import test from "node:test";

import { displayEventTitle, stripLeaguePrefix } from "../src/shared/events-model.js";
import { humanDate, whenLine, countdownLabel, countdownParts, dateBlock, relativeEventWhen } from "../src/shared/events-display.js";
import { bagTagHolderGroups, collapseBagTagMoves } from "../src/shared/bag-tag-model.js";

test("stripLeaguePrefix removes a redundant league prefix only", () => {
  assert.equal(stripLeaguePrefix("Sunday Baggers - Sunday Baggers Nov 15th", "Sunday Baggers"), "Sunday Baggers Nov 15th");
  assert.equal(stripLeaguePrefix("Sunday Baggers – Week 3", "Sunday Baggers"), "Week 3");
  assert.equal(stripLeaguePrefix("Farm Open - Day 2", "Sunday Baggers"), "Farm Open - Day 2");
  assert.equal(stripLeaguePrefix("Sunday Baggers", "Sunday Baggers"), "Sunday Baggers");
  assert.equal(stripLeaguePrefix("Anything", ""), "Anything");
});

test("displayEventTitle keeps its old behaviour and accepts a league", () => {
  assert.equal(displayEventTitle("Sunday Baggers - Sunday Baggers Nov 8th"), "Sunday Baggers Nov 8th");
  assert.equal(displayEventTitle("Red - Blue"), "Red - Blue");
  assert.equal(displayEventTitle("Ryder Cup - Week 2 Match 4", "Ryder Cup"), "Week 2 Match 4");
  assert.equal(displayEventTitle("", "x"), "");
});

test("relativeEventWhen uses the Eastern civil day", () => {
  const now = new Date("2026-11-12T15:00:00Z"); // Thursday
  assert.equal(relativeEventWhen({ date: "2026-11-12" }, now), "Today");
  assert.equal(relativeEventWhen({ date: "2026-11-13" }, now), "Tomorrow");
  assert.equal(relativeEventWhen({ date: "2026-11-15", starts_at: "2026-11-15T20:00:00Z" }, now), "This Sunday · 3 PM");
  assert.equal(relativeEventWhen({ date: "2026-11-21" }, now), "Next Saturday");
  assert.equal(relativeEventWhen({ date: "2026-12-30" }, now), "");
  assert.equal(relativeEventWhen({}, now), "");
});

test("countdown parts and labels", () => {
  const now = new Date("2026-11-12T15:00:00Z");
  const parts = countdownParts({ starts_at: "2026-11-15T20:00:00Z" }, now);
  assert.deepEqual(parts, { days: 3, hours: 5, minutes: 0 });
  assert.equal(countdownLabel(parts), "3 days");
  assert.equal(countdownLabel({ days: 0, hours: 2, minutes: 5 }), "2 h 5 min");
  assert.equal(countdownParts({ starts_at: "2026-11-01T20:00:00Z" }, now), null);
  assert.deepEqual(dateBlock({ date: "2026-11-15" }), { month: "NOV", day: "15", weekday: "Sun" });
});

test("collapseBagTagMoves folds assign/release churn", () => {
  const churn = [];
  for (let i = 0; i < 6; i += 1) {
    churn.push({ id: 20 - i * 2, summary: "Assigned #1 to Kevin Gray" });
    churn.push({ id: 19 - i * 2, summary: "Released #1 from Kevin Gray" });
  }
  const moves = [{ id: 30, summary: "Assigned #2 to Sam Lee" }, ...churn, { id: 3, summary: "Season opened" }];
  const out = collapseBagTagMoves(moves);
  assert.equal(out.length, 3);
  assert.equal(out[1].summary, "Assigned #1 to Kevin Gray");
  assert.equal(out[1].count, 12);
  assert.equal(out[2].summary, "Season opened");
  assert.deepEqual(collapseBagTagMoves(null), []);
});

test("bagTagHolderGroups sorts by tag and splits the top three", () => {
  const groups = bagTagHolderGroups([{ tagNumber: 5 }, { tagNumber: 1 }, { tagNumber: 3 }, { tagNumber: 2 }]);
  assert.deepEqual(groups.podium.map((h) => h.tagNumber), [1, 2, 3]);
  assert.deepEqual(groups.rest.map((h) => h.tagNumber), [5]);
});

test("humanDate never emits ISO and whenLine merges date and time", () => {
  const now = new Date("2026-11-12T15:00:00Z");
  assert.equal(humanDate("2026-11-22", { now }), "Sun, Nov 22");
  assert.equal(humanDate("2026-10-12", { now, year: true }), "Oct 12, 2026");
  assert.equal(humanDate("2025-03-02", { now }), "Mar 2, 2025");
  assert.equal(humanDate("", { now }), "");
  assert.equal(whenLine({ date: "2026-11-28", starts_at: "2026-11-28T13:00:00Z" }, now), "Sat, Nov 28 \u00b7 8:00 AM EST");
  assert.equal(whenLine({ date: "2026-11-13" }, now), "Tomorrow");
  assert.equal(whenLine({}, now), "Date TBD");
});
