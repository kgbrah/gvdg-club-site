import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { b64url } from "../src/web-push.js";
import { buildWelcomeEmail } from "../src/membership-notify.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";

afterEach(() => vi.unstubAllGlobals());

function member(memberId: string, name: string, isAdmin = false) {
  return JSON.stringify({ memberId, name, isAdmin, pinHash: "x", mustChangePin: false });
}
function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (k: string) => rows.get(k) ?? null,
    put: async (k: string, v: string) => { rows.set(k, v); },
    delete: async (k: string) => { rows.delete(k); },
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
      keys: [...rows.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}
async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0058_membership_dues.sql", import.meta.url), "utf8"));
  db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT, date TEXT, status TEXT, type TEXT)");
  db.exec("CREATE TABLE event_config (event_id INTEGER, play_format TEXT, live_scoring_config TEXT)");
  const future = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO events (id, name, date, status, type) VALUES (1, 'Sunday Doubles', ?, 'scheduled', 'league')").run(future);
  return {
    raw: db,
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async all() { return { results: db.prepare(sql).all(...(bound as never[])), success: true }; },
        async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
        async run() { const i = db.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: i.changes } }; },
      };
      return stmt;
    },
  };
}

type Db = Awaited<ReturnType<typeof sqliteDb>>;
const PAYPAL = { PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec", PAYPAL_API_BASE: "https://pp.test" };

async function makeEnv(extra: Record<string, unknown> = {}): Promise<Env & { DB: Db }> {
  return {
    ROSTER: kv({ "member:m_admin": member("m_admin", "Ada Admin", true), "member:m_ace": member("m_ace", "Ace") }),
    RATELIMIT: kv({}),
    DB: await sqliteDb(),
    JWT_SECRET: SECRET,
    SESSION_TTL_SEC: "900",
    ALLOWED_ORIGINS: ORIGIN,
    PIN_PEPPER: "pep",
    ...extra,
  } as unknown as Env & { DB: Db };
}

type Cap = { orderStatus?: string; capStatus?: string; currency?: string; value?: string };
let capture: Cap = {};
let calls: { url: string; body: string }[] = [];
let createdValue = "";

function mockNetwork() {
  calls = [];
  capture = {};
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown; method?: string }) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok" });
    if (url.endsWith("/v2/checkout/orders")) {
      createdValue = JSON.parse(body).purchase_units[0].amount.value;
      return Response.json({ id: "ORDER1" });
    }
    if (url.includes("/v2/checkout/orders/") && url.endsWith("/capture")) {
      return Response.json({
        status: capture.orderStatus ?? "COMPLETED",
        purchase_units: [{ payments: { captures: [{ id: "CAP9", status: capture.capStatus ?? "COMPLETED", amount: { currency_code: capture.currency ?? "USD", value: capture.value ?? "15.00" } }] } }],
      });
    }
    if (url.startsWith("https://api.resend.com")) return Response.json({ id: "em1" });
    return new Response(null, { status: 201 });
  }));
}
const ppCalls = () => calls.filter((c) => c.url.includes("pp.test") && !c.url.endsWith("/token"));
const resendCalls = () => calls.filter((c) => c.url.startsWith("https://api.resend.com"));

function req(path: string, method = "GET", body?: unknown, token?: string) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (token) headers.authorization = "Bearer " + token;
  if (body) headers["content-type"] = "application/json";
  return new Request("https://w" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
const ctx = () => { const jobs: Promise<unknown>[] = []; return { jobs, c: { waitUntil: (p: Promise<unknown>) => { jobs.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext }; };
const jsonOf = async (r: Response) => (await r.json()) as Record<string, any>;
const token = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);

async function apply(env: Env, extra: Record<string, unknown> = {}, c?: ExecutionContext) {
  const res = await worker.fetch(req("/membership/apply", "POST", { name: "Nina Newbie", pdgaNo: "123456", pin: "2468", ...extra }), env, c);
  return { res, data: await jsonOf(res) };
}

beforeEach(() => mockNetwork());

describe("duesOnline switch", () => {
  it("is false without credentials and hides the client id", async () => {
    const env = await makeEnv();
    const cfg = await jsonOf(await worker.fetch(req("/membership/config"), env));
    expect(cfg.duesOnline).toBe(false);
    expect(cfg.paypalClientId).toBeNull();
  });
  it("is false with only one secret", async () => {
    const env = await makeEnv({ PAYPAL_CLIENT_ID: "cid" });
    expect((await jsonOf(await worker.fetch(req("/membership/config"), env))).duesOnline).toBe(false);
  });
  it("is true with both secrets, and can be forced off", async () => {
    const on = await makeEnv(PAYPAL);
    const cfg = await jsonOf(await worker.fetch(req("/membership/config"), on));
    expect(cfg).toMatchObject({ duesOnline: true, duesCents: 1500, paypalClientId: "cid" });
    const off = await makeEnv({ ...PAYPAL, MEMBERSHIP_DUES_ONLINE: "off" });
    expect((await jsonOf(await worker.fetch(req("/membership/config"), off))).duesOnline).toBe(false);
  });
  it("create-order is 503 while off", async () => {
    const env = await makeEnv();
    const { data } = await apply(env);
    const r = await worker.fetch(req(`/membership/apply/${data.application.id}/dues/create-order`, "POST", { payToken: data.payToken }), env);
    expect(r.status).toBe(503);
  });
});

describe("application email field", () => {
  it("is optional, validated, normalized, and never returned publicly", async () => {
    const env = await makeEnv();
    expect((await apply(env)).res.status).toBe(201);
    const env2 = await makeEnv();
    expect((await apply(env2, { email: "not-an-email" })).res.status).toBe(400);
    expect((await apply(env2, { email: "a".repeat(130) + "@x.com" })).res.status).toBe(400);
    const ok = await apply(env2, { email: " Nina@Example.COM " });
    expect(ok.res.status).toBe(201);
    expect(JSON.stringify(ok.data)).not.toContain("example.com");
    const admin = await token("m_admin");
    const listed = await jsonOf(await worker.fetch(req("/admin/members/applications", "GET", undefined, admin), env2));
    expect(JSON.stringify(listed)).not.toContain("example.com");
    expect(listed.applications[0]).toMatchObject({ hasEmail: true });
    expect(listed.duesOnline).toBe(false);
  });
});

describe("dues order + capture (server-trusted)", () => {
  async function ready() {
    const env = await makeEnv(PAYPAL);
    const { data } = await apply(env);
    return { env, id: data.application.id as string, payToken: data.payToken as string };
  }
  const create = (env: Env, id: string, payToken: string, extra: object = {}) =>
    worker.fetch(req(`/membership/apply/${id}/dues/create-order`, "POST", { payToken, ...extra }), env);
  const cap = (env: Env, id: string, payToken: string, orderId = "ORDER1") =>
    worker.fetch(req(`/membership/apply/${id}/dues/capture`, "POST", { payToken, orderId }), env);

  it("prices the order server-side and ignores a client amount", async () => {
    const { env, id, payToken } = await ready();
    const r = await create(env, id, payToken, { amountCents: 1, amount: "0.01" });
    expect(r.status).toBe(200);
    expect(await jsonOf(r)).toMatchObject({ orderId: "ORDER1", amountCents: 1500 });
    expect(createdValue).toBe("15.00");
  });
  it("requires the application's pay token", async () => {
    const { env, id } = await ready();
    expect((await create(env, id, "wrong")).status).toBe(404);
    expect((await create(env, "nope", "wrong")).status).toBe(404);
  });
  it("records a settled capture with order + capture ids", async () => {
    const { env, id, payToken } = await ready();
    const r = await cap(env, id, payToken);
    expect(r.status).toBe(200);
    const admin = await token("m_admin");
    const listed = await jsonOf(await worker.fetch(req("/admin/members/applications", "GET", undefined, admin), env));
    expect(listed.applications[0].payment).toMatchObject({ status: "paid", method: "paypal", amountCents: 1500, captureId: "CAP9", orderId: "ORDER1" });
    expect(listed.applications[0].payment.paidAt).toMatch(/Z$/);
  });
  it("is idempotent: a retry neither re-captures nor double-records", async () => {
    const { env, id, payToken } = await ready();
    await cap(env, id, payToken);
    const before = ppCalls().length;
    const again = await cap(env, id, payToken);
    expect(again.status).toBe(200);
    expect(ppCalls().length).toBe(before);
    expect(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM membership_dues").get()).toEqual({ n: 1 });
    expect((await cap(env, id, payToken, "ORDER2")).status).toBe(409);
  });
  it.each([
    ["non-COMPLETED order", { orderStatus: "PENDING" }],
    ["pending capture", { capStatus: "PENDING" }],
    ["wrong currency", { currency: "EUR" }],
    ["short amount", { value: "14.99" }],
  ])("rejects %s and records nothing", async (_n, c) => {
    const { env, id, payToken } = await ready();
    capture = c as Cap;
    const r = await cap(env, id, payToken);
    expect(r.status).toBe(402);
    expect(env.DB.raw.prepare("SELECT paid_at FROM membership_dues WHERE application_id = ?").get(id)).toMatchObject({ paid_at: null });
    capture = {};
    expect((await cap(env, id, payToken)).status).toBe(200); // reservation was released, retry works
  });
  it("accepts an overpayment", async () => {
    const { env, id, payToken } = await ready();
    capture = { value: "20.00" };
    expect((await cap(env, id, payToken)).status).toBe(200);
  });
  it("blocks a second application from reusing the same PayPal order", async () => {
    const { env, id, payToken } = await ready();
    await cap(env, id, payToken);
    const other = await apply(env, { name: "Other", pdgaNo: "777" });
    const r = await cap(env, other.data.application.id, other.data.payToken);
    expect(r.status).toBe(409);
  });
  it("lets the applicant flag 'paid another way' (method stays none)", async () => {
    const { env, id, payToken } = await ready();
    const r = await worker.fetch(req(`/membership/apply/${id}/dues/other`, "POST", { payToken }), env);
    expect(r.status).toBe(200);
    const admin = await token("m_admin");
    const listed = await jsonOf(await worker.fetch(req("/admin/members/applications", "GET", undefined, admin), env));
    expect(listed.applications[0].payment).toMatchObject({ status: "unpaid", method: "none", claimedOther: true });
    expect(listed.duesOnline).toBe(true);
  });
});

describe("admin mark-paid", () => {
  it("is admin-gated", async () => {
    const env = await makeEnv();
    const { data } = await apply(env);
    const path = `/admin/members/applications/${data.application.id}/mark-paid`;
    expect((await worker.fetch(req(path, "POST", { note: "cash" }), env)).status).toBe(401);
    expect((await worker.fetch(req(path, "POST", { note: "cash" }, await token("m_ace")), env)).status).toBe(403);
    expect(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM membership_dues").get()).toEqual({ n: 0 });
  });
  it("records who, when, and the note; does not overwrite a PayPal payment", async () => {
    const env = await makeEnv(PAYPAL);
    const { data } = await apply(env);
    const admin = await token("m_admin");
    const path = `/admin/members/applications/${data.application.id}/mark-paid`;
    const r = await worker.fetch(req(path, "POST", { note: "cash at league" }, admin), env);
    expect(r.status).toBe(200);
    const listed = await jsonOf(await worker.fetch(req("/admin/members/applications", "GET", undefined, admin), env));
    expect(listed.applications[0].payment).toMatchObject({ status: "manual", method: "manual", markedBy: "Ada Admin", note: "cash at league" });
    expect(listed.applications[0].payment.paidAt).toBeTruthy();
    // paypal-paid rows are protected
    const second = await apply(env, { name: "P", pdgaNo: "888" });
    await worker.fetch(req(`/membership/apply/${second.data.application.id}/dues/capture`, "POST", { payToken: second.data.payToken, orderId: "ORDER1" }), env);
    const blocked = await worker.fetch(req(`/admin/members/applications/${second.data.application.id}/mark-paid`, "POST", { note: "x" }, admin), env);
    expect(blocked.status).toBe(409);
  });
});

describe("welcome email + push + in-app flag", () => {
  const approve = async (env: Env, id: string, c?: ExecutionContext) =>
    worker.fetch(req(`/admin/members/applications/${id}/approve`, "POST", undefined, await token("m_admin")), env, c);

  it("sends received + welcome email only when RESEND_API_KEY is set, and never includes the PIN", async () => {
    const env = await makeEnv({ RESEND_API_KEY: "re_key" });
    const a = ctx();
    const { data } = await apply(env, { email: "nina@example.com" }, a.c);
    await Promise.all(a.jobs);
    expect(resendCalls()).toHaveLength(1);
    const b = ctx();
    expect((await approve(env, data.application.id, b.c)).status).toBe(200);
    await Promise.all(b.jobs);
    const sent = resendCalls();
    expect(sent).toHaveLength(2);
    const payload = JSON.parse(sent[1]!.body);
    expect(payload.to).toEqual(["nina@example.com"]);
    expect(payload.from).toMatch(/@gvdgclub\.com>$/);
    expect(payload.html).toContain("gvdg-members.html");
    expect(payload.html).toContain("facebook.com/groups");
    expect(payload.html).toContain("Sunday Doubles");
    expect(payload.html).toContain("123456");
    for (const part of [payload.html, payload.text, payload.subject]) expect(part).not.toContain("2468");
    expect(sent[0]!.body).not.toContain("2468");
  });
  it("is a no-op without RESEND_API_KEY or without an email", async () => {
    const env = await makeEnv();
    const a = ctx();
    const { data } = await apply(env, { email: "nina@example.com" }, a.c);
    await approve(env, data.application.id, a.c);
    await Promise.all(a.jobs);
    expect(resendCalls()).toHaveLength(0);
    const env2 = await makeEnv({ RESEND_API_KEY: "re_key" });
    const b = ctx();
    const d2 = await apply(env2, {}, b.c);
    await approve(env2, d2.data.application.id, b.c);
    await Promise.all(b.jobs);
    expect(resendCalls()).toHaveLength(0);
  });
  it("sends one approval push and discards the subscription", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const privRaw = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const env = await makeEnv({ VAPID_PUBLIC_KEY: b64url(pubRaw), VAPID_PRIVATE_KEY: b64url(privRaw) });
    const cfg = await jsonOf(await worker.fetch(req("/membership/config"), env));
    expect(cfg.pushPublicKey).toBe(b64url(pubRaw));
    const sub = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const subRaw = new Uint8Array(await crypto.subtle.exportKey("raw", sub.publicKey));
    const body = { endpoint: "https://push.example.test/abc123456", keys: { p256dh: b64url(subRaw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } };
    const { data } = await apply(env);
    const bad = await worker.fetch(req(`/membership/apply/${data.application.id}/push`, "POST", { ...body, payToken: "nope" }), env);
    expect(bad.status).toBe(404);
    const ok = await worker.fetch(req(`/membership/apply/${data.application.id}/push`, "POST", { ...body, payToken: data.payToken }), env);
    expect(ok.status).toBe(200);
    const a = ctx();
    await approve(env, data.application.id, a.c);
    await Promise.all(a.jobs);
    expect(calls.filter((c) => c.url === body.endpoint)).toHaveLength(1);
    expect(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM membership_push_subscriptions").get()).toEqual({ n: 0 });
  });
  it("flags the new member for a one-time welcome card until dismissed", async () => {
    const env = await makeEnv();
    const { data } = await apply(env);
    await approve(env, data.application.id);
    const t = await token("m_123456");
    const me = await jsonOf(await worker.fetch(req("/me", "GET", undefined, t), env));
    expect(me.welcome).toBe(true);
    expect((await worker.fetch(req("/me/welcome-seen", "POST", undefined, t), env)).status).toBe(200);
    expect((await jsonOf(await worker.fetch(req("/me", "GET", undefined, t), env))).welcome).toBe(false);
    const admin = await jsonOf(await worker.fetch(req("/me", "GET", undefined, await token("m_admin")), env));
    expect(admin.welcome).toBe(false);
  });
  it("renders the welcome email without a PIN", () => {
    const m = buildWelcomeEmail({ EXPECTED_ORIGIN: "https://gvdgclub.com" } as unknown as Env, { name: "Nina Newbie", identifier: "123456", events: [] });
    expect(m.html).toContain("Welcome to the club");
    expect(m.text).not.toMatch(/PIN: \d/);
  });
});

describe("email preview", () => {
  it("writes rendered HTML for visual QA when GVDG_EMAIL_PREVIEW_DIR is set", async () => {
    const dir = process.env.GVDG_EMAIL_PREVIEW_DIR;
    if (!dir) return;
    const { writeFileSync, mkdirSync } = (await import("node:fs")) as unknown as { writeFileSync(p: string, d: string): void; mkdirSync(p: string, o?: object): void };
    const { buildReceivedEmail } = await import("../src/membership-notify.js");
    const e = { EXPECTED_ORIGIN: "https://gvdgclub.com" } as unknown as Env;
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + "/welcome-email.html", buildWelcomeEmail(e, { name: "Nina Newbie", identifier: "123456", events: [{ name: "Sunday Doubles", date: "Nov 22" }, { name: "Turkey Trot Open", date: "Nov 27" }] }).html);
    writeFileSync(dir + "/received-email.html", buildReceivedEmail(e, { name: "Nina Newbie", identifier: "123456", duesPaid: false }).html);
  });
});
