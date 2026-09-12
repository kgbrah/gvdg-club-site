import assert from "node:assert/strict";
import test from "node:test";

import { DOUBLES_LEAGUE_DATA } from "../src/members-app/doubles-league-data.js";
import { mergeDoublesLeaderboard } from "../src/members-app/doubles-league-panel.js";

test("doubles leaderboard merges T.J. / TJ spellings without mixing Braley and Williams", () => {
  const original = DOUBLES_LEAGUE_DATA.leaderboard || [];
  const originalBraley = original.filter((player) => /braley/i.test(player.n));
  const originalWilliams = original.filter((player) => /^t\.?j\.?\s+williams$/i.test(player.n));
  assert.ok(originalBraley.length >= 2, "fixture still has split Braley spellings");
  assert.ok(originalWilliams.length >= 2, "fixture still has split Williams spellings");

  const merged = mergeDoublesLeaderboard(original);
  const braleys = merged.filter((player) => /braley/i.test(player.n));
  const williams = merged.filter((player) => /^t\.?j\.?\s+williams$/i.test(player.n));

  assert.equal(braleys.length, 1);
  assert.equal(williams.length, 1);
  assert.equal(braleys[0].tp, originalBraley.reduce((sum, player) => sum + (player.tp || 0), 0));
  assert.equal(williams[0].tp, originalWilliams.reduce((sum, player) => sum + (player.tp || 0), 0));
  assert.notEqual(braleys[0].n.toLowerCase(), williams[0].n.toLowerCase());
});
