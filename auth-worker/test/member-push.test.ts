import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { saveUdiscLeague } from "../src/udisc-league-save.js";
import { b64url } from "../src/web-push.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const text = new TextEncoder();

afterEach(() => vi.unstubAllGlobals());

const member = (memberId: string, name: string, isAdmin = false) =>
  JSON.stringify({ memberId, name, isAdmin, pinHash: "x", mustChangePin: false });

function kv(initial: Record<string, string>) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async (opts?: { prefix?: string }) => ({
      keys: [...rows.keys()].filter((key) => key.startsWith(opts?.prefix || "")).map((name) => ({ name })),
      list_complete: true,
    }),
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
        async run() {
          const info = db.prepare(sql).run(...(bound as never[]));
          return { results: [], success: true, meta: { changes: info.changes } };
        },
      };
      return stmt;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
type TestDb = Awaited<ReturnType<typeof sqliteDb>>;

async function vapid() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  return {
    VAPID_PUBLIC_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    VAPID_PRIVATE_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
  };
}

function makeEnv(db: TestDb, extra: Record<string, string> = {}): Env {
  return {
    ROSTER: kv({
      "member:m_ada": member("m_ada", "Ada Lovelace"),
      "member:m_bo": member("m_bo", "Bo Burnham"),
      "member:m_cy": member("m_cy", "Cy Young"),
      "member:m_di": member("m_di", "Di Prince"),
      "member:m_admin": member("m_admin", "Admin Person", true),
    }),
    RATELIMIT: kv({}),
    DB: db,
    JWT_SECRET: SECRET,
    SESSION_TTL_SEC: "900",
    ALLOWED_ORIGINS: ORIGIN,
    ...extra,
  } as unknown as Env;
}

const token = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);

// Each test call collects waitUntil promises so best-effort pushes can be awaited deterministically.
async function call(env: Env, path: string, method = "GET", bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
  const response = await worker.fetch(new Request("https://worker.example" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const data: any = await response.json().catch(() => null);
  await Promise.all(pending);
  return { status: response.status, data };
}

async function device(n: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { endpoint: `https://push.example/send/${n}`, pair, publicRaw, auth, keys: { p256dh: b64url(publicRaw), auth: b64url(auth) } };
}
type Device = Awaited<ReturnType<typeof device>>;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, bytes * 8));
}

async function decrypt(body: Uint8Array, dev: Device) {
  const salt = body.slice(0, 16);
  const idlen = body[20] ?? 0;
  const senderPub = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const sender = await crypto.subtle.importKey("raw", senderPub as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, dev.pair.privateKey, 256));
  const info = new Uint8Array([...text.encode("WebPush: info\0"), ...dev.publicRaw, ...senderPub]);
  const ikm = await hkdf(dev.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["decrypt"]);
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aes, cipher as BufferSource));
  let end = clear.length;
  while (end > 0 && clear[end - 1] === 0) end -= 1;
  return JSON.parse(new TextDecoder().decode(clear.slice(0, end - 1)));
}

/** Mock the push service: records sends per endpoint; `status` lets a test return 404/410. */
function pushService(devices: Device[], status: Record<string, number> = {}) {
  const sent: { endpoint: string; payload: any }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const dev = devices.find((d) => d.endpoint === url);
    if (status[url]) return new Response(null, { status: status[url] });
    if (dev) sent.push({ endpoint: url, payload: await decrypt(init.body as Uint8Array, dev) });
    return new Response(null, { status: 201 });
  });
  vi.stubGlobal("fetch", fn);
  return { sent, fn };
}

const sub = (dev: Device, prefs?: unknown) => ({ endpoint: dev.endpoint, keys: dev.keys, ...(prefs ? { prefs } : {}) });

const board = (order: string[], date = "2026-11-08") => ({
  league: { type: "league", source: "udisc", name: "Sunday Baggers", season: "2026", format: "stroke", external_url: "https://udisc.com/leagues/sunday-baggers", description: null, date: null },
  events: [],
  standings: {
    leagueName: "Sunday Baggers", shortId: null, seasonStart: date, seasonEnd: date, roundsKept: null, minimumPoints: null, mode: "tags" as const,
    events: [{ name: `Round ${date}`, date, shortId: null, externalUrl: `https://udisc.com/events/round-${date}`, venue: null,
      results: order.map((name, i) => ({ name, place: i + 1, total: 50 + i, toPar: i - 5, points: null, division: null })) }],
    standings: [],
  },
});

const ORDER = ["Ada Lovelace", "Eve Guest", "Bo Burnham", "Cy Young", "Di Prince"];

async function setup(opts: { keys?: boolean } = {}) {
  const db = await sqliteDb();
  const env = makeEnv(db, opts.keys === false ? {} : await vapid());
  const leagueId = (await saveUdiscLeague(env, "m_admin", board(ORDER) as never)).league_id;
  const t = { ada: await token("m_ada"), bo: await token("m_bo"), cy: await token("m_cy"), di: await token("m_di"), admin: await token("m_admin") };
  return { db, env, leagueId, ...t };
}

const rowsOf = (db: TestDb) => db.raw.prepare("SELECT endpoint, member_id, bag_tags FROM member_push_subscriptions ORDER BY endpoint").all();

describe("member push subscription endpoints", () => {
  it("is member-authed and validated", async () => {
    const t = await setup();
    const d = await device("a");
    expect((await call(t.env, "/me/push-subscription")).status).toBe(401);
    expect((await call(t.env, "/me/push-subscription", "PUT", undefined, sub(d))).status).toBe(401);
    expect((await call(t.env, "/me/push-subscription", "DELETE", undefined, { endpoint: d.endpoint })).status).toBe(401);
    expect((await call(t.env, "/me/push-subscription", "PUT", t.bo, { endpoint: "http://insecure.example/x", keys: d.keys })).data.error).toBe("invalid_subscription");
    expect((await call(t.env, "/me/push-subscription", "PUT", t.bo, { endpoint: d.endpoint, keys: { p256dh: "AAAA", auth: d.keys.auth } })).data.error).toBe("invalid_subscription");
    expect((await call(t.env, "/me/push-subscription", "PUT", t.bo, sub(d, { bagTags: "yes" }))).data.error).toBe("invalid_prefs");
    expect((await call(t.env, "/me/push-subscription", "DELETE", t.bo, {})).data.error).toBe("invalid_subscription");
    expect(rowsOf(t.db)).toEqual([]);
  });

  it("reports unconfigured without VAPID keys", async () => {
    const t = await setup({ keys: false });
    const d = await device("a");
    expect((await call(t.env, "/me/push-subscription", "GET", t.bo)).data).toMatchObject({ configured: false, publicKey: null });
    expect((await call(t.env, "/me/push-subscription", "PUT", t.bo, sub(d))).status).toBe(503);
  });

  it("subscribes devices (default on), toggles the preference for all, and only deletes its own", async () => {
    const t = await setup();
    const a = await device("a"); const b = await device("b");
    expect((await call(t.env, "/me/push-subscription", "PUT", t.bo, sub(a))).data).toEqual({ ok: true, prefs: { bagTags: true, messages: true } });
    expect((await call(t.env, "/me/push-subscription", "PUT", t.bo, sub(b))).status).toBe(200);
    const info = (await call(t.env, `/me/push-subscription?endpoint=${encodeURIComponent(a.endpoint)}`, "GET", t.bo)).data;
    expect(info).toMatchObject({ configured: true, devices: 2, subscribed: true, prefs: { bagTags: true, messages: true } });
    expect(info.publicKey).toBeTruthy();
    const toggled = (await call(t.env, "/me/push-subscription", "PUT", t.bo, sub(a, { bagTags: false }))).data.prefs;
    expect(toggled).toEqual({ bagTags: false, messages: true });
    expect(rowsOf(t.db).map((r: any) => r.bag_tags)).toEqual([0, 0]);
    // A new device inherits the member's "off".
    const c = await device("c");
    await call(t.env, "/me/push-subscription", "PUT", t.bo, sub(c));
    expect(rowsOf(t.db).map((r: any) => r.bag_tags)).toEqual([0, 0, 0]);
    // Another member cannot remove Bo's device.
    await call(t.env, "/me/push-subscription", "DELETE", t.cy, { endpoint: a.endpoint });
    expect(rowsOf(t.db)).toHaveLength(3);
    expect((await call(t.env, "/me/push-subscription", "DELETE", t.bo, { endpoint: a.endpoint })).status).toBe(200);
    expect(rowsOf(t.db)).toHaveLength(2);
  });

  it("caps devices per member", async () => {
    const t = await setup();
    for (let i = 0; i < 10; i += 1) await call(t.env, "/me/push-subscription", "PUT", t.bo, sub(await device("d" + i)));
    expect(rowsOf(t.db)).toHaveLength(8);
  });
});

describe("bag tag challenge pushes", () => {
  async function subscribed(t: Awaited<ReturnType<typeof setup>>) {
    const dev = { ada: await device("ada"), bo: await device("bo"), bo2: await device("bo2"), cy: await device("cy"), di: await device("di") };
    await call(t.env, "/me/push-subscription", "PUT", t.ada, sub(dev.ada));
    await call(t.env, "/me/push-subscription", "PUT", t.bo, sub(dev.bo));
    await call(t.env, "/me/push-subscription", "PUT", t.bo, sub(dev.bo2));
    await call(t.env, "/me/push-subscription", "PUT", t.cy, sub(dev.cy));
    await call(t.env, "/me/push-subscription", "PUT", t.di, sub(dev.di));
    return dev;
  }
  const challenge = (t: Awaited<ReturnType<typeof setup>>) =>
    call(t.env, "/bag-tags/challenges", "POST", t.cy, { leagueId: t.leagueId, defenderId: "m_bo", challengerScore: 48, defenderScore: 55 });

  it("a new league challenge reaches only the defender (all of their devices)", async () => {
    const t = await setup();
    const dev = await subscribed(t);
    const svc = pushService(Object.values(dev));
    const created = await challenge(t);
    expect(created.status).toBe(201);
    expect(svc.sent.map((s) => s.endpoint).sort()).toEqual([dev.bo.endpoint, dev.bo2.endpoint].sort());
    expect(svc.sent[0]!.payload).toEqual({
      kind: "member",
      title: "Cy challenged your #3 in Sunday Baggers",
      body: "Cy shot 48, you shot 55. Tap to confirm or decline.",
      url: "/gvdg-members.html#tags",
      tag: `bag-challenge:${created.data.challenge.id}`,
    });
  });

  it("confirm swaps notify only the challenger; a decline too", async () => {
    const t = await setup();
    const dev = await subscribed(t);
    const id = (await challenge(t)).data.challenge.id;
    const svc = pushService(Object.values(dev));
    expect((await call(t.env, `/bag-tags/challenges/${id}/confirm`, "POST", t.bo, {})).status).toBe(200);
    expect(svc.sent).toHaveLength(1);
    expect(svc.sent[0]!.endpoint).toBe(dev.cy.endpoint);
    expect(svc.sent[0]!.payload.title).toBe("Tags swapped in Sunday Baggers: you now hold #3");
    expect(svc.sent[0]!.payload.body).toBe("Bo confirmed your challenge, 48 to 55. Bo takes #4.");

    const t2 = await setup();
    const dev2 = await subscribed(t2);
    const id2 = (await challenge(t2)).data.challenge.id;
    const svc2 = pushService(Object.values(dev2));
    expect((await call(t2.env, `/bag-tags/challenges/${id2}/decline`, "POST", t2.bo, {})).status).toBe(200);
    expect(svc2.sent.map((s) => s.endpoint)).toEqual([dev2.cy.endpoint]);
    expect(svc2.sent[0]!.payload.title).toBe("Bo declined your challenge in Sunday Baggers");
  });

  it("when tags stay, the challenger hears so", async () => {
    const t = await setup();
    const dev = await subscribed(t);
    const id = (await call(t.env, "/bag-tags/challenges", "POST", t.cy, { leagueId: t.leagueId, defenderId: "m_bo", challengerScore: 60, defenderScore: 55 })).data.challenge.id;
    const svc = pushService(Object.values(dev));
    await call(t.env, `/bag-tags/challenges/${id}/confirm`, "POST", t.bo, {});
    expect(svc.sent).toHaveLength(1);
    expect(svc.sent[0]!.payload.title).toBe("Tags stay in Sunday Baggers: you keep #4");
  });

  it("an admin cancel notifies both members and nobody else", async () => {
    const t = await setup();
    const dev = await subscribed(t);
    const id = (await challenge(t)).data.challenge.id;
    const svc = pushService(Object.values(dev));
    expect((await call(t.env, `/admin/bag-tags/challenges/${id}/cancel`, "POST", t.admin, {})).status).toBe(200);
    expect(svc.sent.map((s) => s.endpoint).sort()).toEqual([dev.bo.endpoint, dev.bo2.endpoint, dev.cy.endpoint].sort());
    expect(svc.sent[0]!.payload.title).toBe("Challenge cancelled in Sunday Baggers");
  });

  it("a UDisc refresh expires open challenges and tells both members", async () => {
    const t = await setup();
    const dev = await subscribed(t);
    await challenge(t);
    const svc = pushService(Object.values(dev));
    await saveUdiscLeague(t.env, "udisc-refresh", board(ORDER, "2026-11-15") as never);
    expect(svc.sent.map((s) => s.endpoint).sort()).toEqual([dev.bo.endpoint, dev.bo2.endpoint, dev.cy.endpoint].sort());
    expect(svc.sent[0]!.payload).toMatchObject({
      title: "Your Sunday Baggers challenge expired",
      body: "The ladder was refreshed from UDisc.",
    });
    // A second refresh with nothing open sends nothing.
    svc.sent.length = 0;
    await saveUdiscLeague(t.env, "udisc-refresh", board(ORDER, "2026-11-22") as never);
    expect(svc.sent).toHaveLength(0);
  });

  it("respects the preference, missing subscriptions and missing VAPID keys", async () => {
    const t = await setup();
    const dev = await subscribed(t);
    await call(t.env, "/me/push-subscription", "PUT", t.bo, sub(dev.bo, { bagTags: false }));
    const svc = pushService(Object.values(dev));
    await challenge(t);
    expect(svc.fn).not.toHaveBeenCalled();

    const none = await setup();
    const svc2 = pushService([]);
    expect((await challenge(none)).status).toBe(201);
    expect(svc2.fn).not.toHaveBeenCalled();

    const nokeys = await setup({ keys: false });
    const svc3 = pushService([]);
    expect((await challenge(nokeys)).status).toBe(201);
    expect(svc3.fn).not.toHaveBeenCalled();
  });

  it("drops a device the push service reports gone (404/410), keeps the rest", async () => {
    const t = await setup();
    const dev = await subscribed(t);
    const svc = pushService(Object.values(dev), { [dev.bo.endpoint]: 410 });
    await challenge(t);
    expect(rowsOf(t.db).map((r: any) => r.endpoint)).not.toContain(dev.bo.endpoint);
    expect(rowsOf(t.db).map((r: any) => r.endpoint)).toContain(dev.bo2.endpoint);
    expect(svc.sent.map((s) => s.endpoint)).toEqual([dev.bo2.endpoint]);
    vi.unstubAllGlobals();
    pushService(Object.values(dev), { [dev.bo2.endpoint]: 404 });
    const id = (await call(t.env, "/bag-tags/mine", "GET", t.bo)).data.leagues[0].challenges[0].id;
    await call(t.env, `/bag-tags/challenges/${id}/decline`, "POST", t.bo, {});
    expect(rowsOf(t.db).filter((r: any) => r.member_id === "m_bo")).toHaveLength(1);
  });

  it("challenge flows still succeed when push throws", async () => {
    const t = await setup();
    const dev = await subscribed(t);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const created = await challenge(t);
    expect(created.status).toBe(201);
    const id = created.data.challenge.id;
    expect((await call(t.env, `/bag-tags/challenges/${id}/confirm`, "POST", t.bo, {})).status).toBe(200);
    const id2 = (await call(t.env, "/bag-tags/challenges", "POST", t.di, { leagueId: t.leagueId, defenderId: "m_cy", challengerScore: 1, defenderScore: 2 })).data.challenge.id;
    expect((await call(t.env, `/admin/bag-tags/challenges/${id2}/cancel`, "POST", t.admin, {})).status).toBe(200);
    await expect(saveUdiscLeague(t.env, "udisc-refresh", board(ORDER, "2026-11-15") as never)).resolves.toBeTruthy();
    void dev;
  });

  it("club series challenges notify the right member", async () => {
    const t = await setup();
    const dev = await subscribed(t);
    const created = await call(t.env, "/admin/bag-tags/series", "POST", t.admin, { name: "Club bag tags", season: "2026" });
    const seriesId = created.data.series.id;
    await call(t.env, "/admin/bag-tags/assign", "POST", t.admin, { seriesId, memberId: "m_ada", tagNumber: 1 });
    await call(t.env, "/admin/bag-tags/assign", "POST", t.admin, { seriesId, memberId: "m_di", tagNumber: 7 });
    const svc = pushService(Object.values(dev));
    const made = await call(t.env, "/bag-tags/challenges", "POST", t.di, { defenderId: "m_ada", challengerScore: 50, defenderScore: 60 });
    expect(made.status).toBe(201);
    expect(svc.sent.map((s) => s.endpoint)).toEqual([dev.ada.endpoint]);
    expect(svc.sent[0]!.payload.title).toBe("Di challenged your #1");
    svc.sent.length = 0;
    await call(t.env, `/admin/bag-tags/challenges/${made.data.challenge.id}/confirm`, "POST", t.admin, {});
    expect(svc.sent.map((s) => s.endpoint).sort()).toEqual([dev.ada.endpoint, dev.di.endpoint].sort());
  });

  it("rejects private/loopback/metadata push endpoints on subscribe and skips them when sending", async () => {
    const t = await setup();
    const d = await device("ssrf");
    for (const badEndpoint of [
      "https://127.0.0.1/push",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/push",
      "https://[::1]/push",
      "https://internal/push",
      "https://phone.local/push",
    ]) {
      const res = await call(t.env, "/me/push-subscription", "PUT", t.bo, { endpoint: badEndpoint, keys: d.keys });
      expect(res.status, badEndpoint).toBe(400);
      expect(res.data.error, badEndpoint).toBe("invalid_subscription");
    }
    await t.db.raw.prepare(
      "INSERT INTO member_push_subscriptions (endpoint, member_id, p256dh, auth, bag_tags, messages) VALUES (?, 'm_ada', ?, ?, 1, 1)",
    ).run("https://127.0.0.1/ssrf", d.keys.p256dh, d.keys.auth);
    const svc = pushService([]);
    const { sendMemberPush } = await import("../src/member-push.js");
    await sendMemberPush(t.env, ["m_ada"], "bagTags", { title: "Hi", body: "Test", url: "/gvdg-members.html", tag: "test" });
    expect(svc.fn).not.toHaveBeenCalled();
  });
});
