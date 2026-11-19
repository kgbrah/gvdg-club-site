import assert from "node:assert/strict";
import test from "node:test";

import { HOLE_MAP_SIZE, HOLE_MAP_WATCH_SIZE, projectHoleMap, SATELLITE_MAX_TILES, satelliteTileLayers, satelliteTileZoom } from "../src/shared/hole-map-model.js";

const hole = { hole: 1, par: 3, tee: { lat: 35.62005, lng: -77.37012 }, target: { lat: 35.62071, lng: -77.36938 } };

test("tiles cover the whole map in one sharp zoom, the same for every screen size", () => {
  const small = projectHoleMap(hole, { ...HOLE_MAP_SIZE, fitViewport: true });
  const big = projectHoleMap(hole, { ...HOLE_MAP_WATCH_SIZE, fitViewport: true });
  for (const map of [small, big]) {
    const tiles = satelliteTileLayers(map.bounds, map.width, map.height);
    assert.ok(tiles.length >= 1 && tiles.length <= SATELLITE_MAX_TILES);
    assert.match(tiles[0].url, /\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/);
    // Every corner of the frame is under a tile (no gaps).
    for (const [x, y] of [[0.5, 0.5], [99.5, 0.5], [0.5, 99.5], [99.5, 99.5], [50, 50]]) {
      assert.ok(tiles.some((tile) => tile.left <= x && x <= tile.left + tile.width && tile.top <= y && y <= tile.top + tile.height), `covered at ${x},${y}`);
    }
  }
  // The big replay map isn't one blurry zoom-12 tile any more: a 300 ft hole is drawn at zoom 18-19.
  assert.ok(satelliteTileZoom(big.bounds) >= 18, "sharp on the big replay map: " + satelliteTileZoom(big.bounds));
  assert.ok(satelliteTileZoom(small.bounds) >= 18);
});

test("a long hole steps the zoom down to stay within the tile budget", () => {
  const long = { hole: 2, par: 4, tee: { lat: 35.6, lng: -77.37 }, target: { lat: 35.605, lng: -77.364 } };
  const map = projectHoleMap(long, { ...HOLE_MAP_WATCH_SIZE, fitViewport: true });
  const tiles = satelliteTileLayers(map.bounds, map.width, map.height);
  assert.ok(tiles.length <= SATELLITE_MAX_TILES);
  assert.ok(satelliteTileZoom(map.bounds) < 19);
});
