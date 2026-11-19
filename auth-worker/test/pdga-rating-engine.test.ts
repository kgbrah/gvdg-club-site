import { describe, expect, it } from "vitest";
import { listMemberCasualResults } from "../src/db-results.js";
import { reviewPdgaMatch } from "../src/pdga-baseline-store.js";
import { getLiveRatingBaseline } from "../src/pdga-baseline-store.js";
import { repairRatingSource } from "../src/rating-repair.js";
import { RATING_METHODS, pointsPerThrow, roundRatingForScore } from "../src/rating-engine.js";
import { runRatingRepairCycle } from "../src/ratings-recompute.js";
import { getMemberRatings } from "../src/ratings.js";
import { readFileSync } from "node:fs";
import { PDGA_TEST_MIGRATIONS, pdgaTestDb } from "./pdga-test-db.js";

const TEE = { lat: 35.60, lng: -77.37 };
const PIN = { lat: 35.601, lng: -77.37 };
const LAYOUT = 4;
const ALPHA = "m_alpha";
const BETA = "m_beta";
const SINGLE = '{"groupFormat":"singles","scoringStyle":"stroke"}';

function positions(distance = 250) {
  return [1, 2, 3].map((hole) => ({ hole, par: 3, distance_ft: distance,
    tee: { ...TEE, lng: TEE.lng + hole / 100 }, target: { ...PIN, lng: TEE.lng + hole / 100 } }));
}

function card(total: number, distance = 250, startedAt?: string) {
  return JSON.stringify(positions(distance).map((hole) => ({
    hole: hole.hole, par: hole.par, strokes: hole.hole === 1 ? total - 6 : 3,
    layoutAtPlay: { layoutId: LAYOUT, courseId: 1, tee: hole.tee, target: hole.target, distance_ft: hole.distance_ft,
      ...(startedAt ? { roundStartedAt: startedAt } : {}) },
  })));
}

const pdgaHoles = (length: number) => JSON.stringify([1, 2, 3].map((hole) => ({ hole, par: 3, lengthFt: length })));

async function fixture() {
  const { db, sqlite } = await pdgaTestDb();
  sqlite.exec("INSERT INTO courses (id, name, location) VALUES (1, 'Historical Park', 'Greenville, NC')");
  sqlite.prepare("INSERT INTO course_layouts (id, course_id, name, holes) VALUES (?, 1, 'Main', ?)").run(LAYOUT, JSON.stringify(positions()));
  sqlite.exec(`INSERT INTO events (id, name, type, status, format, date, course_id, layout_id)
    VALUES (1,'Club field','league_round','final','stroke','2026-06-10',1,4), (2,'Small field','league_round','final','stroke','2026-06-12',1,4)`);
  const result = sqlite.prepare("INSERT INTO results (event_id, member_id, name, place, total, to_par, scorecard, created_at) VALUES (?,?,?,?,?,?,?,?)");
  for (const [member, strokes] of [[ALPHA, 9], [BETA, 9], ["m_gamma", 10]] as const) {
    result.run(1, member, member, 1, strokes, strokes - 9, card(strokes), "2026-06-10 20:00:00");
  }
  result.run(2, ALPHA, ALPHA, 1, 10, 1, card(10), "2026-06-12 20:00:00");
  const anchor = sqlite.prepare("INSERT INTO rating_anchor_snapshots (member_id,observed_at,effective_at,rating) VALUES (?,?,?,?)");
  anchor.run(ALPHA, "2026-05-08T00:00:00.000Z", "2026-05-06T00:00:00.000Z", 1000);
  anchor.run(BETA, "2026-05-08T00:00:00.000Z", "2026-05-06T00:00:00.000Z", 1000);

  const casual = sqlite.prepare("INSERT INTO casual_rounds (id,round_code,course_id,layout_id,holes,started_at,finalized_at,scoring_config) VALUES (?,?,1,4,?,?,?,?)");
  const casualResult = sqlite.prepare("INSERT INTO casual_results (casual_round_id,member_id,name,place,total,to_par,scorecard) VALUES (?,?,?,1,?,?,?)");
  const archived = (distance = 250) => JSON.stringify(positions(distance).map((hole) => ({
    hole: hole.hole, par: hole.par, layoutAtPlay: { courseId: 1, layoutId: LAYOUT, tee: hole.tee, target: hole.target, distance_ft: hole.distance_ft },
  })));
  casual.run(1, "CASUAL", archived(), "2026-06-11T15:00:00Z", "2026-06-11 18:30:00", SINGLE);
  casualResult.run(1, ALPHA, "First", 10, 1, card(10));
  casual.run(2, "LONGER", archived(400), "2026-06-11T15:00:00Z", "2026-06-11 18:30:00", SINGLE);
  casualResult.run(2, ALPHA, "First", 10, 1, card(10, 400));

  // PDGA rounds on a layout matched to ours: two before the casual round, one the same day, one after.
  const round = sqlite.prepare(`INSERT INTO pdga_rated_rounds (tourn_id, round_number, pdga_layout_id, round_date, event_name,
      event_state, course_name, layout_name, hole_count, total_par, total_length_ft, holes_json, official_ssa, ratings_status,
      rated_players, fetched_at) VALUES (?, 1, 900, ?, 'PDGA event', 'NC', 'Historical Park', 'Main', 3, 9, 750, ?, ?, 'official', 20, '2026-08-01')`);
  round.run(101, "2026-05-01", pdgaHoles(250), 9.2);
  round.run(102, "2026-06-05", pdgaHoles(250), 9.8);
  round.run(103, "2026-06-11", pdgaHoles(250), 30);
  round.run(104, "2026-07-01", pdgaHoles(250), 31);
  sqlite.exec(`INSERT INTO pdga_layout_matches (pdga_layout_id, course_id, layout_id, quality, review_status, matched_at)
    VALUES (900, 1, 4, 'exact', 'auto', '2026-08-01T00:00:00Z')`);
  return { db, sqlite };
}

const ratingRows = (sqlite: Awaited<ReturnType<typeof fixture>>["sqlite"]) => sqlite.prepare(`SELECT member_id, stream, event_id,
  casual_round_code, round_rating, ssa, ppt, rating_method, propagator_count, anchor_count, unrated_reason, weather_adjustment,
  pdga_baseline_ssa, pdga_baseline_rounds, source_fingerprint FROM round_ratings ORDER BY stream, event_id, casual_round_code, member_id`).all();

describe("migration 0062", () => {
  it("rebuilds round_ratings with the pdga method while keeping every row, id, key and cascade", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    const migrations = PDGA_TEST_MIGRATIONS.filter((file) => file < "0062");
    for (const file of migrations) sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
    sqlite.exec(`INSERT INTO courses (id, name) VALUES (1, 'Park');
      INSERT INTO course_layouts (id, course_id, name) VALUES (4, 1, 'Main');
      INSERT INTO events (id, name, type, status, date) VALUES (1, 'Night', 'league_round', 'final', '2026-06-10');
      INSERT INTO round_ratings (id, member_id, player_name, stream, event_id, course_id, layout_id, round_date, total, to_par,
        round_rating, rating_method, source_result_id, anchor_count, source_fingerprint)
        VALUES (7, 'm_a', 'A', 'competition', 1, 1, 4, '2026-06-10', 54, 0, 950, 'stable', 3, 2, 'fp');
      INSERT INTO round_ratings (id, member_id, player_name, stream, casual_round_code, round_date, total, round_rating, rating_method)
        VALUES (9, 'm_a', 'A', 'casual', 'ABC123', '2026-06-11', 55, 940, 'layout');`);
    sqlite.exec(readFileSync(new URL("../migrations/0062_pdga_layout_baselines.sql", import.meta.url), "utf8"));
    expect(sqlite.prepare("SELECT id, rating_method, source_result_id, anchor_count, source_fingerprint, pdga_baseline_ssa FROM round_ratings ORDER BY id").all())
      .toEqual([
        { id: 7, rating_method: "stable", source_result_id: 3, anchor_count: 2, source_fingerprint: "fp", pdga_baseline_ssa: null },
        { id: 9, rating_method: "layout", source_result_id: null, anchor_count: 0, source_fingerprint: null, pdga_baseline_ssa: null },
      ]);
    sqlite.exec(`INSERT INTO round_ratings (member_id, player_name, stream, casual_round_code, round_date, total, rating_method)
      VALUES ('m_b', 'B', 'casual', 'ABC123', '2026-06-11', 56, 'pdga')`);
    expect(sqlite.prepare("SELECT MAX(id) AS id FROM round_ratings").get()).toEqual({ id: 10 });
    expect(() => sqlite.exec(`INSERT INTO round_ratings (member_id, player_name, stream, casual_round_code, round_date, total, rating_method)
      VALUES ('m_b', 'B', 'casual', 'ABC123', '2026-06-11', 56, 'pdga')`)).toThrow(/UNIQUE/);
    expect(() => sqlite.exec(`INSERT INTO round_ratings (member_id, player_name, stream, casual_round_code, round_date, total, rating_method)
      VALUES ('m_c', 'C', 'casual', 'ABC123', '2026-06-11', 56, 'guess')`)).toThrow(/CHECK/);
    sqlite.exec("DELETE FROM events WHERE id = 1");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM round_ratings WHERE event_id = 1").get()).toEqual({ count: 0 });
  });
});

describe("PDGA layout baselines in the rating engine", () => {
  it("lists pdga among the rating methods and accepts it in storage", () => {
    expect(RATING_METHODS).toEqual(["stable", "provisional", "layout", "pdga", "unrated"]);
  });

  it("rates a casual round from the median SSA of earlier PDGA rounds only, with the round's gust adjustment", async () => {
    const { db, sqlite } = await fixture();
    await repairRatingSource(db, "casual", 1, 38);
    const row = sqlite.prepare("SELECT * FROM round_ratings WHERE casual_round_code = 'CASUAL'").get() as Record<string, unknown>;
    // 9.2 and 9.8 (before 2026-06-11); the same-day 30 and later 31 are excluded.
    expect(row).toMatchObject({ rating_method: "pdga", pdga_baseline_ssa: 9.5, pdga_baseline_rounds: 2, weather_adjustment: 0.7,
      baseline_event_id: null, unrated_reason: null });
    expect(row.round_rating).toBe(roundRatingForScore(10, 9.5 + 0.7, pointsPerThrow(9.5)));
    const display = (await getMemberRatings(db, ALPHA)).casual.rounds.find((round) => round.round_code === "CASUAL");
    expect(display).toMatchObject({ rating_method: "pdga", pdga_baseline_rounds: 2, pdga_baseline_ssa: 9.5, rating: row.round_rating });
    expect((await listMemberCasualResults(db, ALPHA)).find((entry) => entry.round_code === "CASUAL")).toMatchObject({ round_rating: row.round_rating });
  });

  it("prefers the PDGA baseline to an earlier club field for casual rounds", async () => {
    const { db, sqlite } = await fixture();
    await repairRatingSource(db, "competition", 1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM layout_rating_baselines").get()).toEqual({ count: 1 });
    await repairRatingSource(db, "casual", 1);
    expect(sqlite.prepare("SELECT rating_method, baseline_event_id FROM round_ratings WHERE casual_round_code = 'CASUAL'").get())
      .toEqual({ rating_method: "pdga", baseline_event_id: null });
  });

  it("ignores PDGA rounds whose layout does not fit the as-played hole lengths", async () => {
    const { db, sqlite } = await fixture();
    await repairRatingSource(db, "casual", 2);
    expect(sqlite.prepare("SELECT rating_method, round_rating, pdga_baseline_ssa FROM round_ratings WHERE casual_round_code = 'LONGER'").get())
      .toEqual({ rating_method: "unrated", round_rating: null, pdga_baseline_ssa: null });
  });

  it("keeps a stable field's own day-of SSA and records the PDGA baseline beside it", async () => {
    const { db, sqlite } = await fixture();
    sqlite.exec("INSERT INTO rating_anchor_snapshots (member_id,observed_at,effective_at,rating) VALUES ('m_gamma','2026-05-08T00:00:00.000Z','2026-05-06T00:00:00.000Z',970)");
    await repairRatingSource(db, "competition", 1);
    const rows = sqlite.prepare("SELECT member_id, rating_method, round_rating, pdga_baseline_ssa, pdga_baseline_rounds FROM round_ratings WHERE event_id = 1 ORDER BY member_id").all();
    expect(rows).toEqual([
      { member_id: ALPHA, rating_method: "stable", round_rating: expect.any(Number), pdga_baseline_ssa: 9.5, pdga_baseline_rounds: 2 },
      { member_id: BETA, rating_method: "stable", round_rating: expect.any(Number), pdga_baseline_ssa: 9.5, pdga_baseline_rounds: 2 },
      { member_id: "m_gamma", rating_method: "stable", round_rating: expect.any(Number), pdga_baseline_ssa: 9.5, pdga_baseline_rounds: 2 },
    ]);
    expect(sqlite.prepare("SELECT ssa FROM round_ratings WHERE event_id = 1 LIMIT 1").get()).not.toEqual({ ssa: 9.5 });
  });

  it("rates a small field (a provisional two-player solve) from the PDGA baseline", async () => {
    const { db, sqlite } = await fixture();
    await repairRatingSource(db, "competition", 1);
    expect(sqlite.prepare("SELECT DISTINCT rating_method, ssa, pdga_baseline_rounds, anchor_count FROM round_ratings WHERE event_id = 1").all())
      .toEqual([{ rating_method: "pdga", ssa: 9.5, pdga_baseline_rounds: 2, anchor_count: 2 }]);
    // Its own (provisional) solve still feeds the club layout baseline evidence.
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM layout_rating_baselines").get()).toEqual({ count: 1 });
    // Without PDGA evidence the field keeps its provisional solve.
    sqlite.exec("DELETE FROM pdga_layout_matches");
    await repairRatingSource(db, "competition", 1);
    expect(sqlite.prepare("SELECT DISTINCT rating_method FROM round_ratings WHERE event_id = 1").all()).toEqual([{ rating_method: "provisional" }]);
  });

  it("normalises PDGA SSAs with each round's measured gust before the median", async () => {
    const { db, sqlite } = await fixture();
    sqlite.exec("UPDATE pdga_rated_rounds SET wind_gust_mph = 38, weather_status = 'ok', weather_course_id = 1 WHERE tourn_id = 101");
    // A gust measured at another course does not count.
    sqlite.exec("UPDATE pdga_rated_rounds SET wind_gust_mph = 38, weather_status = 'ok', weather_course_id = 99 WHERE tourn_id = 102");
    await repairRatingSource(db, "casual", 1, 38);
    // 9.2 - 0.7 = 8.5 and 9.8 as played: median 9.15. The casual round then adds its own 0.7.
    const row = sqlite.prepare("SELECT rating_method, pdga_baseline_ssa, ssa, round_rating FROM round_ratings WHERE casual_round_code = 'CASUAL'").get();
    expect(row).toEqual({ rating_method: "pdga", pdga_baseline_ssa: 9.15, ssa: 9.85, round_rating: roundRatingForScore(10, 9.85, pointsPerThrow(9.15)) });
    expect((await getMemberRatings(db, ALPHA)).casual.rounds.find((round) => round.round_code === "CASUAL")).toMatchObject({ rating: row && (row as { round_rating: number }).round_rating });
  });

  it("uses the PDGA baseline for a field with too few rated players to solve its own SSA", async () => {
    const { db, sqlite } = await fixture();
    const result = await repairRatingSource(db, "competition", 2);
    expect(result).toMatchObject({ rows: 1, layoutBaselines: 0, waiting: false });
    // Before 2026-06-12: 9.2, 9.8 and the 2026-06-11 round (30): median 9.8.
    const row = sqlite.prepare("SELECT rating_method, round_rating, ssa, anchor_count, pdga_baseline_rounds FROM round_ratings WHERE event_id = 2").get();
    expect(row).toEqual({ rating_method: "pdga", round_rating: roundRatingForScore(10, 9.8, pointsPerThrow(9.8)), ssa: 9.8, anchor_count: 1,
      pdga_baseline_rounds: 3 });
    expect(sqlite.prepare("SELECT rating FROM results WHERE event_id = 2").get()).toEqual({ rating: row && (row as { round_rating: number }).round_rating });
    expect((await getMemberRatings(db, ALPHA)).competitive.rounds.find((round) => round.label === "Small field"))
      .toMatchObject({ rating_method: "pdga", pdga_baseline_rounds: 3 });
  });

  it("is deterministic and idempotent across repeated repairs and recompute cycles", async () => {
    const { db, sqlite } = await fixture();
    for (const [stream, id] of [["competition", 1], ["competition", 2], ["casual", 1], ["casual", 2]] as const) await repairRatingSource(db, stream, id);
    const first = ratingRows(sqlite);
    for (const [stream, id] of [["casual", 2], ["casual", 1], ["competition", 2], ["competition", 1]] as const) await repairRatingSource(db, stream, id);
    expect(ratingRows(sqlite)).toEqual(first);
    await runRatingRepairCycle(db, "2026-09-01T00:00:00.000Z");
    await runRatingRepairCycle(db, "2026-09-02T00:00:00.000Z");
    expect(ratingRows(sqlite)).toEqual(first);
  });

  it("withholds a PDGA-based rating once an admin rejects the match, queues repair, and re-rates without it", async () => {
    const { db, sqlite } = await fixture();
    await repairRatingSource(db, "competition", 1);
    await repairRatingSource(db, "casual", 1);
    await repairRatingSource(db, "competition", 2);
    expect(await reviewPdgaMatch(db, 900, "reject", null, "m_admin", "2026-09-01T00:00:00.000Z")).toEqual({ ok: true });
    const display = await getMemberRatings(db, ALPHA);
    expect(display.casual.rounds.find((round) => round.round_code === "CASUAL"))
      .toMatchObject({ rating: null, unrated_reason: "rating-source-changed", pdga_baseline_rounds: null });
    expect(display.competitive.rounds.find((round) => round.label === "Small field")).toMatchObject({ rating: null });
    expect(sqlite.prepare("SELECT stream, source_id, last_code FROM rating_repair_issues ORDER BY stream, source_id").all()).toEqual([
      { stream: "casual", source_id: 1, last_code: "pdga-baseline-changed" }, { stream: "casual", source_id: 2, last_code: "pdga-baseline-changed" },
      { stream: "competition", source_id: 1, last_code: "pdga-baseline-changed" }, { stream: "competition", source_id: 2, last_code: "pdga-baseline-changed" },
    ]);
    await runRatingRepairCycle(db, "2026-09-01T00:00:00.000Z");
    expect(sqlite.prepare("SELECT rating_method, baseline_event_id FROM round_ratings WHERE casual_round_code = 'CASUAL'").get())
      .toEqual({ rating_method: "layout", baseline_event_id: 1 });
    expect(sqlite.prepare("SELECT rating_method, round_rating FROM round_ratings WHERE event_id = 2").get())
      .toEqual({ rating_method: "unrated", round_rating: null });
  });

  it("aborts the rating batch when the PDGA evidence changes mid-repair", async () => {
    const { db, sqlite } = await fixture();
    const batch = db.batch!.bind(db);
    db.batch = async (statements) => {
      sqlite.exec("UPDATE pdga_rated_rounds SET official_ssa = 9.9 WHERE tourn_id = 101");
      return batch(statements);
    };
    await expect(repairRatingSource(db, "casual", 1)).rejects.toThrow("CHECK constraint failed");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM round_ratings").get()).toEqual({ count: 0 });
  });

  it("projects live ratings from the PDGA baseline first", async () => {
    const { db } = await fixture();
    await expect(getLiveRatingBaseline(db, LAYOUT, positions(), "2026-06-11T15:00:00Z"))
      .resolves.toMatchObject({ source: "pdga", ssa: 9.5, rounds: 2 });
    await expect(getLiveRatingBaseline(db, LAYOUT, positions(), "2026-04-11T15:00:00Z")).resolves.toBeNull();
    await expect(getLiveRatingBaseline(db, null, positions(), "2026-06-11T15:00:00Z")).resolves.toBeNull();
  });
});
