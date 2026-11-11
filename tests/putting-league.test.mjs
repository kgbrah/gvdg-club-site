import assert from "node:assert/strict";
import test from "node:test";

import { defaultPuttingStations, normalizeConfig } from "../src/admin-app/scoring-model.js";
import { buildScorecardViewState, cardReview, nextPuttingScore, puttingScorecardMakes, puttingStationRows } from "../src/score-app/score-view-model.js";

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

test("putting live stats are station makes, attempts, and station score", () => {
  const rows = puttingStationRows(
    [
      { hole: 1, par: 5, distance_ft: 15, points: 1 },
      { hole: 2, par: 5, distance_ft: 33, points: 3 },
      { hole: 3, par: 5, distance_ft: 20 },
    ],
    [
      { hole: 1, par: 5, distanceFt: 15, score: 4 },
      { hole: 2, par: 5, distanceFt: 33, score: 2 },
      { hole: 3, par: 5, distanceFt: 20, score: null },
    ],
  );
  assert.deepEqual(rows, [
    { attempts: 5, distanceFt: 15, hole: 1, label: "15 ft", made: 4, pointsEach: 1, stationScore: 4 },
    { attempts: 5, distanceFt: 33, hole: 2, label: "33 ft", made: 2, pointsEach: 3, stationScore: 6 },
    { attempts: 5, distanceFt: 20, hole: 3, label: "20 ft", made: null, pointsEach: 1, stationScore: null },
  ]);
  assert.equal(puttingScorecardMakes([
    { hole: 1, par: 5, strokes: 4 },
    { hole: 2, par: 5, strokes: 2, points: 3 },
    { hole: 3, par: 5, strokes: null },
  ]), 6);
  assert.equal(puttingScorecardMakes([]), null);
});

test("putting confirm totals makes over attempts and points, not to par", () => {
  const review = cardReview({
    holes: [
      { hole: 1, par: 5, distance_ft: 15, points: 1 },
      { hole: 2, par: 5, distance_ft: 20, points: 2 },
      { hole: 3, par: 5, distance_ft: 25, points: 3 },
      { hole: 4, par: 5, distance_ft: 30, points: 4 },
      { hole: 5, par: 5, distance_ft: 33, points: 5 },
      { hole: 6, par: 2, distance_ft: 50, points: 10 },
    ],
    cardmates: [
      { index: 0, name: "Kevin Gray", isMe: true, scores: { 1: 4, 2: 4, 3: 3, 4: 3, 5: 3, 6: 1 } },
      { index: 1, name: "Steveo", scores: { 1: 4, 2: 4, 3: 3, 4: 3, 5: 3, 6: 1 } },
    ],
    roundConfig: { groupFormat: "singles", scoringStyle: "putting" },
    scoreTargets: [],
  }, 0, []);
  assert.equal(review.rows[0].label, "Kevin Gray");
  assert.equal(review.rows[0].makesLabel, "18/27");
  assert.equal(review.rows[0].pointsLabel, "58");
  assert.equal(review.rows[1].label, "Steveo");
  assert.equal(review.rows[1].pointsLabel, "58");
});
