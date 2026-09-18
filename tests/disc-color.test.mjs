import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  DEFAULT_DISC_COLOR,
  DISC_COLORS,
  applyDiscColor,
  discColorStorageKey,
  discColorToken,
  fetchRemoteDiscColor,
  loadLocalDiscColor,
  readStoredDiscColor,
  sanitizeDiscColor,
  writeStoredDiscColor,
} from "../src/shared/disc-color.js";

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

test("sanitizeDiscColor only accepts named plastics", () => {
  assert.equal(sanitizeDiscColor("teal"), "teal");
  assert.equal(sanitizeDiscColor("ORANGE"), "orange");
  assert.equal(sanitizeDiscColor("javascript:alert(1)"), DEFAULT_DISC_COLOR);
  assert.equal(sanitizeDiscColor(""), DEFAULT_DISC_COLOR);
  assert.equal(DISC_COLORS.length, 10);
  assert.equal(discColorToken("pink"), "var(--disc-pink)");
});

test("disc color storage is keyed per member", () => {
  const storage = memoryStorage();
  assert.equal(discColorStorageKey("abc"), "gvdg-disc-color:abc");
  writeStoredDiscColor(storage, "abc", "purple");
  assert.equal(readStoredDiscColor(storage, "abc"), "purple");
  writeStoredDiscColor(storage, "abc", null);
  assert.equal(readStoredDiscColor(storage, "abc"), null);
});

test("loadLocalDiscColor reads the member-keyed plastic", () => {
  const storage = memoryStorage();
  writeStoredDiscColor(storage, "12345", "pink");
  const loaded = loadLocalDiscColor({ token: "", pdgaNo: "12345", storage, sessionStorage: storage });
  assert.equal(loaded.discColor, "pink");
  assert.equal(loaded.memberId, "12345");
});

test("fetchRemoteDiscColor ignores an unset remote preference", async () => {
  const unset = await fetchRemoteDiscColor({
    token: "t",
    requestImpl: async () => ({ ok: true, json: async () => ({ discColor: null }) }),
  });
  assert.equal(unset, undefined);
  const teal = await fetchRemoteDiscColor({
    token: "t",
    requestImpl: async () => ({ ok: true, json: async () => ({ discColor: "teal" }) }),
  });
  assert.equal(teal, "teal");
});

test("applyDiscColor paints --disc-plate on the root", () => {
  const style = new Map();
  const attrs = new Map();
  const root = {
    style: {
      setProperty: (name, value) => style.set(name, value),
    },
    setAttribute: (name, value) => attrs.set(name, value),
  };
  assert.equal(applyDiscColor("gold", root), "gold");
  assert.equal(style.get("--disc-plate"), "var(--disc-gold)");
  assert.equal(attrs.get("data-disc-color"), "gold");
});

test("worker, tokens, and client share the same disc color ids", () => {
  const worker = readFileSync("auth-worker/src/disc-color-routes.ts", "utf8");
  const tokens = readFileSync("tokens.css", "utf8");
  for (const row of DISC_COLORS) {
    assert.match(worker, new RegExp(`"${row.id}"`));
    assert.match(tokens, new RegExp(row.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":"));
  }
});
