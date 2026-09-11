import assert from "node:assert/strict";
import test from "node:test";

import { isLiveWatchRequest, liveScoreHref, liveWatchHref } from "../src/shared/live-watch.js";

test("liveWatchHref builds a public watch URL for events and casual rounds", () => {
  assert.equal(liveWatchHref({ eventId: 2 }), "score.html?event=2&watch=1");
  assert.equal(liveWatchHref({ roundCode: "qa12-34" }), "score.html?round=QA1234&watch=1");
  assert.equal(liveWatchHref({}), "");
});

test("liveScoreHref omits watch and can carry a guest token", () => {
  assert.equal(liveScoreHref({ eventId: 2, guestToken: "abc" }), "score.html?event=2&gt=abc");
  assert.equal(liveScoreHref({ roundCode: "K7M2QX" }), "score.html?round=K7M2QX");
});

test("isLiveWatchRequest accepts 1/true/yes", () => {
  assert.equal(isLiveWatchRequest("round=QA1234&watch=1"), true);
  assert.equal(isLiveWatchRequest("?event=2&watch=true"), true);
  assert.equal(isLiveWatchRequest(new URLSearchParams("watch=yes")), true);
  assert.equal(isLiveWatchRequest("round=QA1234"), false);
});
