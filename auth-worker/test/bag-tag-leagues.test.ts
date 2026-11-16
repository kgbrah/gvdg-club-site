import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { saveUdiscLeague } from "../src/udisc-league-save.js";
import { linkLadderPlayers } from "../src/bag-tag-leagues.js";

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

type TestDb = Awaited<ReturnType<typeof sqliteDb>>;

function makeEnv(db: TestDb): Env {
  return {
    ROSTER: kv({
      "member:m_ada": member("m_ada", "Ada Lovelace"),
      "member:m_bo": member("m_bo", "Bo Burnham"),
      "member:m_cy": member("m_cy", "Cy Young"),
      "member:m_di": member("m_di", "Di Prince"),
      "member:m_zed": member("m_zed", "Zed Outsider"),
      "member:m_admin": member("m_admin", "Admin Person", true),
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

async function call(env: Env, path: string, method = "GET", bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await worker.fetch(new Request("https://worker.example" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const data: any = await response.json().catch(() => null);
  return { status: response.status, data };
}

function board(order: string[], date = "2026-11-08") {
  const results = order.map((name, index) => ({ name, place: index + 1, total: 50 + index, toPar: index - 5, points: null, division: null }));
  return {
    league: { type: "league", source: "udisc", name: "Sunday Baggers", season: "2026", format: "stroke", external_url: "https://udisc.com/leagues/sunday-baggers", description: null, date: null },
    events: [],
    standings: {
      leagueName: "Sunday Baggers",
      shortId: null,
      seasonStart: date,
      seasonEnd: date,
      roundsKept: null,
      minimumPoints: null,
      mode: "tags" as const,
      events: [{ name: `Round ${date}`, date, shortId: null, externalUrl: `https://udisc.com/events/round-${date}`, venue: null, results }],
      standings: [],
    },
  };
}

async function importLeague(env: Env, order: string[], date?: string) {
  const saved = await saveUdiscLeague(env, "m_admin", board(order, date) as never);
  return saved.league_id;
}

const ORDER = ["Ada Lovelace", "Eve Guest", "Bo Burnham", "Cy Young", "Di Prince"];

async function setup() {
  const db = await sqliteDb();
  const env = makeEnv(db);
  const leagueId = await importLeague(env, ORDER);
  return {
    db,
    env,
    leagueId,
    ada: await token("m_ada"),
    bo: await token("m_bo"),
    cy: await token("m_cy"),
    di: await token("m_di"),
    zed: await token("m_zed"),
    admin: await token("m_admin"),
  };
}

const names = (holders: Array<{ tagNumber: number; name: string }>) => holders.map((row) => [row.tagNumber, row.name]);

describe("league bag-tag challenges", () => {
  it("links league players to members by full name only", () => {
    const linked = linkLadderPlayers(
      [
        { tag: 1, name: "Ada Lovelace", memberId: null },
        { tag: 2, name: "Bo", memberId: null },
        { tag: 3, name: "Cy Young", memberId: null },
        { tag: 4, name: "Di Prince", memberId: "m_other" },
      ],
      [
        { memberId: "m_ada", name: "Ada Lovelace" },
        { memberId: "m_bo", name: "Bo Burnham" },
        { memberId: "m_cy", name: "Cy Young" },
        { memberId: "m_cy2", name: "Cy Young" },
        { memberId: "m_other", name: "Someone Else" },
      ],
      [],
    );
    expect(Object.fromEntries(linked)).toEqual({ 1: "m_ada", 4: "m_other" });
  });

  it("lists a member's league ladder, with unlinked players visible but not challengeable", async () => {
    const t = await setup();
    const mine = await call(t.env, "/bag-tags/mine", "GET", t.bo);
    expect(mine.status).toBe(200);
    expect(mine.data.leagues).toHaveLength(1);
    const league = mine.data.leagues[0];
    expect(league.league.name).toBe("Sunday Baggers");
    expect(league.mine.tagNumber).toBe(3);
    expect(names(league.holders)).toEqual([[1, "Ada Lovelace"], [2, "Eve Guest"], [3, "Bo Burnham"], [4, "Cy Young"], [5, "Di Prince"]]);
    expect(league.holders.find((row: any) => row.name === "Eve Guest").linked).toBe(false);
    expect((await call(t.env, "/bag-tags/mine", "GET", t.zed)).data.leagues).toEqual([]);

    const unlinked = await call(t.env, "/bag-tags/challenges", "POST", t.bo, { leagueId: t.leagueId, defenderId: "m_eve", challengerScore: 50, defenderScore: 60 });
    expect(unlinked.data.error).toBe("not_a_holder");
  });

  it("creates, declines, and confirms a swap on the app ladder", async () => {
    const t = await setup();
    const created = await call(t.env, "/bag-tags/challenges", "POST", t.cy, { leagueId: t.leagueId, defenderId: "m_bo", challengerScore: 48, defenderScore: 55 });
    expect(created.status).toBe(201);
    expect(created.data.challenge).toMatchObject({ leagueId: t.leagueId, challengerTag: 4, defenderTag: 3, status: "pending" });
    const id = created.data.challenge.id as number;

    expect((await call(t.env, "/bag-tags/challenges", "POST", t.cy, { leagueId: t.leagueId, defenderId: "m_ada", challengerScore: 40, defenderScore: 55 })).data.error).toBe("challenge_open");
    const defenderView = await call(t.env, "/bag-tags/mine", "GET", t.bo);
    expect(defenderView.data.leagues[0].challenges.map((row: any) => row.id)).toEqual([id]);

    expect((await call(t.env, `/bag-tags/challenges/${id}/decline`, "POST", t.bo, {})).status).toBe(200);
    expect((await call(t.env, `/bag-tags/challenges/${id}/confirm`, "POST", t.bo, {})).status).toBe(404);

    const again = await call(t.env, "/bag-tags/challenges", "POST", t.cy, { leagueId: t.leagueId, defenderId: "m_bo", challengerScore: 48, defenderScore: 55 });
    const againId = again.data.challenge.id as number;
    expect((await call(t.env, `/bag-tags/challenges/${againId}/confirm`, "POST", t.bo, {})).data).toEqual({ ok: true, changes: 2 });
    const after = await call(t.env, "/bag-tags/mine", "GET", t.cy);
    expect(names(after.data.leagues[0].holders)).toEqual([[1, "Ada Lovelace"], [2, "Eve Guest"], [3, "Cy Young"], [4, "Bo Burnham"], [5, "Di Prince"]]);
    expect(after.data.leagues[0].moves[0]).toMatchObject({ kind: "challenge", appOnly: false });
    expect(after.data.leagues[0].moves[0].summary).toBe("Challenge: Cy Young #4 → #3, Bo Burnham #3 → #4");
  });

  it("keeps the better tag when the challenger loses the head-to-head", async () => {
    const t = await setup();
    const made = await call(t.env, "/bag-tags/challenges", "POST", t.cy, { leagueId: t.leagueId, defenderId: "m_bo", challengerScore: 60, defenderScore: 50 });
    expect((await call(t.env, `/bag-tags/challenges/${made.data.challenge.id}/confirm`, "POST", t.bo, {})).data).toEqual({ ok: true, changes: 0 });
    const holders = (await call(t.env, "/bag-tags/mine", "GET", t.cy)).data.leagues[0].holders;
    expect(names(holders)[2]).toEqual([3, "Bo Burnham"]);
  });

  it("rejects bad challenges", async () => {
    const t = await setup();
    const send = (bearer: string, body: Record<string, unknown>) =>
      call(t.env, "/bag-tags/challenges", "POST", bearer, { leagueId: t.leagueId, challengerScore: 50, defenderScore: 60, ...body });
    expect((await send(t.zed, { defenderId: "m_ada" })).data.error).toBe("not_a_holder");
    expect((await send(t.bo, { defenderId: "m_cy" })).data.error).toBe("must_challenge_better_tag");
    expect((await send(t.bo, { defenderId: "m_bo" })).data.error).toBe("invalid_challenge");
    expect((await send(t.bo, { defenderId: "m_ada", challengerScore: 4.5 })).data.error).toBe("invalid_challenge");
    expect((await send(t.bo, { defenderId: "m_ada", defenderScore: "x" })).data.error).toBe("invalid_challenge");
    expect((await send(t.bo, { defenderId: "m_ada", leagueId: 999 })).data.error).toBe("no_league");
    expect((await call(t.env, "/bag-tags/challenges", "POST", undefined, { leagueId: t.leagueId, defenderId: "m_ada", challengerScore: 1, defenderScore: 2 })).status).toBe(401);
  });

  it("only the two members can answer; an admin can cancel but not confirm", async () => {
    const t = await setup();
    const made = await call(t.env, "/bag-tags/challenges", "POST", t.cy, { leagueId: t.leagueId, defenderId: "m_bo", challengerScore: 48, defenderScore: 55 });
    const id = made.data.challenge.id as number;
    for (const bearer of [t.di, t.zed, t.cy, t.ada]) {
      expect((await call(t.env, `/bag-tags/challenges/${id}/confirm`, "POST", bearer, {})).status).toBe(403);
      expect((await call(t.env, `/bag-tags/challenges/${id}/decline`, "POST", bearer, {})).status).toBe(403);
    }
    expect((await call(t.env, `/admin/bag-tags/challenges/${id}/confirm`, "POST", t.admin, {})).status).toBe(409);
    expect((await call(t.env, `/admin/bag-tags/challenges/${id}/cancel`, "POST", t.bo, {})).status).toBe(403);
    expect((await call(t.env, `/admin/bag-tags/challenges/${id}/cancel`, "POST", t.admin, {})).status).toBe(200);
    expect((await call(t.env, `/bag-tags/challenges/${id}/confirm`, "POST", t.bo, {})).status).toBe(404);
    const adminView = await call(t.env, "/admin/bag-tags", "GET", t.admin);
    expect(adminView.data.leagues[0].closed.map((row: any) => [row.id, row.status])).toEqual([[id, "cancelled"]]);
    expect(adminView.data.challenges).toEqual([]);
  });

  it("refuses to settle when the tags changed since it was issued", async () => {
    const t = await setup();
    const first = await call(t.env, "/bag-tags/challenges", "POST", t.cy, { leagueId: t.leagueId, defenderId: "m_bo", challengerScore: 48, defenderScore: 55 });
    const second = await call(t.env, "/bag-tags/challenges", "POST", t.di, { leagueId: t.leagueId, defenderId: "m_bo", challengerScore: 40, defenderScore: 55 });
    expect((await call(t.env, `/bag-tags/challenges/${second.data.challenge.id}/confirm`, "POST", t.bo, {})).data.changes).toBe(2);
    const stale = await call(t.env, `/bag-tags/challenges/${first.data.challenge.id}/confirm`, "POST", t.bo, {});
    expect(stale).toMatchObject({ status: 409, data: { error: "stale_tags" } });
    const holders = (await call(t.env, "/bag-tags/mine", "GET", t.cy)).data.leagues[0].holders;
    expect(names(holders)).toEqual([[1, "Ada Lovelace"], [2, "Eve Guest"], [3, "Di Prince"], [4, "Cy Young"], [5, "Bo Burnham"]]);
  });

  it("UDisc wins: an import resets the ladder, expires open challenges, and keeps app swaps as history", async () => {
    const t = await setup();
    const swapped = await call(t.env, "/bag-tags/challenges", "POST", t.cy, { leagueId: t.leagueId, defenderId: "m_bo", challengerScore: 48, defenderScore: 55 });
    await call(t.env, `/bag-tags/challenges/${swapped.data.challenge.id}/confirm`, "POST", t.bo, {});
    const open = await call(t.env, "/bag-tags/challenges", "POST", t.di, { leagueId: t.leagueId, defenderId: "m_cy", challengerScore: 40, defenderScore: 55 });
    const openId = open.data.challenge.id as number;

    const next = ["Di Prince", "Ada Lovelace", "Bo Burnham", "Eve Guest", "Cy Young"];
    expect(await importLeague(t.env, next, "2026-11-15")).toBe(t.leagueId);

    for (const bearer of [t.di, t.cy]) {
      const view = (await call(t.env, "/bag-tags/mine", "GET", bearer)).data.leagues[0];
      expect(names(view.holders)).toEqual(next.map((name, index) => [index + 1, name]));
      expect(view.challenges).toEqual([]);
      expect(view.closed).toHaveLength(1);
      expect(view.closed[0]).toMatchObject({ id: openId, status: "expired", closedNote: "expired: ladder refreshed from UDisc" });
      const kinds = view.moves.map((move: any) => [move.kind, move.appOnly]);
      expect(kinds).toEqual([["import", false], ["challenge", true], ["import", false]]);
    }
    expect((await call(t.env, `/bag-tags/challenges/${openId}/confirm`, "POST", t.cy, {})).status).toBe(404);
    expect((await call(t.env, `/bag-tags/challenges/${openId}/decline`, "POST", t.cy, {})).status).toBe(404);

    const reissue = await call(t.env, "/bag-tags/challenges", "POST", t.di, { leagueId: t.leagueId, defenderId: "m_ada", challengerScore: 1, defenderScore: 2 });
    expect(reissue.data.error).toBe("must_challenge_better_tag");
  });

  it("an open challenge made before an import is stale even if the same two members are on the new ladder", async () => {
    const t = await setup();
    const made = await call(t.env, "/bag-tags/challenges", "POST", t.cy, { leagueId: t.leagueId, defenderId: "m_bo", challengerScore: 48, defenderScore: 55 });
    t.db.raw.prepare("UPDATE bag_tag_challenges SET status = 'pending', closed_note = NULL WHERE id = ?").run(made.data.challenge.id);
    await importLeague(t.env, ["Ada Lovelace", "Cy Young", "Eve Guest", "Bo Burnham", "Di Prince"], "2026-11-15");
    t.db.raw.prepare("UPDATE bag_tag_challenges SET status = 'pending' WHERE id = ?").run(made.data.challenge.id);
    expect((await call(t.env, `/bag-tags/challenges/${made.data.challenge.id}/confirm`, "POST", t.bo, {})).data.error).toBe("stale_tags");
  });

  it("an admin can link an unlinked UDisc player so they can be challenged", async () => {
    const t = await setup();
    const view = await call(t.env, "/admin/bag-tags", "GET", t.admin);
    expect(view.data.leagues[0].unlinked).toEqual(["Eve Guest"]);
    expect((await call(t.env, `/admin/bag-tags/leagues/${t.leagueId}/link`, "POST", t.bo, { playerName: "Eve Guest", memberId: "m_zed" })).status).toBe(403);
    expect((await call(t.env, `/admin/bag-tags/leagues/${t.leagueId}/link`, "POST", t.admin, { playerName: "Eve Guest", memberId: "m_nobody" })).data.error).toBe("member_not_found");
    expect((await call(t.env, `/admin/bag-tags/leagues/${t.leagueId}/link`, "POST", t.admin, { playerName: "Eve Guest", memberId: "m_zed" })).status).toBe(200);
    const made = await call(t.env, "/bag-tags/challenges", "POST", t.bo, { leagueId: t.leagueId, defenderId: "m_zed", challengerScore: 50, defenderScore: 60 });
    expect(made.status).toBe(201);
    await importLeague(t.env, ORDER, "2026-11-15");
    const zed = (await call(t.env, "/bag-tags/mine", "GET", t.zed)).data.leagues[0];
    expect(zed.mine.tagNumber).toBe(2);
    expect((await call(t.env, `/admin/bag-tags/leagues/${t.leagueId}/link`, "POST", t.admin, { playerName: "Eve Guest", memberId: null })).status).toBe(200);
    expect((await call(t.env, "/bag-tags/mine", "GET", t.zed)).data.leagues).toEqual([]);
  });

  it("club series challenges stay separate from league ones", async () => {
    const t = await setup();
    const created = await call(t.env, "/admin/bag-tags/series", "POST", t.admin, { name: "Club bag tags" });
    const seriesId = created.data.series.id as number;
    await call(t.env, "/admin/bag-tags/assign", "POST", t.admin, { seriesId, memberId: "m_ada", tagNumber: 1 });
    await call(t.env, "/admin/bag-tags/assign", "POST", t.admin, { seriesId, memberId: "m_bo", tagNumber: 4 });
    const club = await call(t.env, "/bag-tags/challenges", "POST", t.bo, { defenderId: "m_ada", challengerScore: 50, defenderScore: 60 });
    expect(club.status).toBe(201);
    const league = await call(t.env, "/bag-tags/challenges", "POST", t.bo, { leagueId: t.leagueId, defenderId: "m_ada", challengerScore: 50, defenderScore: 60 });
    expect(league.status).toBe(201);
    const mine = await call(t.env, "/bag-tags/mine", "GET", t.bo);
    expect(mine.data.challenges.map((row: any) => row.id)).toEqual([club.data.challenge.id]);
    expect(mine.data.leagues[0].challenges.map((row: any) => row.id)).toEqual([league.data.challenge.id]);
    const admin = await call(t.env, "/admin/bag-tags", "GET", t.admin);
    expect(admin.data.challenges.map((row: any) => row.id)).toEqual([club.data.challenge.id]);
    expect(admin.data.leagues[0].challenges.map((row: any) => row.id)).toEqual([league.data.challenge.id]);
    await importLeague(t.env, ORDER, "2026-11-15");
    const after = await call(t.env, "/bag-tags/mine", "GET", t.bo);
    expect(after.data.challenges.map((row: any) => row.status)).toEqual(["pending"]);
  });
});
