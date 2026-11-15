import assert from "node:assert/strict";
import test from "node:test";

import { destination, findTools } from "../src/shared/app-navigation.js";
import { drainRoundJournal, resetJournalRetries } from "../src/score-app/round-recovery.js";
import {
  createPracticeStorage, distanceBetween, distanceFromMeters, EMPTY_PRACTICE, localDate,
  metersFromDistance, practiceDraftView, practicePercent, puttingMakeTotals, stagePutting,
} from "../src/members-app/practice-model.js";

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

test("Play and tool search distinguish physical bag and practice from Disc style", () => {
  assert.equal(destination("member", "practice").group, "play");
  assert.equal(destination("member", "my-bag").group, "play");
  assert.ok(findTools("disc equipment").some((result) => result.key === "my-bag"));
  assert.ok(findTools("putting drill").some((result) => result.key === "practice"));
  assert.ok(findTools("disc color").some((result) => result.key === "appearance"));
});

test("putting conversion uses canonical meters and percentages weight actual attempts", () => {
  assert.equal(metersFromDistance(100, "ft"), 30.48);
  assert.equal(distanceFromMeters(30.48, "ft"), 100);
  assert.equal(metersFromDistance(10, "yd"), null);
  assert.equal(localDate(new Date(2026, 10, 14, 23, 55)), "2026-11-14");
  const form = {
    date: "2026-11-14",
    stations: [
      { distance: "10", unit: "ft", attempts: "20", makes: "18" },
      { distance: "15", unit: "ft", attempts: "1", makes: "0" },
    ],
  };
  const record = stagePutting(form);
  assert.equal(record.stations[0].distance, 10);
  assert.deepEqual(puttingMakeTotals(record.stations), { attempts: 21, makes: 18 });
  assert.equal(practicePercent(18, 21), 85.7);
  assert.equal(practicePercent(0, 1), 0);
  assert.equal(practicePercent(0, 0), null);
  assert.equal(practicePercent(2, 1), null);
  assert.equal(stagePutting({ ...form, stations: [...form.stations, { distance: 3.048, unit: "m", attempts: 5, makes: 2 }] }), null);
  assert.equal(stagePutting({ ...form, stations: [{ ...form.stations[0], makes: "" }] }), null);
  assert.ok(distanceBetween({ lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }) > 110);
});

test("practice and bag writes survive restart and never appear under another owner", async () => {
  const storage = memoryStorage();
  const owner = createPracticeStorage(storage, "owner-a");
  const addition = owner.append("disc", { id: "disc-1", action: "save", expectedRevision: 0, record: { brand: "Innova", model: "Teebird" } });
  const started = owner.append("throw", { id: "throw-1", action: "save", expectedRevision: 0, record: { discId: "disc-1", date: "2026-11-14" } });
  const restored = createPracticeStorage(storage, "owner-a");
  const different = createPracticeStorage(storage, "owner-b");
  assert.deepEqual(different.journal.entries(), []);
  assert.equal(practiceDraftView(null, restored.journal.entries()).discs[0].draftId, addition.id);
  assert.equal(practiceDraftView(null, restored.journal.entries()).throws.items[0].record.discId, "disc-1");
  const sends = [];
  const attempt = async (item) => {
    sends.push(item.id);
    return sends.length === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 };
  };
  await drainRoundJournal(restored.journal, attempt, { now: () => 1000 });
  resetJournalRetries(restored.journal);
  await drainRoundJournal(restored.journal, attempt, { now: () => 3000 });
  assert.deepEqual(sends, [addition.id, addition.id, started.id]);
  assert.deepEqual(restored.journal.entries(), []);
});

test("cache strips committed GPS and a failed local write creates no saved draft", () => {
  const storage = memoryStorage();
  const owner = createPracticeStorage(storage, "owner-a");
  const snapshot = {
    ...EMPTY_PRACTICE, owner: "owner-a",
    throws: { items: [{ id: "throw-1", record: { distance: 35, origin: { lat: 38, lng: -80 }, end: { lat: 39, lng: -80 } } }], next: null },
  };
  owner.save(snapshot);
  assert.deepEqual(owner.load().throws.items[0].record, { distance: 35 });
  assert.equal(createPracticeStorage(storage, "owner-b").load(), null);
  assert.throws(() => owner.save({ ...snapshot, owner: "owner-b" }), /practice_scope_changed/);

  const write = storage.setItem;
  storage.setItem = (key, value) => {
    if (key.endsWith("-device")) write(key, value);
    else throw new Error("storage quota");
  };
  assert.throws(() => owner.append("disc", { id: "draft", action: "save", expectedRevision: 0, record: {} }), /storage quota/);
  assert.equal(owner.journal.entries().length, 0);
});
