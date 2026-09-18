import assert from "node:assert/strict";
import test from "node:test";

import {
  NAME_KEY,
  PDGA_KEY,
  TOKEN_KEY,
  clearMemberSession,
  readMemberSessionValue,
  readMemberToken,
  writeMemberSession,
  writeMemberSessionValue,
} from "../src/shared/member-session.js";

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    data,
  };
}

test("member session prefers localStorage and dual-writes", () => {
  const persistent = memoryStorage();
  const session = memoryStorage();
  writeMemberSession({ token: "tok-1", name: "Ava", pdgaNo: "12345" }, { persistent, session });
  assert.equal(persistent.getItem(TOKEN_KEY), "tok-1");
  assert.equal(session.getItem(TOKEN_KEY), "tok-1");
  assert.equal(readMemberToken({ persistent, session }), "tok-1");
  assert.equal(readMemberSessionValue(NAME_KEY, { persistent, session }), "Ava");
  assert.equal(readMemberSessionValue(PDGA_KEY, { persistent, session }), "12345");
});

test("member session migrates a tab-only token into localStorage", () => {
  const persistent = memoryStorage();
  const session = memoryStorage({ [TOKEN_KEY]: "old-tab-token" });
  assert.equal(readMemberToken({ persistent, session }), "old-tab-token");
  assert.equal(persistent.getItem(TOKEN_KEY), "old-tab-token");
});

test("clearMemberSession wipes both stores", () => {
  const persistent = memoryStorage({ [TOKEN_KEY]: "tok", [NAME_KEY]: "Ava" });
  const session = memoryStorage({ [TOKEN_KEY]: "tok", [PDGA_KEY]: "9" });
  clearMemberSession({ persistent, session });
  assert.equal(persistent.getItem(TOKEN_KEY), null);
  assert.equal(session.getItem(TOKEN_KEY), null);
  assert.equal(persistent.getItem(NAME_KEY), null);
  assert.equal(session.getItem(PDGA_KEY), null);
});

test("empty writes remove the key", () => {
  const persistent = memoryStorage({ [PDGA_KEY]: "123" });
  const session = memoryStorage({ [PDGA_KEY]: "123" });
  writeMemberSessionValue(PDGA_KEY, "", { persistent, session });
  assert.equal(persistent.getItem(PDGA_KEY), null);
  assert.equal(session.getItem(PDGA_KEY), null);
});
