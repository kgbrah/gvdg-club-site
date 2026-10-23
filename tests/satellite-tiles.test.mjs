import assert from "node:assert/strict";
import test from "node:test";

import { satelliteTileLayers } from "../src/shared/hole-map-model.js";

test("satellite tiles cover a hole when the export photo fails", () => {
  const tiles = satelliteTileLayers(
    { minLat: 35.488, maxLat: 35.491, minLng: -77.428, maxLng: -77.424 },
    640,
    360,
  );
  assert.ok(tiles.length >= 1 && tiles.length <= 16);
  assert.match(tiles[0].url, /\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/);
  assert.ok(tiles.some((tile) => tile.left < 100 && tile.top < 100 && tile.width > 0 && tile.height > 0));
});
