import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { holePlayStats, mergePartnerPlayInputs, parseBreakdown, parseThrowsBody, playStatsByKind, playStatsView, roundPlayStats, selectPlayStatsView, totalsFromPdgaScoreLine, withPlayBreakdown } from "../src/play-stats.js";
import { putMember } from "../src/roster.js";

const TEE = { lat: 35.6, lng: -77.37 };
const BASKET = { lat: 35.6008, lng: -77.37 };
const HOLE = { hole: 1, par: 3, tee: TEE, target: BASKET };

function northOf(point: { lat: number; lng: number }, meters: number) {
  return { lat: point.lat + meters / 111320, lng: point.lng };
}

describe("play stats", () => {
  it("counts a C1 birdie from a marked lie", () => {
    const stats = holePlayStats(HOLE, [northOf(BASKET, 8)], 2);
    expect(stats.c1r?.hit).toBe(1);
    expect(stats.c1Putt?.hit).toBe(1);
  });

  it("merges throw stats onto a classic breakdown", () => {
    const next = withPlayBreakdown(
      { aces: 0, eagles: 0, birdies: 1, pars: 0, bogeys: 0, doubles_plus: 0 },
      { memberId: "m1", name: "Ann", scores: { 1: 2 }, throws: { 1: [{ ...northOf(BASKET, 8), n: 1 }] } },
      [HOLE],
    );
    expect(next.birdies).toBe(1);
    expect(next.c1r_hit).toBe(1);
    expect(next.holes).toBe(1);
  });

  it("parses throws posts and ranks birdie rate", () => {
    expect(parseThrowsBody({ hole: 1, throws: [{ lat: 35.6, lng: -77.37 }] })?.throws).toHaveLength(1);
    expect(parseThrowsBody({ hole: 0, throws: [] })).toBeNull();
    const view = playStatsView([
      { memberId: "a", name: "Ann", totals: parseBreakdown({ eagles: 1, birdies: 8, pars: 7, bogeys: 2, doubles_plus: 0 }) },
      { memberId: "b", name: "Ben", totals: parseBreakdown({ eagles: 0, birdies: 3, pars: 12, bogeys: 3, doubles_plus: 0 }) },
    ], "b");
    const birdie = view.find((row) => row.id === "birdie");
    expect(birdie?.mine?.rank).toBe(2);
    expect(roundPlayStats([HOLE], { 1: [northOf(BASKET, 8)] }, { 1: 2 }).c1_putt_hit).toBe(1);
    const split = playStatsByKind([
      { member_id: "b", name: "Ben", kind: "competitive", breakdown: { eagles: 1, birdies: 8, pars: 7, bogeys: 2, doubles_plus: 0 } },
      { member_id: "b", name: "Ben", kind: "casual", breakdown: { eagles: 0, birdies: 14, pars: 4, bogeys: 0, doubles_plus: 0 } },
    ], "b");
    expect(split.competitive.mine.totals.birdies).toBe(8);
    expect(split.casual.mine.totals.birdies).toBe(14);
    expect(split.competitive.mine.totals.holes).toBe(18);
    expect(split.casual.mine.totals.holes).toBe(18);
    const competitiveBirdie = split.competitive.categories.find((row) => row.id === "birdieMix");
    const casualBirdie = split.casual.categories.find((row) => row.id === "birdieMix");
    expect(competitiveBirdie?.mine?.hit).toBe(8);
    expect(casualBirdie?.mine?.hit).toBe(14);
  });

  it("keeps doubles and matchplay out of singles stroke mix", () => {
    const split = playStatsByKind([
      { member_id: "b", name: "Ben", kind: "competitive", group_format: "singles", scoring_style: "stroke", breakdown: { eagles: 0, birdies: 8, pars: 8, bogeys: 2, doubles_plus: 0 } },
      { member_id: "b", name: "Ben", kind: "competitive", group_format: "doubles", scoring_style: "stroke", breakdown: { eagles: 0, birdies: 16, pars: 2, bogeys: 0, doubles_plus: 0 } },
    ], "b");
    expect(selectPlayStatsView(split.competitive, "singles", "stroke")?.mine.totals.birdies).toBe(8);
    expect(selectPlayStatsView(split.competitive, "doubles", "all")?.mine.totals.birdies).toBe(16);
  });

  it("copies doubles team hole mix onto a partner with no personal scores", () => {
    const merged = mergePartnerPlayInputs([
      { scores: { 1: 2 }, throws: { 1: [{ ...northOf(BASKET, 8), n: 1 }] } },
      { scores: {}, throws: {} },
    ]);
    const play = roundPlayStats([HOLE], merged.throws, merged.scores);
    expect(play.birdies).toBe(1);
    expect(play.c1r_hit).toBe(1);
    expect(totalsFromPdgaScoreLine("2,3", "3,3", 2).birdies).toBe(1);
  });
});

const golden = JSON.parse(readFileSync(new URL("../../tests/fixtures/shot-stats-golden.json", import.meta.url), "utf8")) as {
  hole: Parameters<typeof holePlayStats>[0];
  cases: { title: string; throws: unknown; score: number; expect: Partial<ReturnType<typeof holePlayStats>> }[];
};
for (const fixture of golden.cases) {
  it(fixture.title, () => {
    expect(holePlayStats(golden.hole, fixture.throws, fixture.score)).toMatchObject(fixture.expect);
  });
}

it("GET /play-stats exposes club-hosted PDGA events under both competitive and pdga with clubPdgaEventIds", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  const migDir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, migDir), "utf8"));
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
  const kv = new Map<string, string>();
  const ROSTER = {
    async get(k: string) { return kv.get(k) ?? null; },
    async put(k: string, v: string) { kv.set(k, v); },
    async delete(k: string) { kv.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
  const SECRET = "s".repeat(40);
  await putMember(ROSTER, { memberId: "m1", name: "Ada", pdgaNo: "80024", pinHash: "x", mustChangePin: false });
  await putMember(ROSTER, { memberId: "m2", name: "Grace", pdgaNo: "90011", pinHash: "x", mustChangePin: false });

  const year = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date());
  const eventDay = `${year}-05-10`;
  sqlite.prepare("INSERT INTO events (id, type, name, date, status) VALUES (10, 'tournament', 'Club Sanctioned', ?, 'completed')").run(eventDay);
  sqlite.prepare("INSERT INTO event_config (event_id, pdga_event_id) VALUES (10, 104547)").run();
  sqlite.prepare("INSERT INTO events (id, type, name, date, status) VALUES (11, 'tournament', 'Club Weekly', ?, 'completed')").run(eventDay);

  const bd1 = JSON.stringify({ holes: 18, birdies: 5, pars: 11, bogeys: 2, fir_hit: 10, fir_att: 14 });
  const bd2 = JSON.stringify({ holes: 18, birdies: 3, pars: 12, bogeys: 3, fir_hit: 8, fir_att: 14 });
  sqlite.prepare("INSERT INTO results (event_id, member_id, name, breakdown) VALUES (10, 'm1', 'Ada', ?)").run(bd1);
  sqlite.prepare("INSERT INTO results (event_id, member_id, name, breakdown) VALUES (10, 'm2', 'Grace', ?)").run(bd2);
  sqlite.prepare("INSERT INTO results (event_id, member_id, name, breakdown) VALUES (11, 'm1', 'Ada', ?)").run(bd2);

  const env = {
    DB: { prepare, async batch(stmts: { run(): Promise<unknown> }[]) { for (const s of stmts) await s.run(); return []; } },
    ROSTER,
    RATELIMIT: ROSTER,
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: "http://localhost:8080",
  } as unknown as Env;

  const token = await signSession({ sub: "m1", mustChangePin: false }, SECRET, 3600);
  const res = await worker.fetch(new Request("https://worker/play-stats", {
    headers: { Origin: "http://localhost:8080", Authorization: "Bearer " + token },
  }), env);
  expect(res.status).toBe(200);
  const jsonBody = await res.json() as {
    competitive: { mine: { totals: { holes: number } } };
    pdga: { mine: { totals: { holes: number } }; categories: { id: string; mine?: { rank?: number | null } }[] };
    clubPdgaEventIds: string[];
  };
  expect(jsonBody.competitive.mine.totals.holes).toBe(36);
  expect(jsonBody.pdga.mine.totals.holes).toBe(18);
  expect(jsonBody.clubPdgaEventIds).toEqual(["104547"]);
  const pdgaBirdie = jsonBody.pdga.categories.find((c) => c.id === "birdie");
  expect(pdgaBirdie?.mine?.rank).toBe(1);
});
