import assert from "node:assert/strict";
import test from "node:test";
import { createRoundJournal, roundRecoveryScope } from "../src/score-app/round-recovery.js";
import { shotLedgerState, statsFromShotLedgers } from "../src/score-app/shot-ledger-model.js";
import { parseShotRows, shotLedgerQuality } from "../src/shared/shot-ledger.js";
import { holePlayStats } from "../src/shared/shot-stats-model.js";

const uuid = (n) => `11111111-1111-4111-a111-00000000000${n}`;
const hole = { hole: 1, par: 3, target: { lat: 0, lng: 0.002 } };
const oldGeometry = { tee: null, target: { lat: 0, lng: 0 } };

function stroke(n, fields) {
  return { id: uuid(n), kind: "throw", attempt: "throw", outcome: "missed", ...fields };
}

test("records both same-place putts, actual measurement and unknown outcome without legacy inference", () => {
  const origin = { lat: 0, lng: -0.000005, accuracyM: 2.1, observedAt: 1_786_000_100_000 };
  const shots = parseShotRows([
    stroke(1, { originLie: "tee", landingLie: "rough", distanceFt: 189, distanceSource: "manual" }),
    stroke(2, { attempt: "putt", origin, puttDistanceFt: 2 }),
    stroke(3, { attempt: "putt", origin, puttDistanceFt: 2, outcome: "made" }),
  ]);
  assert.equal(shots.length, 3);
  assert.deepEqual(shots[1].origin, shots[2].origin);
  assert.equal(shots[0].fairway, false);
  assert.equal(shots[0].distanceFt, 189);
  assert.equal(parseShotRows([shots[0], shots[0]]), null);
  assert.equal(shotLedgerQuality(shots, 4), "different-count");
  assert.deepEqual(holePlayStats(hole, shots, 3).c1Putt, { att: 2, hit: 1 });
  assert.equal(holePlayStats(hole, shots, 3).c1xPutt, null);
  const incomplete = [{ ...shots[0], outcome: "unknown" }, ...shots.slice(1)];
  assert.equal(shotLedgerQuality(incomplete, 3), "unknown-outcome");
  assert.equal(holePlayStats(hole, incomplete, 3).shotQuality, "incomplete");
  assert.equal(holePlayStats(hole, incomplete, 3).c1Putt, null);
  const legacy = [{ lat: 0, lng: -0.000055, n: 1 }];
  assert.equal(parseShotRows(legacy), null);
  assert.equal(holePlayStats({ ...hole, target: oldGeometry.target }, legacy, 2).shotQuality, "estimated");
});

test("uses explicit ace, throw-in and penalty semantics while omitting uncertain GPS buckets", () => {
  const target = oldGeometry.target;
  const fixture = { ...hole, target };
  const ace = parseShotRows([stroke(1, { outcome: "made", originLie: "tee" })]);
  assert.equal(shotLedgerQuality(ace, 1), "complete");
  assert.equal(holePlayStats(fixture, ace, 1).c1Putt, null);
  const drop = { lat: 0, lng: -0.000085, accuracyM: 3 };
  const shots = parseShotRows([
    stroke(1, { originLie: "tee", landingLie: "ob", landing: drop }),
    { id: uuid(2), kind: "penalty", landingLie: "drop-zone", landing: drop },
    stroke(3, { attempt: "putt", outcome: "made", originLie: "drop-zone", origin: drop }),
  ]);
  const ob = holePlayStats(fixture, shots, 3);
  assert.deepEqual(ob.fir, { att: 1, hit: 0 });
  assert.equal(ob.c1r, null);
  assert.equal(ob.c1Putt, null);
  assert.equal(ob.c2Putt, null);
  const throwIn = [{ ...shots[0], outOfBounds: false }, stroke(2, { outcome: "made", origin: drop })];
  assert.equal(holePlayStats(fixture, throwIn, 2).c1Putt, null);
});

function testStorage() {
  const saved = new Map();
  return {
    get length() { return saved.size; }, key: (i) => [...saved.keys()][i], getItem: (key) => saved.get(key) || null,
    setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key),
  };
}

test("restores sequenced optimistic edits offline and exposes conflicting local rows for review", () => {
  const storage = testStorage();
  const scope = { roundCode: "ABCD", roundId: "generation", cardId: "card", playerIndex: 1 };
  const create = (input = scope) => createRoundJournal(storage, roundRecoveryScope(input));
  const journal = create();
  const body = (rows) => ({ hole: 1, scorerIndex: 1, ledger: { targetId: "player:1", binding: "1", geometry: oldGeometry, rows } });
  const first = journal.enqueue("shots", body([stroke(1, {})]), null);
  const latest = journal.enqueue("shots", body([stroke(1, {}), stroke(2, { outcome: "made" })]), first.order);
  const state = { holes: [hole], scoreTargets: [{ id: "player:1", type: "player", playerIndexes: [1] }], recoveryItems: create().entries() };
  assert.deepEqual(create({ ...scope, playerIndex: 2 }).entries(), []);
  assert.deepEqual(create({ ...scope, roundId: "different" }).entries(), []);
  const staged = shotLedgerState(state, 1, hole);
  assert.equal(staged.revision, latest.order);
  assert.deepEqual(staged.rows, latest.body.ledger.rows);
  assert.deepEqual(statsFromShotLedgers(state, 1).holes[0].target, oldGeometry.target);
  journal.update(first, { state: "error" });
  state.recoveryItems = create().entries();
  const problem = shotLedgerState(state, 1, hole);
  assert.equal(problem.revision, null);
  assert.deepEqual(problem.rows, []);
  assert.deepEqual(problem.review.body.ledger.rows, latest.body.ledger.rows);
});
