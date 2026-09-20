import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { HOLE_MAP_COMPACT_SIZE, HOLE_MAP_WATCH_SIZE } from "../src/shared/hole-map-model.js";
import {
  preloadRoundMaps,
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

test("satelliteUrlsForRound warms the current hole, neighbors, and zoom variants first", () => {
  const now = satelliteUrlsForRound(layout, {
    activeIndex: 2,
    ahead: 2,
    size: HOLE_MAP_WATCH_SIZE,
  });
  const all = satelliteUrlsForRound(layout, {
    activeIndex: 2,
    all: true,
    size: HOLE_MAP_WATCH_SIZE,
  });
  const zooms = satelliteUrlsForRound(layout, {
    activeIndex: 2,
    ahead: 0,
    size: HOLE_MAP_COMPACT_SIZE,
    zooms: true,
  });
  assert.equal(now.length, 4);
  assert.equal(all.length, 6);
  assert.equal(zooms.length, 4);
  assert.equal(now[0], satelliteUrlForHole(layout[1], { ...HOLE_MAP_WATCH_SIZE, focus: "hole" }));
});

test("preloadRoundMaps fetches neighbors now and the rest of the layout later", () => {
  const loaded = [];
  const idle = [];
  const result = preloadRoundMaps(layout, {
    activeIndex: 0,
    ahead: 1,
    all: true,
    size: HOLE_MAP_WATCH_SIZE,
    loader: (url) => loaded.push(url),
    scheduleIdle: (fn) => idle.push(fn),
  });
  assert.equal(result.now.length, 2);
  assert.equal(result.later.length, 4);
  assert.deepEqual(loaded, result.now);
  idle.forEach((fn) => fn());
  assert.deepEqual(loaded, [...result.now, ...result.later]);
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
