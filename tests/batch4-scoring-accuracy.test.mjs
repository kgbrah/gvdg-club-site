import assert from "node:assert/strict";
import test from "node:test";

import { casualReplaySnapshot } from "../src/shared/casual-replay.js";
import { decorateStandings, handicapKey, handicapScoringEnabled, myLayoutHandicaps } from "../src/shared/handicap.js";
import { offlineRoundOutcome } from "../src/shared/offline-round.js";
import { playStatsByKind, selectPlayStatsView } from "../src/shared/play-stats.js";
import { holePlayStats } from "../src/shared/shot-stats-model.js";
import { createRoundJournal, drainRoundJournal, roundRecoveryScope } from "../src/score-app/round-recovery.js";
import { applyTeeOrder, isMatchDormie, optimisticScores, scoreRows, throwsByScorer } from "../src/score-app/score-view-model.js";
import { buildShareCard, drawShareCard, shareCardSize } from "../src/score-app/scorecard-share.js";

test("handicapScoringEnabled disables putting and myLayoutHandicaps combines casual + competition singles", () => {
  assert.equal(handicapScoringEnabled({ scoringStyle: "putting", handicap: true }), false);
  const now = new Date("2026-11-15T12:00:00Z");
  const list = myLayoutHandicaps([
    { layout_id: 7, course_name: "Park", layout_name: "Main", to_par: 2, place: 1, finalized_at: "2026-11-01", stroke: true },
    { layout_id: 7, course_name: "Park", layout_name: "Main", to_par: 4, place: 2, event_date: "2026-10-15", stroke_singles: 1 },
    { layout_id: 7, course_name: "Park", layout_name: "Main", to_par: -12, place: 1, event_date: "2026-10-01", stroke_singles: 0 },
  ], now);
  assert.equal(list.length, 1);
  assert.equal(list[0].rounds, 2);
  assert.equal(list[0].start, -2);
});

test("decorateStandings averages partner handicap starts for doubles pairs", () => {
  const ranked = decorateStandings([
    { name: "Team A", toPar: 2, thru: 18, handicapKeys: [handicapKey("m_one"), handicapKey("m_two")] },
  ], {
    [handicapKey("m_one")]: { start: -4, rounds: 4, provisional: false },
    [handicapKey("m_two")]: { start: 0, rounds: 4, provisional: false },
  });
  assert.equal(ranked[0].handicapStart, -2);
  assert.equal(ranked[0].net, 0);
});

test("holePlayStats uses next.puttDistanceFt for non-GPS manual shot ledgers", () => {
  const hole = { hole: 1, par: 3 };
  const inside = holePlayStats(hole, [
    { kind: "throw", outcome: "missed", attempt: "throw" },
    { kind: "throw", outcome: "made", attempt: "putt", puttDistanceFt: 20 },
  ], 2);
  assert.deepEqual(inside.c1r, { att: 1, hit: 1 });
  assert.deepEqual(inside.parked, { att: 1, hit: 0 });
  const missAndScramble = holePlayStats(hole, [
    { kind: "throw", outcome: "missed", attempt: "throw" },
    { kind: "throw", outcome: "missed", attempt: "putt", puttDistanceFt: 75 },
    { kind: "throw", outcome: "made", attempt: "putt", puttDistanceFt: 8 },
  ], 3);
  assert.deepEqual(missAndScramble.c1r, { att: 1, hit: 0 });
  assert.deepEqual(missAndScramble.c2r, { att: 1, hit: 0 });
  assert.deepEqual(missAndScramble.scramble, { att: 1, hit: 1 });
});

test("offlineRoundOutcome matchplay handles skipped holes and shotgun clinches", () => {
  const round = {
    format: { scoringStyle: "matchplay", groupFormat: "singles" },
    source: { holes: [{ hole: 1, par: 3 }, { hole: 2, par: 3 }, { hole: 3, par: 3 }, { hole: 4, par: 3 }] },
    players: [{ id: "p1", name: "A" }, { id: "p2", name: "B" }],
    scores: {
      "player:0": { 2: 2, 3: 2, 4: 2 },
      "player:1": { 2: 3, 3: 3, 4: 3 },
    },
  };
  const outcome = offlineRoundOutcome(round);
  assert.equal(outcome.match.played, 3);
  assert.equal(outcome.match.label, "3&1");
  assert.equal(outcome.complete, true);
  assert.deepEqual(outcome.requiredHoles, [2, 3, 4]);
});

test("playStatsByKind excludes putting rows from the all-style stroke mix", () => {
  const payload = playStatsByKind([
    {
      member_id: "m_1",
      name: "Alex",
      kind: "casual",
      group_format: "singles",
      scoring_style: "stroke",
      breakdown: { holes: 18, aces: 1, eagles: 0, birdies: 2, pars: 15, bogeys: 0, doubles_plus: 0 },
    },
    {
      member_id: "m_1",
      name: "Alex",
      kind: "casual",
      group_format: "singles",
      scoring_style: "putting",
      breakdown: { holes: 5, aces: 5, eagles: 0, birdies: 0, pars: 0, bogeys: 0, doubles_plus: 0 },
    },
  ], "m_1");
  assert.equal(selectPlayStatsView(payload.casual, "all", "all").mine.totals.aces, 1);
  assert.equal(selectPlayStatsView(payload.casual, "all", "all").mine.totals.holes, 18);
  assert.equal(selectPlayStatsView(payload.casual, "all", "stroke").mine.totals.aces, 1);
  assert.equal(selectPlayStatsView(payload.casual, "all", "matchplay").mine.totals.holes, 0);
});

test("casualReplaySnapshot groups doubles pairs and gates thru on place + positive total", () => {
  const snap = casualReplaySnapshot({
    round: { round_code: "PAIR9", holes: JSON.stringify([{ hole: 1, par: 3 }, { hole: 2, par: 3 }]) },
    results: [
      {
        name: "Ann", total: 5, to_par: -1, place: 1, live_player_index: 0,
        scoring_group: JSON.stringify({ targetId: "pair:a", targetType: "pair", label: "Team A", members: ["Ann", "Bo"] }),
      },
      {
        name: "Bo", total: 5, to_par: -1, place: 1, live_player_index: 1,
        scoring_group: JSON.stringify({ targetId: "pair:a", targetType: "pair", label: "Team A", members: ["Ann", "Bo"] }),
      },
      { name: "DNF", total: 0, to_par: 0, place: null, live_player_index: 2 },
    ],
  });
  assert.equal(snap.standings.length, 2);
  assert.deepEqual(snap.standings[0].playerIndexes, [0, 1]);
  assert.equal(snap.standings[0].thru, 2);
  assert.equal(snap.standings[1].thru, 0);
  assert.equal(snap.scoreTargets[0].id, "pair:a");
});

test("score-view-model ignores errored recovery items, follows shotgun play order, and scopes dormie to the card", () => {
  const items = [
    { kind: "score", state: "error", body: { scorerIndex: 0, index: 0, hole: 1, strokes: 5 } },
    { kind: "throws", state: "error", body: { scorerIndex: 0, hole: 1, throws: [{ lat: 1, lng: 1, n: 1 }] } },
    { kind: "score", state: "pending", body: { scorerIndex: 0, index: 1, hole: 1, strokes: 3 } },
  ];
  assert.equal(optimisticScores(items).size, 1);
  assert.deepEqual(throwsByScorer({ cardmates: [{ index: 0, throws: {} }], recoveryItems: items }, 0), {});

  const teeState = {
    holes: [{ hole: 1, par: 3 }, { hole: 2, par: 3 }, { hole: 3, par: 3 }],
    cardmates: [{ index: 0, name: "Ana", isMe: true, startingHole: 2, scores: {} }, { index: 1, name: "Bo", startingHole: 2, scores: {} }],
  };
  const rows = scoreRows(teeState);
  assert.equal(applyTeeOrder(teeState, rows, 1, 0).hint, "Tee order: Ana · then Bo");
  assert.equal(applyTeeOrder(teeState, rows, 2, 0).hint, "Tee order after hole 2 scores");

  const dormieState = {
    roundConfig: { scoringStyle: "matchplay", groupFormat: "singles" },
    cardmates: [{ index: 0, name: "Ana", isMe: true }, { index: 1, name: "Bo" }],
    snap: {
      standings: [
        { targetId: "player:0", match: { dormie: false } },
        { targetId: "player:1", match: { dormie: false } },
        { targetId: "player:9", match: { dormie: true } },
      ],
    },
  };
  assert.equal(isMatchDormie(dormieState), false);
});

test("drainRoundJournal blocks later pending writes on the same errored key without blocking other holes", async () => {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  const journal = createRoundJournal(storage, roundRecoveryScope({ roundCode: "ABCD", roundId: "g1", cardId: "c1", playerIndex: 0 }));
  journal.enqueue("score", { scorerIndex: 0, index: 0, hole: 1, strokes: 3 });
  journal.enqueue("score", { scorerIndex: 0, index: 0, hole: 1, strokes: 4 });
  const other = journal.enqueue("score", { scorerIndex: 0, index: 0, hole: 2, strokes: 2 });
  const sent = [];
  await drainRoundJournal(journal, async (item) => {
    sent.push(item.body.hole + ":" + item.body.strokes);
    if (item.body.hole === 1) return { ok: false, status: 409, data: { error: "card_locked" } };
    return { ok: true, status: 200, data: {} };
  });
  assert.deepEqual(sent, ["1:3", "2:2"]);
  assert.equal(journal.entries().length, 2);
  assert.equal(journal.entries().some((row) => row.id === other.id), false);
});

test("buildShareCard and drawShareCard handle putting rounds without stroke mix or par labels", () => {
  const model = buildShareCard({
    courseName: "Putting Green",
    holes: [{ hole: 1, par: 5, distance_ft: 25, points: 2 }, { hole: 2, par: 5, distance_ft: 33, points: 3 }],
    cardmates: [{ index: 0, name: "Ava", isMe: true, scores: { 1: 4, 2: 2 } }],
    myIndex: 0,
    roundConfig: { groupFormat: "singles", scoringStyle: "putting" },
    scoreTargets: [],
  }, { now: new Date("2026-09-18T16:00:00.000Z") });
  assert.equal(model.putting, true);
  assert.equal(model.players[0].makes, 6);
  assert.equal(model.players[0].total, 14);
  assert.equal(model.players[0].toPar, null);
  assert.deepEqual(model.players[0].mix, { aces: 0, eagles: 0, birdies: 0, pars: 0, bogeys: 0, doubles: 0 });
  const size = shareCardSize(model);
  const texts = [];
  const noop = () => {};
  const ctx = {
    fillStyle: "", strokeStyle: "", font: "", textAlign: "left", textBaseline: "alphabetic", lineWidth: 1,
    fillRect: noop, beginPath: noop, roundRect: noop, fill: noop, stroke: noop,
    measureText: (t) => ({ width: String(t).length * 10 }),
    fillText: (t) => texts.push(String(t)),
  };
  drawShareCard(ctx, model, size);
  assert.ok(texts.includes("MK"));
  assert.ok(texts.includes("PTS"));
  assert.ok(texts.includes("25 ft"));
  assert.equal(texts.some((t) => t.startsWith("par ")), false);
  assert.equal(texts.some((t) => t.includes("Ace ")), false);
});
