import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index.js";
import { putMember } from "../src/roster.js";
import { hashPin } from "../src/crypto.js";
import type { Env } from "../src/index.js";

const ORIGIN = "https://www.greenvillediscgolf.com";

function makeKV() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async ({ prefix = "" }: { prefix?: string; cursor?: string } = {}) => ({
      keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}
function makeDB() {
  const stmt = { bind: () => stmt, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => ({ results: [], success: true }) };
  return { prepare: () => stmt };
}

let env: Env;
let roster: ReturnType<typeof makeKV>;

beforeEach(async () => {
  roster = makeKV();
  env = {
    ROSTER: roster,
    RATELIMIT: makeKV(),
    DB: makeDB(),
    JWT_SECRET: "unit-test-secret-at-least-32-bytes-long!!",
    ALLOWED_ORIGINS: ORIGIN,
    SESSION_TTL_SEC: "900",
    LIVE: undefined,
    PHOTOS: undefined,
  } as unknown as Env;
  await putMember(roster as never, { memberId: "m_1", name: "Admin Person", pdgaNo: "1", pinHash: await hashPin("4821"), mustChangePin: false, isAdmin: true });
  await putMember(roster as never, { memberId: "m_999", name: "Normal Member", pdgaNo: "999", pinHash: await hashPin("4821"), mustChangePin: false });
});

function req(path: string, method = "GET", token?: string, body?: unknown): Request {
  const h: Record<string, string> = { Origin: ORIGIN };
  if (token) h.authorization = "Bearer " + token;
  if (body) h["content-type"] = "application/json";
  return new Request("https://w" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}
async function login(identifier: string, pin: string): Promise<string> {
  const r = await worker.fetch(req("/login", "POST", undefined, { identifier, pin }), env);
  return ((await r.json()) as { token: string }).token;
}
const json = async (r: Response) => (await r.json()) as Record<string, any>;

describe("admin members onboarding", () => {
  it("401 without a token, 403 for a non-admin", async () => {
    expect((await worker.fetch(req("/admin/members", "GET"), env)).status).toBe(401);
    const t = await login("999", "4821");
    expect((await worker.fetch(req("/admin/members", "GET", t), env)).status).toBe(403);
  });

  it("creates a member + issues a temp PIN that logs in with forced change", async () => {
    const t = await login("1", "4821");
    const res = await worker.fetch(req("/admin/members", "POST", t, { name: "New Player", pdgaNo: "273070" }), env);
    expect(res.status).toBe(201);
    const j = await json(res);
    expect(/^\d{4}$/.test(j.tempPin)).toBe(true);
    expect(j.member).toMatchObject({ memberId: "m_273070", name: "New Player", pdgaNo: "273070", isAdmin: false, mustChangePin: true });
    // the issued temp PIN works at /login and is flagged for forced change
    const l = await worker.fetch(req("/login", "POST", undefined, { identifier: "273070", pin: j.tempPin }), env);
    expect(l.status).toBe(200);
    expect((await json(l)).mustChangePin).toBe(true);
  });

  it("requires explicit confirmation before creating another admin", async () => {
    const t = await login("1", "4821");

    const blocked = await worker.fetch(req("/admin/members", "POST", t, { name: "New Admin", pdgaNo: "273071", isAdmin: true }), env);
    expect(blocked.status).toBe(409);
    expect(await json(blocked)).toMatchObject({ error: "admin_grant_confirmation_required" });
    expect(await roster.get("member:m_273071")).toBeNull();

    const confirmed = await worker.fetch(
      req("/admin/members", "POST", t, { name: "New Admin", pdgaNo: "273071", isAdmin: true, confirm_admin_grant: true }),
      env,
    );
    expect(confirmed.status).toBe(201);
    const j = await json(confirmed);
    expect(j.member).toMatchObject({ memberId: "m_273071", name: "New Admin", pdgaNo: "273071", isAdmin: true, mustChangePin: true });
  });

  it("409 when the member already exists; validates input", async () => {
    const t = await login("1", "4821");
    await worker.fetch(req("/admin/members", "POST", t, { name: "A", pdgaNo: "273070" }), env);
    expect((await worker.fetch(req("/admin/members", "POST", t, { name: "B", pdgaNo: "273070" }), env)).status).toBe(409);
    expect((await worker.fetch(req("/admin/members", "POST", t, { pdgaNo: "5" }), env)).status).toBe(400); // no name
    expect((await worker.fetch(req("/admin/members", "POST", t, { name: "X" }), env)).status).toBe(400); // no pdga/udisc
    expect((await worker.fetch(req("/admin/members", "POST", t, { name: "X", pdgaNo: "abc" }), env)).status).toBe(400); // bad pdga
  });

  it("reissues a temp PIN for an existing member (forced change), 404 unknown", async () => {
    const t = await login("1", "4821");
    const res = await worker.fetch(req("/admin/members/reset-pin", "POST", t, { identifier: "999" }), env);
    expect(res.status).toBe(200);
    const j = await json(res);
    expect(/^\d{4}$/.test(j.tempPin)).toBe(true);
    const l = await worker.fetch(req("/login", "POST", undefined, { identifier: "999", pin: j.tempPin }), env);
    expect((await json(l)).mustChangePin).toBe(true); // old PIN replaced, forced change
    expect((await worker.fetch(req("/admin/members/reset-pin", "POST", t, { identifier: "55555" }), env)).status).toBe(404);
  });

  it("lists members without leaking the PIN hash", async () => {
    const t = await login("1", "4821");
    const j = await json(await worker.fetch(req("/admin/members", "GET", t), env));
    expect(Array.isArray(j.members)).toBe(true);
    expect(j.members.find((m: any) => m.memberId === "m_1").isAdmin).toBe(true);
    expect(j.members.every((m: any) => !("pinHash" in m))).toBe(true);
  });
});
