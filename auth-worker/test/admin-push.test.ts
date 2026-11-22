import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { notifyNewOrder } from "../src/order-notify.js";
import { sendAdminPush } from "../src/admin-push.js";
import { b64url, encryptWebPush, fromB64url } from "../src/web-push.js";
import { signSession } from "../src/jwt.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const text = new TextEncoder();
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

afterEach(() => vi.unstubAllGlobals());

function member(memberId: string, name: string, isAdmin = false) {
  return JSON.stringify({ memberId, name, isAdmin, pinHash: "x", mustChangePin: false });
}

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async () => ({ keys: [], list_complete: true }),
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all() {
          return { results: db.prepare(sql).all(...(bound as never[])), success: true };
        },
        async first() {
          return db.prepare(sql).get(...(bound as never[])) ?? null;
        },
        async run() {
          const info = db.prepare(sql).run(...(bound as never[]));
          return { results: [], success: true, meta: { changes: info.changes } };
        },
      };
      return stmt;
    },
  };
}

async function vapidPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateRaw = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { publicKey: b64url(publicRaw), privateKey: b64url(privateRaw), publicRaw, privateRaw };
}

async function subscriber() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, publicRaw, auth, p256dh: b64url(publicRaw), authKey: b64url(auth) };
}

function envOf(db: unknown, extra: Record<string, string> = {}): Env {
  return {
    ROSTER: kv({
      "member:m_admin": member("m_admin", "Admin", true),
      "member:m_ace": member("m_ace", "Ace"),
      "member:m_two": member("m_two", "Two"),
    }),
    RATELIMIT: kv({}),
    DB: db,
    JWT_SECRET: SECRET,
    SESSION_TTL_SEC: "900",
    ALLOWED_ORIGINS: ORIGIN,
    ...extra,
  } as unknown as Env;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    bytes * 8,
  ));
}

async function decryptPush(body: Uint8Array, clientPrivate: CryptoKey, clientPublic: Uint8Array, authSecret: Uint8Array) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const salt = body.slice(0, 16);
  const idlen = body[20] ?? 0;
  const senderPub = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const sender = await crypto.subtle.importKey("raw", senderPub as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, clientPrivate, 256));
  const ikm = await hkdf(authSecret, shared, concat(text.encode("WebPush: info\0"), clientPublic, senderPub), 32);
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["decrypt"]);
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aes, cipher as BufferSource));
  let end = clear.length;
  while (end > 0 && clear[end - 1] === 0) end -= 1;
  if (end < 1 || (clear[end - 1] !== 2 && clear[end - 1] !== 1)) throw new Error("bad padding");
  return { clear: clear.slice(0, end - 1), rs: view.getUint32(16), idlen };
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("web push encryption", () => {
  it("round-trips a payload and builds a verifiable VAPID token", async () => {
    const sub = await subscriber();
    const message = text.encode("{\"title\":\"Bag tag request\"}");
    const body = await encryptWebPush(message, sub.publicRaw, sub.auth);
    const decoded = await decryptPush(body, sub.pair.privateKey, sub.publicRaw, sub.auth);
    expect(decoded.rs).toBe(4096);
    expect(decoded.idlen).toBe(65);
    expect(decode(decoded.clear)).toBe("{\"title\":\"Bag tag request\"}");

    const keys = await vapidPair();
    const env = envOf(await sqliteDb(), { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
    await env.DB.prepare(
      "INSERT INTO admin_push_subscriptions (endpoint, member_id, p256dh, auth) VALUES (?, ?, ?, ?)",
    ).bind("https://push.example.test/admin", "m_admin", sub.p256dh, sub.authKey).run();
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(null, { status: 201 });
    }));
    await sendAdminPush(env, {
      title: "Bag tag request",
      body: "Ace asked for a bag tag.",
      url: "/admin.html?tab=bag-tags",
      tag: "bag-tag:m_ace",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://push.example.test/admin");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("86400");
    const authz = headers.Authorization;
    expect(authz?.startsWith("vapid t=")).toBe(true);
    const token = authz!.slice("vapid t=".length).split(", k=")[0]!;
    const [h, p, sig] = token.split(".");
    const claims = JSON.parse(decode(fromB64url(p!)!)) as { aud: string; sub: string };
    expect(claims.aud).toBe("https://push.example.test");
    expect(claims.sub).toBe("mailto:greenvillediscgolf@gmail.com");
    const verifyKey = await crypto.subtle.importKey("raw", keys.publicRaw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      fromB64url(sig!)! as BufferSource,
      text.encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
    const pushed = seen[0]!.init.body as Uint8Array;
    const note = JSON.parse(decode((await decryptPush(pushed, sub.pair.privateKey, sub.publicRaw, sub.auth)).clear));
    expect(note).toMatchObject({
      title: "Bag tag request",
      url: "/admin.html?tab=bag-tags",
      tag: "bag-tag:m_ace",
    });
  });

  it("drops a subscription the push service no longer accepts", async () => {
    const sub = await subscriber();
    const keys = await vapidPair();
    const env = envOf(await sqliteDb(), { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
    await env.DB.prepare(
      "INSERT INTO admin_push_subscriptions (endpoint, member_id, p256dh, auth) VALUES (?, ?, ?, ?)",
    ).bind("https://push.example.test/gone", "m_admin", sub.p256dh, sub.authKey).run();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 410 })));
    await sendAdminPush(env, { title: "New shop order", body: "Order #1", url: "/admin.html?tab=orders", tag: "shop-order-1" });
    const left = await env.DB.prepare("SELECT endpoint FROM admin_push_subscriptions").all<{ endpoint: string }>();
    expect(left.results).toEqual([]);
  });

  it("does not touch the network when VAPID keys are missing", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await sendAdminPush({} as Env, { title: "x", body: "y", url: "/admin.html", tag: "t" });
    await notifyNewOrder({} as Env, { id: 3, member_name: "Ada" }, []);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("admin push routes", () => {
  async function token(sub: string) {
    return signSession({ sub, mustChangePin: false }, SECRET, 900);
  }

  async function call(env: Env, path: string, method = "GET", bearer?: string, body?: unknown, ctx?: ExecutionContext) {
    const headers: Record<string, string> = { Origin: ORIGIN };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const jobs: Promise<unknown>[] = [];
    const response = await worker.fetch(new Request("https://worker.example" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, ctx ?? { waitUntil(job) { jobs.push(job); } } as ExecutionContext);
    await Promise.all(jobs);
    const data: any = await response.json().catch(() => null);
    return { status: response.status, data };
  }

  it("lets an admin subscribe and unsubscribe, and refuses a phone that is not https", async () => {
    const db = await sqliteDb();
    const plain = envOf(db);
    const admin = await token("m_admin");
    const ace = await token("m_ace");
    expect((await call(plain, "/admin/push")).status).toBe(401);
    expect((await call(plain, "/admin/push", "GET", ace)).status).toBe(403);
    expect((await call(plain, "/admin/push", "GET", admin)).data).toEqual({
      configured: false,
      publicKey: null,
      subscribed: false,
    });
    const sub = await subscriber();
    const body = { endpoint: "https://push.example.test/phone", keys: { p256dh: sub.p256dh, auth: sub.authKey } };
    expect((await call(plain, "/admin/push", "POST", admin, body)).data.error).toBe("push_unconfigured");

    const keys = await vapidPair();
    const env = envOf(db, { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
    expect((await call(env, "/admin/push", "POST", admin, { endpoint: "http://push.example.test/x", keys: body.keys })).status).toBe(400);
    expect((await call(env, "/admin/push", "POST", admin, body)).status).toBe(200);
    expect((await call(env, "/admin/push", "GET", admin)).data).toMatchObject({
      configured: true,
      publicKey: keys.publicKey,
      subscribed: true,
    });
    expect((await call(env, "/admin/push", "DELETE", ace, { endpoint: body.endpoint })).status).toBe(403);
    expect((await call(env, "/admin/push", "DELETE", admin, { endpoint: "https://push.example.test/other" })).status).toBe(200);
    expect((await call(env, "/admin/push", "GET", admin)).data.subscribed).toBe(true);
    expect((await call(env, "/admin/push", "DELETE", admin, { endpoint: body.endpoint })).status).toBe(200);
    expect((await call(env, "/admin/push", "GET", admin)).data.subscribed).toBe(false);
  });

  it("alerts once for a new bag tag request, again for a challenge, and still for an order with email off", async () => {
    const db = await sqliteDb();
    const sub = await subscriber();
    const keys = await vapidPair();
    const env = envOf(db, { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
    await env.DB.prepare(
      "INSERT INTO admin_push_subscriptions (endpoint, member_id, p256dh, auth) VALUES (?, ?, ?, ?)",
    ).bind("https://push.example.test/admin", "m_admin", sub.p256dh, sub.authKey).run();
    const seen: { body: Uint8Array }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ body: init.body as Uint8Array });
      return new Response(null, { status: 201 });
    }));
    const admin = await token("m_admin");
    const ace = await token("m_ace");
    const two = await token("m_two");
    const created = await call(env, "/admin/bag-tags/series", "POST", admin, { name: "Club bag tags", season: "2026" });
    const seriesId = created.data.series.id;
    const asked = await call(env, "/bag-tags/request", "POST", ace, {});
    expect(asked.status).toBe(201);
    const again = await call(env, "/bag-tags/request", "POST", ace, {});
    expect(again.status).toBe(200);
    expect(seen).toHaveLength(1);
    const first = JSON.parse(decode((await decryptPush(seen[0]!.body, sub.pair.privateKey, sub.publicRaw, sub.auth)).clear));
    expect(first).toMatchObject({ title: "Bag tag request", url: "/admin.html?tab=bag-tags", tag: "bag-tag:m_ace" });

    await call(env, "/admin/bag-tags/assign", "POST", admin, { seriesId, memberId: "m_ace", tagNumber: 1 });
    await call(env, "/admin/bag-tags/assign", "POST", admin, { seriesId, memberId: "m_two", tagNumber: 2 });
    const challenge = await call(env, "/bag-tags/challenges", "POST", two, {
      defenderId: "m_ace",
      challengerScore: 50,
      defenderScore: 60,
    });
    expect(challenge.status).toBe(201);
    expect(seen).toHaveLength(2);
    const second = JSON.parse(decode((await decryptPush(seen[1]!.body, sub.pair.privateKey, sub.publicRaw, sub.auth)).clear));
    expect(second.title).toBe("Bag tag challenge");
    expect(second.url).toBe("/admin.html?tab=bag-tags");

    await notifyNewOrder(env, { id: 9, member_name: "Ada", total_cents: 500 }, []);
    expect(seen).toHaveLength(3);
    const third = JSON.parse(decode((await decryptPush(seen[2]!.body, sub.pair.privateKey, sub.publicRaw, sub.auth)).clear));
    expect(third).toMatchObject({ title: "New shop order", url: "/admin.html?tab=orders", tag: "shop-order-9" });
  });

  it("rejects private/loopback/metadata push endpoints on subscribe and skips them when sending", async () => {
    const db = await sqliteDb();
    const sub = await subscriber();
    const keys = await vapidPair();
    const env = envOf(db, { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
    const admin = await token("m_admin");
    for (const badEndpoint of [
      "https://127.0.0.1/push",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/push",
      "https://[::1]/push",
      "https://internal/push",
      "https://push.local/push",
    ]) {
      const res = await call(env, "/admin/push", "POST", admin, { endpoint: badEndpoint, keys: { p256dh: sub.p256dh, auth: sub.authKey } });
      expect(res.status, badEndpoint).toBe(400);
      expect(res.data.error, badEndpoint).toBe("invalid_subscription");
    }
    await env.DB.prepare(
      "INSERT INTO admin_push_subscriptions (endpoint, member_id, p256dh, auth) VALUES (?, ?, ?, ?)",
    ).bind("https://169.254.169.254/latest", "m_admin", sub.p256dh, sub.authKey).run();
    const fetched = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetched);
    await notifyNewOrder(env, { id: 10, member_name: "Ada", total_cents: 500 }, []);
    expect(fetched).not.toHaveBeenCalled();
    const remaining = await env.DB.prepare("SELECT endpoint FROM admin_push_subscriptions").all<{ endpoint: string }>();
    expect(remaining.results).toEqual([]);
  });
});
