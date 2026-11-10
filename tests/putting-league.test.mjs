import assert from "node:assert/strict";
import test from "node:test";

import { defaultPuttingStations, normalizeConfig } from "../src/admin-app/scoring-model.js";
import { nextPuttingScore } from "../src/score-app/score-view-model.js";

test("putting league defaults to five stations and forces singles", () => {
  const config = normalizeConfig({ groupFormat: "doubles", scoringStyle: "putting", handicap: true });
  assert.equal(config.groupFormat, "singles");
  assert.equal(config.scoringStyle, "putting");
  assert.equal(config.handicap, false);
  assert.deepEqual(config.putting.stations, defaultPuttingStations());
  assert.equal(nextPuttingScore(null, 5, "plus"), 1);
  assert.equal(nextPuttingScore(null, 5, "minus"), 0);
  assert.equal(nextPuttingScore(5, 5, "plus"), 5);
  assert.equal(nextPuttingScore(0, 5, "minus"), null);
});
