import assert from "node:assert/strict";
import test from "node:test";

import { addThrow } from "../src/shared/hole-map-model.js";
import { drainClipDrafts } from "../src/score-app/clip-recovery.js";
import {
  RECOVERY_SYNC_GRACE_MS,
  createRoundJournal,
  drainRoundJournal,
  recoveryBannerMode,
  resetJournalRetries,
  roundRecoveryScope,
} from "../src/score-app/round-recovery.js";
import { buildScorecardViewState, optimisticScores, strokesFor, throwsByScorer } from "../src/score-app/score-view-model.js";

function storageOnDevice() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const round = { roundCode: "1234", roundId: "generation-1", cardId: "c1", playerIndex: 4 };
const lay = (lat) => [{ lat, lng: 80, n: 1 }];
const accepted = { ok: true, status: 200, data: {} };
const journalFor = (storage, params = round) => createRoundJournal(storage, roundRecoveryScope(params));

test("restoring a journal isolates event, round generation, card and account", () => {
  const storage = storageOnDevice();
  const written = journalFor(storage);
  const first = written.enqueue("throws", { hole: 1, scorerIndex: 4, throws: lay(35) });
  const second = written.enqueue("throws", { hole: 1, scorerIndex: 8, throws: lay(36) });
  const restored = journalFor(storage);
  assert.deepEqual(restored.entries(), [first, second]);
  assert.deepEqual(journalFor(storage, { ...round, roundCode: "", eventId: "1234" }).entries(), []);
  assert.deepEqual(journalFor(storage, { ...round, roundId: "generation-2" }).entries(), []);
  assert.deepEqual(journalFor(storage, { ...round, cardId: "c2" }).entries(), []);
  assert.deepEqual(journalFor(storage, { ...round, playerIndex: 8 }).entries(), []);
  assert.equal(roundRecoveryScope({ ...round, playerIndex: null }), null);
});

test("scorer switching keeps holes, marks and optimistic vote withdrawals independent", () => {
  const state = {
    holes: [{ hole: 1, par: 3 }],
    holeIdx: 0,
    status: "live",
    scoreTargets: [{ id: "pair-x", playerIndexes: [4, 5] }],
    cardmates: [
      { index: 4, scores: { 1: 3 }, scorecards: { 1: { "player:4": 3, "player:8": 3 } }, throws: { 1: lay(34) }, isMe: true },
      { index: 8, scores: { 1: 4 }, throws: { 1: lay(35) } },
    ],
    recoveryItems: [
      { kind: "throws", body: { scorerIndex: 4, hole: 1, throws: lay(36) } },
      { kind: "throws", body: { scorerIndex: 8, hole: 1, throws: [] } },
      { kind: "score", body: { scorerIndex: 4, hole: 1, targetId: "pair-x", strokes: null } },
    ],
  };
  state.optimisticScores = optimisticScores(state.recoveryItems);
  assert.deepEqual(throwsByScorer(state, 4), { 1: lay(36) });
  assert.deepEqual(throwsByScorer(state, 8), { 1: [] });
  assert.equal(strokesFor(state, 4, 1, 4), null);
  assert.equal(strokesFor(state, 4, 1, 8), 3);
  const view = buildScorecardViewState({ state, mode: "round", scorerIndex: 8 });
  assert.equal(view.finish.canFinish, false, "other players' writes on this local card block finish");
  assert.equal(view.finish.pendingFinish, true, "completed card keeps Finish card slot reserved while syncing");
  const synced = buildScorecardViewState({ state: { ...state, recoveryItems: [] }, mode: "round", scorerIndex: 8 });
  assert.equal(synced.finish.canFinish, true);
  assert.equal(synced.finish.pendingFinish, false);
  const point = { lat: 35, lng: 80 };
  assert.equal(addThrow(addThrow([], point, 0), point, 0).length, 2, "short putts at the same fix are separate throws");
});

test("offline restart, 5xx, 429 and new writes during a drain preserve durable FIFO", async () => {
  const storage = storageOnDevice();
  let time = 1_000;
  const make = () => createRoundJournal(storage, roundRecoveryScope(round), { now: () => time });
  const first = make().enqueue("score", { scorerIndex: 4, hole: 1, index: 4, strokes: 3 });
  const second = make().enqueue("throws", { scorerIndex: 8, hole: 1, throws: lay(35) });
  const restarted = make();
  const attempts = [];
  const send = async (item) => {
    attempts.push(item.id);
    if (attempts.length === 1) return { ok: false, status: 503 };
    if (attempts.length === 2) return { ok: false, status: 429, retryAfter: "7" };
    if (attempts.length === 3) make().enqueue("score", { scorerIndex: 4, hole: 1, index: 4, strokes: 4 });
    return accepted;
  };
  const run = (online) => drainRoundJournal(restarted, send, { now: () => time, online: () => online });
  assert.equal(await run(false), null);
  assert.deepEqual(attempts, []);
  assert.equal(await run(true), 2_500);
  assert.deepEqual(attempts, [first.id]);
  time = 2_500;
  assert.equal(await run(true), 9_500);
  time = 9_499;
  assert.equal(await run(true), 9_500);
  time = 9_500;
  assert.equal(await run(true), null);
  assert.deepEqual(attempts.slice(0, 4), [first.id, first.id, first.id, second.id]);
  assert.equal(attempts.length, 5);
  assert.deepEqual(restarted.entries(), []);
});

test("authentication and permanent failures survive restart with exact values", async () => {
  const storage = storageOnDevice();
  const journal = journalFor(storage);
  const body = { scorerIndex: 8, hole: 2, index: 4, strokes: 5 };
  const item = journal.enqueue("score", body);
  await drainRoundJournal(journal, async () => ({ ok: false, status: 401 }));
  const restored = journalFor(storage);
  assert.equal(restored.entries()[0].state, "auth");
  assert.deepEqual(restored.entries()[0].body, body);
  await drainRoundJournal(restored, () => assert.fail("an auth failure needs a new session or a manual retry"));
  resetJournalRetries(restored);
  await drainRoundJournal(restored, async () => ({ ok: false, status: 409, data: { error: "card_locked" } }));
  assert.equal(restored.entries()[0].error, "card_locked");
  assert.equal(restored.entries()[0].id, item.id);
  resetJournalRetries(restored, { includeErrors: true });
  await drainRoundJournal(restored, async () => accepted);
  assert.deepEqual(restored.entries(), []);
});

test("clip retries keep bytes and client ID until a successful record is acknowledged", async () => {
  const record = { id: "clip-1", scopeKey: "card-1", createdAt: 0, nextAt: 0, state: "pending", attempt: 0, blob: new Blob(["clip bytes"]) };
  const records = new Map([[record.id, record], ["other-card", { ...record, id: "other-card", scopeKey: "card-2" }]]);
  const store = () => ({
    list: async (scope) => [...records.values()].filter((row) => row.scopeKey === scope),
    put: async (row) => records.set(row.id, row),
    remove: async (id) => records.delete(id),
  });
  assert.equal(await drainClipDrafts(store(), record.scopeKey, async () => ({ ok: false, status: 0 }), { now: () => 0 }), 1500);
  const failed = records.get(record.id);
  assert.equal(await failed.blob.text(), "clip bytes");
  assert.equal(failed.state, "pending");
  await drainClipDrafts(store(), record.scopeKey, async (retry) => {
    assert.equal(retry.id, record.id);
    return { ok: true, data: { id: 42 } };
  }, { now: () => 1500 });
  assert.equal(records.has(record.id), false);
  assert.equal(records.has("other-card"), true);
});

test("a failed durable write leaves no locally saved edit", () => {
  const storage = storageOnDevice();
  const originalSet = storage.setItem;
  storage.setItem = (key, value) => {
    if (!key.endsWith("-device")) throw new Error("quota");
    originalSet(key, value);
  };
  const journal = journalFor(storage);
  assert.throws(() => journal.enqueue("throws", { scorerIndex: 4, hole: 1, throws: lay(35) }), /quota/);
  assert.deepEqual(journal.entries(), []);
});

test("recovery banner waits through normal online saves and shows immediately on offline, retry, stall, or error", () => {
  const now = 10_000;
  const fresh = { id: "a", order: String(now - 50).padStart(16, "0") + ":a", state: "pending", attempt: 0 };
  const stalled = { id: "b", order: String(now - RECOVERY_SYNC_GRACE_MS).padStart(16, "0") + ":b", state: "pending", attempt: 0 };
  const retried = { ...fresh, attempt: 1 };
  const errored = { ...fresh, state: "error" };
  const auth = { ...fresh, state: "auth" };

  assert.equal(recoveryBannerMode({ items: [], online: true, now }), "none");
  assert.equal(recoveryBannerMode({ items: [fresh], online: true, now }), "delayed");
  assert.equal(recoveryBannerMode({ items: [fresh], online: false, now }), "immediate");
  assert.equal(recoveryBannerMode({ items: [stalled], online: true, now }), "immediate");
  assert.equal(recoveryBannerMode({ items: [retried], online: true, now }), "immediate");
  assert.equal(recoveryBannerMode({ items: [errored], online: true, now }), "immediate");
  assert.equal(recoveryBannerMode({ items: [auth], online: true, now }), "immediate");
  assert.equal(recoveryBannerMode({ items: [], storageError: true, online: true, now }), "immediate");
  assert.equal(recoveryBannerMode({ items: [], unavailable: true, online: true, now }), "immediate");
});
