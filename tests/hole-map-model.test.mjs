import assert from "node:assert/strict";
import test from "node:test";

import { headingDeg, holeMapLabel, holePoint, projectHoleMap, windBlowToDeg } from "../src/shared/hole-map-model.js";

test("holePoint requires numeric lat/lng", () => {
  assert.equal(holePoint(null), null);
  assert.equal(holePoint({ lat: 35, lng: "nope" }), null);
  assert.deepEqual(holePoint({ lat: 35.1, lng: -82.4, label: "  Blue  " }), {
    lat: 35.1,
    lng: -82.4,
    label: "Blue",
  });
});

test("projectHoleMap returns a north-up tee-to-basket layout", () => {
  const map = projectHoleMap({
    hole: 3,
    distance_ft: 250,
    tee: { lat: 35.6, lng: -77.37, label: "Gold" },
    target: { lat: 35.601, lng: -77.37, label: "A" },
  }, { windFromDeg: 0 });
  assert.ok(map);
  assert.equal(map.distanceFt, 250);
  assert.ok(map.basket.y < map.tee.y);
  assert.equal(map.tee.label, "Gold");
  assert.equal(map.basket.label, "A");
  assert.equal(map.windBlowToDeg, 180);
  assert.match(holeMapLabel(map, 3), /Hole 3 map, 250 ft/);
});

test("projectHoleMap hides identical tee and basket points", () => {
  assert.equal(projectHoleMap({
    tee: { lat: 35, lng: -77 },
    target: { lat: 35, lng: -77 },
  }), null);
});

test("heading and wind helpers stay on the compass", () => {
  assert.equal(Math.round(headingDeg({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })), 0);
  assert.equal(windBlowToDeg(90), 270);
  assert.equal(windBlowToDeg(null), null);
});
