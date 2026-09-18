import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientMineFailure,
  mineCacheKey,
  readMineCache,
  writeMineCache,
} from "../src/score-app/score-session-cache.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

const card = {
  cardId: "c0",
  holes: [{ hole: 1, par: 3 }],
  cardmates: [{ index: 0, name: "Ava", isMe: true }],
};

test("mine cache stores a live card and restores it", () => {
  const storage = memoryStorage();
  const key = mineCacheKey("ABCD", "");
  assert.equal(key, "gvdg_score_mine:ABCD");
  assert.equal(writeMineCache(key, card, storage), true);
  assert.deepEqual(readMineCache(key, storage).cardId, "c0");
});

test("mine cache ignores empty or incomplete payloads", () => {
  const storage = memoryStorage();
  const key = mineCacheKey("", "12");
  assert.equal(writeMineCache(key, { cardId: null, holes: [], cardmates: [] }, storage), false);
  assert.equal(writeMineCache(key, { cardId: "c0", holes: [], cardmates: [{ index: 0 }] }, storage), false);
  assert.equal(readMineCache(key, storage), null);
});

test("transient mine failures include network and 5xx", () => {
  assert.equal(isTransientMineFailure({ neterr: true, status: 0 }), true);
  assert.equal(isTransientMineFailure({ status: 503 }), true);
  assert.equal(isTransientMineFailure({ status: 401 }), false);
  assert.equal(isTransientMineFailure({ status: 200, data: {} }), false);
});
