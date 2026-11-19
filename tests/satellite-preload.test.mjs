import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { HOLE_MAP_COMPACT_SIZE, HOLE_MAP_WATCH_SIZE, projectHoleMap } from "../src/shared/hole-map-model.js";
import {
  preloadRoundMaps,
  satelliteTileUrlsForHole,
  satelliteUrlForHole,
  satelliteUrlsForRound,
} from "../src/shared/satellite-preload.js";

const hole = (n, lat) => ({
  hole: n,
  tee: { lat, lng: -77.37 },
  target: { lat: lat + 0.001, lng: -77.37 },
});

const layout = [hole(1, 35.6), hole(2, 35.61), hole(3, 35.62), hole(4, 35.63), hole(5, 35.64), hole(6, 35.65)];

test("satelliteUrlForHole matches the projected watch and scorecard images", () => {
  const watch = satelliteUrlForHole(layout[0], { ...HOLE_MAP_WATCH_SIZE, focus: "hole" });
  const compact = satelliteUrlForHole(layout[0], { ...HOLE_MAP_COMPACT_SIZE, focus: "hole" });
  assert.match(watch, /size=960%2C1215|size=960,1215/);
  assert.match(compact, /size=320%2C180|size=320,180/);
  assert.notEqual(watch, compact);
});

test("satelliteUrlsForRound warms the tiles of the current hole, neighbors, and zoom variants", () => {
  const tilesOf = (row, focus = "hole", size = HOLE_MAP_WATCH_SIZE) => satelliteTileUrlsForHole(row, { ...size, focus });
  const now = satelliteUrlsForRound(layout, { activeIndex: 2, ahead: 2, size: HOLE_MAP_WATCH_SIZE });
  const all = satelliteUrlsForRound(layout, { activeIndex: 2, all: true, size: HOLE_MAP_WATCH_SIZE });
  const zooms = satelliteUrlsForRound(layout, { activeIndex: 2, ahead: 0, size: HOLE_MAP_COMPACT_SIZE, zooms: true });
  const unique = (lists) => [...new Set(lists.flat())];
  assert.deepEqual(now, unique([1, 2, 3, 4].map((i) => tilesOf(layout[i]))));
  assert.deepEqual(all, unique(layout.map((row) => tilesOf(row))));
  assert.deepEqual(zooms, unique([1, 2].map((i) => tilesOf(layout[i], "hole", HOLE_MAP_COMPACT_SIZE)).concat([tilesOf(layout[2], "c1", HOLE_MAP_COMPACT_SIZE), tilesOf(layout[2], "c2", HOLE_MAP_COMPACT_SIZE)])));
  assert.ok(now.every((url) => /\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(url)), "tiles, never the slow export");
});

test("preloadRoundMaps fetches neighbors now and the rest of the layout later (not with Data Saver on)", () => {
  const loaded = [];
  const idle = [];
  const result = preloadRoundMaps(layout, {
    activeIndex: 0,
    ahead: 1,
    all: true,
    size: HOLE_MAP_WATCH_SIZE,
    saveData: false,
    loader: (url) => loaded.push(url),
    scheduleIdle: (fn) => idle.push(fn),
  });
  assert.ok(result.now.length > 0 && result.later.length > 0);
  assert.deepEqual(loaded, result.now);
  idle.forEach((fn) => fn());
  assert.deepEqual(loaded, [...result.now, ...result.later]);
  const saving = preloadRoundMaps(layout.map((row) => ({ ...row, hole: row.hole + 100, tee: { ...row.tee, lng: -77.5 }, target: { ...row.target, lng: -77.5 } })), {
    activeIndex: 0, ahead: 1, all: true, size: HOLE_MAP_WATCH_SIZE, saveData: true, loader: () => {}, scheduleIdle: (fn) => fn(),
  });
  assert.equal(saving.later.length, 0, "Data Saver: just the holes around the one in view");
});

test("the scorer warms the tiles its fitted map will show", () => {
  const size = { width: 362, height: 356 };
  const urls = satelliteUrlsForRound(layout, { size, activeIndex: 2, ahead: 1, fitViewport: true });
  const expected = [...new Set(layout.slice(1, 4).flatMap((row) => satelliteTileUrlsForHole(row, { ...size, fitViewport: true })))];
  assert.deepEqual(urls, expected);
  const map = projectHoleMap(layout[2], { ...size, fitViewport: true });
  assert.ok(map.satelliteUrl.includes("/MapServer/export"), "the export picture is still there as the fallback");
});

test("watch and scorecard surfaces preload maps before they are shown", () => {
  const watch = readFileSync("src/score-app/watch-view.js", "utf8");
  const score = readFileSync("src/score-app/scorecard-view.js", "utf8");
  const map = readFileSync("src/shared/hole-map.js", "utf8");
  assert.match(watch, /preloadRoundMaps\(holes/);
  assert.match(watch, /HOLE_MAP_WATCH_SIZE/);
  assert.match(score, /preloadRoundMaps\(holes/);
  assert.match(score, /HOLE_MAP_COMPACT_SIZE/);
  assert.match(map, /fetchPriority: "high"/);
  assert.match(map, /HOLE_MAP_WATCH_SIZE/);
});
