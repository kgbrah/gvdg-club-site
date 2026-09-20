import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  strokeLabel,
  scoreForPlayerIndexes,
  watchHoleScoreChips,
  watchMatchCards,
  watchReplayCaption,
  watchReplayDelayMs,
  watchReplayHole,
  watchReplayIsScoreStep,
  watchReplayPlayers,
  watchReplayStepCount,
  watchReplayVisibleThrows,
  watchStrokeHoleChips,
} from "../src/score-app/score-view-model.js";

test("strokeLabel names hole results from strokes vs par", () => {
  assert.deepEqual(strokeLabel(1, 3), { text: "ace", className: "under", delta: -2, strokes: 1 });
  assert.equal(strokeLabel(2, 3).text, "birdie");
  assert.equal(strokeLabel(3, 3).text, "par");
  assert.equal(strokeLabel(3, 3).className, "even");
  assert.equal(strokeLabel(4, 3).text, "bogey");
  assert.equal(strokeLabel(5, 3).text, "double");
  assert.equal(strokeLabel(6, 3).text, "+3");
  assert.equal(strokeLabel(2, 4).text, "eagle");
  assert.equal(strokeLabel(null, 3), null);
});

test("watchHoleScoreChips attach labels to GPS marks for the selected hole", () => {
  const chips = watchHoleScoreChips({
    hole: 7,
    par: 3,
    players: [
      { index: 0, scores: { 7: 3 } },
      { index: 1, scores: { 7: 2 } },
    ],
    locations: [
      { index: 0, initials: "AS", lat: 35.6, lng: -77.37 },
      { index: 1, initials: "TB", lat: 35.601, lng: -77.37 },
      { index: 2, initials: "JB", lat: 35.602, lng: -77.37 },
    ],
  });
  assert.equal(chips[0].label, "par");
  assert.equal(chips[1].label, "birdie");
  assert.equal(chips[1].strokes, 2);
  assert.equal(chips[2].label, undefined);
});

test("watchHoleScoreChips read a doubles pair score from the partner", () => {
  const chips = watchHoleScoreChips({
    hole: 1,
    par: 3,
    players: [
      { index: 0, scores: {} },
      { index: 1, scores: { 1: 2 } },
    ],
    scoreTargets: [{ id: "pair:alpha", playerIndexes: [0, 1] }],
    locations: [{ index: 0, initials: "AS", lat: 35.6, lng: -77.37 }],
  });
  assert.equal(chips[0].label, "birdie");
  assert.equal(chips[0].strokes, 2);
});

test("watchHoleScoreChips skip players omitted from an explicit doubles target list", () => {
  const chips = watchHoleScoreChips({
    hole: 1,
    par: 3,
    players: [
      { index: 0, scores: { 1: 3 } },
      { index: 1, scores: { 1: 3 } },
    ],
    scoreTargets: [{ id: "pair:beta", playerIndexes: [2, 3] }],
    locations: [{ index: 0, initials: "AS", lat: 35.6, lng: -77.37 }],
  });
  assert.equal(chips[0].label, undefined);
});

test("scoreForPlayerIndexes reads a pair's shared hole score", () => {
  const players = [
    { index: 0, scores: {} },
    { index: 1, scores: { 1: 4 } },
  ];
  assert.equal(scoreForPlayerIndexes(players, [0, 1], 1), 4);
  assert.equal(scoreForPlayerIndexes(players, [0], 1), null);
});

test("watchStrokeHoleChips list every scored player or pair on the selected hole", () => {
  const chips = watchStrokeHoleChips({
    hole: 7,
    par: 3,
    players: [
      { index: 0, name: "Alex", scores: { 7: 2 } },
      { index: 1, name: "Ty", scores: { 7: 3 } },
      { index: 2, name: "Jarrett", scores: {} },
    ],
    scoreTargets: [
      { id: "player:0", label: "Alex", playerIndexes: [0] },
      { id: "player:1", label: "Ty", playerIndexes: [1] },
      { id: "player:2", label: "Jarrett", playerIndexes: [2] },
    ],
  });
  assert.equal(chips.length, 2);
  assert.equal(chips[0].name, "Alex");
  assert.equal(chips[0].label, "birdie");
  assert.equal(chips[1].name, "Ty");
  assert.equal(chips[1].label, "par");
});

test("watchStrokeHoleChips treat an empty scoreTargets list as authoritative", () => {
  const chips = watchStrokeHoleChips({
    hole: 1,
    par: 3,
    players: [{ index: 0, name: "Alex", scores: { 1: 3 } }],
    scoreTargets: [],
  });
  assert.equal(chips.length, 0);
});

test("watchStrokeHoleChips fall back to players when scoreTargets is omitted", () => {
  const chips = watchStrokeHoleChips({
    hole: 1,
    par: 3,
    players: [{ index: 0, name: "Alex", scores: { 1: 2 } }],
  });
  assert.equal(chips.length, 1);
  assert.equal(chips[0].label, "birdie");
});

test("watchMatchCards list each pair with thru, status, and hole result chips", () => {
  const cards = watchMatchCards({
    hole: 1,
    par: 3,
    players: [
      { index: 0, cardId: "c0", scores: { 1: 3 } },
      { index: 1, cardId: "c0", scores: { 1: 4 } },
    ],
    scoreTargets: [
      { id: "t-left", label: "AS", playerIndexes: [0], members: ["Alex"] },
      { id: "t-right", label: "JB", playerIndexes: [1], members: ["Jarrett"] },
    ],
    standings: [
      { targetId: "t-left", thru: 1, match: { status: "1 up", outcome: "leading", holesWon: 1, holesLost: 0, holesTied: 0 } },
      { targetId: "t-right", thru: 1, match: { status: "1 up", outcome: "trailing", holesWon: 0, holesLost: 1, holesTied: 0 } },
    ],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, "AS vs JB");
  assert.equal(cards[0].status, "AS 1 up");
  assert.equal(cards[0].thru, 1);
  assert.equal(cards[0].chips[0].label, "par");
  assert.equal(cards[0].chips[0].result, "won");
  assert.equal(cards[0].chips[1].label, "bogey");
  assert.equal(cards[0].chips[1].result, "lost");
});

test("watchMatchCards group two targets by card even when cardId is null", () => {
  const cards = watchMatchCards({
    hole: 2,
    par: 3,
    players: [
      { index: 0, cardId: null, scores: { 2: 3 } },
      { index: 1, cardId: null, scores: { 2: 3 } },
      { index: 2, cardId: "c1", scores: { 2: 2 } },
      { index: 3, cardId: "c1", scores: { 2: 4 } },
    ],
    scoreTargets: [
      { id: "a", label: "A", playerIndexes: [0] },
      { id: "b", label: "B", playerIndexes: [1] },
      { id: "c", label: "C", playerIndexes: [2] },
      { id: "d", label: "D", playerIndexes: [3] },
    ],
    standings: [
      { targetId: "a", thru: 2, match: { status: "AS", outcome: "draw", holesWon: 0, holesLost: 0, holesTied: 2 } },
      { targetId: "c", thru: 2, match: { status: "1 up", outcome: "leading", holesWon: 1, holesLost: 0, holesTied: 1 } },
    ],
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].title, "A vs B");
  assert.equal(cards[0].status, "AS");
  assert.equal(cards[0].thru, 2);
  assert.equal(cards[0].chips[0].result, "halved");
  assert.equal(cards[1].title, "C vs D");
  assert.equal(cards[1].status, "C 1 up");
  assert.equal(cards[1].chips[0].result, "won");
});

test("watchMatchCards thru counts completed head-to-head holes, not a side's own scores", () => {
  const cards = watchMatchCards({
    hole: 2,
    par: 3,
    players: [
      { index: 0, cardId: "c0", scores: { 1: 3, 2: 3 } },
      { index: 1, cardId: "c0", scores: { 1: 4 } },
    ],
    scoreTargets: [
      { id: "t-left", label: "AS", playerIndexes: [0] },
      { id: "t-right", label: "JB", playerIndexes: [1] },
    ],
    standings: [
      { targetId: "t-left", thru: 2, match: { status: "AS", outcome: "draw", holesWon: 0, holesLost: 0, holesTied: 1 } },
      { targetId: "t-right", thru: 1, match: { status: "AS", outcome: "draw", holesWon: 0, holesLost: 0, holesTied: 1 } },
    ],
  });
  assert.equal(cards[0].thru, 1);
  assert.equal(cards[0].status, "AS");
  assert.equal(cards[0].chips.length, 1);
});

test("watch replay reveals throws one at a time then the score", () => {
  const player = {
    index: 0,
    name: "KG",
    scores: { 1: 3 },
    throws: { 1: [{ lat: 35.6005, lng: -77.37, n: 1 }, { lat: 35.6008, lng: -77.37, n: 2 }] },
  };
  const hole = { hole: 1, par: 3, tee: { lat: 35.6, lng: -77.37 } };
  const plan = watchReplayHole({ player, hole });
  assert.equal(plan.throwCount, 2);
  assert.equal(plan.strokes, 3);
  assert.equal(watchReplayStepCount(plan), 4);
  assert.equal(watchReplayVisibleThrows(plan, 0).length, 0);
  assert.equal(watchReplayVisibleThrows(plan, 1).length, 1);
  assert.equal(watchReplayVisibleThrows(plan, 2).length, 2);
  assert.equal(watchReplayIsScoreStep(plan, 2), false);
  assert.equal(watchReplayIsScoreStep(plan, 3), true);
  assert.equal(watchReplayCaption(plan, 0), "On the tee");
  assert.match(watchReplayCaption(plan, 3), /In the basket/);
  assert.equal(watchReplayDelayMs(plan, 0), 2400);
  assert.equal(watchReplayDelayMs(plan, 1), 4200);
  assert.equal(watchReplayDelayMs(plan, 3), 4500);
  assert.deepEqual(watchReplayPlayers([player, { index: 1, name: "JR" }]).map((row) => row.name), ["KG", "JR"]);
});

test("watch view uses overlay chips for stroke and match cards for matchplay", () => {
  const watch = readFileSync("src/score-app/watch-view.js", "utf8");
  const map = readFileSync("src/shared/hole-map.js", "utf8");
  assert.match(watch, /function WatchStrokeStrip/);
  assert.match(watch, /function WatchMatchCards/);
  assert.match(watch, /watchHoleScoreChips/);
  assert.match(watch, /watchStrokeHoleChips/);
  assert.match(watch, /watchMatchCards/);
  assert.match(watch, /props\.isMatchplay \? h\(WatchMatchCards/);
  assert.match(map, /function ScoreChips/);
  assert.match(map, /if \(compact\) return null/);
  assert.match(map, /scoreChipAnchor/);
  const html = readFileSync("score.html", "utf8");
  assert.match(html, /chip-left\.chip-above/);
  assert.match(html, /chip-right\.chip-below/);
});
