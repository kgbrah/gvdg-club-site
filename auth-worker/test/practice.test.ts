import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import type { D1Like } from "../src/db-types.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";
import { normalizeDistance, parsePracticeMutation } from "../src/practice-input.js";
import { handlePracticeRoute } from "../src/practice-routes.js";
import { writePractice } from "../src/practice-store.js";

const SECRET = "p".repeat(40);
const OWNER = "m_player";
const OTHER = "m_other";
const SESSION = { mustChangePin: false, pinVer: 2 };
const ORIGIN = "https://gvdgclub.com";
const DISC = { brand: "Innova", model: "Teebird", plastic: "Star", weightGrams: 172, notes: "Fieldwork", inBag: true, archived: false };
const id = (value: number) => "44226890-895a-406b-ab45-" + String(value).padStart(12, "0");

function payload(opId: number, recordId: number, kind: string, record: unknown, extra: Record<string, unknown> = {}) {
  return { owner: OWNER, opId: id(opId), id: id(recordId), kind, action: "save", expectedRevision: 0, record, ...extra };
}

function date(daysBefore = 0) {
  return new Date(Date.now() - daysBefore * 86_400_000).toISOString().slice(0, 10);
}

async function fixture() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0051_member_practice.sql", import.meta.url), "utf8"));
  let fail = false;
  type Sql = { sql: string; values: unknown[] };
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) { stmt.values = values; return stmt; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...stmt.values) }; },
        async first() { return sqlite.prepare(sql).get(...stmt.values) || null; },
      };
      return stmt;
    },
    async batch(statements: Sql[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => {
          if (fail && statement.sql.includes("UPDATE member_practice_operations SET")) throw new Error("simulated database write failure");
          return { success: true, results: sqlite.prepare(statement.sql).all(...statement.values) };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Like;
  const ratelimit = new Map<string, string>();
  const env = {
    DB: db, JWT_SECRET: SECRET,
    RATELIMIT: { get: async (key: string) => ratelimit.get(key) || null, put: async (key: string, value: string) => ratelimit.set(key, value) },
    ROSTER: { get: async (key: string) => key === "member:" + OWNER || key === "member:" + OTHER
      ? JSON.stringify({ memberId: key.slice(7), name: "Player", pinVer: 2, mustChangePin: false, isAdmin: key.endsWith(OTHER) }) : null },
  } as unknown as Env;
  const mine = await signSession({ sub: OWNER, ...SESSION }, SECRET, 900);
  const other = await signSession({ sub: OTHER, ...SESSION }, SECRET, 900);
  const guest = await signOpenPlaySession({ sub: "op_guest", name: "Guest" }, SECRET, 900);
  async function call(tail = "", token = mine, body?: unknown) {
    const url = new URL("https://auth.gvdgclub.com/me/practice" + tail);
    const method = body === undefined ? "GET" : "POST";
    const request = new Request(url, {
      method, headers: { Authorization: "Bearer " + token },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return (await handlePracticeRoute(request, env, ORIGIN, url.pathname, method))!;
  }
  return { db, sqlite, call, other, guest, failWrites: (value: boolean) => { fail = value; }, ratelimit };
}

describe("private member practice", () => {
  it("authenticates the owner, isolates exports and rejects cross-account disc links", async () => {
    const { call, other, guest } = await fixture();
    const disc = payload(1, 100, "disc", DISC);
    expect((await call("", guest)).status).toBe(401);
    expect((await call("/mutations", other, disc)).status).toBe(403);
    const saved = await call("/mutations", undefined, disc);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("Cache-Control")).toBe("private, no-store");

    const gps = { lat: 34.8, lng: -82.4, accuracyM: 5.4 };
    const measured = {
      discId: id(100), shotType: "backhand", date: date(), distance: 300, unit: "ft",
      origin: gps, end: { lat: 34.801, lng: -82.4, accuracyM: 8 },
    };
    expect((await call("/mutations", other, payload(2, 101, "throw", measured, { owner: OTHER }))).status).toBe(409);
    expect((await call("/mutations", undefined, payload(2, 101, "throw", measured))).status).toBe(200);
    const exportMine = await call("/export");
    expect(exportMine.headers.get("Content-Disposition")).toContain("attachment");
    expect(await exportMine.json()).toMatchObject({ throws: [{ record: { meters: 91.44, origin: gps } }] });
    const exportOther = await call("/export", other);
    expect(await exportOther.json()).toMatchObject({ discs: [], throws: [], putting: [] });
    expect((await call("?owner=" + OWNER, other)).status).toBe(400);
  });

  it("uses one atomic receipt after a lost response or a newer edit", async () => {
    const { call, sqlite } = await fixture();
    const first = payload(1, 100, "disc", DISC);
    const update = payload(2, 100, "disc", { ...DISC, inBag: false, archived: true }, { expectedRevision: 1 });
    const concurrent = await Promise.all([call("/mutations", undefined, first), call("/mutations", undefined, first)]);
    expect(await concurrent[0]!.json()).toEqual({ ok: true, id: id(100), revision: 1 });
    expect(await concurrent[1]!.json()).toEqual({ ok: true, id: id(100), revision: 1 });
    expect(await (await call("/mutations", undefined, update)).json()).toMatchObject({ revision: 2 });
    expect(await (await call("/mutations", undefined, first)).json()).toMatchObject({ revision: 1 });
    expect((await call("/mutations", undefined, { ...first, record: { ...DISC, model: "Another model" } })).status).toBe(409);
    expect(await (await call()).json()).toMatchObject({ discs: [{ revision: 2, record: { archived: true, inBag: false } }] });
    expect(sqlite.prepare("SELECT count(*) AS n FROM member_practice_records").get()?.n).toBe(1);
  });

  it("keeps a bag disc's optional colour and private writing, and older records exactly as they were", () => {
    const withExtras = parsePracticeMutation(payload(1, 100, "disc", { ...DISC, color: "Orange", ink: "Ada L 252-555-0101" }), OWNER)!;
    expect(withExtras.record).toMatchObject({ color: "Orange", ink: "Ada L 252-555-0101" });
    const plain = parsePracticeMutation(payload(1, 101, "disc", DISC), OWNER)!;
    expect(Object.keys(plain.record!).sort()).toEqual(Object.keys(DISC).sort());
    expect(parsePracticeMutation(payload(1, 102, "disc", { ...DISC, color: "", ink: "" }), OWNER)!.record).toEqual(DISC);
    expect(parsePracticeMutation(payload(1, 103, "disc", { ...DISC, ink: "x".repeat(121) }), OWNER)).toBeNull();
    expect(parsePracticeMutation(payload(1, 104, "disc", { ...DISC, color: 7 }), OWNER)).toBeNull();
    expect(parsePracticeMutation(payload(1, 105, "disc", { ...DISC, photo: "x" }), OWNER)).toBeNull();
  });

  it("rolls back a partial write and retries the same request", async () => {
    const { db, sqlite, failWrites } = await fixture();
    const mutation = parsePracticeMutation(payload(1, 100, "disc", DISC), OWNER)!;
    failWrites(true);
    await expect(writePractice(db, OWNER, mutation)).rejects.toThrow("database write failure");
    expect(sqlite.prepare("SELECT count(*) AS n FROM member_practice_operations").get()?.n).toBe(0);
    expect(sqlite.prepare("SELECT count(*) AS n FROM member_practice_records").get()?.n).toBe(0);
    failWrites(false);
    expect(await writePractice(db, OWNER, mutation)).toEqual({ ok: true, id: id(100), revision: 1 });
  });

  it("weights putting totals by attempts, merges equivalent units and removes deleted sessions", async () => {
    const { call, sqlite } = await fixture();
    const putt = (dated: string, station: object) => ({ date: dated, stations: [station] });
    const first = payload(1, 101, "putting", putt(date(), { distance: 10, unit: "ft", attempts: 20, makes: 18 }));
    const prior = payload(2, 102, "putting", putt(date(40), { distance: 3.048, unit: "m", attempts: 1, makes: 0 }));
    expect((await call("/mutations", undefined, first)).status).toBe(200);
    expect((await call("/mutations", undefined, prior)).status).toBe(200);
    expect(await (await call()).json()).toMatchObject({
      puttingTotals: { attempts: 21, makes: 18, sessions: 2 },
      puttingTrends: [{ meters: 3.048, makes: 18, attempts: 21, lastMakes: 18, lastAttempts: 20, priorMakes: 0, priorAttempts: 1 }],
    });
    const { record: _record, ...tombstone } = { ...first, action: "delete", expectedRevision: 1, opId: id(3) };
    expect((await call("/mutations", undefined, tombstone)).status).toBe(200);
    const deleted = sqlite.prepare("SELECT payload FROM member_practice_records WHERE id = ?").get(first.id);
    expect(deleted?.payload).toBeNull();
    expect((await call("/mutations", undefined, first)).status).toBe(200);
    expect(await (await call("/export")).json()).toMatchObject({ putting: [{ id: prior.id }] });
    expect(await (await call()).json()).toMatchObject({ puttingTotals: { attempts: 1, makes: 0, sessions: 1 } });
  });

  it("retains discs referenced by history and permits deletion after the throw is removed", async () => {
    const { call } = await fixture();
    const disc = payload(1, 100, "disc", DISC);
    const removeDisc = (operation: number, revision: number) => ({
      owner: OWNER, id: disc.id, opId: id(operation), kind: "disc", action: "delete", expectedRevision: revision,
    });
    await call("/mutations", undefined, disc);
    expect((await call("/mutations", undefined, removeDisc(2, 1))).status).toBe(409);
    const measured = {
      discId: disc.id, shotType: "roller", date: date(), distance: 250, unit: "ft",
    };
    const saved = payload(3, 101, "throw", measured);
    expect((await call("/mutations", undefined, saved)).status).toBe(200);
    expect((await call("/mutations", undefined, payload(4, 100, "disc", {
      ...DISC, inBag: false, archived: true,
    }, { expectedRevision: 1 }))).status).toBe(200);
    expect(await (await call("/mutations", undefined, removeDisc(5, 2))).json()).toEqual({ error: "disc_in_use" });
    expect((await call("/mutations", undefined, {
      owner: OWNER, id: saved.id, opId: id(6), kind: "throw", action: "delete", expectedRevision: 1,
    })).status).toBe(200);
    expect((await call("/mutations", undefined, removeDisc(7, 2))).status).toBe(200);
    expect(await (await call("/export")).json()).toMatchObject({ discs: [], throws: [] });
  });

  it("bounds bodies, record counts and rate", async () => {
    const { call, sqlite, ratelimit } = await fixture();
    expect((await call("/mutations", undefined, { text: "a".repeat(9000) })).status).toBe(413);
    const invalid = payload(1, 101, "putting", { date: date(), stations: [{ distance: 15, unit: "ft", attempts: 3, makes: 4 }] });
    expect((await call("/mutations", undefined, invalid)).status).toBe(400);
    const seed = sqlite.prepare("INSERT INTO member_practice_records VALUES (?, ?, 'disc', 1, ?, ?, 'seed', 0)");
    for (let i = 0; i < 400; i += 1) seed.run(OWNER, id(1000 + i), date(), JSON.stringify(DISC));
    expect(await (await call("/mutations", undefined, payload(4, 100, "disc", DISC))).json()).toEqual({ error: "record_limit" });
    ratelimit.set("practice-write:" + OWNER, "48");
    const limited = await call("/mutations", undefined, payload(5, 100, "disc", DISC));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
  });

  it("strictly validates decimals, dates, GPS pairs and impossible samples", () => {
    expect(normalizeDistance(100, "ft", 300)).toEqual({ distance: 100, unit: "ft", meters: 30.48 });
    expect(normalizeDistance("100", "ft", 300)).toBeNull();
    const basic = { discId: id(100), shotType: "forehand", date: date(), distance: 50, unit: "m" };
    expect(parsePracticeMutation(payload(1, 101, "throw", { ...basic, date: "2025-02-30" }), OWNER)).toBeNull();
    expect(parsePracticeMutation(payload(1, 101, "throw", { ...basic, origin: { lat: 1, lng: 2 } }), OWNER)).toBeNull();
    expect(parsePracticeMutation(payload(1, 101, "throw", { ...basic, meters: 50 }), OWNER)).toBeNull();
    expect(parsePracticeMutation(payload(1, 101, "disc", { ...DISC, archived: true }), OWNER)).toBeNull();
    expect(parsePracticeMutation(payload(1, 101, "putting", {
      date: date(), stations: [
        { distance: 10, unit: "ft", attempts: 3, makes: 2 },
        { distance: 3.048, unit: "m", attempts: 5, makes: 1 },
      ],
    }), OWNER)).toBeNull();
  });
});
