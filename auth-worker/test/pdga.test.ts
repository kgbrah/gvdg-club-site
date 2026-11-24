import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { resetPdgaApiSession } from "../src/pdga-api.js";
import { PDGA_STATS_VERSION, statsFromPlayer } from "../src/pdga.js";

// PDGA Developer Program compliance: Worker reads PDGA data ONLY through PDGA's documented REST API
// (api.pdga.com) and official PDGA Live API (https://www.pdga.com/dev/api/live), never scraping pdga.com HTML pages
// or undocumented /api/v1/feat/members/* endpoints, with temporary caching purged hourly.

const ORIGIN = "http://localhost:8080";
const API = "https://api.test.pdga";
const LIVE_API = "https://live.test.pdga";
const STATS_API = "https://stats.test.pdga";

function memoryKv() {
  const rows = new Map<string, string>();
  return {
    async get(key: string) { return rows.get(key) ?? null; },
    async put(key: string, value: string) { rows.set(key, value); },
    async delete(key: string) { rows.delete(key); },
    async list() { return { keys: [], list_complete: true }; },
  };
}

async function env(
  players: Record<string, Record<string, unknown>> = {},
  liveHandlers: Record<string, unknown> = {},
  annualStats: Record<string, Record<string, unknown>[]> = {},
) {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE pdga_api_players (pdga_number TEXT PRIMARY KEY, data TEXT, fetched_at INTEGER NOT NULL);
    CREATE TABLE pdga_api_player_stats (pdga_number TEXT NOT NULL, year INTEGER NOT NULL, data TEXT, fetched_at INTEGER NOT NULL, PRIMARY KEY (pdga_number, year));
    CREATE TABLE pdga_live_cache (cache_key TEXT PRIMARY KEY, etag TEXT, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE pdga_watch_events (
      event_id INTEGER PRIMARY KEY, state TEXT NOT NULL, name TEXT NOT NULL, tier TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '', start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      listed_at INTEGER NOT NULL, read_at INTEGER, read_error TEXT NOT NULL DEFAULT '',
      completed INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL
    );
    CREATE TABLE pdga_member_event_links (
      event_id INTEGER NOT NULL, member_id TEXT NOT NULL, pdga_number TEXT NOT NULL, result_id INTEGER NOT NULL,
      division TEXT NOT NULL DEFAULT '', event_start TEXT NOT NULL DEFAULT '', event_end TEXT NOT NULL DEFAULT '',
      matched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (event_id, member_id)
    );
  `);
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { bound = args; return statement; },
      async all() { return { results: sqlite.prepare(sql).all(...(bound as never[])), success: true }; },
      async first() { return sqlite.prepare(sql).get(...(bound as never[])) ?? null; },
      async run() { const info = sqlite.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
    };
    return statement;
  };
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/services/json/user/login")) return Response.json({ sessid: "s", session_name: "SESS", token: "t" });
    if (url.startsWith(API)) {
      const parsed = new URL(url);
      if (parsed.pathname === "/services/json/player-statistics") {
        const year = parsed.searchParams.get("year") ?? "";
        const pdgaNo = parsed.searchParams.get("pdga_number") ?? "";
        const rows = (annualStats[year] ?? []).filter((r) => !pdgaNo || String(r.pdga_number ?? "") === pdgaNo);
        return Response.json({ sessid: "s", status: rows.length ? 0 : 1, players: rows });
      }
      const numbers = (parsed.searchParams.get("pdga_number") ?? "").split(",");
      return Response.json({ players: numbers.flatMap((number) => players[number] ? [players[number]] : []) });
    }
    for (const [needle, body] of Object.entries(liveHandlers)) {
      if (url.includes(needle)) {
        return Response.json(body, { headers: { ETag: `W/"${needle}"` } });
      }
    }
    return new Response("Not found", { status: 404 });
  });
  resetPdgaApiSession();
  return {
    calls,
    sqlite,
    env: {
      DB: { prepare, async batch(statements: { run(): Promise<unknown> }[]) { for (const s of statements) await s.run(); return []; } },
      RATELIMIT: memoryKv(),
      ROSTER: memoryKv(),
      JWT_SECRET: "x".repeat(40),
      ALLOWED_ORIGINS: ORIGIN,
      PDGA_API_USERNAME: "club",
      PDGA_API_PASSWORD: "pw",
      PDGA_API_BASE: API,
      PDGA_LIVE_API_BASE: LIVE_API,
      PDGA_LIVE_STATS_BASE: STATS_API,
    } as unknown as Env,
  };
}

const stats = (target: Env, query: string, ip = "203.0.113.9") =>
  worker.fetch(new Request("https://worker/pdga-stats?" + query, { headers: { Origin: ORIGIN, "CF-Connecting-IP": ip } }), target);

afterEach(() => vi.unstubAllGlobals());

describe("GET /pdga-stats", () => {
  it("returns the official rating from REST API when no matched Live events exist", async () => {
    const { env: target, calls } = await env({ "80024": { pdga_number: "80024", first_name: "Ada", last_name: "Lovelace",
      membership_status: "current", rating: "941", rating_effective_date: "2026-11-11" } });
    const response = await stats(target, "pdga=80024");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(statsFromPlayer("80024", {
      pdgaNumber: "80024", name: "Ada Lovelace", membershipStatus: "current", membershipExpires: null, rating: 941, ratingDate: "2026-11-11",
      classification: null, city: null, state: null, country: null, url: "https://www.pdga.com/player/80024",
    }));
    expect(calls.every((url) => url.startsWith(API + "/services/json/"))).toBe(true);
    const body = statsFromPlayer("1", null);
    expect(body).toMatchObject({ official_rating: null, previous_rating: null, live_rating: null, peak_rating: null, events_count: 0,
      events: [], play_rounds: [], source: "pdga-api", stats_version: PDGA_STATS_VERSION });
  });

  it("enriches /pdga-stats with annual REST stats, documented PDGA Live round details, and /api/v1/ throw/putting stats, then serves from temporary cache", async () => {
    const currentYear = String(new Date().getUTCFullYear());
    const { env: target, sqlite, calls } = await env(
      { "80024": { pdga_number: "80024", first_name: "Ada", last_name: "Lovelace",
        membership_status: "current", rating: "941", rating_effective_date: "2026-11-11" } },
      {
        "live_results_fetch_player?ResultID=555": {
          data: {
            ResultID: 555,
            TournID: 96414,
            PDGANum: 80024,
            Name: "Ada Lovelace",
            Division: "FPO",
            Place: 2,
            Total: 106,
            ToPar: -6,
            AverageRoundRating: 961,
            Scores: [
              {
                ScoreID: 8801,
                Round: 1,
                RoundDate: "2026-11-01",
                RoundScore: 54,
                RoundToPar: -2,
                RoundComplete: true,
                RoundRating: 952,
                HoleScores: { "1": 2, "2": 3, "3": 4 },
                Layout: { Detail: { "1": { Par: 3 }, "2": { Par: 3 }, "3": { Par: 3 } } },
              },
              {
                ScoreID: 8802,
                Round: 2,
                RoundDate: "2026-11-02",
                RoundScore: 52,
                RoundToPar: -4,
                RoundComplete: true,
                RoundRating: 970,
                HoleScores: { "1": 2, "2": 2, "3": 3 },
                Layout: { Detail: { "1": { Par: 3 }, "2": { Par: 3 }, "3": { Par: 3 } } },
              },
              {
                ScoreID: 8803,
                Round: 13,
                RoundDate: "2026-11-02",
                RoundScore: 3,
                RoundToPar: 0,
                RoundComplete: true,
                RoundRating: 999,
                HoleScores: { "1": 3 },
                Layout: { Detail: { "1": { Par: 3 } } },
              },
            ],
          },
          hash: "h",
        },
        "/feat/live-scores/8801/round-stats": [
          { statId: 1, statCount: 12, statOpportunityCount: 16, statValue: 75 },
          { statId: 7, statCount: 8, statOpportunityCount: 10, statValue: 80 },
          { statId: 9, statCount: 1, statOpportunityCount: 18, statValue: 5.56 },
        ],
        "/feat/live-scores/8802/round-stats": [
          { statId: 1, statCount: 14, statOpportunityCount: 16, statValue: 87.5 },
          { statId: 2, statCount: 10, statOpportunityCount: 18, statValue: 55.6 },
          { statId: 9, statCount: 2, statOpportunityCount: 18, statValue: 11.11 },
        ],
      },
      {
        [currentYear]: [
          {
            pdga_number: "80024",
            year: currentYear,
            division_code: "FPO",
            division_name: "Pro Open Women",
            class: "P",
            rating: "941",
            events: "6",
            points: "340.5",
            prize: "$150.00",
            players_defeated: "48",
            wins: "1",
          },
        ],
      },
    );
    const future = Date.now() + 86_400_000;
    sqlite.prepare("INSERT INTO pdga_watch_events (event_id, state, name, start_date, end_date, listed_at, completed, expires_at) VALUES (96414, 'NC', 'Greenville &amp; Open', '2026-11-01', '2026-11-02', 1, 1, ?)").run(future);
    sqlite.prepare("INSERT INTO pdga_member_event_links (event_id, member_id, pdga_number, result_id, division, event_start, event_end, matched_at, expires_at) VALUES (96414, 'm_a', '80024', 555, 'FPO', '2026-11-01', '2026-11-02', 1, ?)").run(future);

    const response = await stats(target, "pdga=80024");
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      pdga: "80024",
      official_rating: 941,
      live_rating: 961,
      peak_rating: 970,
      events_count: 1,
      live_stats: { ob_count: 3, ob_holes: 36 },
      stats_version: PDGA_STATS_VERSION,
      source: "pdga-api",
      annual_stats: [
        {
          year: Number(currentYear),
          divisionCode: "FPO",
          divisionName: "Pro Open Women",
          classification: "P",
          rating: 941,
          events: 6,
          points: 340.5,
          prize: 150,
          playersDefeated: 48,
          wins: 1,
          url: `https://www.pdga.com/player/80024/stats/${currentYear}`,
        },
      ],
    });
    expect(body.events).toEqual([
      {
        tournament: "Greenville &amp; Open",
        date: "2026-11-01",
        epoch: Math.floor(Date.parse("2026-11-01T12:00:00Z") / 1000),
        division: "FPO",
        eventId: "96414",
        place: 2,
        total: 106,
        to_par: -6,
        average_rating: 961,
        dnf: false,
        live_url: "https://www.pdga.com/live/event/96414/FPO/scores",
        rounds: [
          {
            rating: 952,
            score: 54,
            round: "1",
            to_par: -2,
            date: "2026-11-01",
            complete: true,
            holes: 3,
            aces: 0,
            eagles: 0,
            birdies: 1,
            pars: 1,
            bogeys: 1,
            doubles_plus: 0,
            stats: {
              fwh: { hit: 12, opp: 16 },
              c1x: { hit: 8, opp: 10 },
              ob: { count: 1, holes: 18 },
            },
          },
          {
            rating: 970,
            score: 52,
            round: "2",
            to_par: -4,
            date: "2026-11-02",
            complete: true,
            holes: 3,
            aces: 0,
            eagles: 0,
            birdies: 2,
            pars: 1,
            bogeys: 0,
            doubles_plus: 0,
            stats: {
              fwh: { hit: 14, opp: 16 },
              c1r: { hit: 10, opp: 18 },
              ob: { count: 2, holes: 18 },
            },
          },
        ],
      },
    ]);
    expect(body.play).toMatchObject({
      holes: 7,
      birdies: 3,
      pars: 3,
      bogeys: 1,
      fir_hit: 26,
      fir_att: 32,
      c1r_hit: 10,
      c1r_att: 18,
      c1x_putt_hit: 8,
      c1x_putt_att: 10,
    });

    const before = calls.length;
    for (let i = 0; i < 35; i++) expect((await stats(target, "pdga=80024")).status).toBe(200);
    expect(calls.length).toBe(before);
  });

  it("rejects bad numbers, and answers the QA drive's member without calling PDGA", async () => {
    const { env: target, calls } = await env();
    expect((await stats(target, "pdga=abc")).status).toBe(400);
    expect(await (await stats(target, "pdga=90000001")).json()).toMatchObject({
      official_rating: 935,
      live_rating: 941,
      peak_rating: 958,
      events_count: 3,
      play: { holes: 54, fir_hit: 34, fir_att: 48 },
    });
    expect(calls).toEqual([]);
  });
});

describe("the Worker's PDGA sources", () => {
  it("allows documented Live API URLs only inside pdga-live-api.ts and forbids scraping / undocumented endpoints everywhere", () => {
    const dir = new URL("../src/", import.meta.url);
    const walk = (sub: string): string[] => readdirSync(new URL(sub, dir)).map(String).flatMap((name) => {
      if (name.endsWith(".ts")) return [sub + name];
      try { return walk(sub + name + "/"); } catch { return []; } // not a directory
    });
    const files = walk("").filter((name) => name.endsWith(".ts"));
    const offenders = files.flatMap((name) => {
      const text = readFileSync(new URL(name, dir), "utf8");
      const baseForbidden = [
        /feat\/members/,
        /rating-detail/,
        /fetch\([^)]*pdga\.com\/(?:player|tour)/,
        /GVDG-DGS-Scraper/,
        /discgolfscene\.com\/tournaments\/search/,
        /parseDiscGolfScene/,
        /safeFetch\([^)]*discgolfscene/,
        /pdga-baseline/,
      ];
      const liveApiUrlPatterns = name === "pdga-live-api.ts"
        ? []
        : [/pdga\.com\/api\/v1/, /apps\/tournament\/live-api/, /live_results_fetch/];
      return [...baseForbidden, ...liveApiUrlPatterns]
        .flatMap((pattern) => pattern.test(text) ? [name + " " + pattern] : []);
    });
    expect(offenders).toEqual([]);
  });
});
