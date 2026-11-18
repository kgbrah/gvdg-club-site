import assert from "node:assert/strict";
import test from "node:test";

import { isQuiet, liveRoundMeta, sinceText } from "../src/admin-app/live-rounds-panel.js";

const NOW = Date.parse("2026-11-18T15:00:00Z");

test("live round times read naturally", () => {
  assert.equal(sinceText("2026-11-18T14:59:30Z", NOW), "just now");
  assert.equal(sinceText("2026-11-18T14:35:00Z", NOW), "25 min ago");
  assert.equal(sinceText("2026-11-18T12:00:00Z", NOW), "3 h ago");
  assert.equal(sinceText("2026-11-17T13:00:00Z", NOW), "26 h ago");
  assert.equal(sinceText("2026-11-15T15:00:00Z", NOW), "3 days ago");
  assert.equal(sinceText("", NOW), "");
});

test("a round's line says how far along it is and when it last moved; quiet after an hour", () => {
  const round = { holes: 18, holesScored: 2, lastActivity: "2026-11-17T13:00:00Z" };
  assert.equal(liveRoundMeta(round, NOW), "2 of 18 holes scored · last activity 26 h ago");
  assert.equal(isQuiet(round, NOW), true);
  assert.equal(isQuiet({ lastActivity: "2026-11-18T14:10:00Z" }, NOW), false);
  assert.equal(isQuiet({}, NOW), false);
  assert.equal(liveRoundMeta({}, NOW), "");
});
