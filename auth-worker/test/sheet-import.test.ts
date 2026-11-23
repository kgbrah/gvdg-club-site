// Admin › Import › The club's Google Sheets (sheet-import.ts), held accounts (held-accounts.ts) and account tiers.
// The owner's rules: the sheets are canon; rows match by PDGA #, UDisc name or name; anyone not in the app gets a held
// account that carries over when they set up their sign-in; tiers are Admin / Member / Guest, set by an admin.
import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { hashPin } from "../src/crypto.js";
import { heldMemberIdFor, normalizePersonName, putMember, type Member } from "../src/roster.js";

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
  const statement = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      async all() { return { results: db.prepare(sql).all(...(bound as never[])), success: true }; },
      async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
      async run() { const info = db.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
      sql, get bound() { return bound; },
    };
    return stmt;
  };
  return {
    raw: db,
    prepare: statement,
    async batch(statements: Array<ReturnType<typeof statement>>) {
      db.exec("BEGIN");
      try {
        const out = statements.map((stmt) => { const info = db.prepare(stmt.sql).run(...(stmt.bound as never[])); return { success: true, meta: { changes: Number(info.changes) } }; });
        db.exec("COMMIT");
        return out;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}

let db: Awaited<ReturnType<typeof sqliteDb>>;
let roster: ReturnType<typeof memoryKv>;
let env: Env;

const base = (memberId: string, name: string, extra: Partial<Member> = {}): Member => ({ memberId, name, pinHash: "h", mustChangePin: false, memberThroughYear: 2026, ...extra });

beforeEach(async () => {
  db = await sqliteDb();
  roster = memoryKv();
  env = { ROSTER: roster, RATELIMIT: memoryKv(), DB: db, JWT_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN, SESSION_TTL_SEC: "900" } as unknown as Env;
  await putMember(roster as never, base("m_1", "Avery Brooks", { pdgaNo: "1", isAdmin: true }));
  await putMember(roster as never, base("m_80024", "Jordan Parker", { pdgaNo: "80024" }));
  await putMember(roster as never, base("m_u_rileyc", "Riley Chen", { udisc: "rileyc" }));
  await putMember(roster as never, base("m_555", "Taylor Morgan", { pdgaNo: "555" }));
});

const token = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);
async function call(path: string, body?: unknown, who = "m_1") {
  const headers: Record<string, string> = { Origin: ORIGIN, Authorization: "Bearer " + await token(who) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await worker.fetch(new Request("https://w" + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const raw = await response.text();
  return { status: response.status, data: raw ? JSON.parse(raw) : null };
}
const wallet = (memberId: string) => (db.raw.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM wallet_transactions WHERE member_id = ?").get(memberId) as { c: number }).c;
const record = (memberId: string) => { const raw = roster.rows.get("member:" + memberId); return raw ? JSON.parse(raw) as Member : null; };
/** Plan, then apply what the plan matched (as the admin screen does). */
async function importSheet(kind: string, rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const planned = await call("/admin/sheet-import/plan", { kind, rows, ...extra });
  expect(planned.status).toBe(200);
  const apply = planned.data.rows.filter((row: { action: string }) => row.action === "update" || row.action === "new")
    .map((row: { line: number; match: { memberId: string } | null }) => ({ ...rows.find((r) => r.line === row.line), memberId: row.match?.memberId ?? "" }));
  const applied = await call("/admin/sheet-import/apply", { kind, rows: apply, ...extra });
  return { planned: planned.data, applied };
}

describe("names", () => {
  it("match however the sheet writes them", () => {
    expect(normalizePersonName("Parker, Jordan")).toBe("jordan parker");
    expect(normalizePersonName("  JORDAN   parker ")).toBe("jordan parker");
    expect(normalizePersonName("José O'Neil-Smith")).toBe("jose oneilsmith");
    expect(heldMemberIdFor({ name: "Sam Lee", pdgaNo: "#12,345" })).toBe("m_h_p12345");
    expect(heldMemberIdFor({ name: "Sam Lee" })).toBe(heldMemberIdFor({ name: "lee, sam" }));
  });
});

describe("store credit balances (the sheet is canon)", () => {
  const sheet = [
    { line: 2, name: "Jordan Parker", pdga: "80024", value: 2000 },
    { line: 3, name: "Chen, Riley", value: -300 },
    { line: 4, name: "Sam Lee", pdga: "12345", value: 1250 },
    { line: 5, name: "Taylor Morgn", value: 500 },
    { line: 6, name: "J. Parker", pdga: "80024", value: 900 },
    { line: 7, name: "", pdga: "777", value: 100 },
  ];

  it("plans every row, applies it, and does nothing the second time", async () => {
    db.raw.exec("INSERT INTO wallet_transactions (member_id, member_name, amount_cents, transaction_type, source) VALUES ('m_80024', 'Jordan Parker', 500, 'credit', 'manual_adjustment')");
    const { planned, applied } = await importSheet("balances", sheet);
    const byLine = Object.fromEntries(planned.rows.map((row: { line: number }) => [row.line, row]));
    expect(byLine[2]).toMatchObject({ action: "update", before: "$5.00", after: "$20.00", match: { memberId: "m_80024", how: "pdga" } });
    expect(byLine[3]).toMatchObject({ action: "update", before: "$0.00", after: "-$3.00", match: { memberId: "m_u_rileyc", how: "name" } });
    expect(byLine[4]).toMatchObject({ action: "new", after: "$12.50", match: null });
    expect(byLine[4].notes).toContain("New member account, held until they sign up.");
    expect(byLine[5]).toMatchObject({ action: "new", suggestions: [{ memberId: "m_555", name: "Taylor Morgan" }] });
    expect(byLine[6]).toMatchObject({ action: "skip", notes: ["Same person as row 2; that row is used."] });
    expect(byLine[7]).toMatchObject({ action: "skip" });
    expect(planned.counts).toEqual({ update: 2, new: 2, same: 0, skip: 2 });
    expect(applied.status).toBe(200);
    expect(applied.data.results.map((row: { status: string }) => row.status)).toEqual(["done", "done", "done", "done"]);
    expect(wallet("m_80024")).toBe(2000);
    expect(wallet("m_u_rileyc")).toBe(-300);
    expect(wallet("m_h_p12345")).toBe(1250);
    expect(record("m_h_p12345")).toMatchObject({ name: "Sam Lee", pdgaNo: "12345", held: true, pinHash: "" });
    expect(roster.rows.has("idx:pdga:12345")).toBe(false); // a held account can't sign in
    expect(db.raw.prepare("SELECT note, source FROM wallet_transactions WHERE member_id = 'm_80024' ORDER BY id DESC").get())
      .toEqual({ note: "Balance from the club's Google Sheet", source: "sheet_import" });

    // Again: everything is the same, no new entries, and Sam's held account is found, not made twice.
    const entries = (db.raw.prepare("SELECT COUNT(*) AS n FROM wallet_transactions").get() as { n: number }).n;
    const again = await importSheet("balances", sheet);
    // Taylor Morgn's held account (from the first run) is found by name, so nothing is new.
    expect(again.planned.counts).toEqual({ update: 0, new: 0, same: 4, skip: 2 });
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM wallet_transactions").get() as { n: number }).n).toBe(entries);
    // Spent $2 in the app since: the sheet wins.
    db.raw.exec("INSERT INTO wallet_transactions (member_id, member_name, amount_cents, transaction_type, source) VALUES ('m_80024', 'Jordan Parker', -200, 'debit', 'store_credit')");
    await importSheet("balances", sheet.slice(0, 1));
    expect(wallet("m_80024")).toBe(2000);
  });

  it("is admin only, and applies in batches", async () => {
    expect((await call("/admin/sheet-import/plan", { kind: "balances", rows: sheet }, "m_80024")).status).toBe(403);
    expect((await call("/admin/sheet-import/plan", { kind: "nope", rows: sheet })).status).toBe(400);
    const many = Array.from({ length: 26 }, (_, i) => ({ line: i + 2, name: "Player " + i, value: 100 }));
    expect((await call("/admin/sheet-import/apply", { kind: "balances", rows: many })).status).toBe(413);
  });
});

describe("held accounts carry over when the player sets up their account", () => {
  it("an admin adding Sam Lee picks up the store credit, dues and bag tag held for him", async () => {
    db.raw.exec("INSERT INTO bag_tag_series (id, name, active) VALUES (1, '2026 tags', 1)");
    await importSheet("balances", [{ line: 2, name: "Sam Lee", value: 1250 }]);
    await importSheet("dues", [{ line: 2, name: "Sam Lee", value: 2027 }]);
    await importSheet("tags", [{ line: 2, name: "Sam Lee", value: 7 }], { seriesId: 1 });
    const heldId = heldMemberIdFor({ name: "Sam Lee" });
    expect(record(heldId)).toMatchObject({ held: true, memberThroughYear: 2027 });

    const added = await call("/admin/members", { name: "Sam Lee", pdgaNo: "12345" });
    expect(added.status).toBe(201);
    expect(added.data.carriedOver).toBe("Matched Sam Lee from the club's sheets: $12.50 store credit, dues through 2027 and bag tag #7 came over.");
    expect(added.data.member).toMatchObject({ memberId: "m_12345", tier: "member", held: false, memberThroughYear: 2027 });
    expect(wallet("m_12345")).toBe(1250);
    expect(wallet(heldId)).toBe(0);
    expect(db.raw.prepare("SELECT tag_number, member_id, member_name FROM bag_tag_holders").all()).toEqual([{ tag_number: 7, member_id: "m_12345", member_name: "Sam Lee" }]);
    expect(record(heldId)).toBeNull();
  });

  it("matches on PDGA # first, and never matches a name held for a different PDGA #", async () => {
    await importSheet("balances", [{ line: 2, name: "Alex Kim", pdga: "4444", value: 300 }]);
    const other = await call("/admin/members", { name: "Alex Kim", pdgaNo: "5555" });
    expect(other.data.carriedOver).toBeNull();
    expect(wallet("m_5555")).toBe(0);
    const same = await call("/admin/members", { name: "Alexander Kim", pdgaNo: "4444" });
    expect(same.data.carriedOver).toContain("$3.00 store credit");
    expect(wallet("m_4444")).toBe(300);
  });

  it("an admin can link a held account to someone already in the app under another name", async () => {
    await importSheet("balances", [{ line: 2, name: "Taylor Morgn", value: 500 }]);
    const heldId = heldMemberIdFor({ name: "Taylor Morgn" });
    const listed = await call("/admin/members");
    expect(listed.data.members.find((m: { memberId: string }) => m.memberId === heldId)).toMatchObject({ held: true, tier: "member" });
    const linked = await call("/admin/members/link-held", { heldId, memberId: "m_555" });
    expect(linked.status).toBe(200);
    expect(linked.data.carriedOver).toBe("Matched Taylor Morgn from the club's sheets: $5.00 store credit came over.");
    expect(wallet("m_555")).toBe(500);
    expect(record(heldId)).toBeNull();
    expect((await call("/admin/members/link-held", { heldId, memberId: "m_555" })).status).toBe(409);
  });

  it("a held account can't sign in", async () => {
    await importSheet("balances", [{ line: 2, name: "Sam Lee", pdga: "12345", value: 100 }]);
    const login = await worker.fetch(new Request("https://w/login", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ identifier: "12345", pin: "0000" }) }), env);
    expect(login.status).toBe(401);
  });
});

describe("dues, people and bag tags", () => {
  it("dues: the sheet's year wins, blanks are left alone", async () => {
    await putMember(roster as never, base("m_42", "Casey Jones", { pdgaNo: "42", memberThroughYear: 2027 }));
    const { planned } = await importSheet("dues", [
      { line: 2, name: "Casey Jones", value: 2026 }, { line: 3, name: "Jordan Parker", value: null }, { line: 4, name: "Pat Doe", value: 2026 },
    ]);
    expect(planned.rows.map((row: { action: string }) => row.action)).toEqual(["update", "same", "new"]);
    expect(record("m_42")?.memberThroughYear).toBe(2026);
    expect(record("m_80024")?.memberThroughYear).toBe(2026);
    expect(record(heldMemberIdFor({ name: "Pat Doe" }))?.memberThroughYear).toBe(2026);
  });

  it("people: tiers from the sheet (never an admin's), blank sign-in names filled, existing ones kept", async () => {
    await putMember(roster as never, base("m_555", "Taylor Morgan", { pdgaNo: "555", udisc: "tmorgan" }));
    const { planned } = await importSheet("people", [
      { line: 2, name: "Jordan Parker", pdga: "80024", tier: "guest" },
      { line: 3, name: "Avery Brooks", pdga: "1", tier: "guest" },
      { line: 4, name: "Riley Chen", pdga: "31337", udisc: "rileyc" },
      { line: 5, name: "Taylor Morgan", pdga: "556", udisc: "tmorgan" },
      { line: 6, name: "Drew Walk-On", tier: "guest" },
    ], { defaultTier: "member" });
    expect(planned.rows[1].notes).toContain("An admin: their tier isn't changed by an import.");
    expect(planned.rows[3].notes).toContain("PDGA # in the app is 555; it stays (it's how they sign in).");
    expect(record("m_80024")).toMatchObject({ guest: true });
    expect(record("m_1")).toMatchObject({ isAdmin: true });
    expect(record("m_1")?.guest).toBeUndefined();
    expect(record("m_u_rileyc")?.pdgaNo).toBe("31337");
    expect(roster.rows.get("idx:pdga:31337")).toBe("m_u_rileyc");
    expect(record("m_555")?.pdgaNo).toBe("555");
    expect(record(heldMemberIdFor({ name: "Drew Walk-On" }))).toMatchObject({ held: true, guest: true });
  });

  it("bag tags: the series becomes the sheet, releasing anyone not on it", async () => {
    db.raw.exec(`INSERT INTO bag_tag_series (id, name, active) VALUES (1, '2026 tags', 1);
      INSERT INTO bag_tag_holders (series_id, tag_number, member_id, member_name) VALUES (1, 1, 'm_80024', 'Jordan Parker'), (1, 2, 'm_u_rileyc', 'Riley Chen'), (1, 3, 'm_555', 'Taylor Morgan')`);
    const sheet = [{ line: 2, name: "Riley Chen", value: 1 }, { line: 3, name: "Sam Lee", value: 2 }, { line: 4, name: "Jordan Parker", value: 3 }];
    const { planned, applied } = await importSheet("tags", sheet, { seriesId: 1 });
    expect(planned.releases).toEqual([{ tag: 3, name: "Taylor Morgan" }]);
    expect(planned.rows.map((row: { before: string; after: string }) => [row.before, row.after])).toEqual([["#2", "#1"], ["", "#2"], ["#1", "#3"]]);
    expect(applied.status).toBe(200);
    expect(db.raw.prepare("SELECT tag_number, member_id FROM bag_tag_holders WHERE series_id = 1 ORDER BY tag_number").all()).toEqual([
      { tag_number: 1, member_id: "m_u_rileyc" }, { tag_number: 2, member_id: heldMemberIdFor({ name: "Sam Lee" }) }, { tag_number: 3, member_id: "m_80024" },
    ]);
    expect((db.raw.prepare("SELECT summary FROM bag_tag_moves ORDER BY id DESC").get() as { summary: string }).summary).toBe("Standings set from the club's Google Sheet (3 tags)");
    // Two rows with the same tag: flagged in the plan, refused on apply.
    const dup = await call("/admin/sheet-import/plan", { kind: "tags", seriesId: 1, rows: [{ line: 2, name: "Riley Chen", value: 1 }, { line: 3, name: "Jordan Parker", value: 1 }] });
    expect(dup.data.rows[1]).toMatchObject({ action: "skip", notes: ["Tag #1 is also on row 2; fix the sheet first."] });
    expect((await call("/admin/sheet-import/apply", { kind: "tags", seriesId: 1, rows: [{ line: 2, name: "Riley Chen", value: 1, memberId: "m_u_rileyc" }, { line: 3, name: "Jordan Parker", value: 1, memberId: "m_80024" }] })).status).toBe(409);
    expect((await call("/admin/sheet-import/plan", { kind: "tags", seriesId: 99, rows: sheet })).status).toBe(404);
  });
});

describe("account tiers (assigned by an admin)", () => {
  it("Admin / Member / Guest, the last admin protected, held accounts can't be made admin", async () => {
    expect((await call("/admin/members/set-tier", { memberId: "m_80024", tier: "guest" })).data.member).toMatchObject({ tier: "guest", membershipCurrent: false, renewalYear: null });
    expect((await call("/admin/members/set-tier", { memberId: "m_80024", tier: "admin" })).data.member).toMatchObject({ tier: "admin", isAdmin: true });
    expect(record("m_80024")?.guest).toBeUndefined();
    expect((await call("/admin/members/set-tier", { memberId: "m_80024", tier: "member" })).data.member).toMatchObject({ tier: "member", isAdmin: false });
    expect((await call("/admin/members/set-tier", { memberId: "m_1", tier: "guest" })).status).toBe(409);
    expect((await call("/admin/members/set-tier", { memberId: "m_80024", tier: "owner" })).status).toBe(400);
    expect((await call("/admin/members/set-tier", { memberId: "m_80024", tier: "guest" }, "m_555")).status).toBe(403);
    await importSheet("balances", [{ line: 2, name: "Sam Lee", value: 100 }]);
    expect((await call("/admin/members/set-tier", { memberId: heldMemberIdFor({ name: "Sam Lee" }), tier: "admin" })).status).toBe(409);
  });

  it("guests buy but don't list: the marketplace says so and refuses a new listing", async () => {
    await call("/admin/members/set-tier", { memberId: "m_80024", tier: "guest" });
    const asGuest = await call("/market/listings", { title: "Buzzz" }, "m_80024");
    expect(asGuest).toMatchObject({ status: 403, data: { error: "guests_cannot_list" } });
    expect((await call("/market/listings", undefined, "m_80024")).data.viewer).toMatchObject({ kind: "member", canList: false });
    expect((await call("/market/listings", undefined, "m_555")).data.viewer).toMatchObject({ kind: "member", canList: true });
    // A member gets past the seller check (this test Worker has no photo storage).
    expect((await call("/market/listings", { title: "Buzzz" }, "m_555")).data.error).not.toBe("guests_cannot_list");
  });

    it("moves every lapsed member to Guest in one go (not admins, not held accounts)", async () => {
    await putMember(roster as never, base("m_77", "Lapsed Larry", { pdgaNo: "77", memberThroughYear: 2024 }));
    await putMember(roster as never, base("m_78", "Lapsed Admin", { pdgaNo: "78", memberThroughYear: 2024, isAdmin: true }));
    const moved = await call("/admin/members/lapsed-to-guest", {});
    expect(moved.data).toEqual({ moved: 1 });
    expect(record("m_77")).toMatchObject({ guest: true });
    expect(record("m_78")?.guest).toBeUndefined();
    expect((await call("/admin/members/lapsed-to-guest", {})).data).toEqual({ moved: 0 });
  });
});

describe("a smooth first import (owner QA run)", () => {
  it("a value the app can't use skips that row with a note instead of refusing the whole sheet", async () => {
    const year = new Date().getUTCFullYear();
    const balances = await call("/admin/sheet-import/plan", { kind: "balances", rows: [
      { line: 2, name: "Jordan Parker", pdga: "80024", value: 1200 },
      { line: 3, name: "Big Spender", value: 1_200_000 },
    ] });
    expect(balances.status).toBe(200);
    expect(balances.data.rows[1]).toMatchObject({ action: "skip", notes: ["$12,000.00 is more than $10,000; check the sheet."] });
    expect(balances.data.rows[0]).toMatchObject({ action: "update" });
    const dues = await call("/admin/sheet-import/plan", { kind: "dues", rows: [{ line: 2, name: "Future Person", value: year + 6 }] });
    expect(dues.data.rows[0].action).toBe("skip");
    expect(dues.data.rows[0].notes[0]).toMatch(/isn't a dues year the app can use/);
    const tags = await call("/admin/sheet-import/plan", { kind: "tags", rows: [{ line: 2, name: "Jordan Parker", value: 0 }], seriesId: 1 });
    expect([200, 404]).toContain(tags.status); // no series in this setup: refused for that reason, not the tag
    // Applying the usable rows works; the unusable one (if sent anyway) does nothing.
    const applied = await call("/admin/sheet-import/apply", { kind: "balances", rows: [{ line: 3, name: "Big Spender", value: 1_200_000 }] });
    expect(applied.data.results).toEqual([{ line: 3, memberId: "", status: "error", error: "unusable_value" }]);
    expect([...roster.rows.values()].some((value) => value.includes("Big Spender"))).toBe(false);
  });

  it("linking a misspelled row to someone remembers the spelling, so the same sheet matches them next time", async () => {
    const rows = [{ line: 2, name: "Jordon Parkar", value: 1500 }];
    const first = await call("/admin/sheet-import/plan", { kind: "balances", rows });
    expect(first.data.rows[0]).toMatchObject({ action: "new", suggestions: [{ memberId: "m_80024", name: "Jordan Parker" }] });
    // The admin picks Jordan Parker for that row.
    expect((await call("/admin/sheet-import/apply", { kind: "balances", rows: [{ ...rows[0], memberId: "m_80024" }] })).status).toBe(200);
    expect(record("m_80024")?.sheetNames).toEqual(["jordon parkar"]);
    expect(wallet("m_80024")).toBe(1500);
    const again = await call("/admin/sheet-import/plan", { kind: "balances", rows });
    expect(again.data.rows[0]).toMatchObject({ action: "same", match: { memberId: "m_80024", how: "name" } });
    expect(again.data.rows[0].notes).toContain("Linked to Jordan Parker on an earlier import.");
    // A row matched by PDGA # under another name isn't remembered as a spelling (the PDGA # already finds them).
    await call("/admin/sheet-import/apply", { kind: "balances", rows: [{ line: 2, name: "J Parker", pdga: "80024", value: 1500, memberId: "m_80024" }] });
    expect(record("m_80024")?.sheetNames).toEqual(["jordon parkar"]);
  });

  it("checking a big first sheet stays quick: 200 new names against a few hundred members", async () => {
    for (let i = 0; i < 280; i++) await putMember(roster as never, base("m_" + (20000 + i), `Member${i} Surname${i % 23}`, { pdgaNo: String(20000 + i) }));
    const rows = Array.from({ length: 200 }, (_, i) => ({ line: i + 2, name: `Newcomer${i} Family${i % 31}`, value: 100 }));
    await call("/admin/sheet-import/plan", { kind: "balances", rows: rows.slice(0, 5) }); // warm up
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      const planned = await call("/admin/sheet-import/plan", { kind: "balances", rows });
      best = Math.min(best, performance.now() - started);
      expect(planned.status).toBe(200);
      expect(planned.data.counts.new).toBe(200);
    }
    // Was ~50ms of CPU warm (every new name against every member); the free plan allows ~10ms per request.
    expect(best).toBeLessThan(30);
  });

  it("caps lapsed-to-guest batches at 25 and enforces tag row + KV write limits without partial writes", async () => {
    for (let i = 0; i < 30; i += 1) {
      await putMember(roster as never, base(`m_${90000 + i}`, `Lapsed Player ${i}`, { pdgaNo: String(90000 + i), memberThroughYear: 2024 }));
    }
    const firstBatch = await call("/admin/members/lapsed-to-guest", {});
    expect(firstBatch.status).toBe(200);
    expect(firstBatch.data).toEqual({ moved: 25, remaining: 5 });
    const secondBatch = await call("/admin/members/lapsed-to-guest", {});
    expect(secondBatch.status).toBe(200);
    expect(secondBatch.data).toEqual({ moved: 5 });

    db.raw.exec("INSERT INTO bag_tag_series (id, name, active) VALUES (2, '2026 capped tags', 1)");
    const tooManyRows = Array.from({ length: 201 }, (_, i) => ({ line: i + 2, name: `Row ${i}`, value: i + 1 }));
    expect((await call("/admin/sheet-import/apply", { kind: "tags", seriesId: 2, rows: tooManyRows })).status).toBe(413);

    const tooManyNew = Array.from({ length: 26 }, (_, i) => ({ line: i + 2, name: `Brand New Player ${i}`, value: i + 1 }));
    const refused = await call("/admin/sheet-import/apply", { kind: "tags", seriesId: 2, rows: tooManyNew });
    expect(refused.status).toBe(413);
    expect(refused.data.error).toBe("too_many_new_members");

    // Existing members (>25) needing no KV writes are allowed in a single tags import.
    const existingRows = Array.from({ length: 30 }, (_, i) => ({
      line: i + 2, name: `Lapsed Player ${i}`, value: i + 1, memberId: `m_${90000 + i}`,
    }));
    const ok = await call("/admin/sheet-import/apply", { kind: "tags", seriesId: 2, rows: existingRows });
    expect(ok.status).toBe(200);
    expect(ok.data.results).toHaveLength(30);
  });
});
