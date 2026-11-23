import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { putMember, type Member } from "../src/roster.js";
import { absorbHeld, findHeldMatch } from "../src/held-accounts.js";
import { giveTag } from "../src/db-bag-tags.js";
import { challengeNote } from "../src/bag-tag-notify.js";
import { reserveDues, recordPaypalDues, getDues } from "../src/membership-dues-db.js";
import { saveUdiscLeague } from "../src/udisc-league-save.js";
import { deleteLeague } from "../src/db-leagues.js";
import { relinkLeague } from "../src/bag-tag-leagues.js";
import { updateStoreOrderFulfillment } from "../src/shop-db.js";
import { parseUdiscHistory } from "../src/imports/udisc-history.js";
import { asIsoTimestamp } from "../src/input.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";

afterEach(() => vi.unstubAllGlobals());

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
      return { keys: keys.map((name) => ({ name })), list_complete: true };
    },
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  return {
    raw: db,
    prepare(sql: string) {
      let bound: unknown[] = [];
      const execSync = () => {
        if (/\bRETURNING\b/i.test(sql) || /^\s*(?:SELECT|WITH)\b/i.test(sql)) {
          const rows = db.prepare(sql).all(...(bound as never[]));
          return { results: rows, success: true, meta: { changes: rows.length, rows_written: rows.length } };
        }
        const info = db.prepare(sql).run(...(bound as never[]));
        return { results: [], success: true, meta: { changes: Number(info.changes), rows_written: Number(info.changes) } };
      };
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        execSync,
        async all() { return { results: db.prepare(sql).all(...(bound as never[])), success: true }; },
        async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
        async run() { return execSync(); },
      };
      return stmt;
    },
    async batch(list: Array<{ execSync?: () => unknown; run(): Promise<unknown> }>) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = [];
        for (const s of list) out.push(s.execSync ? s.execSync() : await s.run());
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

function makeEnv(db: Db, extra: Record<string, unknown> = {}) {
  const roster = kv({
    "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin One", isAdmin: true, pdgaNo: "1", pinHash: "h", mustChangePin: false }),
    "idx:pdga:1": "m_admin",
    "member:m_ada": JSON.stringify({ memberId: "m_ada", name: "Ada Lovelace", pdgaNo: "101", pinHash: "h", mustChangePin: false, memberThroughYear: 2027 }),
    "idx:pdga:101": "m_ada",
    "member:m_bo": JSON.stringify({ memberId: "m_bo", name: "Bo Burnham", pdgaNo: "102", pinHash: "h", mustChangePin: false, memberThroughYear: 2027 }),
    "idx:pdga:102": "m_bo",
    "member:m_cy": JSON.stringify({ memberId: "m_cy", name: "Cy Young", pdgaNo: "103", pinHash: "h", mustChangePin: false, memberThroughYear: 2027 }),
    "idx:pdga:103": "m_cy",
  });
  return {
    ROSTER: roster,
    RATELIMIT: kv(),
    DB: db,
    JWT_SECRET: SECRET,
    SESSION_TTL_SEC: "900",
    ALLOWED_ORIGINS: ORIGIN,
    ...extra,
  } as unknown as Env & { ROSTER: ReturnType<typeof kv> };
}

const tok = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);

async function call(env: Env, path: string, method = "GET", bearer?: string, body?: unknown) {
  const h: Record<string, string> = { Origin: ORIGIN, "CF-Connecting-IP": "198.51.100.42" };
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request("https://w.example" + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

describe("Batch 6: Pro Shop PayPal stock-before-capture, guest contact, idempotency & terminal cancel", () => {
  it("reserves stock before PayPal capture, handles concurrent capture without 502, restores stock on failure, and persists guest contact", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db, { PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec", PAYPAL_API_BASE: "https://pp.test" });
    db.raw.prepare("INSERT INTO store_products (id, category, name, price_cents, stock_qty, active) VALUES (1, 'disc', 'Buzzz', 1800, 1, 1), (2, 'disc', 'Zone', 1500, 2, 1)").run();

    let captureCount = 0;
    let captureDelay: (() => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/oauth2/token")) return Response.json({ access_token: "tok" });
      if (u.includes("/capture")) {
        captureCount += 1;
        if (captureDelay) {
          await new Promise<void>((resolve) => {
            const done = captureDelay!;
            captureDelay = null;
            setTimeout(() => { done(); resolve(); }, 10);
          });
        }
        return Response.json({ status: "COMPLETED", purchase_units: [{ payments: { captures: [{ status: "COMPLETED", amount: { value: "18.00", currency_code: "USD" } }] } }] });
      }
      if (u.includes("/v2/checkout/orders")) return Response.json({ id: "PP_ORDER_1" });
      return new Response("{}", { status: 404 });
    }));

    const created = await call(env, "/shop/pay/create-order", "POST", undefined, {
      name: "Walkup Buyer",
      contact: "walkup@example.com",
      items: [{ product_id: 1, quantity: 1 }],
    });
    expect(created.status).toBe(200);
    const sessionRow = db.raw.prepare("SELECT contact, status FROM store_payment_sessions WHERE paypal_order_id = 'PP_ORDER_1'").get() as any;
    expect(sessionRow).toEqual({ contact: "walkup@example.com", status: "pending" });

    // Backdate created_at (>10m old) and overlap both captures inside ppCaptureOrder: claim still serializes via captured_at (never re-claiming on created_at).
    db.raw.prepare("UPDATE store_payment_sessions SET created_at = datetime('now', '-30 minutes') WHERE paypal_order_id = 'PP_ORDER_1'").run();
    captureDelay = () => {};
    // Simulate concurrent captures on the same orderId: one wins (201), one cleanly rejects 409/200 without calling PayPal twice or returning 502.
    const [capA, capB] = await Promise.all([
      call(env, "/shop/pay/capture", "POST", undefined, { orderId: "PP_ORDER_1" }),
      call(env, "/shop/pay/capture", "POST", undefined, { orderId: "PP_ORDER_1" }),
    ]);
    expect([capA.status, capB.status].sort()).toEqual([201, 409].every((s) => [capA.status, capB.status].includes(s)) ? [201, 409] : [200, 201]);
    expect(captureCount).toBe(1);
    expect((db.raw.prepare("SELECT stock_qty FROM store_products WHERE id = 1").get() as any).stock_qty).toBe(0);
    const winner = capA.status === 201 ? capA : capB;
    expect(winner.data.order.admin_note).toBeUndefined(); // safeOrder strips contact from public response
    expect((db.raw.prepare("SELECT admin_note FROM store_orders WHERE payment_ref = 'PP_ORDER_1'").get() as any).admin_note).toBe("Contact: walkup@example.com");

    // Second PayPal session for sold-out product 1: stock check runs BEFORE calling ppCaptureOrder, so captureCount stays 1.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/oauth2/token")) return Response.json({ access_token: "tok" });
      if (u.includes("/capture")) { captureCount += 1; return Response.json({}); }
      if (u.includes("/v2/checkout/orders")) return Response.json({ id: "PP_ORDER_2" });
      return new Response("{}", { status: 404 });
    }));
    db.raw.prepare("INSERT INTO store_payment_sessions (paypal_order_id, member_id, member_name, items_json, total_cents, status) VALUES ('PP_ORDER_2', 'guest', 'Late Buyer', ?, 1800, 'pending')")
      .run(JSON.stringify([{ product_id: 1, name_snapshot: "Buzzz", price_cents: 1800, quantity: 1 }]));
    const soldOut = await call(env, "/shop/pay/capture", "POST", undefined, { orderId: "PP_ORDER_2" });
    expect(soldOut).toMatchObject({ status: 409, data: { error: "insufficient_stock", product_id: 1 } });
    expect(captureCount).toBe(1);

    // Failed capture (PENDING eCheck) restores reserved stock & returns session to pending.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/oauth2/token")) return Response.json({ access_token: "tok" });
      if (u.includes("/capture")) return Response.json({ status: "COMPLETED", purchase_units: [{ payments: { captures: [{ status: "PENDING", amount: { value: "15.00", currency_code: "USD" } }] } }] });
      return new Response("{}", { status: 404 });
    }));
    db.raw.prepare("INSERT INTO store_payment_sessions (paypal_order_id, member_id, member_name, items_json, total_cents, status) VALUES ('PP_ORDER_3', 'm_ada', 'Ada Lovelace', ?, 1500, 'pending')")
      .run(JSON.stringify([{ product_id: 2, name_snapshot: "Zone", price_cents: 1500, quantity: 1 }]));
    const incomplete = await call(env, "/shop/pay/capture", "POST", await tok("m_ada"), { orderId: "PP_ORDER_3" });
    expect(incomplete.status).toBe(402);
    expect((db.raw.prepare("SELECT stock_qty FROM store_products WHERE id = 2").get() as any).stock_qty).toBe(2);
    expect((db.raw.prepare("SELECT status FROM store_payment_sessions WHERE paypal_order_id = 'PP_ORDER_3'").get() as any).status).toBe("pending");
  });

  it("makes cancelled orders terminal against un-cancel/double-restock and detects cart edits on store-credit idempotency reuse", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    const admin = await tok("m_admin");
    const ada = await tok("m_ada");
    db.raw.prepare("INSERT INTO store_products (id, category, name, price_cents, stock_qty, active) VALUES (1, 'disc', 'Buzzz', 1000, 1, 1), (2, 'disc', 'Zone', 1500, 2, 1)").run();
    db.raw.prepare("INSERT INTO wallet_transactions (member_id, member_name, amount_cents, transaction_type, source, created_by) VALUES ('m_ada', 'Ada Lovelace', 5000, 'credit', 'manual_adjustment', 'm_admin')").run();

    // Buy the last Buzzz with idempotency key K1.
    const buy = await call(env, "/shop/orders", "POST", ada, { idempotency_key: "K1", items: [{ product_id: 1, quantity: 1 }] });
    expect(buy.status).toBe(201);
    const orderId = buy.data.order.id as number;
    expect((db.raw.prepare("SELECT stock_qty FROM store_products WHERE id = 1").get() as any).stock_qty).toBe(0);

    // Exact retry with K1 succeeds with 200 even though stock is now 0.
    const retry = await call(env, "/shop/orders", "POST", ada, { idempotency_key: "K1", items: [{ product_id: 1, quantity: 1 }] });
    expect(retry.status).toBe(200);
    expect(retry.data.order.id).toBe(orderId);

    // Editing cart and reusing K1 conflicts cleanly (409).
    const conflict = await call(env, "/shop/orders", "POST", ada, { idempotency_key: "K1", items: [{ product_id: 2, quantity: 1 }] });
    expect(conflict).toMatchObject({ status: 409, data: { error: "idempotency_key_conflict" } });

    // Cancel order -> stock becomes 1, restocked_at set, wallet refunded.
    const cancel = await call(env, `/admin/orders/${orderId}`, "PATCH", admin, { status: "cancelled" });
    expect(cancel.status).toBe(200);
    expect((db.raw.prepare("SELECT stock_qty FROM store_products WHERE id = 1").get() as any).stock_qty).toBe(1);
    expect((db.raw.prepare("SELECT restocked_at FROM store_orders WHERE id = ?").get(orderId) as any).restocked_at).toBeTruthy();

    // Un-cancelling is refused (409 already_cancelled), and guarded DB fulfillment refuses to overwrite a cancelled status.
    const reopen = await call(env, `/admin/orders/${orderId}`, "PATCH", admin, { status: "submitted" });
    expect(reopen).toMatchObject({ status: 409, data: { error: "already_cancelled" } });
    expect(await updateStoreOrderFulfillment(db as any, orderId, { status: "shipped" })).toBeNull();

    // Deleting a cancelled order does NOT double-restock or double-refund.
    const del = await call(env, `/admin/orders/${orderId}`, "DELETE", admin);
    expect(del.status).toBe(200);
    expect((db.raw.prepare("SELECT stock_qty FROM store_products WHERE id = 1").get() as any).stock_qty).toBe(1);
  });

  it("enforces idempotency on admin wallet credit, event payout, CTP payout, and membership reserveDues", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    const admin = await tok("m_admin");
    db.raw.prepare("INSERT INTO events (id, name, date, status, type) VALUES (10, 'Weekly', '2026-06-01', 'final', 'league')").run();
    db.raw.prepare("INSERT INTO ctps (id, event_id, hole, prize) VALUES (5, 10, 7, 'Disc')").run();

    expect((await call(env, "/admin/wallets/credit", "POST", admin, { member_id: "m_ada", amount_cents: "0" })).status).toBe(400);
    const w1 = await call(env, "/admin/wallets/credit", "POST", admin, { member_id: "m_ada", amount_cents: 500, idempotency_key: "wk1" });
    const w2 = await call(env, "/admin/wallets/credit", "POST", admin, { member_id: "m_ada", amount_cents: 500, idempotency_key: "wk1" });
    const wConflict = await call(env, "/admin/wallets/credit", "POST", admin, { member_id: "m_ada", amount_cents: 600, idempotency_key: "wk1" });
    expect(w1.status).toBe(201);
    expect(w2.status).toBe(200);
    expect(w1.data.balance_cents).toBe(500);
    expect(wConflict.status).toBe(409);

    const e1 = await call(env, "/admin/events/10/store-credit", "POST", admin, { member_id: "m_ada", amount_cents: 700, idempotency_key: "ek1" });
    const e2 = await call(env, "/admin/events/10/store-credit", "POST", admin, { member_id: "m_ada", amount_cents: 700, idempotency_key: "ek1" });
    expect(e1.status).toBe(201);
    expect(e2.status).toBe(200);
    expect(e2.data.balance_cents).toBe(1200);

    // CTP payout blocks accidental second award to another player WITHOUT clobbering winner_member_id, even concurrently.
    const c1 = await call(env, "/admin/events/10/ctps/5/store-credit", "POST", admin, { member_id: "m_ada", amount_cents: 400, winner_name: "Ada" });
    expect(c1.status).toBe(201);
    const cDup = await call(env, "/admin/events/10/ctps/5/store-credit", "POST", admin, { member_id: "m_bo", amount_cents: 400, winner_name: "Bo" });
    expect(cDup).toMatchObject({ status: 409, data: { error: "ctp_already_paid" } });
    expect((db.raw.prepare("SELECT winner_member_id FROM ctps WHERE id = 5").get() as any).winner_member_id).toBe("m_ada");

    db.raw.prepare("INSERT INTO ctps (id, event_id, hole, prize) VALUES (6, 10, 8, 'Putter')").run();
    const [raceA, raceB] = await Promise.all([
      call(env, "/admin/events/10/ctps/6/store-credit", "POST", admin, { member_id: "m_ada", amount_cents: 300, winner_name: "Ada" }),
      call(env, "/admin/events/10/ctps/6/store-credit", "POST", admin, { member_id: "m_bo", amount_cents: 300, winner_name: "Bo" }),
    ]);
    expect([raceA.status, raceB.status].sort()).toEqual([201, 409]);
    const ctp6Winner = (db.raw.prepare("SELECT winner_member_id FROM ctps WHERE id = 6").get() as any).winner_member_id;
    const ctp6Paid = (db.raw.prepare("SELECT member_id FROM wallet_transactions WHERE idempotency_key = 'ctp_payout:10:6'").get() as any).member_id;
    expect(ctp6Winner).toBe(ctp6Paid);

    // reserveDues blocks concurrent same-orderId reservation; unique paypal_order_id conflict releases lock.
    expect(await reserveDues(db as any, "app_1", "ORD_SAME")).toBe(true);
    expect(await reserveDues(db as any, "app_1", "ORD_SAME")).toBe(false);
    await recordPaypalDues(db as any, "app_1", "ORD_USED", "CAP1", 1500);

    // HTTP /dues/capture hitting recordPaypalDues UNIQUE conflict releases reserved_order_id instead of wedging it.
    const envWithPaypal = makeEnv(db, { PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec", PAYPAL_API_BASE: "https://pp.test" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/oauth2/token")) return Response.json({ access_token: "tok" });
      if (u.includes("/capture")) return Response.json({ status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP2", status: "COMPLETED", amount: { value: "15.00", currency_code: "USD" } }] } }] });
      return new Response("{}", { status: 404 });
    }));
    const applied = await call(envWithPaypal, "/membership/apply", "POST", undefined, { name: "New Person", pdgaNo: "8888", pin: "2468", email: "new@example.com" });
    expect(applied.status).toBe(201);
    const dupDues = await call(envWithPaypal, `/membership/apply/${applied.data.application.id}/dues/capture`, "POST", undefined, {
      payToken: applied.data.payToken,
      orderId: "ORD_USED",
    });
    expect(dupDues).toMatchObject({ status: 409, data: { error: "order_already_used" } });
    expect((await getDues(db as any, applied.data.application.id))?.reserved_order_id).toBeNull();
  });
});

describe("Batch 6: Held accounts, bag tags, cleanup, UDisc imports & timestamps", () => {
  it("keeps held accounts from downgrading renewed years or demoting members and cleans up all bag tag orphans", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    const admin = await tok("m_admin");
    const ada = await tok("m_ada");
    const bo = await tok("m_bo");
    const cy = await tok("m_cy");

    // Held balance import does NOT stamp memberThroughYear; absorbs cleanly without demoting Ada from member -> guest or downgrading 2027 -> 2026.
    await call(env, "/admin/sheet-import/apply", "POST", admin, {
      kind: "balances",
      defaultTier: "guest",
      rows: [{ line: 2, name: "Dana Balances", pdga: "9090", value: 900 }],
    });
    const danaHeld = JSON.parse((await env.ROSTER.get("member:m_h_p9090"))!) as Member;
    expect(danaHeld.memberThroughYear).toBeUndefined();
    const held: Member = { memberId: "m_h_p555", name: "Ada Lovelace", pdgaNo: "555", guest: true, held: true, pinHash: "", mustChangePin: true, memberThroughYear: 2025 };
    await putMember(env.ROSTER, held);
    expect(await findHeldMatch(env, { name: "Ada Lovelace", pdgaNo: null })).toBe("m_h_p555");
    const realAda = JSON.parse((await env.ROSTER.get("member:m_ada"))!) as Member;
    const carried = await absorbHeld(env, "m_h_p555", realAda, "m_admin");
    expect(carried?.guest).toBe(false);
    const afterAda = JSON.parse((await env.ROSTER.get("member:m_ada"))!) as Member;
    expect(afterAda.memberThroughYear).toBe(2027);
    expect(afterAda.guest).toBeUndefined();

    // Migration 0079 UNIQUE(league_id, member_id) index rejects duplicate member on bag_tag_league_ladder.
    db.raw.prepare("INSERT INTO leagues (id, name, season) VALUES (1, 'Tags League', '2026')").run();
    db.raw.prepare("INSERT INTO bag_tag_league_ladder (league_id, tag_number, player_name, member_id) VALUES (1, 1, 'Ada Lovelace', 'm_ada'), (1, 2, 'Bo Burnham', 'm_bo'), (1, 3, 'Cy Young', 'm_cy')").run();
    db.raw.prepare("INSERT INTO bag_tag_league_state (league_id) VALUES (1)").run();
    expect(() => {
      db.raw.prepare("INSERT INTO bag_tag_league_ladder (league_id, tag_number, player_name, member_id) VALUES (1, 9, 'Ada Again', 'm_ada')").run();
    }).toThrow();

    // Concurrent league challenges against #1 Ada: winner swaps atomically, loser gets 409 stale_tags, nobody erased/duplicated.
    const l1 = await call(env, "/bag-tags/challenges", "POST", bo, { leagueId: 1, defenderId: "m_ada", challengerScore: 48, defenderScore: 55 });
    const l2 = await call(env, "/bag-tags/challenges", "POST", cy, { leagueId: 1, defenderId: "m_ada", challengerScore: 47, defenderScore: 55 });
    const [lc1, lc2] = await Promise.all([
      call(env, `/bag-tags/challenges/${l1.data.challenge.id}/confirm`, "POST", ada, {}),
      call(env, `/bag-tags/challenges/${l2.data.challenge.id}/confirm`, "POST", ada, {}),
    ]);
    expect([lc1.status, lc2.status].sort()).toEqual([200, 409]);
    const ladderRows = db.raw.prepare("SELECT tag_number, member_id FROM bag_tag_league_ladder WHERE league_id = 1 ORDER BY tag_number").all();
    expect(ladderRows).toHaveLength(3);

    // UDisc tied + multi-division players are NOT dropped on ladder import.
    const leagueSaved = await saveUdiscLeague(env, "m_admin", {
      league: { type: "league", source: "udisc", name: "Tied League", season: "2026", format: "stroke", external_url: "https://udisc.com/leagues/tied", description: null, date: null },
      events: [],
      standings: {
        leagueName: "Tied League",
        shortId: null,
        seasonStart: "2026-11-01",
        seasonEnd: "2026-11-01",
        roundsKept: null,
        minimumPoints: null,
        mode: "tags",
        events: [{
          name: "Week 1",
          date: "2026-11-01",
          shortId: null,
          externalUrl: "https://udisc.com/events/w1",
          venue: null,
          results: [
            { name: "Ada Lovelace", place: 1, total: 50, toPar: -4, points: null, division: "MPO" },
            { name: "Bo Burnham", place: 1, total: 52, toPar: -2, points: null, division: "MA1" },
            { name: "Cy Young", place: 2, total: 54, toPar: 0, points: null, division: "MA1" },
          ],
        }],
        standings: [],
      },
    });
    const tiedLadder = db.raw.prepare("SELECT tag_number, player_name FROM bag_tag_league_ladder WHERE league_id = ? ORDER BY tag_number").all(leagueSaved.league_id);
    expect(tiedLadder).toEqual([
      { tag_number: 1, player_name: "Ada Lovelace" },
      { tag_number: 2, player_name: "Bo Burnham" },
      { tag_number: 3, player_name: "Cy Young" },
    ]);

    // relinkLeague can swap/promote an already-linked member from tag #3 to #1 without tripping the partial unique index.
    db.raw.prepare("UPDATE bag_tag_league_ladder SET member_id = NULL WHERE league_id = ? AND tag_number IN (1, 3)").run(leagueSaved.league_id);
    db.raw.prepare("UPDATE bag_tag_league_ladder SET member_id = 'm_ada' WHERE league_id = ? AND tag_number = 3").run(leagueSaved.league_id);
    db.raw.prepare("UPDATE bag_tag_league_ladder SET member_id = 'm_cy' WHERE league_id = ? AND tag_number = 1").run(leagueSaved.league_id);
    db.raw.prepare("INSERT OR REPLACE INTO bag_tag_league_links (league_id, player_key, player_name, member_id) VALUES (?, 'adalovelace', 'Ada Lovelace', 'm_ada'), (?, 'cyyoung', 'Cy Young', 'm_cy')")
      .run(leagueSaved.league_id, leagueSaved.league_id);
    await relinkLeague(env, leagueSaved.league_id);
    expect((db.raw.prepare("SELECT member_id FROM bag_tag_league_ladder WHERE league_id = ? AND tag_number = 1").get(leagueSaved.league_id) as any).member_id).toBe("m_ada");
    expect((db.raw.prepare("SELECT member_id FROM bag_tag_league_ladder WHERE league_id = ? AND tag_number = 3").get(leagueSaved.league_id) as any).member_id).toBe("m_cy");

    // Duplicate UDisc division rows mapped to the same member_id re-import cleanly without UNIQUE violation.
    const dupInput: Parameters<typeof saveUdiscLeague>[2] = {
      league: { type: "league", source: "udisc", name: "Dup Div League", season: "2026", format: "stroke", external_url: "https://udisc.com/leagues/dup", description: null, date: null },
      events: [],
      standings: {
        leagueName: "Dup Div League",
        shortId: null,
        seasonStart: "2026-11-02",
        seasonEnd: "2026-11-02",
        roundsKept: null,
        minimumPoints: null,
        mode: "tags",
        events: [{
          name: "Week 1",
          date: "2026-11-02",
          shortId: null,
          externalUrl: "https://udisc.com/events/dupw1",
          venue: null,
          results: [
            { name: "Ada Lovelace", place: 1, total: 50, toPar: -4, points: null, division: "FPO" },
            { name: "Ada Lovelace", place: 2, total: 50, toPar: -4, points: null, division: "MPO" },
          ],
        }],
        standings: [],
      },
    };
    const dupLeague = await saveUdiscLeague(env, "m_admin", dupInput);
    // Re-import once results carry linked member_id = 'm_ada' on BOTH duplicate rows.
    db.raw.prepare("UPDATE results SET member_id = 'm_ada' WHERE event_id IN (SELECT id FROM events WHERE league_id = ?)").run(dupLeague.league_id);
    await saveUdiscLeague(env, "m_admin", dupInput);
    const dupLadder = db.raw.prepare("SELECT tag_number, member_id FROM bag_tag_league_ladder WHERE league_id = ? ORDER BY tag_number").all(dupLeague.league_id);
    expect(dupLadder).toEqual([
      { tag_number: 1, member_id: "m_ada" },
      { tag_number: 2, member_id: null },
    ]);

    // deleteLeague removes bag_tag_league_* rows cleanly.
    await deleteLeague(db as any, 1);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM bag_tag_league_ladder WHERE league_id = 1").get() as any).n).toBe(0);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM bag_tag_challenges WHERE league_id = 1").get() as any).n).toBe(0);

    // Club series giveTag preserves old tag when target tag collides.
    const s1 = (await call(env, "/admin/bag-tags/series", "POST", admin, { name: "Series 2026" })).data.series.id as number;
    await call(env, "/admin/bag-tags/assign", "POST", admin, { seriesId: s1, memberId: "m_ada", tagNumber: 1 });
    await call(env, "/admin/bag-tags/assign", "POST", admin, { seriesId: s1, memberId: "m_bo", tagNumber: 2 });
    await expect(giveTag(db as any, { seriesId: s1, tagNumber: 1, memberId: "m_bo", memberName: "Bo Burnham" })).rejects.toThrow();
    expect((db.raw.prepare("SELECT tag_number FROM bag_tag_holders WHERE series_id = ? AND member_id = 'm_bo'").get(s1) as any).tag_number).toBe(2);

    // Admin confirm push copy is neutral rather than challenger-perspective for defender.
    const note = challengeNote({
      id: 99, series_id: s1, challenger_id: "m_bo", challenger_name: "Bo Burnham",
      defender_id: "m_ada", defender_name: "Ada Lovelace", challenger_tag: 2, defender_tag: 1,
      challenger_score: 48, defender_score: 52, status: "settled", created_at: "",
    }, { kind: "confirmed", swapped: true, byAdmin: true }, "");
    expect(note.note.title).not.toContain("you now hold");
    expect(note.note.title).toContain("#1");
    expect(note.note.title).toContain("#2");

    // Member removal cleans up bag_tag_holders & pending challenges & requests.
    const s2 = (await call(env, "/admin/bag-tags/series", "POST", admin, { name: "Series 2027" })).data.series.id as number;
    await call(env, "/admin/bag-tags/assign", "POST", admin, { seriesId: s2, memberId: "m_ada", tagNumber: 1 });
    await call(env, "/admin/bag-tags/assign", "POST", admin, { seriesId: s2, memberId: "m_cy", tagNumber: 4 });
    // Archived series (s1) blocks release.
    expect((await call(env, "/admin/bag-tags/release", "POST", admin, { seriesId: s1, memberId: "m_ada" })).status).toBe(404);
    await call(env, "/admin/members/remove", "POST", admin, { memberId: "m_cy" });
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM bag_tag_holders WHERE series_id = ? AND member_id = 'm_cy'").get(s2) as any).n).toBe(0);
  });

  it("deduplicates unmatched new people across rows, fixes UDisc history scratch/case/cap bugs, and tightens asIsoTimestamp", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    const admin = await tok("m_admin");
    const ada = await tok("m_ada");

    const plan = await call(env, "/admin/sheet-import/plan", "POST", admin, {
      kind: "balances",
      rows: [
        { line: 2, name: "Pat Riley", pdga: "98765", value: 500 },
        { line: 3, name: "Pat Riley", value: 700 },
      ],
    });
    expect(plan.data.rows[0].action).toBe("new");
    expect(plan.data.rows[1].action).toBe("skip");

    // 2-scratch round where player shot a real 6 on Hole 7 (par 3) and scratched Holes 17-18 with par-3 placeholders:
    const csvHeader = ["PlayerName", "CourseName", "LayoutName", "StartDate", "Total", "+/-", "Hole1", "Hole2", "Hole3", "Hole4"].join(",");
    const csvPar = ["Par", "Park", "Main", "2026-05-01 10:00", "12", "", "3", "3", "3", "3"].join(",");
    // Holes 1=3, 2=6 (+3), 3=3 (scratched), 4=3 (scratched) -> Total=9 (+3); sum=15, gap=6!
    const csvAdaLower = ["ada lovelace", "Park", "Main", "2026-05-01 10:00", "9", "+3", "3", "6", "3", "3"].join(",");
    const csvAdaUpper = ["Ada Lovelace", "Park", "Main", "2026-05-02 10:00", "12", "E", "3", "3", "3", "3"].join(",");
    const imported = await call(env, "/me/udisc-history", "POST", ada, {
      csv: [csvHeader, csvPar, csvAdaLower, csvAdaUpper].join("\n"),
    });
    expect(imported.status).toBe(200);
    expect(imported.data.saved).toBe(2); // case-variant round NOT dropped

    const parsed = parseUdiscHistory([csvHeader, csvPar, csvAdaLower].join("\n"));
    expect("rounds" in parsed).toBe(true);
    if ("rounds" in parsed) {
      // Real Hole 2 score 6 must still be intact!
      expect(parsed.rounds[0]!.holes.find((h) => h.hole === 2)?.strokes).toBe(6);
    }

    // Multi-player CSV with 2,400 total rows (600 per player * 4 players) parses without too_many error.
    const bigRows = ["PlayerName,CourseName,LayoutName,Date,Total,+/-,Hole1"];
    for (let i = 0; i < 600; i++) {
      const m = String(1000 + i).padStart(4, "0");
      const day = `2026-${String(1 + Math.floor(i / 28) % 12).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")} 10:${String(i % 60).padStart(2, "0")}`;
      for (const p of ["Ada Lovelace", "Player Two", "Player Three", "Player Four"]) {
        bigRows.push(`${p},Course ${m},Main,${day},3,E,3`);
      }
    }
    const bigParsed = parseUdiscHistory(bigRows.join("\n"));
    expect("rounds" in bigParsed).toBe(true);

    // asIsoTimestamp rejects zone-less date / space-separated strings and accepts lowercase 'z'.
    expect(asIsoTimestamp("2026-06-15 18:00")).toBeUndefined();
    expect(asIsoTimestamp("2026-06-15")).toBeUndefined();
    expect(asIsoTimestamp("2026-06-15T18:00")).toBeUndefined();
    expect(asIsoTimestamp("2026-06-15T18:00:00z")).toBe("2026-06-15T18:00:00.000Z");
    expect(asIsoTimestamp("2026-06-15T18:00-04:00")).toBe("2026-06-15T22:00:00.000Z");
  });
});
