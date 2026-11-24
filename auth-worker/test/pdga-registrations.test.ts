import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { resetPdgaApiSession } from "../src/pdga-api.js";
import { refreshPdgaRegistrations } from "../src/pdga-registrations.js";
import { putMember } from "../src/roster.js";

const ORIGIN = "http://localhost:8080";
const API_BASE = "https://api.test.pdga";
const LIVE_BASE = "https://live.test.pdga";
const STATS_BASE = "https://stats.test.pdga";
const SECRET = "test-secret-" + "s".repeat(40);
const MIGRATIONS = new URL("../migrations/", import.meta.url);

function memoryKv() {
  const rows = new Map<string, string>();
  return {
    async get(key: string) { return rows.get(key) ?? null; },
    async put(key: string, value: string) { rows.set(key, value); },
    async delete(key: string) { rows.delete(key); },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      return {
        keys: [...rows.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

async function migratedDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      async all() { return { results: sqlite.prepare(sql).all(...(bound as never[])), success: true }; },
      async first() { return sqlite.prepare(sql).get(...(bound as never[])) ?? null; },
      async run() { const info = sqlite.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
    };
    return stmt;
  };
  return {
    sqlite,
    DB: { prepare, async batch(stmts: { run(): Promise<unknown> }[]) { for (const s of stmts) await s.run(); return []; } },
  };
}

async function setupEnv() {
  const { sqlite, DB } = await migratedDb();
  const ROSTER = memoryKv();
  await putMember(ROSTER, { memberId: "m_ada", name: "Ada Lovelace", pdgaNo: "80024", isAdmin: false, pinHash: "x", mustChangePin: false });
  await putMember(ROSTER, { memberId: "m_grace", name: "Grace Hopper", pdgaNo: "90011", isAdmin: true, pinHash: "x", mustChangePin: false });
  await putMember(ROSTER, { memberId: "m_held", name: "Held Member", pdgaNo: "77777", held: true, pinHash: "x", mustChangePin: false });
  const env = {
    DB,
    ROSTER,
    RATELIMIT: memoryKv(),
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    PDGA_API_USERNAME: "club",
    PDGA_API_PASSWORD: "pw",
    PDGA_API_BASE: API_BASE,
    PDGA_LIVE_API_BASE: LIVE_BASE,
    PDGA_LIVE_STATS_BASE: STATS_BASE,
  } as unknown as Env;
  return { sqlite, env };
}

afterEach(() => vi.unstubAllGlobals());

describe("PDGA Live registrations & migration 0080", () => {
  it("replays migrations 0001 through 0083 cleanly with foreign keys ON", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (file === "0080_pdga_live_cache.sql") break;
      sqlite.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
    }
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec("BEGIN");
    for (const file of files.filter((f) => f >= "0080_pdga_live_cache.sql")) {
      sqlite.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
    }
    sqlite.exec("COMMIT");
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pdga_%' ORDER BY name").all();
    expect(tables).toEqual([
      { name: "pdga_api_player_stats" },
      { name: "pdga_api_players" },
      { name: "pdga_live_cache" },
      { name: "pdga_member_event_links" },
      { name: "pdga_watch_events" },
    ]);
  });

  it("matches members via Live API rosters, hides clubmate PDGA #s, removes withdrawals, and preserves completed links", async () => {
    resetPdgaApiSession();
    const { sqlite, env } = await setupEnv();
    // Pick a current epoch timestamp aligned to state index 0 ("NC") so Date.now() queries treat rows as unexpired.
    const now = Math.floor(Date.now() / (3 * 3_600_000)) * (3 * 3_600_000);
    const futureDay = new Date(now + 10 * 86_400_000).toISOString().slice(0, 10);
    const pastDay = new Date(now - 5 * 86_400_000).toISOString().slice(0, 10);

    let withdrawn = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/user/login")) return Response.json({ sessid: "s", session_name: "SESS", token: "t" });
      if (url.startsWith(API_BASE + "/services/json/event")) {
        return Response.json({
          events: [{
            tournament_id: "501",
            tournament_name: "Greenville Winter Classic",
            tier: "B",
            city: "Greenville",
            state_prov: "NC",
            start_date: futureDay,
            end_date: futureDay,
          }],
        });
      }
      if (url.includes("live_results_fetch_event?TournID=501")) {
        return Response.json({
          data: {
            TournamentId: 501,
            Name: "Greenville Winter Classic",
            StartDate: futureDay,
            EndDate: futureDay,
            LocationShort: "Greenville, NC",
            FormattedTier: "B-Tier",
            Divisions: [{ Division: "MPO", Players: 3, LatestRound: 1 }],
          },
          hash: "e",
        });
      }
      if (url.includes("live_results_fetch?TournID=501")) {
        const scores = [
          { ResultID: 1001, PDGANum: 80024, HasPDGANum: 1, Division: "MPO", Name: "Ada" },
          ...(withdrawn ? [] : [{ ResultID: 1002, PDGANum: 90011, HasPDGANum: 1, Division: "MPO", Name: "Grace" }]),
          { ResultID: 1003, PDGANum: 77777, HasPDGANum: 1, Division: "MPO", Name: "Held" },
        ];
        return Response.json({ data: { MPO: [{ division: "MPO", scores }] }, hash: "f" });
      }
      return new Response("not found", { status: 404 });
    });

    // Seed an already-completed historical event not returned by today's upcoming search -> its links must survive.
    sqlite.prepare("INSERT INTO pdga_watch_events (event_id, state, name, start_date, end_date, listed_at, completed, expires_at) VALUES (400, 'NC', 'Past Open', ?, ?, 1, 1, ?)")
      .run(pastDay, pastDay, now + 86_400_000);
    sqlite.prepare("INSERT INTO pdga_member_event_links (event_id, member_id, pdga_number, result_id, division, event_start, event_end, matched_at, expires_at) VALUES (400, 'm_ada', '80024', 900, 'FPO', ?, ?, 1, ?)")
      .run(pastDay, pastDay, now + 86_400_000);

    const tick1 = await refreshPdgaRegistrations(env, now);
    expect(tick1).toMatchObject({ state: "NC", listed: 1, read: 1, matched: 2, failed: 0 });

    // Past event link survived even though 400 wasn't in upcoming search results.
    const pastLink = sqlite.prepare("SELECT result_id FROM pdga_member_event_links WHERE event_id = 400 AND member_id = 'm_ada'").get() as { result_id: number } | undefined;
    expect(pastLink?.result_id).toBe(900);

    const adaToken = await signSession({ sub: "m_ada", mustChangePin: false }, SECRET, 3600);
    const graceToken = await signSession({ sub: "m_grace", mustChangePin: false }, SECRET, 3600);

    const regRes = await worker.fetch(new Request("https://worker/pdga-registrations", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${adaToken}` },
    }), env);
    expect(regRes.status).toBe(200);
    const regText = await regRes.text();
    expect(regText).not.toContain("90011"); // clubmates' PDGA numbers never leak to the browser
    const regJson = JSON.parse(regText) as { mine: { eventId: number; going: { name: string; division: string }[] }[]; club: unknown[] };
    expect(regJson.mine).toHaveLength(1);
    expect(regJson.mine[0]!.eventId).toBe(501);
    expect(regJson.mine[0]!.going.map((g) => g.name)).toEqual(["Grace Hopper"]);
    expect(regJson.club).toEqual([]);

    // Non-admin denied status route; admin receives state & match counts.
    const denied = await worker.fetch(new Request("https://worker/admin/pdga-registrations/status", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${adaToken}` },
    }), env);
    expect(denied.status).toBe(403);
    const statusRes = await worker.fetch(new Request("https://worker/admin/pdga-registrations/status", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${graceToken}` },
    }), env);
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toMatchObject({ registrations: 3, members: 2 }); // 1 preserved past link (400) + 2 upcoming links (501)

    // When Grace withdraws on next check (past REREAD_MINUTES = 55), her link is removed.
    withdrawn = true;
    sqlite.prepare("DELETE FROM pdga_live_cache").run();
    const tick2 = await refreshPdgaRegistrations(env, now + 60 * 60_000 * 3); // 3 hours later -> back to NC
    expect(tick2.matched).toBe(1);
    const regAfter = await (await worker.fetch(new Request("https://worker/pdga-registrations", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${adaToken}` },
    }), env)).json() as { mine: { going: unknown[] }[] };
    expect(regAfter.mine[0]!.going).toEqual([]);
  });

  it("backfills unread seasonal NC/VA/SC events within 180 days at lowest priority without re-polling them", async () => {
    resetPdgaApiSession();
    const { sqlite, env } = await setupEnv();
    const now = Math.floor(Date.now() / (3 * 3_600_000)) * (3 * 3_600_000);
    const futureDay = new Date(now + 10 * 86_400_000).toISOString().slice(0, 10);
    const seasonPastDay = new Date(now - 90 * 86_400_000).toISOString().slice(0, 10);
    const liveReads: number[] = [];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/user/login")) return Response.json({ sessid: "s", session_name: "SESS", token: "t" });
      if (url.startsWith(API_BASE + "/services/json/event")) {
        return Response.json({
          events: [
            {
              tournament_id: "601",
              tournament_name: "Upcoming NC Open",
              tier: "B",
              city: "Greenville",
              state_prov: "NC",
              start_date: futureDay,
              end_date: futureDay,
            },
            {
              tournament_id: "602",
              tournament_name: "Seasonal Past Classic",
              tier: "C",
              city: "Raleigh",
              state_prov: "NC",
              start_date: seasonPastDay,
              end_date: seasonPastDay,
            },
          ],
        });
      }
      const evMatch = url.match(/live_results_fetch_event\?TournID=(\d+)/);
      if (evMatch) {
        const id = Number(evMatch[1]);
        liveReads.push(id);
        const day = id === 602 ? seasonPastDay : futureDay;
        return Response.json({
          data: {
            TournamentId: id,
            Name: id === 602 ? "Seasonal Past Classic" : "Upcoming NC Open",
            StartDate: day,
            EndDate: day,
            LocationShort: "NC",
            FormattedTier: "C-Tier",
            Divisions: [{ Division: "MA1", Players: 1, LatestRound: 1 }],
          },
          hash: "e",
        });
      }
      if (url.includes("live_results_fetch?")) {
        return Response.json({
          data: { MA1: [{ division: "MA1", scores: [{ ResultID: 2001, PDGANum: 80024, HasPDGANum: 1, Division: "MA1", Name: "Ada" }] }] },
          hash: "f",
        });
      }
      return new Response("not found", { status: 404 });
    });

    const tick1 = await refreshPdgaRegistrations(env, now);
    expect(tick1).toMatchObject({ state: "NC", listed: 2, read: 2, matched: 2, failed: 0 });
    expect(liveReads).toEqual([601, 602]); // upcoming prioritized before older seasonal event

    const pastLink = sqlite.prepare("SELECT result_id FROM pdga_member_event_links WHERE event_id = 602 AND member_id = 'm_ada'").get() as { result_id: number } | undefined;
    expect(pastLink?.result_id).toBe(2001);

    // Upcoming /pdga-registrations only lists upcoming events, never the 90-day-old one.
    const adaToken = await signSession({ sub: "m_ada", mustChangePin: false }, SECRET, 3600);
    const regJson = await (await worker.fetch(new Request("https://worker/pdga-registrations", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${adaToken}` },
    }), env)).json() as { mine: { eventId: number }[] };
    expect(regJson.mine.map((e) => e.eventId)).toEqual([601]);

    // Subsequent tick past DONE_RECHECK reads only upcoming 601 and never re-polls old 602.
    liveReads.length = 0;
    sqlite.prepare("DELETE FROM pdga_live_cache").run();
    await refreshPdgaRegistrations(env, now + 9 * 3_600_000);
    expect(liveReads).toEqual([601]);
  });
});
