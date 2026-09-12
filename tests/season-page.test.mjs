import assert from "node:assert/strict";
import test from "node:test";

import { buildSeasonPage, dateYear, easternDateOnly, easternYear, namesMatch } from "../src/members-app/season-page-model.js";

const NOW = new Date("2026-09-11T16:00:00Z");

test("eastern helpers use America/New_York", () => {
  assert.equal(easternYear(NOW), 2026);
  assert.equal(easternDateOnly(NOW), "2026-09-11");
  assert.equal(dateYear("2026-07-04"), 2026);
  assert.equal(dateYear("2025-12-31T23:00:00Z"), 2025);
  assert.equal(dateYear(""), null);
});

test("namesMatch is case-insensitive and ignores padding", () => {
  assert.equal(namesMatch("QA Admin", "qa admin"), true);
  assert.equal(namesMatch("QA Admin", "Someone Else"), false);
  assert.equal(namesMatch("", "QA Admin"), false);
  assert.equal(namesMatch("Tj Braley", "TJ Braley"), true);
  assert.equal(namesMatch("Schwarga", "Alex Schwarga"), true);
});

test("buildSeasonPage keeps this year's club results and skips last year", () => {
  const page = buildSeasonPage({
    now: NOW,
    memberName: "QA Admin",
    results: [
      { id: 1, event_id: 10, event_name: "Fall Open", event_date: "2026-09-20", place: 1, to_par: -3 },
      { id: 2, event_id: 9, event_name: "Last Year Open", event_date: "2025-09-20", place: 1, to_par: -8 },
      { id: 3, event_id: 11, event_name: "Match", event_date: "2026-06-17", place: 2, to_par: null },
    ],
    ratings: {
      competitive: {
        live_rating: 910,
        rounds: [
          { date: "2026-07-04", rating: 906 },
          { date: "2025-07-04", rating: 880 },
        ],
      },
      casual: { live_rating: 890, rounds: [{ date: "2026-07-05T14:00:00Z", rating: 890 }] },
    },
    registrations: [
      { id: 4, event_id: 12, event_name: "Next Week", event_date: "2026-09-16", event_status: "scheduled" },
      { id: 5, event_id: 8, event_name: "Done", event_date: "2026-08-01", event_status: "final" },
    ],
    leagues: [
      {
        league: { id: 4, name: "Ryder Cup", season: "2026" },
        officialSheet: true,
        standings: [
          { name: "Other", points: 12, events: 6, wins: 4 },
          { name: "QA Admin", points: 8, events: 5, wins: 2 },
        ],
      },
      {
        league: { id: 2, name: "Singles", season: "2026" },
        standings: [{ name: "Not You", points: 20, events: 8, wins: 3 }],
      },
    ],
  });

  assert.equal(page.year, 2026);
  assert.equal(page.rounds, 2);
  assert.equal(page.avgToPar, -3);
  assert.equal(page.bestFinish, 1);
  assert.equal(page.clubRating, 898);
  assert.equal(page.ratedRounds, 2);
  assert.equal(page.results.map((row) => row.event_name).join(","), "Fall Open,Match");
  assert.equal(page.upcoming.length, 1);
  assert.equal(page.upcoming[0].event_name, "Next Week");
  assert.equal(page.standings.length, 1);
  assert.deepEqual(page.standings[0], {
    leagueId: 4,
    leagueName: "Ryder Cup",
    season: "2026",
    officialSheet: true,
    place: 2,
    points: 8,
    events: 5,
    wins: 2,
    field: 2,
  });
});

test("buildSeasonPage empty payload stays numeric zeros", () => {
  const page = buildSeasonPage({ now: NOW });
  assert.equal(page.rounds, 0);
  assert.equal(page.avgToPar, null);
  assert.equal(page.bestFinish, null);
  assert.equal(page.clubRating, null);
  assert.equal(page.ratedRounds, 0);
  assert.equal(page.results.length, 0);
  assert.equal(page.upcoming.length, 0);
  assert.equal(page.standings.length, 0);
});
