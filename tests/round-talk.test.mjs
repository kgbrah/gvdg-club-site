import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { mergeRoundMessages, roundMessageNotice, unseenRoundMessages } from "../src/shared/round-messages-model.js";
import { messagePathFromLocation } from "../src/score-app/round-talk.js";

test("a watcher message lands on the card thread", () => {
  const merged = mergeRoundMessages([], [
    { id: 1, side: "watch", authorName: "Sam", toName: "Kevin", body: "Parked it" },
    { id: 1, side: "watch", authorName: "Sam", toName: "Kevin", body: "Parked it" },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(messagePathFromLocation({ search: "?event=12" }), "/events/12/live/messages");
  assert.equal(messagePathFromLocation({ search: "?round=abcd" }), "/rounds/ABCD/live/messages");
  const watch = readFileSync("src/score-app/watch-view.js", "utf8");
  const card = readFileSync("src/score-app/scorecard-view.js", "utf8");
  assert.match(watch, /viewer: "watch"/);
  assert.match(card, /viewer: "card"/);
  const actions = card.slice(card.indexOf("function RoundToolActions"), card.indexOf("function RoundTools"));
  const tools = card.slice(card.indexOf("function RoundTools"), card.indexOf("function HoleHeader"));
  assert.doesNotMatch(actions, /RoundTalk/);
  assert.match(tools, /round-quick-tools[\s\S]*RoundTalk/);
  assert.match(readFileSync("sw.js", "utf8"), /data\.kind === "talk"/);
});

test("unseen card messages ignore the card's own replies", () => {
  const thread = [
    { id: "1", side: "watch", authorName: "Sam", toName: "", body: "Parked it" },
    { id: "2", side: "card", authorName: "Kevin", toName: "", body: "Thanks" },
    { id: "4", side: "watch", authorName: "Sam", toName: "Kevin", body: "In the tree" },
  ];
  const unseen = unseenRoundMessages(thread, 1, "card");
  assert.deepEqual(unseen.map((message) => message.id), ["4"]);
  assert.equal(roundMessageNotice(unseen[0]).title, "Sam to Kevin");
  assert.equal(roundMessageNotice(unseen[0]).body, "In the tree");
  assert.deepEqual(unseenRoundMessages(thread, 4, "card"), []);
  assert.equal(unseenRoundMessages(thread, 0, "watch").length, 1);
});
