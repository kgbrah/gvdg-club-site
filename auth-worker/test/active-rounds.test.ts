// Admin › Live rounds: every casual round still live, by code, found from the live index AND from member-started
// rounds that were never saved (a ghost can fall out of the index), checked against each round's Durable Object.
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { courseTrafficPayload } from "../src/course-traffic.js";
import { LiveEventDO } from "../src/live.js";
import { signSession } from "../src/jwt.js";
import type { D1Like } from "../src/db-types.js";
import type { Env } from "../src/env.js";
import type { LiveState } from "../src/live-types.js";

const SECRET = "s".repeat(40);
const ADMIN = "m_admin";
const PLAYER = "m_ada";

function durableState(): LiveState {
  const data = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") data.set(key, structuredClone(value));
        else for (const [name, stored] of Object.entries(key)) data.set(name, structuredClone(stored));
      },
      getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
    },
    acceptWebSocket: () => {}, getWebSockets: () => [],
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as LiveState;
}

async function fixture() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  const db = {
    prepare(sql: string) {
      const stmt = {
        values: [] as unknown[],
        bind(...values: unknown[]) { stmt.values = values; return stmt; },
        async all() { return { results: sqlite.prepare(sql).all(...(stmt.values as never[])), success: true }; },
        async first() { return sqlite.prepare(sql).get(...(stmt.values as never[])) ?? null; },
        async run() { const info = sqlite.prepare(sql).run(...(stmt.values as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
      };
      return stmt;
    },
  } as unknown as D1Like;
  const objects = new Map<string, LiveEventDO>();
  const reads: string[] = [];
  const live = (id: string) => {
    let entry = objects.get(id);
    if (!entry) { entry = new LiveEventDO(durableState(), { DB: db } as never); objects.set(id, entry); }
    return entry;
  };
  const env = {
    DB: db, JWT_SECRET: SECRET, ALLOWED_ORIGINS: "https://gvdgclub.com",
    LIVE: { idFromName: (name: string) => name, get: (id: string) => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => { reads.push(id); return live(id).fetch(new Request(input, init)); } }) },
    ROSTER: { get: async (key: string) => JSON.stringify({ memberId: key.slice(7), isAdmin: key.endsWith(ADMIN), name: "QA", pinVer: 0, mustChangePin: false }) },
    RATELIMIT: { get: async () => null, put: async () => {} },
  } as unknown as Env;
  const token = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);
  async function api(path: string, actor: string | null, method = "GET") {
    const headers = new Headers({ Origin: "https://gvdgclub.com" });
    if (actor) headers.set("Authorization", "Bearer " + await token(actor));
    const response = await worker.fetch(new Request("https://worker.test" + path, { method, headers }), env);
    const raw = await response.text();
    return { status: response.status, raw, data: raw ? JSON.parse(raw) : null };
  }
  async function start(code: string, startedAt: string, players: string[], { index = true, shared = true } = {}) {
    const response = await live("round:" + code).fetch(new Request("https://do/start", {
      method: "POST",
      body: JSON.stringify({ casual: true, roundCode: code, createdBy: shared ? PLAYER : null, courseName: "Pinebrook", layoutName: "Main",
        holes: [{ hole: 1, par: 3 }, { hole: 2, par: 3 }, { hole: 3, par: 4 }], players: players.map((name, i) => ({ memberId: "m_p" + i, name })), startedAt }),
    }));
    expect(response.status).toBe(200);
    if (index) sqlite.prepare("INSERT INTO live_round_index (key, course_name, started_at) VALUES (?, 'Pinebrook', ?)").run("round:" + code, startedAt);
  }
  return { sqlite, env, api, start, live, reads };
}

afterEach(() => { vi.useRealTimers(); });

describe("Admin › Live rounds", () => {
  it("lists every live casual round by code, even a ghost that fell out of the index, and an admin can end it", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    // A ghost: started yesterday, one hole scored, never finished, and no longer in the live index.
    vi.setSystemTime(Date.parse("2026-11-17T14:00:00Z"));
    await f.start("GHOST1", "2026-11-17T14:00:00Z", ["Ada Lovelace", "Bo Burnham"], { index: false });
    await f.live("round:GHOST1").fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Admin": "true" }, body: JSON.stringify({ index: 0, hole: 1, strokes: 3 }) }));
    // Today: a round out on the course right now (indexed), a finished one, and an indexed one that was cancelled.
    vi.setSystemTime(Date.parse("2026-11-18T15:00:00Z"));
    await f.start("FRESH2", "2026-11-18T15:00:00Z", ["Cy Young"]);
    f.sqlite.exec("INSERT INTO casual_round_sharing (round_code, visibility) VALUES ('DONE33', 'card')");
    f.sqlite.exec("INSERT INTO casual_rounds (round_code, course_name, finalized_at) VALUES ('DONE33', 'Pinebrook', '2026-11-18 13:00:00')");
    f.sqlite.exec("INSERT INTO live_round_index (key, course_name, started_at) VALUES ('round:GONE44', 'Pinebrook', '2026-11-18T10:00:00Z')");

    expect((await f.api("/admin/rounds/active", null)).status).toBe(401);
    expect((await f.api("/admin/rounds/active", PLAYER)).status).toBe(403);
    f.reads.length = 0;
    const listed = await f.api("/admin/rounds/active", ADMIN);
    expect(listed.status).toBe(200);
    expect(listed.data.rounds).toEqual([
      { code: "FRESH2", courseName: "Pinebrook", layoutName: "Main", startedAt: "2026-11-18T15:00:00Z", lastActivity: "2026-11-18T15:00:00.000Z",
        players: ["Cy Young"], holes: 3, holesScored: 0 },
      { code: "GHOST1", courseName: "Pinebrook", layoutName: "Main", startedAt: "2026-11-17T14:00:00Z", lastActivity: "2026-11-17T14:00:00.000Z",
        players: ["Ada Lovelace", "Bo Burnham"], holes: 3, holesScored: 1 },
    ]);
    // A saved round is never even asked about; names only (no member ids, no scores).
    expect(f.reads).not.toContain("round:DONE33");
    expect(listed.raw).not.toMatch(/m_p0|m_p1|"scores"/);
    // The cancelled round's stale index row is cleaned up.
    expect(f.sqlite.prepare("SELECT key FROM live_round_index ORDER BY key").all()).toEqual([{ key: "round:FRESH2" }]);

    // The admin ends the ghost (the existing admin cancel): it leaves the list and everyone's Home.
    expect((await f.api("/rounds/GHOST1/cancel", PLAYER, "POST")).status).toBe(403);
    expect((await f.api("/rounds/GHOST1/cancel", ADMIN, "POST")).status).toBe(200);
    expect((await f.api("/admin/rounds/active", ADMIN)).data.rounds.map((round: { code: string }) => round.code)).toEqual(["FRESH2"]);
  });

  it("keeps a card older than 14 hours in the index (off the traffic board), so admins can still find it", async () => {
    const f = await fixture();
    await f.start("OLDIE5", "2026-11-17T08:00:00Z", ["Ada Lovelace"], { shared: false });
    const traffic = await courseTrafficPayload(f.env, Date.parse("2026-11-18T15:00:00Z"));
    expect(traffic.courses).toEqual([]);
    expect(f.sqlite.prepare("SELECT key FROM live_round_index").all()).toEqual([{ key: "round:OLDIE5" }]);
    expect((await f.api("/admin/rounds/active", ADMIN)).data.rounds.map((round: { code: string }) => round.code)).toEqual(["OLDIE5"]);
  });

  it("doesn't let the public reach the round summary", async () => {
    const f = await fixture();
    await f.start("PRIV66", "2026-11-18T15:00:00Z", ["Ada Lovelace"]);
    for (const path of ["/rounds/PRIV66/live/summary", "/rounds/PRIV66/summary", "/events/0/live/summary"]) {
      expect((await f.api(path, null)).raw).not.toMatch(/holesScored/);
    }
  });
});
