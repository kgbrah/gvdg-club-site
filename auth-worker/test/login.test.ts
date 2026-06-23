import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index.js";
import { putMember } from "../src/roster.js";
import { hashPin } from "../src/crypto.js";
import type { KVLike } from "../src/ratelimit.js";
import type { Env } from "../src/index.js";

const ORIGIN = "https://www.greenvillediscgolf.com";
const PIN = "4821";

function makeKV(): KVLike {
  const m = new Map<string, string>();
  return {
    get: async (k) => (m.has(k) ? m.get(k)! : null),
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}

let env: Env;

beforeEach(async () => {
  env = {
    ROSTER: makeKV(),
    RATELIMIT: makeKV(),
    JWT_SECRET: "unit-test-secret-at-least-32-bytes-long!!",
    ALLOWED_ORIGINS: `${ORIGIN},https://greenvillediscgolf.com`,
    SESSION_TTL_SEC: "900",
  };
  await putMember(env.ROSTER as KVLike, {
    memberId: "m_jane",
    name: "Jane Doe",
    pdgaNo: "12345",
    udisc: "JaneD",
    pinHash: await hashPin(PIN),
    mustChangePin: true,
  });
});

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://auth.example${path}`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /login", () => {
  it("returns a token + mustChangePin for correct PIN (by PDGA#)", async () => {
    const res = await worker.fetch(post("/login", { identifier: "12345", pin: PIN }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(typeof json.token).toBe("string");
    expect(json.mustChangePin).toBe(true);
    expect(json.name).toBe("Jane Doe");
    expect(json.pdgaNo).toBe("12345");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("logs in by UDisc username too", async () => {
    const res = await worker.fetch(post("/login", { identifier: "janed", pin: PIN }), env);
    expect(res.status).toBe(200);
  });

  it("rejects a wrong PIN with a generic 401", async () => {
    const res = await worker.fetch(post("/login", { identifier: "12345", pin: "0000" }), env);
    expect(res.status).toBe(401);
  });

  it("does not reveal whether an identifier exists (unknown user → same 401)", async () => {
    const res = await worker.fetch(post("/login", { identifier: "99999", pin: "0000" }), env);
    expect(res.status).toBe(401);
  });

  it("locks the account (423) after too many failures, even with the correct PIN", async () => {
    for (let i = 0; i < 5; i++) {
      await worker.fetch(post("/login", { identifier: "12345", pin: "0000" }), env);
    }
    const res = await worker.fetch(post("/login", { identifier: "12345", pin: PIN }), env);
    expect(res.status).toBe(423);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("rejects a malformed body with 400", async () => {
    const req = new Request("https://auth.example/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect((await worker.fetch(req, env)).status).toBe(400);
  });
});

describe("GET /me", () => {
  it("returns claims for a valid bearer token", async () => {
    const login = await worker.fetch(post("/login", { identifier: "12345", pin: PIN }), env);
    const { token } = (await login.json()) as any;
    const res = await worker.fetch(
      new Request("https://auth.example/me", { headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` } }),
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.sub).toBe("m_jane");
    expect(json.mustChangePin).toBe(true);
    expect(json.pdgaNo).toBe("12345");
    expect(json.name).toBe("Jane Doe");
  });

  it("401s without a token", async () => {
    const res = await worker.fetch(new Request("https://auth.example/me", { headers: { Origin: ORIGIN } }), env);
    expect(res.status).toBe(401);
  });
});

describe("POST /set-pin", () => {
  async function loginToken(pin: string): Promise<string> {
    const res = await worker.fetch(post("/login", { identifier: "12345", pin }), env);
    return ((await res.json()) as any).token;
  }

  it("changes the PIN, clears mustChangePin, and the new PIN works while the old fails", async () => {
    const token = await loginToken(PIN);
    const res = await worker.fetch(post("/set-pin", { newPin: "7777" }, { Authorization: `Bearer ${token}` }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.mustChangePin).toBe(false);

    expect((await worker.fetch(post("/login", { identifier: "12345", pin: "7777" }), env)).status).toBe(200);
    expect((await worker.fetch(post("/login", { identifier: "12345", pin: PIN }), env)).status).toBe(401);
  });

  it("rejects an invalid PIN format with 400", async () => {
    const token = await loginToken(PIN);
    for (const bad of ["12", "abcd", "12345", ""]) {
      const res = await worker.fetch(post("/set-pin", { newPin: bad }, { Authorization: `Bearer ${token}` }), env);
      expect(res.status, `pin=${bad}`).toBe(400);
    }
  });

  it("401s without a token", async () => {
    expect((await worker.fetch(post("/set-pin", { newPin: "7777" }), env)).status).toBe(401);
  });
});

describe("misconfiguration (fail closed)", () => {
  it("returns 500 — not a weakly-signed token — when JWT_SECRET is missing/short", async () => {
    const badEnv = { ...env, JWT_SECRET: "" };
    const res = await worker.fetch(post("/login", { identifier: "12345", pin: PIN }), badEnv);
    expect(res.status).toBe(500);
  });
});

describe("CORS", () => {
  it("answers preflight from an allowed origin with the ACAO header", async () => {
    const res = await worker.fetch(
      new Request("https://auth.example/login", { method: "OPTIONS", headers: { Origin: ORIGIN } }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("does not send ACAO for a disallowed origin", async () => {
    const res = await worker.fetch(
      new Request("https://auth.example/login", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }),
      env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
