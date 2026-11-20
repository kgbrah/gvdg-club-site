import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";

// Owner: "need admin to be able to view all member wallet balances".

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

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).sort()) raw.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
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

const member = (memberId: string, name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ memberId, name, pinHash: "x", mustChangePin: false, ...extra });
let env: Env;
let db: Awaited<ReturnType<typeof sqliteDb>>;

beforeEach(async () => {
  db = await sqliteDb();
  env = {
    DB: db, RATELIMIT: kv(), JWT_SECRET: SECRET, SESSION_TTL_SEC: "900", ALLOWED_ORIGINS: ORIGIN,
    ROSTER: kv({
      "member:m_ada": member("m_ada", "Ada Lovelace", { pdgaNo: "80024" }),
      "member:m_bo": member("m_bo", "Bo Diddley"),
      "member:m_cy": member("m_cy", "Cy Young"),
      "member:m_held": member("m_held", "Held Sheet Player", { held: true }),
      "member:m_held2": member("m_held2", "Held With Credit", { held: true }),
      "member:m_admin": member("m_admin", "Club Admin", { isAdmin: true }),
    }),
  } as unknown as Env;
  const tx = db.raw.prepare("INSERT INTO wallet_transactions (member_id, member_name, amount_cents, transaction_type, source, created_at) VALUES (?, ?, ?, ?, 'manual_adjustment', ?)");
  tx.run("m_ada", "Ada", 2000, "credit", "2026-11-01 10:00:00");
  tx.run("m_ada", "Ada", -750, "debit", "2026-11-10 10:00:00");
  tx.run("m_cy", "Cy Young", -300, "debit", "2026-10-05 09:00:00");
  tx.run("m_held2", "Held With Credit", 1500, "credit", "2026-09-01 09:00:00");
  tx.run("m_gone", "Former Member", 500, "credit", "2026-08-01 09:00:00");
});

async function call(path: string, sub?: string) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (sub) headers.Authorization = "Bearer " + await signSession({ sub, mustChangePin: false }, SECRET, 900);
  const response = await worker.fetch(new Request("https://worker" + path, { headers }), env, { waitUntil() {}, passThroughOnException() {} } as never);
  return { status: response.status, data: await response.json() as Record<string, any> };
}

describe("GET /admin/wallets/balances", () => {
  it("lists every member's balance for an admin, highest first, with the total the club owes", async () => {
    expect((await call("/admin/wallets/balances")).status).toBe(401);
    expect((await call("/admin/wallets/balances", "m_ada")).status).toBe(403);
    const { status, data } = await call("/admin/wallets/balances", "m_admin");
    expect(status).toBe(200);
    expect(data.members.map((row: { memberId: string; balanceCents: number }) => [row.memberId, row.balanceCents])).toEqual([
      ["m_held2", 1500], ["m_ada", 1250], ["m_gone", 500], ["m_bo", 0], ["m_admin", 0], ["m_cy", -300],
    ]);
    // Current roster names (the ledger's "Ada" is old); someone gone from the roster keeps the ledger's name.
    expect(data.members.find((row: { memberId: string }) => row.memberId === "m_ada")).toMatchObject({
      name: "Ada Lovelace", pdgaNo: "80024", transactions: 2, lastActivityAt: "2026-11-10 10:00:00", onRoster: true,
    });
    expect(data.members.find((row: { memberId: string }) => row.memberId === "m_gone")).toMatchObject({ name: "Former Member", onRoster: false });
    // A held account (sheet import, no sign-in yet) shows only when it has credit.
    expect(data.members.some((row: { memberId: string }) => row.memberId === "m_held")).toBe(false);
    expect(data.totalCents).toBe(3250);
    expect(data.withBalance).toBe(4);
    // One member's own ledger still answers at /admin/wallets/:id.
    expect((await call("/admin/wallets/m_ada", "m_admin")).data.balance_cents).toBe(1250);
  });

  it("pages through one member's ledger for the drill-down, newest first, with event names", async () => {
    db.raw.exec("INSERT INTO events (id, type, name, status) VALUES (4, 'tournament', 'Fall Classic', 'final')");
    const tx = db.raw.prepare("INSERT INTO wallet_transactions (member_id, member_name, amount_cents, transaction_type, source, event_id, created_at) VALUES ('m_bo', 'Bo', ?, ?, ?, ?, ?)");
    for (let i = 1; i <= 30; i++) tx.run(100, "credit", "manual_adjustment", null, "2026-10-" + String(i).padStart(2, "0") + " 10:00:00");
    tx.run(-500, "debit", "event_entry", 4, "2026-11-01 10:00:00");
    const first = await call("/admin/wallets/m_bo?page=1", "m_admin");
    expect(first.status).toBe(200);
    expect(first.data.balance_cents).toBe(2500);
    expect(first.data.transactions).toHaveLength(25);
    expect(first.data.more).toBe(true);
    expect(first.data.transactions[0]).toMatchObject({ amount_cents: -500, source: "event_entry", event_name: "Fall Classic" });
    const last = first.data.transactions.at(-1).id;
    const second = await call("/admin/wallets/m_bo?page=1&before=" + last, "m_admin");
    expect(second.data.transactions).toHaveLength(6);
    expect(second.data.more).toBe(false);
    expect(second.data.transactions.every((row: { id: number }) => row.id < last)).toBe(true);
    expect((await call("/admin/wallets/m_bo?page=1&before=x", "m_admin")).status).toBe(400);
    expect((await call("/admin/wallets/m_bo?page=1", "m_ada")).status).toBe(403);
    // Without ?page it answers as before.
    expect((await call("/admin/wallets/m_bo", "m_admin")).data.transactions).toHaveLength(31);
  });
});
