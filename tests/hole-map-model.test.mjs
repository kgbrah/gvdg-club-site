import assert from "node:assert/strict";
import test from "node:test";

import { addThrow, CIRCLE1_M, CIRCLE2_M, circleEllipse, currentRangeHud, flightArc, GPS_REMAINING_MAX_FT, GPS_WATCH_OPTIONS, gpsErrorPolicy, gpsHudPrompt, headingDeg, holeMapLabel, holePoint, lastThrow, lastThrowHud, latLngFromMapPoint, mapFocusFromRemaining, nextTeeHud, playerMarksOnMap, projectHoleMap, projectMapPoint, puttingCircle, rangeHud, readAllThrows, readThrows, remainingFt, resolveMapFocus, satelliteImageUrl, scoreChipAnchor, teePadRotationDeg, throwSegments, throwsStorageKey, undoThrow, windBlowToDeg, withSelfLocation, writeThrows } from "../src/shared/hole-map-model.js";

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
  assert.ok(map.basket.y / map.height > 0.24 && map.basket.y / map.height < 0.36);
  assert.ok(map.tee.y / map.height > 0.64 && map.tee.y / map.height < 0.76);
});

test("projectHoleMap overlays a satellite image on the GPS bounds", () => {
  const map = projectHoleMap({
    hole: 1,
    distance_ft: 297,
    tee: { lat: 35.62635943646063, lng: -77.37487380252036, label: "Hole 1 tee" },
    target: { lat: 35.626574, lng: -77.3758408, label: "Hole 1 basket" },
  });
  assert.ok(map.satelliteUrl.startsWith("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?"));
  assert.match(map.satelliteUrl, /bboxSR=4326/);
  assert.match(map.satelliteUrl, /format=jpg/);
  assert.ok(map.bounds.minLng < map.bounds.maxLng);
  assert.ok(map.bounds.minLat < map.bounds.maxLat);
  assert.equal(satelliteImageUrl(null), "");
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

test("tee pad rotation follows the on-screen fairway, not compass heading", () => {
  assert.equal(teePadRotationDeg({ x: 10, y: 10 }, { x: 10, y: 0 }), -180);
  assert.equal(teePadRotationDeg({ x: 0, y: 10 }, { x: 10, y: 10 }), -90);
  assert.equal(teePadRotationDeg({ x: 0, y: 0 }, { x: 10, y: 10 }), -45);
  const southeast = projectHoleMap({
    tee: { lat: 35.6, lng: -77.37, label: "Gold" },
    target: { lat: 35.599, lng: -77.369, label: "A" },
  });
  assert.ok(southeast.teeRotationDeg > -90 && southeast.teeRotationDeg < 0);
  assert.ok(southeast.basket.x > southeast.tee.x);
  assert.ok(southeast.basket.y > southeast.tee.y);
});

test("projectMapPoint places players on the hole and hides off-map GPS", () => {
  const map = projectHoleMap({
    hole: 1,
    tee: { lat: 35.6, lng: -77.37, label: "Gold" },
    target: { lat: 35.601, lng: -77.37, label: "A" },
  });
  const mid = projectMapPoint(map, 35.6005, -77.37);
  assert.ok(mid);
  assert.ok(mid.x > 0 && mid.x < map.width);
  assert.ok(mid.y > 0 && mid.y < map.height);
  assert.equal(projectMapPoint(map, 40, -90), null);
  const marks = playerMarksOnMap(map, [
    { index: 0, initials: "as", lat: 35.6005, lng: -77.37, strokes: 3, label: "par", relClass: "even" },
    { index: 1, initials: "TB", lat: 40, lng: -90 },
  ]);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].initials, "AS");
  assert.equal(marks[0].label, "par");
  assert.equal(marks[0].strokes, 3);
});

test("scoreChipAnchor flips chips away from the top and right edges", () => {
  assert.deepEqual(scoreChipAnchor({ x: 50, y: 80 }, 100, 100), { x: "right", y: "above" });
  assert.deepEqual(scoreChipAnchor({ x: 90, y: 10 }, 100, 100), { x: "left", y: "below" });
  assert.deepEqual(scoreChipAnchor({ x: 10, y: 10 }, 100, 100), { x: "right", y: "below" });
  assert.deepEqual(scoreChipAnchor({ x: 90, y: 80 }, 100, 100), { x: "left", y: "above" });
});

function northOf(from, meters) {
  return { lat: from.lat + (meters / 6371000) * (180 / Math.PI), lng: from.lng };
}

test("remaining distance and putting circles use PDGA 10m / 20m", () => {
  const basket = { lat: 35.6, lng: -77.37 };
  const inC1 = northOf(basket, CIRCLE1_M);
  const inC2 = northOf(basket, 15);
  const outside = northOf(basket, 25);
  assert.equal(CIRCLE1_M, 10);
  assert.equal(CIRCLE2_M, 20);
  assert.equal(remainingFt(inC1, basket), 33);
  assert.equal(remainingFt(inC2, basket), 49);
  assert.equal(remainingFt(outside, basket), 82);
  assert.equal(puttingCircle(inC1, basket), "C1");
  assert.equal(puttingCircle(inC2, basket), "C2");
  assert.equal(puttingCircle(outside, basket), null);
  assert.equal(remainingFt(null, basket), null);
});

test("range HUD captions hole length, remaining, and throw", () => {
  const basket = { lat: 35.6, lng: -77.37 };
  assert.deepEqual(rangeHud({ holeFt: 297, mode: "hole" }), {
    caption: "hole",
    circle: null,
    ft: 297,
    mode: "hole",
  });
  assert.equal(rangeHud({ holeFt: 0, mode: "hole" }), null);
  assert.deepEqual(rangeHud({ from: northOf(basket, 10), to: basket }), {
    caption: "in C1",
    circle: "C1",
    ft: 33,
    mode: "remaining",
  });
  assert.deepEqual(rangeHud({ from: northOf(basket, 15), mode: "throw", to: basket }), {
    caption: "throw",
    circle: "C2",
    ft: 49,
    mode: "throw",
  });
  assert.deepEqual(rangeHud({ from: northOf(basket, 25), to: basket }), {
    caption: "to basket",
    circle: null,
    ft: 82,
    mode: "remaining",
  });
});

test("map focus auto-zooms into C2 then C1 and can be pinned", () => {
  assert.equal(mapFocusFromRemaining(20), "c1");
  assert.equal(mapFocusFromRemaining(50), "c2");
  assert.equal(mapFocusFromRemaining(120), "hole");
  assert.equal(mapFocusFromRemaining(null), "hole");
  assert.equal(resolveMapFocus(null, 20), "c1");
  assert.equal(resolveMapFocus("hole", 20), "hole");
  assert.equal(resolveMapFocus("c2", 20), "c2");
});

test("C1 and C2 focus tighten the satellite bounds around the basket", () => {
  const hole = {
    distance_ft: 308,
    tee: { lat: 35.6, lng: -77.37, label: "Gold" },
    target: { lat: 35.601, lng: -77.37, label: "A" },
  };
  const full = projectHoleMap(hole);
  const c2 = projectHoleMap(hole, { focus: "c2" });
  const c1 = projectHoleMap(hole, { focus: "c1" });
  assert.equal(full.focus, "hole");
  assert.equal(c1.focus, "c1");
  assert.ok(c2.bounds.maxLat - c2.bounds.minLat < full.bounds.maxLat - full.bounds.minLat);
  assert.ok(c1.bounds.maxLat - c1.bounds.minLat < c2.bounds.maxLat - c2.bounds.minLat);
  assert.ok(Math.abs(c1.basket.x / c1.width - 0.5) < 0.05);
  assert.ok(Math.abs(c1.basket.y / c1.height - 0.5) < 0.05);
  assert.ok(c1.circle1);
  assert.ok(c1.circle2.rx > c1.circle1.rx);
});

test("nextTeeHud reports distance to the following tee", () => {
  const gps = { lat: 35.601, lng: -77.37 };
  const next = { tee: { lat: 35.6015, lng: -77.37 } };
  const hud = nextTeeHud(gps, next);
  assert.equal(hud.caption, "next tee");
  assert.ok(hud.ft > 0 && hud.ft < 250);
  assert.equal(nextTeeHud(gps, null), null);
  assert.equal(nextTeeHud(null, next), null);
});

test("gpsErrorPolicy keeps the last fix and retries timeouts", () => {
  assert.deepEqual(gpsErrorPolicy(1, true), { keepFix: true, restart: false, retryMs: 0, status: "denied" });
  assert.deepEqual(gpsErrorPolicy(3, true), { keepFix: true, restart: true, retryMs: 2000, status: "ready" });
  assert.deepEqual(gpsErrorPolicy(2, false), { keepFix: true, restart: true, retryMs: 2000, status: "watching" });
  assert.equal(GPS_WATCH_OPTIONS.timeout, 60000);
  assert.equal(GPS_WATCH_OPTIONS.enableHighAccuracy, true);
});

test("gpsHudPrompt asks guests to tap until remaining is live", () => {
  assert.equal(gpsHudPrompt("ready"), "");
  assert.equal(gpsHudPrompt("ready", "remaining"), "");
  assert.equal(gpsHudPrompt("ready", "hole"), "Tap for GPS");
  assert.equal(gpsHudPrompt("denied"), "GPS blocked");
  assert.equal(gpsHudPrompt("watching"), "Finding GPS…");
  assert.equal(gpsHudPrompt("unavailable"), "GPS unavailable");
  assert.equal(gpsHudPrompt("idle"), "Tap for GPS");
  assert.equal(gpsHudPrompt(), "Tap for GPS");
});

test("withSelfLocation updates the device pin instead of adding ME", () => {
  const others = [{ index: 0, initials: "KG", lat: 35.6, lng: -77.37 }];
  assert.deepEqual(withSelfLocation(others, null), others);
  assert.deepEqual(withSelfLocation(others, { lat: 35.601, lng: -77.371 }, { index: 0, initials: "KG" }), [
    { index: 0, initials: "KG", lat: 35.601, lng: -77.371, relClass: "self" },
  ]);
  assert.deepEqual(withSelfLocation(
    [{ index: 1, initials: "TB", lat: 35.6, lng: -77.37 }],
    { lat: 35.601, lng: -77.371 },
    { index: 0, initials: "KG" },
  ), [
    { index: 1, initials: "TB", lat: 35.6, lng: -77.37 },
    { index: 0, initials: "KG", lat: 35.601, lng: -77.371, relClass: "self" },
  ]);
});

test("throw log numbers lies from the tee and skips tiny duplicates", () => {
  const tee = { lat: 35.6, lng: -77.37 };
  const landing = { lat: 35.6008, lng: -77.37 };
  const next = { lat: 35.601, lng: -77.37 };
  const first = addThrow([], landing);
  assert.deepEqual(first, [{ lat: 35.6008, lng: -77.37, n: 1 }]);
  assert.equal(addThrow(first, landing).length, 1);
  const two = addThrow(first, next);
  assert.equal(two[1].n, 2);
  assert.equal(lastThrow(two).lat, 35.601);
  const segs = throwSegments(two, tee);
  assert.equal(segs.length, 2);
  assert.ok(segs[0].ft > 0);
  assert.equal(lastThrowHud(two, tee).caption, "throw 2");
  assert.equal(undoThrow(two).length, 1);
  const arc = flightArc({ x: 10, y: 80 }, { x: 90, y: 20 }, "lie");
  assert.equal(arc.kind, "lie");
  assert.match(arc.path, /^M 10\.0 80\.0 Q /);
  assert.ok(arc.ms >= 380);
  assert.equal(flightArc({ x: 1, y: 1 }, { x: 1.2, y: 1.1 }), null);
  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, value) => store.set(key, value),
  };
  writeThrows(storage, "ABC", 1, two);
  assert.equal(throwsStorageKey("ABC", 1), "gvdg-throws:ABC:1");
  assert.deepEqual(readThrows(storage, "ABC", 1).map((row) => row.n), [1, 2]);
  writeThrows(storage, "ABC", 2, first);
  const all = readAllThrows(storage, "ABC", [{ hole: 1 }, { hole: 2 }, { hole: 3 }]);
  assert.equal(all[1].length, 2);
  assert.equal(all[2].length, 1);
  assert.equal(all[3], undefined);
});

test("currentRangeHud can remain from the last lie when GPS is off", () => {
  const hole = { distance_ft: 308, target: { lat: 35.6, lng: -77.37 } };
  const near = northOf(hole.target, 25);
  const far = { lat: 35.227, lng: -80.843 };
  assert.deepEqual(currentRangeHud(hole, near, null), {
    caption: "to basket",
    circle: null,
    ft: 82,
    holeFt: 308,
    mode: "remaining",
  });
  const farHud = currentRangeHud(hole, far, null);
  assert.equal(farHud.mode, "remaining");
  assert.equal(farHud.caption, "to basket");
  assert.ok(farHud.ft > GPS_REMAINING_MAX_FT);
  assert.equal(farHud.holeFt, 308);
  assert.deepEqual(currentRangeHud(hole, null, null), {
    caption: "hole",
    circle: null,
    ft: 308,
    mode: "hole",
  });
  const throwHud = currentRangeHud(hole, near, { a: near, b: hole.target });
  assert.equal(throwHud.mode, "throw");
  assert.equal(throwHud.holeFt, 308);
  assert.equal(throwHud.ft, 82);
  const fromLie = currentRangeHud(hole, null, null, near);
  assert.equal(fromLie.mode, "remaining");
  assert.equal(fromLie.ft, 82);
});

test("projectHoleMap stamps GPS and PDGA circles; map taps invert", () => {
  const map = projectHoleMap({
    hole: 1,
    distance_ft: 250,
    tee: { lat: 35.6, lng: -77.37, label: "Gold" },
    target: { lat: 35.601, lng: -77.37, label: "A" },
  });
  assert.equal(map.tee.lat, 35.6);
  assert.equal(map.basket.lat, 35.601);
  assert.ok(map.circle1);
  assert.ok(map.circle2);
  assert.equal(map.circle1.cx, map.basket.x);
  assert.equal(map.circle1.cy, map.basket.y);
  assert.ok(map.circle2.rx > map.circle1.rx);
  assert.ok(map.circle2.ry > map.circle1.ry);
  const c1 = circleEllipse(map, CIRCLE1_M);
  const c2 = circleEllipse(map, CIRCLE2_M);
  assert.equal(c1.rx, map.circle1.rx);
  assert.equal(c2.ry, map.circle2.ry);
  const back = latLngFromMapPoint(map, map.tee.x, map.tee.y);
  assert.ok(Math.abs(back.lat - map.tee.lat) < 1e-8);
  assert.ok(Math.abs(back.lng - map.tee.lng) < 1e-8);
});
