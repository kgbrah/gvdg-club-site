import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { karmaKey } from "../src/karma-directory.js";

// Owner: "Let's make ALL donations reward +10 karma per dollar." Direct donations (the Donate buttons, the $1 prompts,
// fundraisers) are reported by the member and confirmed by an admin; the marketplace's confirmed gifts were raised.

const SECRET = "x".repeat(40);
const ORIGIN = "https://gvdgclub.com";
const MIGRATIONS = new URL("../migrations/", import.meta.url);

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    async get(key: string) { return rows.get(key) ?? null; },
    async put(key: string, value: string) { rows.set(key, value); },
    async delete(key: string) { rows.delete(key); },
    async list({ prefix = "" }: { prefix?: string } = {}) { return { keys: [...rows.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}

async function sqliteDb(before?: (raw: import("node:sqlite").DatabaseSync) => void) {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (file === "0077_club_donations.sql") before?.(raw);
    raw.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      async all() { return { results: raw.prepare(sql).all(...(bound as never[])), success: true }; },
      async first() { return raw.prepare(sql).get(...(bound as never[])) ?? null; },
      async run() { const info = raw.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
    };
    return stmt;
  };
  return { raw, prepare, async batch(list: { run(): Promise<unknown> }[]) { for (const s of list) await s.run(); return []; } };
}

const member = (memberId: string, extra: Record<string, unknown> = {}) => JSON.stringify({ memberId, name: memberId === "m_ada" ? "Ada Lovelace" : memberId, pinHash: "x", mustChangePin: false, ...extra });
let env: Env;
let db: Awaited<ReturnType<typeof sqliteDb>>;

beforeEach(async () => {
  db = await sqliteDb();
  env = {
    DB: db, RATELIMIT: kv(), JWT_SECRET: SECRET, SESSION_TTL_SEC: "900", ALLOWED_ORIGINS: ORIGIN,
    ROSTER: kv({ "member:m_ada": member("m_ada"), "member:m_admin": member("m_admin", { isAdmin: true }) }),
  } as unknown as Env;
});

async function call(path: string, options: { sub?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": "application/json" };
  if (options.sub) headers.Authorization = "Bearer " + await signSession({ sub: options.sub, mustChangePin: false }, SECRET, 900);
  const response = await worker.fetch(new Request("https://worker" + path, {
    method: options.method ?? "GET", headers, body: options.body == null ? undefined : JSON.stringify(options.body),
  }), env, { waitUntil() {}, passThroughOnException() {} } as never);
  return { status: response.status, data: await response.json() as Record<string, any> };
}

describe("direct donations: reported by the member, confirmed by an admin, +10 karma a dollar", () => {
  it("a member reports a gift; the admin's 'received' gives +10 karma for every whole dollar and tells them", async () => {
    expect((await call("/me/donations", { method: "POST", body: { amountCents: 500 } })).status).toBe(401);
    expect((await call("/me/donations", { sub: "m_ada", method: "POST", body: { amountCents: 50 } })).data.error).toBe("invalid_amount");
    expect((await call("/me/donations", { sub: "m_ada", method: "POST", body: { amountCents: 200_000 } })).data.error).toBe("invalid_amount");
    const report = await call("/me/donations", { sub: "m_ada", method: "POST", body: { amountCents: 550, source: "club-card" } });
    expect(report.status).toBe(201);
    expect(report.data).toMatchObject({ donation: { memberName: "Ada Lovelace", amountCents: 550, source: "club-card", status: "pending", karma: 0 }, karmaPerDollar: 10 });
    expect((await call("/me/donations", { sub: "m_ada" })).data.donations).toHaveLength(1);

    expect((await call("/admin/donations", { sub: "m_ada" })).status).toBe(403);
    const queue = await call("/admin/donations", { sub: "m_admin" });
    expect(queue.data.pending.map((row: { amountCents: number }) => row.amountCents)).toEqual([550]);
    const id = queue.data.pending[0].id;
    const reviewed = await call(`/admin/donations/${id}/review`, { sub: "m_admin", method: "POST", body: { decision: "received" } });
    expect(reviewed.data.donation).toMatchObject({ status: "confirmed", karma: 50 });
    expect((await call(`/admin/donations/${id}/review`, { sub: "m_admin", method: "POST", body: { decision: "received" } })).status).toBe(409);
    expect(db.raw.prepare("SELECT title, body FROM member_notices WHERE member_id = 'm_ada' ORDER BY id DESC LIMIT 1").get())
      .toEqual({ title: "Thank you for your donation", body: "The club received your $5.50 donation. That's +50 karma. Thank you for supporting the club!" });
    const directory = await call("/karma");
    expect(directory.data.players[karmaKey("m_ada")]).toBe(50);
  });

  it("'not received' gives no karma and says so; three waiting reports at most; unknown sources are 'other'", async () => {
    const first = await call("/me/donations", { sub: "m_ada", method: "POST", body: { amountCents: 100, source: "made-up" } });
    expect(first.data.donation.source).toBe("other");
    await call("/me/donations", { sub: "m_ada", method: "POST", body: { amountCents: 100, source: "round" } });
    await call("/me/donations", { sub: "m_ada", method: "POST", body: { amountCents: 100, source: "event" } });
    expect((await call("/me/donations", { sub: "m_ada", method: "POST", body: { amountCents: 100 } })).data.error).toBe("too_many_pending");
    const no = await call(`/admin/donations/${first.data.donation.id}/review`, { sub: "m_admin", method: "POST", body: { decision: "not_received", reason: "Nothing in PayPal" } });
    expect(no.data.donation).toMatchObject({ status: "not_received", karma: 0, reviewNote: "Nothing in PayPal" });
    expect(db.raw.prepare("SELECT title FROM member_notices WHERE member_id = 'm_ada' ORDER BY id DESC LIMIT 1").get()).toEqual({ title: "Donation not found" });
    expect((await call(`/admin/donations/${first.data.donation.id}/review`, { sub: "m_admin", method: "POST", body: { decision: "maybe" } })).data.error).toBe("invalid_decision");
  });
});

it("the migration raises the marketplace's already-confirmed gifts from +1 to +10 karma a dollar", async () => {
  const raised = await sqliteDb((raw) => {
    // Gifts recorded before this release (their sales aren't needed for the karma update).
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(`INSERT INTO market_donations (deal_id, seller_id, amount_cents, status, karma) VALUES (1, 'm_ada', 550, 'confirmed', 5), (2, 'm_bo', 300, 'sent', 0)`);
    raw.exec("PRAGMA foreign_keys = ON");
  });
  expect(raised.raw.prepare("SELECT seller_id, karma FROM market_donations ORDER BY id").all()).toEqual([{ seller_id: "m_ada", karma: 50 }, { seller_id: "m_bo", karma: 0 }]);
});
