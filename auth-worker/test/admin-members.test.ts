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

describe("admin member role toggle", () => {
  it("promotes a member and it shows in the list", async () => {
    const t = await login("1", "4821");
    const r = await worker.fetch(req("/admin/members/set-role", "POST", t, { memberId: "m_999", isAdmin: true }), env);
    expect(r.status).toBe(200);
    expect((await json(r)).member).toMatchObject({ memberId: "m_999", isAdmin: true });
    const list = await json(await worker.fetch(req("/admin/members", "GET", t), env));
    expect(list.members.find((m: any) => m.memberId === "m_999").isAdmin).toBe(true);
  });

  it("demotes a member once another admin exists", async () => {
    const t = await login("1", "4821");
    await worker.fetch(req("/admin/members/set-role", "POST", t, { memberId: "m_999", isAdmin: true }), env);
    const r = await worker.fetch(req("/admin/members/set-role", "POST", t, { memberId: "m_1", isAdmin: false }), env);
    expect(r.status).toBe(200);
    expect((await json(r)).member.isAdmin).toBe(false);
  });

  it("refuses to demote the last admin (409)", async () => {
    const t = await login("1", "4821");
    const r = await worker.fetch(req("/admin/members/set-role", "POST", t, { memberId: "m_1", isAdmin: false }), env);
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe("last_admin");
  });

  it("404 unknown member, 400 bad body, 403 for a non-admin", async () => {
    const t = await login("1", "4821");
    expect((await worker.fetch(req("/admin/members/set-role", "POST", t, { memberId: "m_nope", isAdmin: true }), env)).status).toBe(404);
    expect((await worker.fetch(req("/admin/members/set-role", "POST", t, { isAdmin: true }), env)).status).toBe(400);
    expect((await worker.fetch(req("/admin/members/set-role", "POST", t, { memberId: "m_999" }), env)).status).toBe(400);
    const nt = await login("999", "4821");
    expect((await worker.fetch(req("/admin/members/set-role", "POST", nt, { memberId: "m_1", isAdmin: false }), env)).status).toBe(403);
  });

  it("is idempotent (setting the current value is a 200 no-op)", async () => {
    const t = await login("1", "4821");
    const r = await worker.fetch(req("/admin/members/set-role", "POST", t, { memberId: "m_1", isAdmin: true }), env);
    expect(r.status).toBe(200);
    expect((await json(r)).member.isAdmin).toBe(true);
  });

  it("demoting a non-admin is a no-op 200 (never trips last-admin)", async () => {
    const t = await login("1", "4821");
    const r = await worker.fetch(req("/admin/members/set-role", "POST", t, { memberId: "m_999", isAdmin: false }), env);
    expect(r.status).toBe(200);
    expect((await json(r)).member.isAdmin).toBe(false);
  });
});

describe("admin member removal and renewal", () => {
  it("removes a member so they can no longer sign in", async () => {
    const t = await login("1", "4821");
    const r = await worker.fetch(req("/admin/members/remove", "POST", t, { memberId: "m_999" }), env);
    expect(r.status).toBe(200);
    expect((await worker.fetch(req("/login", "POST", undefined, { identifier: "999", pin: "4821" }), env)).status).toBe(401);
    const list = await json(await worker.fetch(req("/admin/members", "GET", t), env));
    expect(list.members.some((m: { memberId: string }) => m.memberId === "m_999")).toBe(false);
    expect((await worker.fetch(req("/admin/members/remove", "POST", t, { memberId: "m_999" }), env)).status).toBe(404);
  });

  it("refuses to remove yourself, the last admin, or with a non-admin token", async () => {
    const t = await login("1", "4821");
    const self = await worker.fetch(req("/admin/members/remove", "POST", t, { memberId: "m_1" }), env);
    expect(self.status).toBe(409);
    expect((await json(self)).error).toBe("last_admin");
    const still = await json(await worker.fetch(req("/admin/members", "GET", t), env));
    expect(still.members.some((m: { memberId: string }) => m.memberId === "m_1")).toBe(true);
    const nt = await login("999", "4821");
    expect((await worker.fetch(req("/admin/members/remove", "POST", nt, { memberId: "m_999" }), env)).status).toBe(403);
    expect((await worker.fetch(req("/admin/members/remove", "POST", t, {}), env)).status).toBe(400);
  });

  it("lets a second admin remove the other, and refuses removing yourself once you are not the last", async () => {
    const t = await login("1", "4821");
    await worker.fetch(req("/admin/members/set-role", "POST", t, { memberId: "m_999", isAdmin: true }), env);
    const self = await worker.fetch(req("/admin/members/remove", "POST", t, { memberId: "m_1" }), env);
    expect((await json(self)).error).toBe("self");
    const other = await login("999", "4821");
    const removed = await worker.fetch(req("/admin/members/remove", "POST", other, { memberId: "m_1" }), env);
    expect(removed.status).toBe(200);
    expect((await worker.fetch(req("/login", "POST", undefined, { identifier: "1", pin: "4821" }), env)).status).toBe(401);
  });

  it("renews one year at a time and stops once next year is covered", async () => {
    await putMember(roster as never, {
      memberId: "m_999", name: "Normal Member", pdgaNo: "999", pinHash: await hashPin("4821"), mustChangePin: false, memberThroughYear: 2020,
    });
    const t = await login("1", "4821");
    const first = await json(await worker.fetch(req("/admin/members/renew", "POST", t, { memberId: "m_999" }), env));
    expect(first.member.membershipCurrent).toBe(true);
    expect(first.member.memberThroughYear).toBeGreaterThanOrEqual(2026);
    const through = first.member.memberThroughYear as number;
    const second = await json(await worker.fetch(req("/admin/members/renew", "POST", t, { memberId: "m_999" }), env));
    expect(second.member.memberThroughYear).toBe(through + 1);
    const third = await worker.fetch(req("/admin/members/renew", "POST", t, { memberId: "m_999" }), env);
    expect(third.status).toBe(409);
    expect((await json(third)).error).toBe("already_renewed");
    const me = await json(await worker.fetch(req("/me", "GET", await login("999", "4821")), env));
    expect(me.membership.throughYear).toBe(through + 1);
    expect(me.membership.lapsed).toBe(false);
  });

  it("lets an admin re-add a previously removed member immediately, even when Workers KV serves stale 60s cached reads", async () => {
    // Real Workers KV caches get() for 60s and propagates delete()/put() eventually.
    // Simulate a stale KV whose get() keeps returning old values after delete() and whose list() lags behind.
    const backing = new Map<string, string>();
    const edgeCache = new Map<string, string>();
    const staleKv = {
      get: async (k: string) => {
        if (edgeCache.has(k)) return edgeCache.get(k)!;
        const v = backing.get(k) ?? null;
        if (v !== null) edgeCache.set(k, v);
        return v;
      },
      put: async (k: string, v: string) => {
        backing.set(k, v);
        // Simulate stale edge POP cache that hasn't refreshed yet if already cached
      },
      delete: async (k: string) => {
        backing.delete(k);
        // Deliberately leave edgeCache[k] intact to mimic KV's 60s edge cache after delete!
      },
      list: async ({ prefix = "" }: { prefix?: string } = {}) => {
        const names = new Set<string>([...backing.keys(), ...edgeCache.keys()]);
        return {
          keys: [...names].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
          list_complete: true,
        };
      },
    };
    // Minimal in-memory D1 supporting kv_store (as in migration 0010).
    const kvStore = new Map<string, { ns: string; key: string; value: string; expires_at: number | null }>();
    const d1 = {
      prepare: (sql: string) => {
        let args: unknown[] = [];
        const stmt = {
          bind: (...vals: unknown[]) => { args = vals; return stmt; },
          all: async () => {
            if (/SELECT key, value FROM kv_store/i.test(sql)) {
              const [ns, now] = args as [string, number];
              const results = [...kvStore.values()]
                .filter((r) => r.ns === ns && (r.expires_at === null || r.expires_at > now))
                .map((r) => ({ key: r.key, value: r.value }));
              return { results, success: true };
            }
            return { results: [], success: true };
          },
          first: async () => null,
          run: async () => {
            if (/INSERT INTO kv_store/i.test(sql)) {
              const [ns, key, value, expires_at] = args as [string, string, string, number | null];
              kvStore.set(`${ns}:${key}`, { ns, key, value, expires_at });
            }
            return { results: [], success: true, meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    };
    const kvEnv = { ...env, ROSTER: staleKv, DB: d1 } as unknown as Env;
    await putMember(staleKv as never, { memberId: "m_1", name: "Admin Person", pdgaNo: "1", pinHash: await hashPin("4821"), mustChangePin: false, isAdmin: true });
    await putMember(staleKv as never, { memberId: "m_21439", name: "Max Crotts", pdgaNo: "21439", pinHash: await hashPin("4821"), mustChangePin: false, isAdmin: true });
    await staleKv.put("wa:creds:m_21439", JSON.stringify([{ id: "old-passkey", publicKey: "pk", counter: 1 }]));

    const adminToken = ((await (await worker.fetch(req("/login", "POST", undefined, { identifier: "1", pin: "4821" }), kvEnv)).json()) as { token: string }).token;
    const maxOldToken = ((await (await worker.fetch(req("/login", "POST", undefined, { identifier: "21439", pin: "4821" }), kvEnv)).json()) as { token: string }).token;

    // Warm the edge cache by listing members (exactly what Admin > Members does).
    const before = await json(await worker.fetch(req("/admin/members", "GET", adminToken), kvEnv));
    expect(before.members.some((m: { memberId: string }) => m.memberId === "m_21439")).toBe(true);

    // Remove Max Crotts.
    const rm = await worker.fetch(req("/admin/members/remove", "POST", adminToken, { memberId: "m_21439" }), kvEnv);
    expect(rm.status).toBe(200);

    // Immediately absent from member list, old session immediately rejected, and old passkeys cleared.
    const afterRm = await json(await worker.fetch(req("/admin/members", "GET", adminToken), kvEnv));
    expect(afterRm.members.some((m: { memberId: string }) => m.memberId === "m_21439")).toBe(false);
    expect((await worker.fetch(req("/me", "GET", maxOldToken), kvEnv)).status).toBe(401);
    expect(backing.has("wa:creds:m_21439")).toBe(false);

    // Immediately re-add Max Crotts with the same PDGA# — must succeed (never 409 member_exists).
    const readd = await worker.fetch(req("/admin/members", "POST", adminToken, { name: "Max Crotts", pdgaNo: "21439", isAdmin: true }), kvEnv);
    expect(readd.status).toBe(201);
    const created = await json(readd);
    expect(created.member).toMatchObject({ memberId: "m_21439", name: "Max Crotts", pdgaNo: "21439", isAdmin: true, mustChangePin: true });

    // Re-added member immediately shows up in the list and can log in with the new temporary PIN.
    const afterAdd = await json(await worker.fetch(req("/admin/members", "GET", adminToken), kvEnv));
    expect(afterAdd.members.some((m: { memberId: string }) => m.memberId === "m_21439")).toBe(true);
    const reLogin = await worker.fetch(req("/login", "POST", undefined, { identifier: "21439", pin: created.tempPin }), kvEnv);
    expect(reLogin.status).toBe(200);
    expect((await json(reLogin)).mustChangePin).toBe(true);
  });

  it("ignores dangling login indexes pointing to a removed member when re-adding", async () => {
    const t = await login("1", "4821");
    // Stale index pointing to an old memberId that no longer exists in KV.
    await roster.put("idx:pdga:21439", "m_u_oldmax");
    const res = await worker.fetch(req("/admin/members", "POST", t, { name: "Max Crotts", pdgaNo: "21439", isAdmin: true }), env);
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created.member.memberId).toBe("m_21439");
    expect(await roster.get("idx:pdga:21439")).toBe("m_21439");
  });
});
