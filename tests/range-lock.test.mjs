import assert from "node:assert/strict";
import test from "node:test";
import { rangeLockChanged, rangeLockNote, readRangeLockEnabled, writeRangeLockEnabled } from "../src/shared/range-lock.js";

test("lock-screen rangefinder uses live remaining distance only", () => {
  assert.equal(rangeLockNote({ hud: { mode: "hole", ft: 320 } }), null);
  assert.equal(rangeLockNote({ hud: { mode: "throw", ft: 180 } }), null);
  const note = rangeLockNote({
    hud: { mode: "remaining", ft: 214, circle: null },
    hole: 7,
    par: 3,
    courseName: "Farmville DGC",
  });
  assert.equal(note.title, "214 ft");
  assert.equal(note.body, "to basket · Hole 7 · par 3 · Farmville DGC");
  assert.equal(note.tag, "gvdg-range");
  const inside = rangeLockNote({ hud: { mode: "remaining", ft: 28, circle: "C1" }, hole: 7, par: 3 });
  assert.match(inside.body, /^C1 · Hole 7/);
  assert.equal(rangeLockChanged(null, note), true);
  assert.equal(rangeLockChanged(note, { ...note, ft: 218 }), false);
  assert.equal(rangeLockChanged(note, { ...note, ft: 230 }), true);
  assert.equal(rangeLockChanged(note, { ...note, hole: 8 }), true);
  assert.equal(rangeLockChanged(note, null), true);
});

test("lock-screen preference is a local flag", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(readRangeLockEnabled(storage), false);
  writeRangeLockEnabled(storage, true);
  assert.equal(readRangeLockEnabled(storage), true);
  writeRangeLockEnabled(storage, false);
  assert.equal(readRangeLockEnabled(storage), false);
  assert.equal(readRangeLockEnabled(null), false);
});
