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

beforeEach(async () => {
  env = {
    ROSTER: makeKV(),
    RATELIMIT: makeKV(),
    DB: makeDB(),
    JWT_SECRET: "unit-test-secret-at-least-32-bytes-long!!",
    ALLOWED_ORIGINS: ORIGIN,
    SESSION_TTL_SEC: "900",
    LIVE: undefined,
    PHOTOS: undefined,
  } as unknown as Env;
  await putMember(env.ROSTER as never, { memberId: "m_1", name: "Admin Person", pdgaNo: "1", pinHash: await hashPin("4821"), mustChangePin: false, isAdmin: true });
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

describe("self-serve membership applications", () => {
  it("accepts a public apply and does not create a login until an admin approves", async () => {
    const apply = await worker.fetch(req("/membership/apply", "POST", undefined, {
      name: "New Player",
      pdgaNo: "273070",
      pin: "2468",
    }), env);
    expect(apply.status).toBe(201);
    const created = await json(apply);
    expect(created.application).toMatchObject({ name: "New Player", pdgaNo: "273070" });
    expect(created.application.pinHash).toBeUndefined();

    const loginBefore = await worker.fetch(req("/login", "POST", undefined, { identifier: "273070", pin: "2468" }), env);
    expect(loginBefore.status).toBe(401);

    const admin = await login("1", "4821");
    const listed = await worker.fetch(req("/admin/members/applications", "GET", admin), env);
    expect(listed.status).toBe(200);
    const apps = (await json(listed)).applications as { id: string; name: string }[];
    expect(apps).toHaveLength(1);
    expect(apps[0]!.name).toBe("New Player");

    const approved = await worker.fetch(req(`/admin/members/applications/${apps[0]!.id}/approve`, "POST", admin), env);
    expect(approved.status).toBe(200);
    expect((await json(approved)).member).toMatchObject({
      memberId: "m_273070",
      name: "New Player",
      isAdmin: false,
      mustChangePin: true,
    });

    const loginAfter = await worker.fetch(req("/login", "POST", undefined, { identifier: "273070", pin: "2468" }), env);
    expect(loginAfter.status).toBe(200);
    expect((await json(loginAfter)).mustChangePin).toBe(true);
  });

  it("rejects a pending application without creating a member", async () => {
    await worker.fetch(req("/membership/apply", "POST", undefined, { name: "Waiter", udisc: "waiter.u", pin: "1357" }), env);
    const admin = await login("1", "4821");
    const listed = await json(await worker.fetch(req("/admin/members/applications", "GET", admin), env));
    const id = listed.applications[0].id as string;
    expect((await worker.fetch(req(`/admin/members/applications/${id}/reject`, "POST", admin), env)).status).toBe(200);
    expect((await json(await worker.fetch(req("/admin/members/applications", "GET", admin), env))).applications).toEqual([]);
    expect((await worker.fetch(req("/login", "POST", undefined, { identifier: "waiter.u", pin: "1357" }), env)).status).toBe(401);
  });

  it("does not let a non-admin approve, and blocks duplicate applies", async () => {
    await putMember(env.ROSTER as never, { memberId: "m_999", name: "Normal Member", pdgaNo: "999", pinHash: await hashPin("4821"), mustChangePin: false });
    const first = await worker.fetch(req("/membership/apply", "POST", undefined, { name: "Dup", pdgaNo: "555", pin: "1111" }), env);
    expect(first.status).toBe(201);
    expect((await worker.fetch(req("/membership/apply", "POST", undefined, { name: "Dup2", pdgaNo: "555", pin: "2222" }), env)).status).toBe(409);
    expect((await worker.fetch(req("/membership/apply", "POST", undefined, { name: "Admin Person", pdgaNo: "1", pin: "3333" }), env)).status).toBe(409);

    const memberToken = await login("999", "4821");
    expect((await worker.fetch(req("/admin/members/applications", "GET", memberToken), env)).status).toBe(403);

    expect((await worker.fetch(req("/membership/apply", "POST", undefined, { name: "NoId", pin: "4444" }), env)).status).toBe(400);
    expect((await worker.fetch(req("/membership/apply", "POST", undefined, { name: "BadPin", pdgaNo: "888", pin: "12" }), env)).status).toBe(400);
  });
});
