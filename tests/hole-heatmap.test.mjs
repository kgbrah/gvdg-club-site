import assert from "node:assert/strict";
import test from "node:test";

import { colorizeHeatmap, heatmapPayloadOk, HEATMAP_MIN_SAMPLES, splatHeatmap } from "../src/shared/hole-heatmap.js";

test("splatHeatmap peaks on the sample and stays quiet far away", () => {
  const grid = splatHeatmap(20, 20, [{ x: 10, y: 10 }], { sigma: 3 });
  assert.equal(grid.width, 20);
  assert.equal(grid.height, 20);
  assert.ok(grid.max > 0);
  const center = grid.data[10 * 20 + 10];
  const corner = grid.data[0];
  assert.equal(center, grid.max);
  assert.ok(corner < center * 0.05);
});

test("colorizeHeatmap paints gold-to-coral only where density exists", () => {
  const image = { data: new Uint8ClampedArray(2 * 2 * 4) };
  const data = new Float32Array([0, 1, 0.5, 0]);
  colorizeHeatmap(image, { data, max: 1, width: 2, height: 2 });
  assert.equal(image.data[0], 0);
  assert.equal(image.data[3], 0);
  assert.ok(image.data[4] > 180);
  assert.ok(image.data[7] > 40);
  assert.ok(image.data[8] > 180);
  assert.ok(image.data[11] > 0);
});

test("heatmapPayloadOk accepts field or you arrays", () => {
  assert.equal(heatmapPayloadOk(null), false);
  assert.equal(heatmapPayloadOk({ hole: 1 }), false);
  assert.equal(heatmapPayloadOk({ lies: [] }), true);
  assert.equal(heatmapPayloadOk({ you: [{ lat: 35, lng: -77, n: 1 }] }), true);
  assert.equal(HEATMAP_MIN_SAMPLES, 3);
});
