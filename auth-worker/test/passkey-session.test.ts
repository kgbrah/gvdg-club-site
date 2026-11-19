// Passkey sign-in sessions (owner report: a member who signs in with a passkey couldn't list in the marketplace or
// turn on notifications). The passkey session carried no PIN version, so requireAuth read it as revoked (pinVer 0 vs
// the member's >= 1 after their first PIN change) while /me still showed them signed in.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  // The authenticator's signature is checked by the library (and its own tests); here it says yes.
  return { ...actual, verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 7 } }) };
});

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { putMember } from "../src/roster.js";
import { addCredential } from "../src/webauthn.js";

const SECRET = "x".repeat(40);
const ORIGIN = "https://gvdgclub.com";

function memoryKv() {
  const rows = new Map<string, string>();
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({ keys: [...rows.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async all() { return { results: db.prepare(sql).all(...(bound as never[])), success: true }; },
        async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
        async run() { const info = db.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
      };
      return stmt;
    },
  };
}

const b64url = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function setup() {
  const roster = memoryKv();
  const env = {
    ROSTER: roster, RATELIMIT: memoryKv(), DB: await sqliteDb(), JWT_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN, SESSION_TTL_SEC: "900",
    RP_ID: "gvdgclub.com", EXPECTED_ORIGIN: ORIGIN,
  } as unknown as Env;
  // A former guest who signs in by email: she changed her PIN once (pinVer 1) and added a passkey.
  await putMember(roster as never, { memberId: "m_e_drew", name: "Drew Visitor", email: "drew@example.com", pinHash: "h", mustChangePin: false, pinVer: 1 });
  await addCredential(roster as never, "m_e_drew", { id: "cred-drew", publicKey: b64url("public-key"), counter: 0 });
  return env;
}

async function call(env: Env, path: string, { method = "GET", token, body }: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.5" };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await worker.fetch(new Request("https://w" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const raw = await response.text();
  return { status: response.status, data: raw ? JSON.parse(raw) : null };
}

async function passkeySignIn(env: Env) {
  const options = await call(env, "/webauthn/auth/options", { method: "POST", body: {} });
  expect(options.status).toBe(200);
  const verified = await call(env, "/webauthn/auth/verify", {
    method: "POST",
    body: { flowId: options.data.flowId, response: { id: "cred-drew", rawId: "cred-drew", type: "public-key", response: { userHandle: b64url("m_e_drew"), clientDataJSON: "", authenticatorData: "", signature: "" }, clientExtensionResults: {} } },
  });
  expect(verified.status, JSON.stringify(verified.data)).toBe(200);
  return verified.data.token as string;
}

describe("passkey sign-in sessions", () => {
  it("work everywhere a PIN sign-in does: marketplace listing, notifications, member routes", async () => {
    const env = await setup();
    const token = await passkeySignIn(env);
    expect((await call(env, "/me", { token })).status).toBe(200);
    // The marketplace sees a signed-in member who may list (not "Only club members can list").
    expect((await call(env, "/market/config", { token })).data.viewer).toMatchObject({ kind: "member", canList: true });
    expect((await call(env, "/market/listings", { method: "POST", token, body: { title: "x" } })).data.error).not.toMatch(/unauthorized|members_only|guests_cannot_list/);
    // Notifications: the push subscription route answers for her.
    expect((await call(env, "/me/push-subscription", { token })).status).not.toBe(401);
    expect((await call(env, "/my-registrations", { token })).status).toBe(200);
  });

  it("a session from before a PIN change is signed out by /me too, not left half working", async () => {
    const env = await setup();
    const stale = await signSession({ sub: "m_e_drew", mustChangePin: false, pinVer: 0 }, SECRET, 900);
    expect((await call(env, "/me", { token: stale })).status).toBe(401);
    expect((await call(env, "/market/config", { token: stale })).data.viewer.kind).toBe("public");
    // A forced first-login change still reaches /me (its session is pinVer 0 and so is the record).
    const env2 = await setup();
    await putMember((env2 as unknown as { ROSTER: never }).ROSTER, { memberId: "m_new", name: "New", pdgaNo: "4242", pinHash: "h", mustChangePin: true });
    const forced = await signSession({ sub: "m_new", mustChangePin: true, pinVer: 0 }, SECRET, 900);
    expect((await call(env2, "/me", { token: forced })).data).toMatchObject({ mustChangePin: true });
  });
});
