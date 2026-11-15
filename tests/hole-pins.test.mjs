import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fillMissingHolePins, holesFromPositionLabels, markerHasPin } from "../src/shared/hole-pins.js";
import { projectHoleMap, projectLooseHoleMap } from "../src/shared/hole-map-model.js";

const HOLE1_TEE = { label: "Hole 1 tee", lat: 35.6048891, lng: -77.5758821 };
const HOLE1_BASKET = { label: "Hole 1 basket", lat: 35.6063939, lng: -77.5757044 };

test("Hole N tee and basket labels restore a blank hole without moving a pinned one", () => {
  const donors = holesFromPositionLabels([
    HOLE1_TEE,
    HOLE1_BASKET,
    { label: "Blue", lat: 1, lng: 2 },
    { label: "Hole 1 tee pad", lat: 9, lng: 9 },
  ]);
  assert.equal(donors.length, 1);
  assert.equal(markerHasPin(donors[0].tee), true);
  const holes = fillMissingHolePins([
    { hole: 1, par: 4, distance_ft: 565, tee: { label: "Blue", lat: null, lng: null }, target: { label: "Main", lat: null, lng: null } },
    {
      hole: 3,
      par: 3,
      tee: { label: "Blue", lat: 35.1, lng: -77.1 },
      target: { label: "Main", lat: 35.2, lng: -77.2 },
    },
  ], [
    donors,
    [{ hole: 3, tee: { lat: 9, lng: 9 }, target: { lat: 8, lng: 8 } }],
  ]);
  assert.equal(holes[0].tee.label, "Blue");
  assert.equal(holes[0].tee.lat, HOLE1_TEE.lat);
  assert.equal(holes[0].tee.lng, HOLE1_TEE.lng);
  assert.equal(holes[0].target.label, "Main");
  assert.equal(holes[0].target.lat, HOLE1_BASKET.lat);
  assert.equal(holes[1].tee.lat, 35.1);
  assert.equal(holes[1].target.lng, -77.2);
  assert.equal(holes[0].distance_ft, 565);

  const map = projectHoleMap(holes[0]);
  assert.ok(map && map.satelliteUrl);
  const chased = projectLooseHoleMap(holes[0], { here: { lat: 40, lng: -90 } });
  assert.equal(chased.satelliteUrl, map.satelliteUrl);
  assert.equal(projectLooseHoleMap({ hole: 1, tee: { label: "Blue" }, target: { label: "Main" } }, { here: { lat: 35.6, lng: -77.57 } }), null);
});

test("the current layout's pin beats the position pool when the snapshot is blank", () => {
  const filled = fillMissingHolePins(
    [{ hole: 5, tee: { label: "Blue" }, target: null }],
    [
      holesFromPositionLabels([
        { label: "Hole 5 tee", lat: 1, lng: 2 },
        { label: "Hole 5 basket", lat: 3, lng: 4 },
      ]),
      [{ hole: 5, tee: { label: "Long", lat: 35.5, lng: -77.5 }, target: { label: "Yellow", lat: 35.6, lng: -77.4 } }],
    ],
  );
  assert.equal(filled[0].tee.label, "Blue");
  assert.equal(filled[0].tee.lat, 35.5);
  assert.equal(filled[0].target.label, "Yellow");
  assert.equal(filled[0].target.lng, -77.4);
  assert.equal(fillMissingHolePins(filled, [[{ hole: 5, tee: { lat: 0, lng: 0 }, target: { lat: 1, lng: 1 } }]]), filled);
});

test("the score app reapplies remembered pins after a socket snapshot", () => {
  const controller = readFileSync("src/score-app/score-controller.js", "utf8");
  assert.match(controller, /function assignHoles/);
  assert.match(controller, /function ensureCatalogPins/);
  assert.equal([...controller.matchAll(/assignHoles\(snap\.holes, snap\)/g)].length, 1);
  assert.equal([...controller.matchAll(/assignHoles\(Array\.isArray\(d\.holes\) \? d\.holes : \[\], d\)/g)].length, 2);
  assert.match(controller, /\/positions"/);
  assert.doesNotMatch(readFileSync("src/score-app/scorecard-view.js", "utf8"), /pointReady\(props\.gpsFix\)/);
  assert.doesNotMatch(readFileSync("src/shared/hole-map.js", "utf8"), /here: props\.here/);
});
