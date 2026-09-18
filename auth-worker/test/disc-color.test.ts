import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index.js";
import { putMember } from "../src/roster.js";
import { hashPin } from "../src/crypto.js";
import type { KVLike } from "../src/ratelimit.js";
import type { Env } from "../src/index.js";

const ORIGIN = "https://www.greenvillediscgolf.com";
const PIN = "4821";

function makeKV(): KVLike {
  const store = new Map<string, string>();
  return {
    get: async (key) => (store.has(key) ? store.get(key)! : null),
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
}

function makeDB() {
  const stmt = { bind: () => stmt, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => ({ results: [], success: true }) };
  return { prepare: () => stmt };
}

let env: Env;

beforeEach(async () => {
  env = {
    ROSTER: makeKV() as unknown as Env["ROSTER"],
    RATELIMIT: makeKV() as unknown as Env["RATELIMIT"],
    DB: makeDB() as unknown as Env["DB"],
    JWT_SECRET: "unit-test-secret-at-least-32-bytes-long!!",
    ALLOWED_ORIGINS: `${ORIGIN},https://greenvillediscgolf.com`,
    SESSION_TTL_SEC: "900",
    LIVE: undefined as unknown as Env["LIVE"],
    PHOTOS: undefined as unknown as Env["PHOTOS"],
  } as unknown as Env;
  await putMember(env.ROSTER as KVLike, {
    memberId: "m_jane",
    name: "Jane Doe",
    pdgaNo: "12345",
    udisc: "JaneD",
    pinHash: await hashPin(PIN),
    mustChangePin: true,
  });
});

function jsonRequest(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://auth.example${path}`, {
    method,
    headers: { Origin: ORIGIN, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function authedToken(): Promise<string> {
  const login = await worker.fetch(jsonRequest("/login", "POST", { identifier: "12345", pin: PIN }), env);
  const loginToken = ((await login.json()) as { token: string }).token;
  const setPin = await worker.fetch(jsonRequest("/set-pin", "POST", { newPin: "9999" }, { Authorization: `Bearer ${loginToken}` }), env);
  return ((await setPin.json()) as { token: string }).token;
}

describe("GET/PUT/DELETE /me/disc-color", () => {
  it("401s without a usable token", async () => {
    expect((await worker.fetch(jsonRequest("/me/disc-color", "GET"), env)).status).toBe(401);
  });

  it("rejects unknown plastics", async () => {
    const token = await authedToken();
    const auth = { Authorization: `Bearer ${token}` };
    expect((await worker.fetch(jsonRequest("/me/disc-color", "PUT", { discColor: "chartreuse" }, auth), env)).status).toBe(400);
  });

  it("saves, returns, and clears a disc color", async () => {
    const token = await authedToken();
    const auth = { Authorization: `Bearer ${token}` };
    const put = await worker.fetch(jsonRequest("/me/disc-color", "PUT", { discColor: "teal" }, auth), env);
    expect(put.status).toBe(200);
    expect(((await put.json()) as { discColor: string }).discColor).toBe("teal");

    const get = await worker.fetch(jsonRequest("/me/disc-color", "GET", undefined, auth), env);
    expect(((await get.json()) as { discColor: string }).discColor).toBe("teal");

    const del = await worker.fetch(jsonRequest("/me/disc-color", "DELETE", undefined, auth), env);
    expect(del.status).toBe(200);
    expect(((await (await worker.fetch(jsonRequest("/me/disc-color", "GET", undefined, auth), env)).json()) as { discColor: null }).discColor).toBeNull();
  });
});
