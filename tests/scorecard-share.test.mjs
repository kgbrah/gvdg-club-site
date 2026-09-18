import assert from "node:assert/strict";
import test from "node:test";

import {
  buildShareCard,
  drawShareCard,
  shareCardDate,
  shareCardFileName,
  shareCardSize,
  shareCardText,
  SHARE_CARD_WIDTH,
} from "../src/score-app/scorecard-share.js";

function sampleState() {
  return {
    courseName: "Ayden Park",
    layoutName: "Gold",
    holes: [
      { hole: 1, par: 3 }, { hole: 2, par: 3 }, { hole: 3, par: 3 },
      { hole: 4, par: 3 }, { hole: 5, par: 3 }, { hole: 6, par: 3 },
      { hole: 7, par: 3 }, { hole: 8, par: 3 }, { hole: 9, par: 3 },
      { hole: 10, par: 3 }, { hole: 11, par: 3 }, { hole: 12, par: 3 },
      { hole: 13, par: 3 }, { hole: 14, par: 3 }, { hole: 15, par: 3 },
      { hole: 16, par: 3 }, { hole: 17, par: 3 }, { hole: 18, par: 3 },
    ],
    cardmates: [
      { index: 0, name: "Ava King", isMe: true, scores: { 1: 2, 2: 3, 3: 4 } },
      { index: 1, name: "Milo Chen", scores: { 1: 3, 2: 3 } },
    ],
    myIndex: 0,
    roundConfig: { groupFormat: "singles", scoringStyle: "stroke" },
    scoreTargets: [],
  };
}

test("share card date is Eastern", () => {
  const when = shareCardDate(new Date("2026-09-18T16:00:00.000Z"));
  assert.equal(when.iso, "2026-09-18");
  assert.match(when.display, /Sep 18, 2026/);
});

test("buildShareCard totals the card and drops (you)", () => {
  const model = buildShareCard(sampleState(), {
    now: new Date("2026-09-18T16:00:00.000Z"),
    roundCode: "JQEU74",
    scorerIndex: 0,
  });
  assert.equal(model.mark, "GVDG");
  assert.equal(model.course, "Ayden Park");
  assert.equal(model.layout, "Gold");
  assert.equal(model.roundCode, "JQEU74");
  assert.equal(model.scored, true);
  assert.equal(model.holes.length, 18);
  assert.equal(model.players[0].label, "Ava King");
  assert.equal(model.players[0].total, 9);
  assert.equal(model.players[0].toPar, 0);
  assert.equal(model.players[0].thru, 3);
  assert.equal(model.players[0].scores[0], 2);
  assert.equal(model.players[1].label, "Milo Chen");
  assert.equal(model.players[1].total, 6);
  assert.equal(model.players[1].toPar, 0);
  assert.equal(shareCardFileName(model), "gvdg-ayden-park-2026-09-18.png");
  assert.match(shareCardText(model, "https://gvdgclub.com/score?round=JQEU74"), /Join my card — code JQEU74/);
});

test("buildShareCard stays quiet until someone has a score", () => {
  const model = buildShareCard({
    ...sampleState(),
    cardmates: [
      { index: 0, name: "Ava King", isMe: true, scores: {} },
    ],
  });
  assert.equal(model.scored, false);
  assert.equal(model.players[0].total, null);
});

test("share card is a 1080-wide social image and paints the round", () => {
  const model = buildShareCard(sampleState(), {
    now: new Date("2026-09-18T16:00:00.000Z"),
    roundCode: "JQEU74",
  });
  const size = shareCardSize(model);
  assert.equal(size.width, SHARE_CARD_WIDTH);
  assert.ok(size.height >= 1350);
  const texts = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    fillRect() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    stroke() {},
    fillText(text) { texts.push(String(text)); },
    measureText(text) { return { width: String(text).length * 10 }; },
  };
  drawShareCard(ctx, model, size);
  assert.ok(texts.includes("GVDG"));
  assert.ok(texts.includes("Ayden Park"));
  assert.ok(texts.includes("Ava King"));
  assert.ok(texts.includes("2"));
  assert.ok(texts.includes("gvdgclub.com"));
  assert.ok(texts.some((text) => text.includes("JQEU74")));
});
