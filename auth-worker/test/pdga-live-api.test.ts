import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { emptyPlayTotals } from "../src/play-stats.js";
import {
  applyPdgaLiveStatsToTotals,
  fetchPdgaLiveDivisions,
  fetchPdgaLiveEvent,
  fetchPdgaLivePlayer,
  fetchPdgaLiveRound,
  fetchPdgaLiveScoreStats,
  playTotalsFromLivePlayerRound,
  purgePdgaLiveCaches,
  type PdgaLiveApiEnv,
} from "../src/pdga-live-api.js";

const ORIGIN = "http://localhost:8080";
const LIVE_BASE = "https://live.test.pdga";
const STATS_BASE = "https://stats.test.pdga";
const NOW = Date.UTC(2026, 10, 23, 15, 0, 0);

function sqliteEnv() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
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
    CREATE TABLE kv_store (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (ns, key));
  `);
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
  const DB = { prepare, async batch(stmts: { run(): Promise<unknown> }[]) { for (const s of stmts) await s.run(); return []; } };
  const kv = () => {
    const rows = new Map<string, string>();
    return {
      async get(key: string) { return rows.get(key) ?? null; },
      async put(key: string, val: string) { rows.set(key, val); },
      async delete(key: string) { rows.delete(key); },
      async list() { return { keys: [], list_complete: true }; },
    };
  };
  const liveEnv: PdgaLiveApiEnv = {
    DB: DB as never,
    PDGA_LIVE_API_BASE: LIVE_BASE,
    PDGA_LIVE_STATS_BASE: STATS_BASE,
  };
  const workerEnv = {
    ...liveEnv,
    RATELIMIT: kv(),
    ROSTER: kv(),
    JWT_SECRET: "x".repeat(40),
    ALLOWED_ORIGINS: ORIGIN,
  } as unknown as Env;
  return { raw, DB, liveEnv, workerEnv };
}

afterEach(() => vi.unstubAllGlobals());

describe("pdga-live-api client", () => {
  it("sends If-None-Match on expiry and keeps cached payload on 304 Not Modified", async () => {
    const { liveEnv } = sqliteEnv();
    const seenHeaders: Record<string, string>[] = [];
    let call = 0;
    vi.stubGlobal("fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const hdrs: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => { hdrs[key] = value; });
      seenHeaders.push(hdrs);
      if (call === 1) {
        return Response.json(
          {
            data: {
              TournamentId: 96414,
              Name: "Greenville &amp; Open",
              StartDate: "2026-11-20",
              EndDate: "2026-11-21",
              FormattedTier: "B-Tier",
              Divisions: [{ Division: "MPO", Players: 12, LatestRound: 2 }],
              RoundsList: { "1": { Number: 1, Label: "Round 1", LabelAbbreviated: "Rd 1", Date: "2026-11-20" } },
            },
            hash: "h",
          },
          { headers: { ETag: 'W/"ev-1"' } },
        );
      }
      return new Response(null, { status: 304 });
    });

    const first = await fetchPdgaLiveEvent(liveEnv, 96414, NOW);
    expect(first).toMatchObject({ tournId: 96414, name: "Greenville & Open", tier: "B-Tier" });
    expect(seenHeaders[0]!["user-agent"]).toContain("GVDGClubSite");

    // Within TTL: no network fetch.
    await fetchPdgaLiveEvent(liveEnv, 96414, NOW + 60_000);
    expect(call).toBe(1);

    // Past 5-minute TTL: sends If-None-Match -> handles 304 and refreshes cache.
    const second = await fetchPdgaLiveEvent(liveEnv, 96414, NOW + 10 * 60_000);
    expect(second).toEqual(first);
    expect(call).toBe(2);
    expect(seenHeaders[1]!["if-none-match"]).toBe('W/"ev-1"');
  });

  it("handles { data: [] } empty envelopes, 404s, and pooled divisions", async () => {
    const { liveEnv } = sqliteEnv();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("live_results_fetch_event")) return Response.json({ data: [], hash: "e" });
      if (url.includes("live_results_fetch_round") && url.includes("Round=13")) {
        // Pooled array + playoff round (RoundRating must be forced null) + DNF 999
        return Response.json({
          data: [
            {
              division: "MPO",
              pool: "A",
              holes: [{ Par: 3 }, { Par: 3 }],
              scores: [
                { ResultID: 1, Name: "Ada", PDGANum: 80024, HasPDGANum: 1, Round: 13, RunningPlace: 1, Tied: true, ToPar: -2, RoundScore: 6, Played: 2, Completed: 1, RoundRating: 1050, HoleScores: ["3", "3"], Pars: "3,3" },
                { ResultID: 2, Name: "Bo", PDGANum: 0, HasPDGANum: 0, Round: 13, RunningPlace: 99, Tied: false, ToPar: 0, RoundScore: 999, Played: 1, Completed: 0, RoundRating: 800, HoleScores: ["999", ""], Pars: "3,3" },
              ],
            },
            {
              division: "MPO",
              pool: "B",
              holes: [{ Par: 3 }],
              scores: [{ ResultID: 3, Name: "Cy", PDGANum: 12345, HasPDGANum: 1, Round: 1, RunningPlace: 1, Tied: false, ToPar: -1, RoundScore: 53, Played: 18, Completed: 1, RoundRating: 995, HoleScores: ["2"], Pars: "3" }],
            },
          ],
          hash: "r",
        });
      }
      if (url.includes("live_results_fetch?")) {
        return Response.json({
          data: {
            MA1: [{ division: "MA1", pool: "A", holes: [], scores: [{ ResultID: 10, Name: "Dan", PDGANum: 77777, HasPDGANum: 1 }] }],
          },
          hash: "f",
        });
      }
      return new Response("missing", { status: 404 });
    });

    expect(await fetchPdgaLiveEvent(liveEnv, 99999, NOW)).toBeNull();
    expect(await fetchPdgaLiveScoreStats(liveEnv, 999, NOW)).toBeNull();

    const blocks = await fetchPdgaLiveRound(liveEnv, 96414, "MPO", "Playoff", NOW);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.pool).toBe("A");
    expect(blocks[0]!.scores[0]!.roundRating).toBeNull();
    expect(blocks[0]!.scores[1]!.dnf).toBe(true);
    expect(blocks[0]!.scores[1]!.roundScore).toBeNull();
    expect(blocks[0]!.scores[1]!.pdgaNumber).toBeNull();

    const map = await fetchPdgaLiveDivisions(liveEnv, 96414, ["MA1"], 1, NOW);
    expect(map.get("MA1")?.[0]?.scores[0]?.pdgaNumber).toBe("77777");
  });

  it("ignores statOpportunityCount === 0, ignores DNF hole scores, and aggregates statCount/statOpportunityCount", () => {
    const totals = emptyPlayTotals();
    const ob = applyPdgaLiveStatsToTotals(totals, [
      { statId: 1, statCount: 0, statOpportunityCount: 0, statValue: 0 },
      { statId: 1, statCount: 10, statOpportunityCount: 15, statValue: 66.67 },
      { statId: 7, statCount: 9, statOpportunityCount: 12, statValue: 75 },
      { statId: 9, statCount: 2, statOpportunityCount: 18, statValue: 11.1 },
    ]);
    expect(totals.fir_hit).toBe(10);
    expect(totals.fir_att).toBe(15);
    expect(totals.c1x_putt_hit).toBe(9);
    expect(totals.c1x_putt_att).toBe(12);
    expect(ob).toEqual({ obCount: 2, obHoles: 18 });

    const obReversed = applyPdgaLiveStatsToTotals(emptyPlayTotals(), [
      { statId: 21, statCount: 2, statOpportunityCount: 18, statValue: 2 },
      { statId: 9, statCount: 2, statOpportunityCount: 18, statValue: 11.1 },
    ]);
    expect(obReversed).toEqual({ obCount: 2, obHoles: 18 });

    const playerTotals = playTotalsFromLivePlayerRound({
      scoreId: 1,
      round: 1,
      roundDate: "2026-11-01",
      roundField: "Rd1",
      roundScore: 999,
      roundToPar: null,
      roundComplete: false,
      roundRating: null,
      dnf: true,
      holeScores: {},
      holePars: {},
    });
    expect(playerTotals.holes).toBe(0);
  });

  it("ignores DNF 888/999 scores per-round (keeping earlier completed rounds) and purges expired Section 6 rows", async () => {
    const { raw, liveEnv } = sqliteEnv();
    vi.stubGlobal("fetch", async () => Response.json({
      data: {
        ResultID: 71,
        TournID: 90,
        PDGANum: 80024,
        Name: "Ada",
        Division: "FPO",
        DNF: true,
        Scores: [
          { ScoreID: 1, Round: 1, RoundScore: 54, RoundComplete: true, RoundRating: 960, HoleScores: { "1": 3, "2": 3 }, Layout: { Detail: { "1": { Par: 3 }, "2": { Par: 3 } } } },
          { ScoreID: 2, Round: 2, RoundScore: 888, RoundRating: 900, HoleScores: { "1": 888, "2": 3 }, Layout: { Detail: { "1": { Par: 3 }, "2": { Par: 3 } } } },
          { ScoreID: 3, Round: 13, RoundScore: 3, RoundRating: 990, HoleScores: { "1": 3 }, Layout: { Detail: { "1": { Par: 3 } } } },
        ],
      },
      hash: "h",
    }));

    const player = await fetchPdgaLivePlayer(liveEnv, 71, NOW);
    expect(player?.scores[0]?.dnf).toBe(false);
    expect(player?.scores[0]?.roundRating).toBe(960);
    expect(player?.scores[1]?.dnf).toBe(true);
    expect(player?.scores[1]?.roundScore).toBeNull();
    expect(player?.scores[1]?.roundRating).toBeNull();
    expect(player?.scores[1]?.holeScores).toEqual({ "2": 3 });
    expect(player?.scores[2]?.roundRating).toBeNull();

    raw.prepare("INSERT INTO pdga_live_cache VALUES ('old', null, '{}', 1, ?), ('fresh', null, '{}', 1, ?)").run(NOW - 1, NOW + 60_000);
    raw.prepare("INSERT INTO pdga_watch_events (event_id, state, name, start_date, end_date, listed_at, expires_at) VALUES (1, 'NC', 'Old', '2026-01-01', '2026-01-01', 1, ?), (2, 'NC', 'Fresh', '2026-12-01', '2026-12-01', 1, ?)").run(NOW - 1, NOW + 60_000);
    raw.prepare("INSERT INTO pdga_member_event_links (event_id, member_id, pdga_number, result_id, matched_at, expires_at) VALUES (1, 'm_a', '80024', 10, 1, ?), (2, 'm_a', '80024', 20, 1, ?)").run(NOW - 1, NOW + 60_000);

    expect(await purgePdgaLiveCaches(liveEnv.DB, NOW)).toEqual({ liveResponses: 1, watchEvents: 1, memberLinks: 1 });
    expect((raw.prepare("SELECT COUNT(*) AS c FROM pdga_live_cache WHERE expires_at <= ?").get(NOW) as { c: number }).c).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) AS c FROM pdga_live_cache").get() as { c: number }).c).toBe(2); // fresh + player:71
    expect((raw.prepare("SELECT COUNT(*) AS c FROM pdga_watch_events").get() as { c: number }).c).toBe(1);
    expect((raw.prepare("SELECT COUNT(*) AS c FROM pdga_member_event_links").get() as { c: number }).c).toBe(1);
  });

  it("serves GET /pdga/live/event/:tournId with standings, detailed stats, and PDGA attribution", async () => {
    const { workerEnv } = sqliteEnv();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("live_results_fetch_event")) {
        return Response.json({
          data: {
            TournamentId: 96414,
            Name: "Greenville Open",
            StartDate: "2026-11-21",
            EndDate: "2026-11-22",
            HighestCompletedRound: 1,
            LatestRound: 1,
            Divisions: [{ Division: "MPO", Players: 8, LatestRound: 1 }],
            RoundsList: { "1": { Number: 1, Label: "Round 1", LabelAbbreviated: "Rd 1", Date: "2026-11-21" } },
          },
          hash: "e",
        });
      }
      if (url.includes("live_results_fetch_round")) {
        return Response.json({
          data: {
            division: "MPO",
            pool: null,
            holes: Array.from({ length: 18 }, () => ({ Par: 3 })),
            scores: [{
              ResultID: 301,
              Name: "Paul McBeth",
              ShortName: "P. McBeth",
              PDGANum: 27523,
              HasPDGANum: 1,
              Division: "MPO",
              RunningPlace: 1,
              Tied: false,
              PreviousPlace: 2,
              ToPar: -8,
              ParThruRound: -8,
              RoundtoPar: -8,
              RoundScore: 46,
              Played: 18,
              Completed: 1,
              RoundRating: 1054,
              HoleScores: Array.from({ length: 18 }, () => "3"),
            }],
          },
          hash: "r",
        });
      }
      if (url.includes("tournament-division-stats/96414/MPO")) {
        return Response.json({
          resultStats: [{
            result: { resultId: 301, dnf: false },
            stats: [
              { statId: 1, statCount: 15, statOpportunityCount: 18, statValue: 83.33, rank: 1, isTie: false },
              { statId: 4, statCount: 0, statOpportunityCount: 0, statValue: 0 },
              { statId: 21, statCount: 1, statOpportunityCount: 18, statValue: 1 },
            ],
          }],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const bad = await worker.fetch(new Request("https://worker/pdga/live/event/not-a-num", { headers: { Origin: ORIGIN } }), workerEnv);
    expect(bad.status).toBe(400);

    const res = await worker.fetch(new Request("https://worker/pdga/live/event/96414", { headers: { Origin: ORIGIN } }), workerEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    const body = await res.json() as {
      division: string;
      round: string;
      pdgaEventUrl: string;
      pdgaLiveUrl: string;
      blocks: { scores: { name: string; roundRating: number | null; stats: Record<string, unknown> | null }[] }[];
    };
    expect(body.division).toBe("MPO");
    expect(body.round).toBe("1");
    expect(body.pdgaEventUrl).toBe("https://www.pdga.com/tour/event/96414");
    expect(body.pdgaLiveUrl).toBe("https://www.pdga.com/live/event/96414/MPO/scores?round=1");
    expect(body.blocks[0]!.scores[0]!.roundRating).toBe(1054);
    expect(body.blocks[0]!.scores[0]!.stats).toEqual({
      fwh: { hit: 15, opp: 18, value: 83.33, rank: 1, isTie: false },
      obCount: { hit: 1, opp: 18, value: 1, rank: null, isTie: null },
    });
  });
});
