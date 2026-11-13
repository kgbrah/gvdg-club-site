import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import worker from "../src/index.js";
import { settleBagTags, settleSummary } from "../src/bag-tags.js";
import type { Env } from "../src/env.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";

function member(memberId: string, name: string, isAdmin = false) {
  return JSON.stringify({ memberId, name, isAdmin, pinHash: "x", mustChangePin: false });
}

function kv(initial: Record<string, string>) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => {
      rows.set(key, value);
    },
    delete: async (key: string) => {
      rows.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true }),
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../migrations/0042_bag_tags.sql", import.meta.url), "utf8"));
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all() {
          return { results: db.prepare(sql).all(...bound), success: true };
        },
        async first() {
          return db.prepare(sql).get(...bound) ?? null;
        },
        async run() {
          const info = db.prepare(sql).run(...bound);
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

function envOf(db: unknown): Env {
  return {
    ROSTER: kv({
      "member:m_ace": member("m_ace", "Ace"),
      "member:m_two": member("m_two", "Two"),
      "member:m_five": member("m_five", "Five"),
      "member:m_admin": member("m_admin", "Admin", true),
    }),
    RATELIMIT: kv({}),
    DB: db,
    JWT_SECRET: SECRET,
    SESSION_TTL_SEC: "900",
    ALLOWED_ORIGINS: ORIGIN,
  } as unknown as Env;
}

async function token(sub: string) {
  return signSession({ sub, mustChangePin: false }, SECRET, 900);
}

async function call(db: unknown, path: string, method = "GET", bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await worker.fetch(new Request("https://worker.example" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), envOf(db));
  const data: any = await response.json().catch(() => null);
  return { status: response.status, data };
}

describe("bag tag settle", () => {
  it("gives the better tags to the lower scores and leaves a tie on the better tag", () => {
    const swapped = settleBagTags([
      { memberId: "a", name: "Ace", tagNumber: 1, score: 70 },
      { memberId: "b", name: "Two", tagNumber: 2, score: 60 },
      { memberId: "c", name: "Five", tagNumber: 9, score: 80 },
    ]);
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;
    expect(swapped.assignments.map((row) => [row.memberId, row.tagNumber])).toEqual([
      ["b", 1],
      ["a", 2],
      ["c", 9],
    ]);
    expect(settleSummary("settle", swapped.changes)).toBe("Card settled: Two #2 → #1, Ace #1 → #2");

    const tied = settleBagTags([
      { memberId: "a", name: "Ace", tagNumber: 1, score: 54 },
      { memberId: "b", name: "Two", tagNumber: 4, score: 54 },
    ]);
    expect(tied.ok && tied.changes).toEqual([]);
    expect(settleSummary("challenge", [])).toBe("Challenge played. Tags stayed put.");
  });

  it("rejects a card that is not a real match", () => {
    expect(settleBagTags([{ memberId: "a", name: "Ace", tagNumber: 1, score: 0 }]).ok).toBe(false);
    expect(settleBagTags([
      { memberId: "a", name: "Ace", tagNumber: 1, score: 0 },
      { memberId: "a", name: "Ace", tagNumber: 2, score: 1 },
    ])).toEqual({ ok: false, error: "duplicate" });
  });
});

describe("bag tag routes", () => {
  it("starts empty, then only an admin can assign and settle the card", async () => {
    const db = await sqliteDb();
    const admin = await token("m_admin");
    const ace = await token("m_ace");

    expect(await call(db, "/bag-tags")).toEqual({
      status: 200,
      data: { series: null, holders: [], moves: [] },
    });
    expect((await call(db, "/admin/bag-tags/series", "POST", ace, { name: "Club bag tags" })).status).toBe(403);

    const created = await call(db, "/admin/bag-tags/series", "POST", admin, { name: "Club bag tags", season: "2026" });
    expect(created.status).toBe(201);
    const seriesId = created.data.series.id as number;

    const board = await call(db, "/bag-tags");
    expect(board.data.series).toEqual({ id: seriesId, name: "Club bag tags", season: "2026" });
    expect(board.data.holders).toEqual([]);

    expect((await call(db, "/admin/bag-tags/assign", "POST", admin, { seriesId, memberId: "m_missing", tagNumber: 1 })).status).toBe(404);
    expect((await call(db, "/admin/bag-tags/assign", "POST", admin, { seriesId, memberId: "m_ace", tagNumber: 1 })).status).toBe(200);
    expect((await call(db, "/admin/bag-tags/assign", "POST", admin, { seriesId, memberId: "m_two", tagNumber: 2 })).status).toBe(200);
    expect((await call(db, "/admin/bag-tags/assign", "POST", admin, { seriesId, memberId: "m_five", tagNumber: 5 })).status).toBe(200);
    expect((await call(db, "/admin/bag-tags/assign", "POST", admin, { seriesId, memberId: "m_five", tagNumber: 1 })).data.error).toBe("tag_taken");

    const holders = (await call(db, "/bag-tags")).data.holders;
    expect(holders.map((row: { tagNumber: number; name: string }) => [row.tagNumber, row.name])).toEqual([
      [1, "Ace"],
      [2, "Two"],
      [5, "Five"],
    ]);
    expect(holders[0].memberId).toBeUndefined();

    const settled = await call(db, "/admin/bag-tags/settle", "POST", admin, {
      seriesId,
      players: [
        { memberId: "m_ace", score: 70 },
        { memberId: "m_two", score: 60 },
      ],
    });
    expect(settled.data).toEqual({ ok: true, changes: 2 });
    const after = (await call(db, "/bag-tags")).data.holders;
    expect(after.map((row: { tagNumber: number; name: string }) => [row.tagNumber, row.name])).toEqual([
      [1, "Two"],
      [2, "Ace"],
      [5, "Five"],
    ]);

    const tied = await call(db, "/admin/bag-tags/settle", "POST", admin, {
      seriesId,
      players: [
        { memberId: "m_ace", score: -2 },
        { memberId: "m_two", score: -2 },
      ],
    });
    expect(tied.data.changes).toBe(0);
    expect((await call(db, "/bag-tags")).data.moves[0].summary).toBe("Card settled. Tags stayed put.");
  });

  it("swaps a confirmed challenge and ignores a stale or declined one", async () => {
    const db = await sqliteDb();
    const admin = await token("m_admin");
    const ace = await token("m_ace");
    const two = await token("m_two");
    const created = await call(db, "/admin/bag-tags/series", "POST", admin, { name: "Club bag tags" });
    const seriesId = created.data.series.id as number;
    await call(db, "/admin/bag-tags/assign", "POST", admin, { seriesId, memberId: "m_ace", tagNumber: 1 });
    await call(db, "/admin/bag-tags/assign", "POST", admin, { seriesId, memberId: "m_two", tagNumber: 4 });

    expect((await call(db, "/bag-tags/challenges", "POST", ace, {
      defenderId: "m_two",
      challengerScore: 50,
      defenderScore: 60,
    })).data.error).toBe("must_challenge_better_tag");

    const openPlay = await signOpenPlaySession({ sub: "op_guest", name: "Guest" }, SECRET, 900);
    expect((await call(db, "/bag-tags/challenges", "POST", openPlay, {
      defenderId: "m_ace",
      challengerScore: 50,
      defenderScore: 60,
    })).status).toBe(401);

    const challenge = await call(db, "/bag-tags/challenges", "POST", two, {
      defenderId: "m_ace",
      challengerScore: 50,
      defenderScore: 60,
    });
    expect(challenge.status).toBe(201);
    const id = challenge.data.challenge.id as number;
    expect((await call(db, `/bag-tags/challenges/${id}/confirm`, "POST", two, {})).status).toBe(403);

    const declined = await call(db, "/bag-tags/challenges", "POST", two, {
      defenderId: "m_ace",
      challengerScore: 40,
      defenderScore: 70,
    });
    expect(declined.data.error).toBe("challenge_open");
    expect((await call(db, `/bag-tags/challenges/${id}/decline`, "POST", ace, {})).status).toBe(200);
    expect((await call(db, "/bag-tags")).data.holders.map((row: { name: string }) => row.name)).toEqual(["Ace", "Two"]);

    const again = await call(db, "/bag-tags/challenges", "POST", two, {
      defenderId: "m_ace",
      challengerScore: 48,
      defenderScore: 55,
    });
    const againId = again.data.challenge.id as number;
    expect((await call(db, `/bag-tags/challenges/${againId}/confirm`, "POST", ace, {})).data).toEqual({ ok: true, changes: 2 });
    expect((await call(db, "/bag-tags")).data.holders.map((row: { tagNumber: number; name: string }) => [row.tagNumber, row.name])).toEqual([
      [1, "Two"],
      [4, "Ace"],
    ]);
    expect((await call(db, `/bag-tags/challenges/${againId}/confirm`, "POST", ace, {})).status).toBe(404);

    const pending = await call(db, "/bag-tags/challenges", "POST", ace, {
      defenderId: "m_two",
      challengerScore: 40,
      defenderScore: 70,
    });
    const pendingId = pending.data.challenge.id as number;
    await call(db, "/admin/bag-tags/release", "POST", admin, { seriesId, memberId: "m_ace" });
    await call(db, "/admin/bag-tags/assign", "POST", admin, { seriesId, memberId: "m_ace", tagNumber: 9 });
    expect((await call(db, `/admin/bag-tags/challenges/${pendingId}/confirm`, "POST", admin, {})).data.error).toBe("stale_tags");
    const reissued = await call(db, "/bag-tags/challenges", "POST", ace, {
      defenderId: "m_two",
      challengerScore: 40,
      defenderScore: 70,
    });
    expect(reissued.status).toBe(201);
    expect((await call(db, `/admin/bag-tags/challenges/${reissued.data.challenge.id}/confirm`, "POST", admin, {})).data.changes).toBe(2);
    expect((await call(db, "/bag-tags")).data.holders.map((row: { tagNumber: number; name: string }) => [row.tagNumber, row.name])).toEqual([
      [1, "Ace"],
      [9, "Two"],
    ]);
  });
});
