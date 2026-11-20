import { describe, expect, it } from "vitest";
import { repairRatingSource } from "../src/rating-repair.js";
import { getMemberRatings } from "../src/ratings.js";
import { ratingTestDb } from "./rating-test-db.js";

// Showing ratings re-checks each stored rating against its sources. These pin what that costs for a busy player
// (D1 allows 50 queries per request on the free plan).

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

async function course() {
  const { db, sqlite } = await ratingTestDb();
  sqlite.exec("INSERT INTO courses (id, name, location) VALUES (1, 'Historical Park', 'Greenville, NC')");
  sqlite.prepare("INSERT INTO course_layouts (id, course_id, name, holes) VALUES (4, 1, 'Main', ?)").run(JSON.stringify(positions()));
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
  return { db, sqlite, casualRound, read, reads };
}


describe("showing a busy player's ratings", () => {
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
