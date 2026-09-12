import assert from "node:assert/strict";
import test from "node:test";

import { isLiveWatchRequest, liveRoundCodeFromSearch, liveScoreHref, liveWatchHref } from "../src/shared/live-watch.js";

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

test("isLiveWatchRequest treats a 4+ char watch value as a spectator round code", () => {
  assert.equal(isLiveWatchRequest("watch=6CDNME"), true);
  assert.equal(isLiveWatchRequest("?watch=qa12-34"), true);
  assert.equal(isLiveWatchRequest("watch=1"), true);
  assert.equal(isLiveWatchRequest("watch=ab"), false);
});

test("liveRoundCodeFromSearch reads round= first, then a watch= code alias", () => {
  assert.equal(liveRoundCodeFromSearch("round=QA1234&watch=1"), "QA1234");
  assert.equal(liveRoundCodeFromSearch("watch=6CDNME"), "6CDNME");
  assert.equal(liveRoundCodeFromSearch("?watch=qa12-34"), "QA1234");
  assert.equal(liveRoundCodeFromSearch("watch=1"), "");
  assert.equal(liveRoundCodeFromSearch("watch=true"), "");
  assert.equal(liveRoundCodeFromSearch("event=2&watch=1"), "");
  assert.equal(liveRoundCodeFromSearch(new URLSearchParams("round=k7m2qx")), "K7M2QX");
});
