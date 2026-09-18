import assert from "node:assert/strict";
import test from "node:test";

import { CIRCLE1_M, CIRCLE2_M, circleEllipse, currentRangeHud, GPS_WATCH_OPTIONS, gpsErrorPolicy, gpsHudPrompt, headingDeg, holeMapLabel, holePoint, latLngFromMapPoint, playerMarksOnMap, projectHoleMap, projectMapPoint, puttingCircle, rangeHud, remainingFt, satelliteImageUrl, scoreChipAnchor, teePadRotationDeg, windBlowToDeg, withSelfLocation } from "../src/shared/hole-map-model.js";

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

test("gpsErrorPolicy keeps the last fix and retries timeouts", () => {
  assert.deepEqual(gpsErrorPolicy(1, true), { keepFix: true, restart: false, retryMs: 0, status: "denied" });
  assert.deepEqual(gpsErrorPolicy(3, true), { keepFix: true, restart: true, retryMs: 2000, status: "ready" });
  assert.deepEqual(gpsErrorPolicy(2, false), { keepFix: true, restart: true, retryMs: 2000, status: "watching" });
  assert.equal(GPS_WATCH_OPTIONS.timeout, 60000);
  assert.equal(GPS_WATCH_OPTIONS.enableHighAccuracy, true);
});

test("gpsHudPrompt asks guests to tap until a fix lands", () => {
  assert.equal(gpsHudPrompt("ready"), "");
  assert.equal(gpsHudPrompt("denied"), "GPS blocked");
  assert.equal(gpsHudPrompt("watching"), "Finding GPS…");
  assert.equal(gpsHudPrompt("unavailable"), "GPS unavailable");
  assert.equal(gpsHudPrompt("idle"), "Tap for GPS");
  assert.equal(gpsHudPrompt(), "Tap for GPS");
});

test("withSelfLocation stamps the device as ME without dropping other marks", () => {
  const others = [{ initials: "KG", lat: 35.6, lng: -77.37 }];
  assert.deepEqual(withSelfLocation(others, null), others);
  assert.deepEqual(withSelfLocation(others, { lat: 35.601, lng: -77.371 }), [
    { initials: "KG", lat: 35.6, lng: -77.37 },
    { initials: "ME", lat: 35.601, lng: -77.371, relClass: "self" },
  ]);
});

test("currentRangeHud uses GPS remaining on the hole and falls back when GPS is miles away", () => {
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
  assert.equal(farHud.mode, "hole");
  assert.equal(farHud.caption, "hole");
  assert.equal(farHud.ft, 308);
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
