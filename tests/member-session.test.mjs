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

function fakeToken(iat, ttlSec = 30 * 86400) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "m_1", iat, exp: iat + ttlSec })}.sig`;
}

test("a member session is renewed once it's a day old, from any app", async () => {
  const { RENEW_AFTER_SEC, memberTokenIssuedAt, renewMemberSession } = await import("../src/shared/member-session.js");
  const now = Date.UTC(2026, 10, 19, 12);
  const fresh = fakeToken(now / 1000 - 3600);
  const old = fakeToken(now / 1000 - RENEW_AFTER_SEC - 60);
  assert.equal(memberTokenIssuedAt(fresh), now / 1000 - 3600);
  assert.equal(memberTokenIssuedAt("garbage"), 0);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.Authorization]);
    return { status: 200, json: async () => ({ name: "Ava", token: "tok-new" }) };
  };
  // No session: nothing to do.
  assert.equal(await renewMemberSession({ apiBase: "https://auth.example", fetchImpl, nowMs: now, stores: { persistent: memoryStorage(), session: memoryStorage() } }), "none");
  // Less than a day old: no request.
  const a = { persistent: memoryStorage({ [TOKEN_KEY]: fresh }), session: memoryStorage() };
  assert.equal(await renewMemberSession({ apiBase: "https://auth.example", fetchImpl, nowMs: now, stores: a }), "fresh");
  assert.equal(calls.length, 0);
  // A day old: /me with the current token, and the fresh one is stored in both places.
  const b = { persistent: memoryStorage({ [TOKEN_KEY]: old }), session: memoryStorage() };
  assert.equal(await renewMemberSession({ apiBase: "https://auth.example/", fetchImpl, nowMs: now, stores: b }), "renewed");
  assert.deepEqual(calls[0], ["https://auth.example/me", "Bearer " + old]);
  assert.equal(b.persistent.getItem(TOKEN_KEY), "tok-new");
  assert.equal(b.session.getItem(TOKEN_KEY), "tok-new");
  // A 12-hour session from before the 30-day change is upgraded the first time an app opens.
  const legacy = fakeToken(now / 1000 - 3600, 12 * 3600);
  const d = { persistent: memoryStorage({ [TOKEN_KEY]: legacy }), session: memoryStorage() };
  assert.equal(await renewMemberSession({ apiBase: "https://auth.example", fetchImpl, nowMs: now, stores: d }), "renewed");
  // Signed out or offline: the stored session is left alone (each app handles a 401 its own way).
  for (const failing of [async () => ({ status: 401, json: async () => ({}) }), async () => { throw new Error("offline"); }]) {
    const c = { persistent: memoryStorage({ [TOKEN_KEY]: old }), session: memoryStorage() };
    assert.equal(await renewMemberSession({ apiBase: "https://auth.example", fetchImpl: failing, nowMs: now, stores: c }), "kept");
    assert.equal(c.persistent.getItem(TOKEN_KEY), old);
  }
});
