// Guest accounts (the owner's rules): apply in onboarding (an admin approves), a valid email and phone are required,
// sign in with the email, everything but marketplace listing; the first 100 approved guests also get round history
// and stats (the promotion), after that those need a membership.
import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { parsePhone } from "../src/guest-accounts.js";
import { canonicalLoginKey, putMember } from "../src/roster.js";

const SECRET = "x".repeat(40);
const ORIGIN = "https://gvdgclub.com";

function memoryKv() {
  const rows = new Map<string, string>();
  return {
    rows,
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
    raw: db,
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

let db: Awaited<ReturnType<typeof sqliteDb>>;
let roster: ReturnType<typeof memoryKv>;
let env: Env;

beforeEach(async () => {
  db = await sqliteDb();
  roster = memoryKv();
  env = { ROSTER: roster, RATELIMIT: memoryKv(), DB: db, JWT_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN, SESSION_TTL_SEC: "900" } as unknown as Env;
  await putMember(roster as never, { memberId: "m_1", name: "Avery Brooks", pdgaNo: "1", isAdmin: true, pinHash: "h", mustChangePin: false });
});

async function call(path: string, body?: unknown, who: string | null = "m_1", ip = "203.0.113.9") {
  const headers: Record<string, string> = { Origin: ORIGIN, "CF-Connecting-IP": ip };
  if (who) headers.Authorization = "Bearer " + await signSession({ sub: who, mustChangePin: false }, SECRET, 900);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await worker.fetch(new Request("https://w" + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const raw = await response.text();
  return { status: response.status, data: raw ? JSON.parse(raw) : null };
}
const guestApp = (extra: Record<string, unknown> = {}) => ({ kind: "guest", name: "Drew Visitor", email: "Drew.V7@Example.com", phone: "(864) 555-0123", pin: "4821", ...extra });
async function applyAndApprove(extra: Record<string, unknown> = {}, ip = "203.0.113.9") {
  const applied = await call("/membership/apply", guestApp(extra), null, ip);
  expect(applied.status).toBe(201);
  const approved = await call(`/admin/members/applications/${applied.data.application.id}/approve`, {});
  expect(approved.status).toBe(200);
  return { applied: applied.data, approved: approved.data };
}

describe("phone numbers", () => {
  it("takes a US number typed any way, or an international one", () => {
    expect(parsePhone("(864) 555-0123")).toBe("+18645550123");
    expect(parsePhone("1-864-555-0123")).toBe("+18645550123");
    expect(parsePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(parsePhone("555-0123")).toBeNull();
    expect(parsePhone("(064) 555-0123")).toBeNull();
    expect(parsePhone("call me")).toBeNull();
  });
});

describe("applying for a guest account", () => {
  it("needs a valid email and phone (no PDGA # or UDisc needed), and says how many promo spots are left", async () => {
    expect((await call("/membership/apply", guestApp({ email: "" }), null)).data.error).toBe("email_required");
    expect((await call("/membership/apply", guestApp({ email: "nope" }), null)).data.error).toBe("invalid_email");
    expect((await call("/membership/apply", guestApp({ phone: "" }), null)).data.error).toBe("invalid_phone");
    expect((await call("/membership/apply", guestApp({ phone: "123" }), null)).data.error).toBe("invalid_phone");
    const ok = await call("/membership/apply", guestApp(), null);
    expect(ok.status).toBe(201);
    expect(ok.data).toMatchObject({ application: { kind: "guest", name: "Drew Visitor" }, duesOnline: false, guestSpots: { limit: 100, left: 100 } });
    // The reply never carries their contact details (match the whole number: a random id can contain "555").
    expect(JSON.stringify(ok.data)).not.toMatch(/555-?0123|5550123|example\.com/i);
    expect((await call("/membership/apply", guestApp({ name: "Drew Again" }), null)).data.error).toBe("already_pending");
    // A member application still needs a PDGA # or UDisc name.
    expect((await call("/membership/apply", { name: "Pat", pin: "1234" }, null, "203.0.113.77")).data.error).toBe("pdga_or_udisc_required");
    // The admin list shows it's a guest, with how to reach them.
    const list = await call("/admin/members/applications");
    expect(list.data.applications[0]).toMatchObject({ kind: "guest", contact: { email: "drew.v7@example.com", phone: "+18645550123" } });
    expect(await call("/membership/guest-spots", undefined, null)).toMatchObject({ status: 200, data: { limit: 100, left: 100 } });
  });

  it("approved: a guest account with a promo spot, signing in with the email (never read as a PDGA #)", async () => {
    const { approved } = await applyAndApprove();
    expect(approved.member).toMatchObject({ tier: "guest", guestPromo: true });
    const memberId = approved.member.memberId as string;
    expect(memberId).toMatch(/^m_e_[0-9a-f]{16}$/);
    expect(JSON.parse(roster.rows.get("member:" + memberId)!)).toMatchObject({ guest: true, guestPromo: true, email: "drew.v7@example.com", phone: "+18645550123" });
    expect((await call("/membership/guest-spots", undefined, null)).data.left).toBe(99);
    expect(canonicalLoginKey("Drew.V7@example.com")).toBe("email:drew.v7@example.com");
    // An email with a 7 in it doesn't sign in as PDGA #7, and PDGA #7 doesn't sign in as Drew.
    await putMember(roster as never, { memberId: "m_7", name: "Seven", pdgaNo: "7", pinHash: "x", mustChangePin: false });
    const login = await worker.fetch(new Request("https://w/login", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ identifier: "drew.v7@EXAMPLE.com", pin: "4821" }) }), env);
    expect(login.status).toBe(200);
    const signedIn = await login.json() as { membership: { guest: boolean; history: boolean } };
    expect(signedIn.membership).toMatchObject({ guest: true, history: true, lapsed: false });
    // With a promo spot: round history works.
    expect((await call("/my-results", undefined, memberId)).status).toBe(200);
  });

  it("after 100 promo guests: still a guest account, but round history and stats need a membership", async () => {
    const insert = db.raw.prepare("INSERT INTO guest_promo (member_id) VALUES (?)");
    for (let i = 0; i < 100; i++) insert.run("m_promo_" + i);
    expect((await call("/membership/guest-spots", undefined, null)).data).toEqual({ limit: 100, left: 0 });
    const { approved } = await applyAndApprove({ email: "late@example.com", name: "Late Guest" }, "203.0.113.10");
    expect(approved.member).toMatchObject({ tier: "guest", guestPromo: false });
    const memberId = approved.member.memberId as string;
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM guest_promo").get() as { n: number }).n).toBe(100);
    for (const path of ["/my-results", "/my-play-history", "/my-play-export", "/my-ratings"]) {
      expect(await call(path, undefined, memberId)).toMatchObject({ status: 403, data: { error: "membership_required" } });
    }
    expect((await call("/me", undefined, memberId)).data.membership).toMatchObject({ guest: true, history: false });
    // Members and admins are never blocked; an admin making them a member opens it up.
    expect((await call("/my-results", undefined, "m_1")).status).toBe(200);
    await call("/admin/members/set-tier", { memberId, tier: "member" });
    expect((await call("/my-results", undefined, memberId)).status).toBe(200);
  });

  it("matches a held account from the club's sheets by name on approval", async () => {
    await call("/admin/sheet-import/apply", { kind: "balances", rows: [{ line: 2, name: "Drew Visitor", value: 700, memberId: "" }] });
    const { approved } = await applyAndApprove();
    expect(approved.carriedOver).toContain("$7.00 store credit");
    expect((db.raw.prepare("SELECT SUM(amount_cents) AS c FROM wallet_transactions WHERE member_id = ?").get(approved.member.memberId) as { c: number }).c).toBe(700);
    expect(JSON.parse(roster.rows.get("member:" + approved.member.memberId)!)).toMatchObject({ guest: true, guestPromo: true });
  });
});
