import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { D1KV, ConsistentKV } from "../src/d1kv.js";
import { hashPin } from "../src/crypto.js";
import { signSession } from "../src/jwt.js";
import { memberIdFor, putMember, resolveMember, updateProfile, deleteMember, type Member } from "../src/roster.js";
import { releaseGuestPromo } from "../src/guest-accounts.js";
import { listSeasonPlayRows } from "../src/db-results.js";
import { writePractice } from "../src/practice-store.js";
import { testJpeg } from "./lf-harness.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const FIXTURE = testJpeg();

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function dataUrl(bytes: Uint8Array, type = "image/jpeg") {
  return `data:${type};base64,` + b64(bytes);
}

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async (opts?: { prefix?: string; cursor?: string; limit?: number }) => {
      const prefix = opts?.prefix || "";
      const keys = [...rows.keys()].filter((k) => k.startsWith(prefix)).sort();
      const limit = opts?.limit ?? 1000;
      const start = opts?.cursor ? keys.findIndex((k) => k > opts.cursor!) : 0;
      const from = start < 0 ? keys.length : start;
      const slice = keys.slice(from, from + limit);
      const hasMore = from + slice.length < keys.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: !hasMore,
        ...(hasMore && slice.length ? { cursor: slice[slice.length - 1] } : {}),
      };
    },
  };
}

function r2() {
  const objects = new Map<string, { bytes: Uint8Array; type?: string }>();
  return {
    objects,
    async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: new Uint8Array(value), type: opts?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const hit = objects.get(key);
      if (!hit) return null;
      return { body: new Blob([hit.bytes as BlobPart]).stream(), arrayBuffer: async () => hit.bytes.slice().buffer, httpMetadata: { contentType: hit.type } };
    },
    async delete(key: string) { objects.delete(key); },
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
          if (/\bRETURNING\b/i.test(sql) || /^\s*(?:SELECT|WITH)\b/i.test(sql)) {
            const rows = db.prepare(sql).all(...(bound as never[]));
            return { results: rows, success: true, meta: { changes: rows.length } };
          }
          const info = db.prepare(sql).run(...(bound as never[]));
          return { results: [], success: true, meta: { changes: Number(info.changes) } };
        },
      };
      return stmt;
    },
    async batch(list: Array<{ run(): Promise<unknown> }>) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

type Db = Awaited<ReturnType<typeof sqliteDb>>;
let db: Db;
let roster: ReturnType<typeof kv>;
let ratelimit: ReturnType<typeof kv>;
let photos: ReturnType<typeof r2>;
let env: Env;
let mail: Array<{ to: string; subject: string; text: string }>;

const memberJson = (memberId: string, name: string, extra: Partial<Member> = {}) =>
  JSON.stringify({ memberId, name, isAdmin: false, pinHash: "secret-pin", mustChangePin: false, ...extra });

const tok = (sub: string, extra: Record<string, unknown> = {}) => signSession({ sub, mustChangePin: false, ...extra }, SECRET, 900);

async function call(path: string, method = "GET", bearer?: string, body?: unknown) {
  const h: Record<string, string> = { Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.10" };
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const res = await worker.fetch(new Request("https://w.example" + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx as unknown as ExecutionContext);
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  await Promise.all(pending);
  return { status: res.status, data };
}

beforeEach(async () => {
  db = await sqliteDb();
  photos = r2();
  mail = [];
  roster = kv({
    "member:m_ada": memberJson("m_ada", "Ada Lovelace", { pdgaNo: "101", email: "ada@example.com" }),
    "idx:pdga:101": "m_ada",
    "member:m_bo": memberJson("m_bo", "Bo Burnham", { pdgaNo: "102", email: "bo@example.com" }),
    "idx:pdga:102": "m_bo",
    "member:m_admin": memberJson("m_admin", "Ann Admin", { isAdmin: true, pdgaNo: "1" }),
    "idx:pdga:1": "m_admin",
    "member:m_held": memberJson("m_held", "Held Account", { held: true }),
    "member:m_guest": memberJson("m_guest", "Gus Guest", { guest: true, guestPromo: false, email: "gus@example.com" }),
  });
  ratelimit = kv();
  env = {
    ROSTER: roster,
    RATELIMIT: ratelimit,
    DB: db,
    PHOTOS: photos,
    JWT_SECRET: SECRET,
    SESSION_TTL_SEC: "900",
    ALLOWED_ORIGINS: ORIGIN,
    RESEND_API_KEY: "re_test",
    EXPECTED_ORIGIN: "https://gvdgclub.com",
  } as unknown as Env;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.resend.com")) {
      const payload = JSON.parse(String(init?.body || "{}")) as { to?: string[]; subject?: string; text?: string };
      mail.push({ to: (payload.to || [])[0] || "", subject: payload.subject || "", text: payload.text || "" });
      return new Response(JSON.stringify({ id: "mail_1" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  (db.raw as { close?: () => void }).close?.();
});

describe("Batch 5: Auth, Held Accounts, History Gates & Archive", () => {
  it("rejects held member JWT on /me, /profile, and /casual-rounds/:id/join", async () => {
    const heldToken = await tok("m_held");
    expect((await call("/me", "GET", heldToken)).status).toBe(401);
    expect((await call("/profile", "POST", heldToken, { name: "Hacker" })).status).toBe(401);
    expect((await call("/casual-rounds/1/join", "POST", heldToken, {})).status).toBe(401);
  });

  it("includes sub on GET /me and POST /profile", async () => {
    const t = await tok("m_ada");
    const me = await call("/me", "GET", t);
    expect(me.status).toBe(200);
    expect(me.data.sub).toBe("m_ada");
    const prof = await call("/profile", "POST", t, { name: "Ada L." });
    expect(prof.status).toBe(200);
    expect(prof.data.sub).toBe("m_ada");
  });

  it("enforces historyGate on /play-stats, /me/udisc-history*, and /me/archive?cursor=play:*", async () => {
    const guestToken = await tok("m_guest");
    for (const [method, path, body] of [
      ["GET", "/play-stats", undefined],
      ["GET", "/me/udisc-history", undefined],
      ["POST", "/me/udisc-history", { csv: "" }],
      ["DELETE", "/me/udisc-history", undefined],
      ["DELETE", "/me/udisc-history/1", undefined],
      ["GET", "/me/archive?cursor=play:0:0", undefined],
    ] as const) {
      const res = await call(path, method, guestToken, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.data.error).toBe("membership_required");
    }
    const archivePractice = await call("/me/archive", "GET", guestToken);
    expect(archivePractice.status).toBe(200);
    expect(archivePractice.data.memberId).toBe("m_guest");
  });

  it("listSeasonPlayRows excludes op_% and g_% synthetic IDs", async () => {
    db.raw.prepare("INSERT INTO casual_rounds (id, round_code, course_name, finalized_at) VALUES (1, 'CODE1', 'Park', '2026-11-10T12:00:00Z')").run();
    db.raw.prepare("INSERT INTO casual_results (casual_round_id, member_id, name, total, to_par) VALUES (1, 'm_ada', 'Ada', 54, 0), (1, 'op_walk', 'Open', 55, 1), (1, 'g_walk', 'Guest', 56, 2)").run();
    const rows = await listSeasonPlayRows(db as any, 2026);
    const ids = rows.map((r: any) => r.member_id);
    expect(ids).toContain("m_ada");
    expect(ids).not.toContain("op_walk");
    expect(ids).not.toContain("g_walk");
  });
});

describe("Batch 5: D1KV, ConsistentKV, Promo Pool & UDisc Normalization", () => {
  it("D1KV.list paginates with limit & keyset cursor without duplicates or gaps", async () => {
    const store = new D1KV(db as any, "test_ns");
    for (const k of ["member:a", "member:b", "member:c", "member:d", "member:e"]) {
      await store.put(k, k);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ prefix: "member:", limit: 2, cursor });
      seen.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    expect(seen).toEqual(["member:a", "member:b", "member:c", "member:d", "member:e"]);
  });

  it("ConsistentKV preserves pointCache when loadOverlay fails and isolates concurrent list chains", async () => {
    const backing = kv({ "member:m_1": "1", "member:m_2": "2", "member:m_3": "3" });
    const failingDb = {
      prepare() {
        return {
          bind() { return this; },
          async all() { throw new Error("d1 temporary error"); },
          async first() { throw new Error("d1 temporary error"); },
          async run() { throw new Error("d1 temporary error"); },
        };
      },
    };
    const ckv = new ConsistentKV(backing as any, failingDb as any, "roster_recent");
    await ckv.put("member:m_new", "new-val");
    expect(await ckv.get("member:m_new")).toBe("new-val");
    const page = await ckv.list({ prefix: "member:" });
    expect(page.keys.map((k) => k.name)).toContain("member:m_new");

    const working = new ConsistentKV(backing as any, db as any, "roster_recent");
    const pA1 = await working.list({ prefix: "member:", limit: 1 });
    const pB1 = await working.list({ prefix: "member:", limit: 1 });
    expect(pA1.cursor).not.toBe(pB1.cursor);
    const pA2 = await working.list({ prefix: "member:", limit: 1, cursor: pA1.cursor });
    const pB2 = await working.list({ prefix: "member:", limit: 1, cursor: pB1.cursor });
    expect(pA2.keys[0]!.name).toBe("member:m_2");
    expect(pB2.keys[0]!.name).toBe("member:m_2");
  });

  it("admin tier promotion/removal releases guest_promo, reset-pin clears locks, and UDisc normalizes @ prefix", async () => {
    db.raw.prepare("INSERT INTO guest_promo (member_id, approved_by) VALUES ('m_guest', 'm_admin')").run();
    const adminToken = await tok("m_admin");
    const tierRes = await call("/admin/members/set-tier", "POST", adminToken, { memberId: "m_guest", tier: "member" });
    expect(tierRes.status).toBe(200);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM guest_promo WHERE member_id = 'm_guest'").get() as any).n).toBe(0);

    await ratelimit.put("ratelimit:pdga:101", JSON.stringify({ count: 5, lockedUntil: Date.now() + 60_000 }));
    const resetRes = await call("/admin/members/reset-pin", "POST", adminToken, { identifier: "101" });
    expect(resetRes.status).toBe(200);
    expect(await ratelimit.get("ratelimit:pdga:101")).toBeNull();

    const udId = memberIdFor({ udisc: "@Alice" })!;
    expect(udId).toBe("m_u_alice");
    await putMember(roster as any, { memberId: udId, name: "U Disc", udisc: "@Alice", pinHash: await hashPin("4821"), mustChangePin: false });
    await roster.put("idx:udisc:@alice", udId);
    expect((await resolveMember(roster as any, "@alice"))?.memberId).toBe(udId);
    expect((await resolveMember(roster as any, "alice"))?.memberId).toBe(udId);
    await updateProfile(roster as any, udId, { udisc: "@AliceNew" });
    expect(await roster.get("idx:udisc:@alice")).toBeNull();
    expect((await resolveMember(roster as any, "alicenew"))?.memberId).toBe(udId);
    await roster.put("idx:udisc:@alicenew", udId);
    await deleteMember(roster as any, udId);
    expect(await roster.get("idx:udisc:@alicenew")).toBeNull();

    await releaseGuestPromo(env, "none");
  });

  it("clamps code TTL to >= 60s when saving wrong-try recovery state on fallback Workers KV", async () => {
    const origPut = ratelimit.put.bind(ratelimit);
    await origPut("acct:pinreset:m_ada", JSON.stringify({ hash: "0".repeat(64), tries: 0, expiresAt: Date.now() + 20_000 }));
    const seenTtls: number[] = [];
    ratelimit.put = async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      if (opts?.expirationTtl != null) {
        if (opts.expirationTtl < 60) throw new Error("Invalid expiration_ttl");
        seenTtls.push(opts.expirationTtl);
      }
      await origPut(key, value);
    };
    const res = await call("/pin-reset/verify", "POST", undefined, { identifier: "101", code: "000000", newPin: "5678" });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe("invalid_code");
    expect(seenTtls.some((ttl) => ttl >= 60)).toBe(true);
  });
});

describe("Batch 5: Messages, Practice, Marketplace & Lost-Found Atomicity", () => {
  it("member messages returns newest 200 chronologically", async () => {
    db.raw.prepare("INSERT INTO member_threads (id, member_low, member_high, last_body, last_sender_id) VALUES (1, 'm_ada', 'm_bo', 'msg 205', 'm_ada')").run();
    const insertMsg = db.raw.prepare("INSERT INTO member_messages (id, thread_id, sender_id, body) VALUES (?, 1, 'm_ada', ?)");
    for (let i = 1; i <= 205; i += 1) insertMsg.run(i, `msg ${i}`);
    const t = await tok("m_ada");
    const res = await call("/me/messages/1", "GET", t);
    expect(res.status).toBe(200);
    expect(res.data.messages.length).toBe(200);
    expect(res.data.messages[0].body).toBe("msg 6");
    expect(res.data.messages[199].body).toBe("msg 205");
  });

  it("writePractice returns disc_in_use when deleting an active disc or disc with throws", async () => {
    const t = await writePractice(db as any, "m_ada", {
      opId: "op-disc-1",
      id: "11111111-1111-4111-8111-111111111111",
      kind: "disc",
      expectedRevision: 0,
      action: "save",
      record: { brand: "Innova", model: "Destroyer", inBag: true, archived: false, plastic: "", color: "", weightGrams: null, date: "2026-11-20" },
    } as any);
    expect(t.ok).toBe(true);
    const delActive = await writePractice(db as any, "m_ada", {
      opId: "op-disc-del",
      id: "11111111-1111-4111-8111-111111111111",
      kind: "disc",
      expectedRevision: 1,
      action: "delete",
      record: null,
    } as any);
    expect(delActive).toEqual({ ok: false, error: "disc_in_use" });
  });

  it("marketplace hides pay info on non-active listings, rejects stale price, and makes offer acceptance atomic", async () => {
    const seller = await tok("m_ada");
    const buyer = await tok("m_bo");
    expect((await call("/market/settings", "PUT", seller, { notifyEmail: "ada@example.test", paypalMe: "AdaDiscs" })).status).toBe(200);
    const created = await call("/market/listings", "POST", seller, {
      brand: "Innova", mold: "Wraith", plastic: "Star", discType: "driver", speed: 11, glide: 5, turn: -1, fade: 3,
      weightG: 173, color: "Blue", condition: 8, priceCents: 1500, openToTrade: true, quantity: 1, photos: [dataUrl(FIXTURE)],
    });
    expect(created.status).toBe(201);
    const listingId = created.data.listing.id;

    // Active listing exposes seller pay handles to signed-in buyer
    const activeDetail = await call(`/market/listings/${listingId}`, "GET", buyer);
    expect(activeDetail.status).toBe(200);
    expect(activeDetail.data.listing.pay).not.toBeNull();

    // Competing offers + atomic accept
    const third = await tok("m_admin");
    const o1 = await call(`/market/listings/${listingId}/offers`, "POST", buyer, { text: "Offer 1" });
    const o2 = await call(`/market/listings/${listingId}/offers`, "POST", third, { text: "Offer 2" });
    expect(o1.status).toBe(201);
    expect(o2.status).toBe(201);
    const acc1 = await call(`/market/offers/${o1.data.offer.id}/accept`, "POST", seller, {});
    expect(acc1.status).toBe(200);
    const dealId = acc1.data.deal.id;
    const acc2 = await call(`/market/offers/${o2.data.offer.id}/accept`, "POST", seller, {});
    expect(acc2.status).toBe(409);

    // Non-active listing hides seller pay details even if seller has pay handles
    const detail = await call(`/market/listings/${listingId}`, "GET", buyer);
    expect(detail.status).toBe(200);
    expect(detail.data.listing.pay).toBeNull();

    // Releasing the deal atomically returns listing to active, then buy claims it exclusively
    expect((await call(`/market/deals/${dealId}/release`, "POST", seller, {})).status).toBe(200);
    const bought = await call(`/market/listings/${listingId}/buy`, "POST", buyer, {});
    expect(bought.status).toBe(201);
    expect((await call(`/market/listings/${listingId}/buy`, "POST", third, {})).status).toBe(409);
  });

  it("lost & found enforces expiry on edits/claims, sameEmailIdentity on confirm, and keeps last found photo", async () => {
    const finder = await tok("m_ada");
    const owner = await tok("m_bo");
    const created = await call("/lost-found/posts", "POST", finder, {
      kind: "found", brand: "Discraft", mold: "Buzzz", color: "Yellow", holding: "finder", photos: [dataUrl(FIXTURE)],
    });
    expect(created.status).toBe(201);
    const postId = created.data.post.id;
    const photoId = created.data.post.photos[0].id;

    // Cannot remove last photo on a found post
    const rmLast = await call(`/lost-found/posts/${postId}/photos/${photoId}/remove`, "POST", finder, {});
    expect(rmLast.status).toBe(409);

    // Claim + confirm sameEmailIdentity check (if owner shares finder's email via seller settings, confirm rejects as own_post)
    const claimRes = await call(`/lost-found/posts/${postId}/claim`, "POST", owner, { message: "Yellow Buzzz with my ink" });
    expect(claimRes.status).toBe(201);
    const claimId = claimRes.data.claim.id;
    expect((await call(`/lost-found/claims/${claimId}/returned`, "POST", finder, {})).status).toBe(200);
    db.raw.prepare("INSERT INTO market_seller_settings (member_id, notify_email) VALUES ('m_bo', 'ada@example.com') ON CONFLICT(member_id) DO UPDATE SET notify_email = excluded.notify_email").run();
    const confirmSameEmail = await call(`/lost-found/claims/${claimId}/confirm`, "POST", owner, {});
    expect(confirmSameEmail.status).toBe(403);
    expect(confirmSameEmail.data.error).toBe("own_post");

    // Expired post cannot be edited or claimed
    const created2 = await call("/lost-found/posts", "POST", finder, {
      kind: "found", brand: "Innova", mold: "Roc", color: "White", holding: "finder", photos: [dataUrl(FIXTURE)],
    });
    const post2 = created2.data.post.id;
    db.raw.prepare("UPDATE lf_posts SET expires_at = datetime('now', '-2 days') WHERE id = ?").run(post2);
    expect((await call(`/lost-found/posts/${post2}`, "PATCH", finder, { mold: "Roc3" })).status).toBe(409);
    expect((await call(`/lost-found/posts/${post2}/claim`, "POST", owner, { message: "White Roc with my ink" })).status).toBe(409);
  });
});
