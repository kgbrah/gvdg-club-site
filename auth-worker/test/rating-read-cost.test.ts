import { describe, expect, it } from "vitest";
import { reviewPdgaMatch } from "../src/pdga-baseline-store.js";
import { repairRatingSource } from "../src/rating-repair.js";
import { getMemberRatings } from "../src/ratings.js";
import { pdgaTestDb } from "./pdga-test-db.js";

// Showing ratings re-checks each stored rating against its sources. These pin what that costs for a busy player
// (D1 allows 50 queries per request on the free plan) and when a PDGA-based rating can be trusted as written.

const TEE = { lat: 35.60, lng: -77.37 };
const PIN = { lat: 35.601, lng: -77.37 };
const SINGLE = '{"groupFormat":"singles","scoringStyle":"stroke"}';
const ALPHA = "m_alpha";
const positions = () => [1, 2, 3].map((hole) => ({ hole, par: 3, distance_ft: 250,
  tee: { ...TEE, lng: TEE.lng + hole / 100 }, target: { ...PIN, lng: TEE.lng + hole / 100 } }));
const card = (total: number) => JSON.stringify(positions().map((hole) => ({ hole: hole.hole, par: 3, strokes: hole.hole === 1 ? total - 6 : 3,
  layoutAtPlay: { layoutId: 4, courseId: 1, tee: hole.tee, target: hole.target, distance_ft: 250 } })));
const archived = () => JSON.stringify(positions().map((hole) => ({ hole: hole.hole, par: 3,
  layoutAtPlay: { courseId: 1, layoutId: 4, tee: hole.tee, target: hole.target, distance_ft: 250 } })));
const day = (offset: number) => new Date(Date.parse("2026-01-05T00:00:00Z") + offset * 86_400_000).toISOString().slice(0, 10);
const pdgaHoles = JSON.stringify([1, 2, 3].map((hole) => ({ hole, par: 3, lengthFt: 250 })));

async function course() {
  const { db, sqlite } = await pdgaTestDb();
  sqlite.exec("INSERT INTO courses (id, name, location) VALUES (1, 'Historical Park', 'Greenville, NC')");
  sqlite.prepare("INSERT INTO course_layouts (id, course_id, name, holes) VALUES (4, 1, 'Main', ?)").run(JSON.stringify(positions()));
  const pdgaRound = (tournId: number, date: string, ssa: number) => sqlite.prepare(`INSERT INTO pdga_rated_rounds (tourn_id, round_number,
      pdga_layout_id, round_date, event_name, event_state, course_name, layout_name, hole_count, total_par, total_length_ft, holes_json,
      official_ssa, ratings_status, rated_players, fetched_at)
    VALUES (?, 1, 900, ?, 'PDGA event', 'NC', 'Historical Park', 'Main', 3, 9, 750, ?, ?, 'official', 20, '2026-08-01')`).run(tournId, date, pdgaHoles, ssa);
  const casualRound = async (id: number, date: string, total: number) => {
    sqlite.prepare("INSERT INTO casual_rounds (id,round_code,course_id,layout_id,holes,started_at,finalized_at,scoring_config) VALUES (?,?,1,4,?,?,?,?)")
      .run(id, "R" + id, archived(), date + "T15:00:00Z", date + " 18:30:00", SINGLE);
    sqlite.prepare("INSERT INTO casual_results (casual_round_id,member_id,name,place,total,to_par,scorecard) VALUES (?,?,?,1,?,?,?)")
      .run(id, ALPHA, "Alpha", total, total - 9, card(total));
    await repairRatingSource(db, "casual", id);
  };
  // Every query a ratings read makes, by the table it reads.
  const reads: string[] = [];
  const prepare = db.prepare.bind(db);
  const counted = (sql: string) => { reads.push(sql); return prepare(sql); };
  const read = async () => {
    reads.length = 0;
    db.prepare = counted;
    try { return await getMemberRatings(db, ALPHA); } finally { db.prepare = prepare; }
  };
  return { db, sqlite, pdgaRound, casualRound, read, reads };
}

const pdgaRoundsRead = (reads: readonly string[]) => reads.filter((sql) => /FROM pdga_rated_rounds/.test(sql)).length;

describe("showing a busy player's ratings", () => {
  it("re-checks 40 PDGA-based ratings in a handful of queries, and trusts them as written", async () => {
    const { sqlite, pdgaRound, casualRound, read, reads } = await course();
    for (let index = 0; index < 60; index++) pdgaRound(1000 + index, day(-400 + index * 7), 9 + (index % 5) * 0.2);
    sqlite.exec(`INSERT INTO pdga_layout_matches (pdga_layout_id, course_id, layout_id, quality, review_status, matched_at)
      VALUES (900, 1, 4, 'exact', 'auto', '2026-08-01T00:00:00Z')`);
    for (let index = 1; index <= 40; index++) await casualRound(index, day(index * 5), 9 + (index % 3));
    expect(sqlite.prepare("SELECT rating_method, COUNT(*) AS n FROM round_ratings GROUP BY rating_method").all()).toEqual([{ rating_method: "pdga", n: 40 }]);
    const shown = await read();
    expect(shown.casual.rounds.filter((round) => round.rating != null)).toHaveLength(40);
    // Was two queries per rating (one per list it appears in); now the lists plus one look at what changed.
    expect(reads.length).toBeLessThanOrEqual(6);
    expect(pdgaRoundsRead(reads)).toBe(0);
  });

  it("re-checks 20 club-calibrated ratings in a handful of queries", async () => {
    const { db, sqlite, casualRound, read, reads } = await course();
    const anchor = sqlite.prepare("INSERT INTO rating_anchor_snapshots (member_id,observed_at,effective_at,rating) VALUES (?,?,?,?)");
    for (const member of [ALPHA, "m_beta", "m_gamma"]) anchor.run(member, "2025-12-01T00:00:00.000Z", "2025-11-30T00:00:00.000Z", 1000);
    const result = sqlite.prepare("INSERT INTO results (event_id, member_id, name, place, total, to_par, scorecard, created_at) VALUES (?,?,?,?,?,?,?,?)");
    for (let index = 1; index <= 20; index++) {
      const played = day(index * 7);
      sqlite.prepare("INSERT INTO events (id, name, type, status, format, date, course_id, layout_id) VALUES (?, ?, 'league_round', 'final', 'stroke', ?, 1, 4)")
        .run(index, "League " + index, played);
      for (const [member, strokes] of [[ALPHA, 9], ["m_beta", 9 + (index % 2)], ["m_gamma", 10]] as const) {
        result.run(index, member, member, 1, strokes, strokes - 9, card(strokes), played + " 20:00:00");
      }
      await repairRatingSource(db, "competition", index);
      await casualRound(index, day(index * 7 + 2), 10);
    }
    expect(sqlite.prepare("SELECT rating_method, COUNT(*) AS n FROM round_ratings WHERE stream = 'casual' GROUP BY rating_method").all())
      .toEqual([{ rating_method: "layout", n: 20 }]);
    const shown = await read();
    expect(shown.casual.rounds.filter((round) => round.rating != null)).toHaveLength(20);
    expect(shown.competitive.rounds.filter((round) => round.rating != null)).toHaveLength(20);
    // Was about four queries per calibration event (80+ here); now one pass each over calibrations, fields and anchors.
    expect(reads.length).toBeLessThanOrEqual(12);
  });
});

describe("PDGA-based ratings checked when written", () => {
  async function rated() {
    const setup = await course();
    for (const [tournId, date, ssa] of [[101, "2025-11-01", 9.2], [102, "2026-01-10", 9.8], [103, "2026-02-20", 9.4]] as const) {
      setup.pdgaRound(tournId, date, ssa);
    }
    setup.sqlite.exec(`INSERT INTO pdga_layout_matches (pdga_layout_id, course_id, layout_id, quality, review_status, matched_at)
      VALUES (900, 1, 4, 'exact', 'auto', '2026-08-01T00:00:00Z')`);
    await setup.casualRound(1, "2026-03-01", 10);
    await setup.casualRound(2, "2026-05-01", 11);
    const before = await setup.read();
    expect(before.casual.rounds.map((round) => round.rating != null)).toEqual([true, true]);
    expect(pdgaRoundsRead(setup.reads)).toBe(0);
    return setup;
  }

  it("re-derives a rating once PDGA evidence inside its window changes, and hides it when the baseline moved", async () => {
    const { pdgaRound, read, reads } = await rated();
    pdgaRound(104, "2026-04-01", 30); // inside round 2's window only
    const after = await read();
    expect(pdgaRoundsRead(reads)).toBe(1);
    const byCode = Object.fromEntries(after.casual.rounds.map((round) => [round.round_code, round]));
    expect(byCode.R1).toMatchObject({ rating: expect.any(Number) });
    expect(byCode.R2).toMatchObject({ rating: null, unrated_reason: "rating-source-changed" });
  });

  it("keeps trusting ratings when the new PDGA round is after them, and when the matcher re-runs with the same answer", async () => {
    const { sqlite, pdgaRound, read, reads } = await rated();
    pdgaRound(105, "2026-06-01", 30);
    // What matchPdgaLayouts' upsert does when it reaches the same answer: the same match, a new matched_at.
    sqlite.exec(`UPDATE pdga_layout_matches SET course_id = 1, layout_id = 4, quality = 'exact', review_status = 'auto',
      matched_at = '2026-09-01T00:00:00Z' WHERE pdga_layout_id = 900`);
    const after = await read();
    expect(after.casual.rounds.map((round) => round.rating != null)).toEqual([true, true]);
    expect(pdgaRoundsRead(reads)).toBe(0);
  });

  it("re-derives every rating on the layout after a match review, and a weather update re-derives that round's window", async () => {
    const { db, sqlite, read, reads } = await rated();
    sqlite.exec("UPDATE pdga_rated_rounds SET wind_gust_mph = 25, weather_status = 'ok', weather_course_id = 1 WHERE tourn_id = 103");
    await read();
    expect(pdgaRoundsRead(reads)).toBe(1);
    expect(await reviewPdgaMatch(db, 900, "reject", null, "m_admin", "2026-09-01T00:00:00.000Z")).toEqual({ ok: true });
    const after = await read();
    expect(after.casual.rounds.map((round) => round.rating)).toEqual([null, null]);
  });

  it("re-derives ratings written before rated_at existed, or before the trusted-since time", async () => {
    const { sqlite, read, reads } = await rated();
    sqlite.exec("UPDATE round_ratings SET rated_at = NULL WHERE casual_round_code = 'R1'");
    sqlite.exec("UPDATE round_ratings SET rated_at = '2026-01-01T00:00:00.000Z' WHERE casual_round_code = 'R2'");
    const after = await read();
    expect(pdgaRoundsRead(reads)).toBe(1);
    expect(after.casual.rounds.map((round) => round.rating != null)).toEqual([true, true]);
  });
});
