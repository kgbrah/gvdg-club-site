import assert from "node:assert/strict";
import test from "node:test";

import { casualReplaySnapshot, watchableLiveSnapshot } from "../src/shared/casual-replay.js";

test("watchable snapshots are live or final cards that still have holes", () => {
  assert.equal(watchableLiveSnapshot(null), false);
  assert.equal(watchableLiveSnapshot({ status: "none", holes: [{ hole: 1 }] }), false);
  assert.equal(watchableLiveSnapshot({ status: "final", holes: [] }), false);
  assert.equal(watchableLiveSnapshot({ status: "live", holes: [] }), false);
  assert.equal(watchableLiveSnapshot({ status: "final", holes: [{ hole: 1, par: 3 }] }), true);
  assert.equal(watchableLiveSnapshot({ status: "live", holes: [{ hole: 1, par: 3 }] }), true);
});

test("casual results become a final replay with throws and scorecards", () => {
  const snapshot = casualReplaySnapshot({
    round: {
      round_code: "AB23CD",
      course_id: "2",
      layout_id: 3,
      course_name: "West Meadowbrook Park",
      layout_name: "White Pads to B-Pins",
      holes: JSON.stringify([{ hole: 1, par: 3, distance_ft: 280, tee: { lat: 35.6, lng: -77.37 }, target: { lat: 35.61, lng: -77.36 } }]),
      scoring_config: JSON.stringify({ groupFormat: "singles", scoringStyle: "stroke" }),
    },
    results: [{
      name: "Kevin",
      total: 55,
      to_par: -1,
      scorecard: JSON.stringify([{ hole: 1, par: 3, strokes: 2, throws: [{ lat: 35.601, lng: -77.369 }] }]),
    }],
  });
  assert.equal(snapshot.status, "final");
  assert.equal(snapshot.courseName, "West Meadowbrook Park");
  assert.equal(snapshot.layoutId, 3);
  assert.equal(snapshot.courseId, 2);
  assert.equal(snapshot.holes[0].tee.lat, 35.6);
  assert.equal(snapshot.players[0].scores[1], 2);
  assert.equal(snapshot.players[0].throws[1][0].n, 1);
  assert.deepEqual(snapshot.standings[0].scorecard, [{ hole: 1, par: 3, strokes: 2 }]);
  assert.equal(snapshot.standings[0].total, 55);
  assert.equal(snapshot.standings[0].toPar, -1);
  assert.equal(snapshot.roundConfig.scoringStyle, "stroke");
});

test("missing durable results do not invent a replay", () => {
  assert.equal(casualReplaySnapshot(null), null);
  assert.equal(casualReplaySnapshot({ round: { course_name: "Empty" }, results: [] }), null);
  assert.equal(casualReplaySnapshot({ error: "not_found" }), null);
});
