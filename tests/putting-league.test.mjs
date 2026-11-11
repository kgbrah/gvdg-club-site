import assert from "node:assert/strict";
import test from "node:test";

import { defaultPuttingStations, normalizeConfig } from "../src/admin-app/scoring-model.js";
import { buildScorecardViewState, nextPuttingScore } from "../src/score-app/score-view-model.js";

test("putting league defaults to five stations and forces singles", () => {
  const config = normalizeConfig({ groupFormat: "doubles", scoringStyle: "putting", handicap: true });
  assert.equal(config.groupFormat, "singles");
  assert.equal(config.scoringStyle, "putting");
  assert.equal(config.handicap, false);
  assert.deepEqual(config.putting.stations, defaultPuttingStations());
  assert.equal(defaultPuttingStations()[0].points, 1);
  assert.equal(nextPuttingScore(null, 5, "plus"), 1);
  assert.equal(nextPuttingScore(null, 5, "minus"), 0);
  assert.equal(nextPuttingScore(5, 5, "plus"), 5);
  assert.equal(nextPuttingScore(0, 5, "minus"), null);
});

test("putting stations keep points per make and drop a station outside 1-20", () => {
  const config = normalizeConfig({
    scoringStyle: "putting",
    putting: {
      stations: [
        { distanceFt: 18, putts: 4 },
        { distanceFt: 33, putts: 5, points: 3 },
        { distanceFt: 40, putts: 5, points: 0 },
      ],
    },
  });
  assert.deepEqual(config.putting.stations, [
    { distanceFt: 18, putts: 4, points: 1 },
    { distanceFt: 33, putts: 5, points: 3 },
  ]);
});

test("a weighted putting card shows makes and points", () => {
  const view = buildScorecardViewState({
    state: {
      holes: [
        { hole: 1, par: 5, distance_ft: 15, points: 1 },
        { hole: 2, par: 5, distance_ft: 33, points: 3 },
      ],
      holeIdx: 1,
      myIndex: 0,
      scorerIndex: 0,
      cardmates: [{ index: 0, name: "Ann", isMe: true, scores: { 1: 4, 2: 2 }, scorecards: {} }],
      conflicts: [],
      missing: [],
      roundConfig: { groupFormat: "singles", scoringStyle: "putting" },
      scoreTargets: [],
      snap: { standings: [] },
      status: "live",
    },
    mode: "round",
    roundCode: "PUTT",
    scorerIndex: 0,
    teeSign: null,
  });
  assert.equal(view.holeMeta, "33 ft · 5 putts · 3 pts each");
  assert.deepEqual(view.totals.map((chip) => [chip.label, chip.value]), [
    ["Stations", "2/2"],
    ["Makes", "6"],
    ["Points", "10"],
  ]);
});
