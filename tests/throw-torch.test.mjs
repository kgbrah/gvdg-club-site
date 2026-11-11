import assert from "node:assert/strict";
import test from "node:test";

import { clipsForStanding, setTrackTorch, torchConstraints, trackSupportsTorch } from "../src/score-app/throw-film.js";

test("the light is switched without restarting the picture size", async () => {
  let applied = null;
  const track = {
    readyState: "live",
    async applyConstraints(next) { applied = next; },
  };
  assert.deepEqual(torchConstraints(true), { advanced: [{ torch: true }] });
  assert.equal(await setTrackTorch(track, true), true);
  assert.deepEqual(applied, { advanced: [{ torch: true }] });
  assert.equal(applied.width, undefined);
});

test("the front camera is not offered a light", () => {
  assert.equal(trackSupportsTorch({
    getCapabilities: () => ({}),
    getSettings: () => ({ facingMode: "user" }),
  }), false);
  assert.equal(trackSupportsTorch({
    getCapabilities: () => ({ torch: true }),
    getSettings: () => ({ facingMode: "environment" }),
  }), true);
});

test("a player's clips stay with that name on the leaderboard", () => {
  const clips = [
    { id: 1, mediaPath: "/events/1/live/clips/1/media", playerName: "Kevin Gray", playerIndex: 0, hole: 2 },
    { id: 2, mediaPath: "/events/1/live/clips/2/media", playerName: "Steveo", playerIndex: 1, hole: 6 },
  ];
  const kevin = clipsForStanding(clips, { name: "Kevin Gray", playerIndexes: [0] });
  assert.equal(kevin.length, 1);
  assert.equal(kevin[0].id, 1);
  assert.equal(clipsForStanding(clips, { name: "Aaron Renaud", playerIndexes: [2] }).length, 0);
});
