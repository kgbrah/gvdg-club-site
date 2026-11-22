import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { listMemberCasualResults, listMemberResults } from "../src/db-results.js";
import type { D1Like, D1StatementLike } from "../src/db-types.js";
import { repairRatingSource } from "../src/rating-repair.js";
import { runRatingRepairCycle, runRatingsRecompute } from "../src/ratings-recompute.js";
import { readArchivedRatingHoles, ratingLayoutRevision } from "../src/rating-layout.js";
import { getLayoutRatingBaseline, priorRatingAnchors, queueRatingRepair } from "../src/rating-store.js";
import { getMemberRatings } from "../src/ratings.js";
import { resetPdgaApiSession } from "../src/pdga-api.js";
import type { Env } from "../src/env.js";

const TEE = { lat: 35.60, lng: -77.37 };
const OLD = { lat: 35.601, lng: -77.37 };
const MOVED = { lat: 35.602, lng: -77.37 };
const LAYOUT = 4;
const ALPHA = "m_alpha";
const BETA = "m_beta";
const GAMMA = "m_gamma";
const SINGLE = '{"groupFormat":"singles","scoringStyle":"stroke"}';

function positions(target: typeof OLD) {
  return [1, 2, 3].map((hole) => ({ hole, par: 3, distance_ft: 250,
    tee: { ...TEE, lng: TEE.lng + hole / 100 }, target: { ...target, lng: TEE.lng + hole / 100 } }));
}

function card(target: typeof OLD, total: number, archived = true) {
  return JSON.stringify(positions(target).map((hole) => ({
    hole: hole.hole, par: hole.par, strokes: hole.hole === 1 ? total - 6 : 3,
    ...(archived ? { layoutAtPlay: { layoutId: LAYOUT, courseId: 1, tee: hole.tee, target: hole.target, distance_ft: hole.distance_ft } } : {}),
  })));
}

async function fixture() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_init.sql", "0005_registration.sql", "0015_udisc_export.sql", "0016_casual_rounds.sql",
    "0018_live_scoring_metadata.sql", "0022_ratings.sql", "0024_event_schedule_deadlines.sql", "0050_rating_repair.sql",
    "0062_pdga_layout_baselines.sql", "0073_pdga_evidence_changes.sql"]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  // 0078's change to the anchors table (the rest of 0078 needs tables these tests don't load).
  sqlite.exec("ALTER TABLE rating_anchor_snapshots ADD COLUMN confirmed_at TEXT");
  const startingLayout = sqlite.prepare("INSERT INTO course_layouts (id, course_id, name, holes) VALUES (?,1,'Renamed since first event',?)");
  sqlite.exec("INSERT INTO courses (id, name) VALUES (1,'Historical Park')");
  startingLayout.run(LAYOUT, JSON.stringify(positions(MOVED)));
  sqlite.exec(`
    INSERT INTO events (id, name, type, status, format, date, course_id, layout_id)
     VALUES (1,'Initial round','league_round','final','stroke','2026-06-10',1,4),
            (2,'New basket round','league_round','final','stroke','2026-07-15',1,4),
            (3,'Old unsupported result','league_round','final','stroke','2026-05-01',1,4),
            (4,'Doubles','league_round','final','doubles','2026-06-10',1,4),
            (5,'Match play','league_round','final','matchplay','2026-06-10',1,4),
            (6,'Scheduled','league_round','scheduled','stroke','2026-06-10',1,4);
  `);
  const event = sqlite.prepare(
    "INSERT INTO results (event_id, member_id, name, place, total, to_par, scorecard, created_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const [eventId, pin, endedAt] of [[1, OLD, "2026-06-10 20:00:00"], [2, MOVED, "2026-07-15 20:00:00"]] as const) {
    for (const [member, strokes] of [[ALPHA, 9], [BETA, 9], [GAMMA, 10], ["op_walkup", 10], ["g_guest", 9]] as const) {
      event.run(eventId, member, member, 1, strokes, strokes - 9, card(pin, strokes), endedAt);
    }
    event.run(eventId, "m_bad_score", "Malformed result", 4, 9, 0, card(pin, 11), endedAt);
  }
  for (let id = 3; id <= 6; id += 1) {
    event.run(id, ALPHA, "First", 1, 9, 0, card(OLD, 9, id !== 3), "2026-06-10 20:00:00");
  }
  const insertCasual = sqlite.prepare(
    "INSERT INTO casual_rounds (id,round_code,course_id,layout_id,holes,started_at,finalized_at,scoring_config) VALUES (?,?,1,4,?,?,?,?)",
  );
  const result = sqlite.prepare("INSERT INTO casual_results (casual_round_id,member_id,name,place,total,to_par,scorecard) VALUES (?,?,?,1,10,1,?)");
  const archived = (pin: typeof OLD) => JSON.stringify(positions(pin).map((hole) => ({
    hole: hole.hole, par: hole.par, layoutAtPlay: { courseId: 1, layoutId: LAYOUT, tee: hole.tee, target: hole.target, distance_ft: hole.distance_ft },
  })));
  insertCasual.run(1, "OLDPIN", archived(OLD), "2026-06-11T15:00:00Z", "2026-06-11 18:30:00", SINGLE);
  result.run(1, ALPHA, "First", card(OLD, 10));
  insertCasual.run(2, "NEWPIN", archived(MOVED), "2026-06-11T15:00:00Z", "2026-06-11 18:30:00", SINGLE);
  result.run(2, ALPHA, "First", card(MOVED, 10));
  insertCasual.run(3, "OLDSTYLE", archived(OLD), "2026-06-11T15:00:00Z", "2026-06-11 18:30:00", null);
  result.run(3, ALPHA, "First", card(OLD, 10));
  insertCasual.run(4, "SAMEAS", archived(OLD), "2026-06-10T10:00:00Z", "2026-06-10 12:30:00", SINGLE);
  result.run(4, ALPHA, "First", card(OLD, 10));

  const insertAnchor = sqlite.prepare("INSERT INTO rating_anchor_snapshots (member_id,observed_at,effective_at,rating) VALUES (?,?,?,?)");
  insertAnchor.run(ALPHA, "2026-05-08T00:00:00.000Z", "2026-05-06T00:00:00.000Z", 1000);
  insertAnchor.run(BETA, "2026-05-08T00:00:00.000Z", "2026-05-06T00:00:00.000Z", 1000);
  insertAnchor.run(GAMMA, "2026-07-01T00:00:00.000Z", "2026-05-06T00:00:00.000Z", 970);
  insertAnchor.run(ALPHA, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", 1250);

  let failAt = -1;
  let beforeNextBatch: (() => void) | null = null;
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      function exec() {
        const result = sqlite.prepare(query).run(...values);
        return { results: [], success: true, meta: { changes: result.changes } };
      }
      const statement = {
        bind(...args: unknown[]) { values = args; return statement; },
        async first() { return sqlite.prepare(query).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(query).all(...values), success: true }; },
        async run() { return exec(); },
        exec, query,
      };
      return statement;
    },
    async batch(statements: (D1StatementLike & { exec(): unknown; query: string })[]) {
      const concurrent = beforeNextBatch;
      beforeNextBatch = null;
      concurrent?.();
      sqlite.exec("BEGIN");
      let writeIndex = -1;
      try {
        const results = statements.map((statement) => {
          if (/^INSERT INTO round_ratings|^UPDATE results SET rating/.test(statement.query)) writeIndex += 1;
          if (writeIndex >= 0 && writeIndex === failAt) {
            failAt = -1;
            throw new Error("Simulated transaction failure");
          }
          return statement.exec();
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Like;
  return { db, sqlite, failAtStatement: (index: number) => { failAt = index; },
    duringNextRating: (write: () => void) => { beforeNextBatch = write; } };
}

describe("versioned, transactional rating repair", () => {
  it("recovers an initial partial write without deleting old rows and tolerates duplicate finalization", async () => {
    const { db, sqlite, failAtStatement } = await fixture();
    sqlite.exec(`INSERT INTO round_ratings (member_id, player_name, stream, event_id, round_date, total, to_par, round_rating, rating_method)
      VALUES ('m_alpha','First','competition',1,'2026-06-10',9,0,945,'provisional')`);
    failAtStatement(2);
    await expect(repairRatingSource(db, "competition", 1)).rejects.toThrow("Simulated transaction failure");
    expect(sqlite.prepare("SELECT member_id, round_rating, source_result_id FROM round_ratings").all())
      .toEqual([{ member_id: ALPHA, round_rating: 945, source_result_id: null }]);
    expect(sqlite.prepare("SELECT rating FROM results WHERE event_id=1 AND member_id='m_alpha'").get()?.rating).toBeNull();
    await expect(repairRatingSource(db, "competition", 1)).resolves.toMatchObject({ rows: 3, layoutBaselines: 1 });
    await expect(repairRatingSource(db, "competition", 1)).resolves.toMatchObject({ rows: 3, layoutBaselines: 1 });
    expect(sqlite.prepare("SELECT member_id, round_rating, anchor_count, rating_method FROM round_ratings ORDER BY member_id").all())
      .toMatchObject([
        { member_id: ALPHA, round_rating: 1000, anchor_count: 2, rating_method: "provisional" },
        { member_id: BETA, round_rating: 1000, anchor_count: 2, rating_method: "provisional" },
        { member_id: GAMMA, anchor_count: 2, rating_method: "provisional" },
      ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM layout_rating_baselines").get()?.count).toBe(1);
  });

  it("aborts the whole transaction when a nonrepresentative field row changes and leaves checkpoints untouched", async () => {
    const { db, sqlite, duringNextRating } = await fixture();
    const checkpoint = { stream: "competition", after_id: 27, checked_at: "2026-08-01" };
    sqlite.exec(`
      INSERT INTO rating_repair_checkpoints (stream, after_id, checked_at) VALUES ('competition',27,'2026-08-01');
      INSERT INTO round_ratings (member_id, player_name, stream, event_id, round_date, total, to_par, round_rating, rating_method)
        VALUES ('m_alpha','First','competition',1,'2026-06-10',9,0,945,'provisional');
    `);
    duringNextRating(() => {
      sqlite.prepare("UPDATE results SET total=11, to_par=2, scorecard=? WHERE event_id=1 AND member_id=?")
        .run(card(OLD, 11), BETA);
    });
    await expect(repairRatingSource(db, "competition", 1)).rejects.toThrow("CHECK constraint failed");
    expect(sqlite.prepare("SELECT member_id, round_rating FROM round_ratings").all()).toEqual([{ member_id: ALPHA, round_rating: 945 }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM layout_rating_baselines").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM results WHERE rating IS NOT NULL").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT * FROM rating_repair_checkpoints").all()).toEqual([checkpoint]);

    await queueRatingRepair(db, "competition", 1);
    await expect(repairRatingSource(db, "competition", 1)).resolves.toMatchObject({ rows: 3, layoutBaselines: 1 });
    expect(sqlite.prepare("SELECT total FROM round_ratings WHERE event_id=1 AND member_id=?").get(BETA)).toEqual({ total: 11 });
    expect(sqlite.prepare("SELECT * FROM rating_repair_checkpoints").all()).toEqual([checkpoint]);
  });

  it("rejects changing scoring configuration, prior anchors, and the selected layout baseline", async () => {
    const { db, sqlite, duringNextRating } = await fixture();
    duringNextRating(() => { sqlite.exec("UPDATE events SET format='doubles' WHERE id=1"); });
    await expect(repairRatingSource(db, "competition", 1)).rejects.toThrow("CHECK constraint failed");
    sqlite.exec("UPDATE events SET format='stroke' WHERE id=1");
    duringNextRating(() => { sqlite.exec("UPDATE rating_anchor_snapshots SET rating=990 WHERE member_id='m_beta'"); });
    await expect(repairRatingSource(db, "competition", 1)).rejects.toThrow("CHECK constraint failed");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM round_ratings").get()?.count).toBe(0);
    await repairRatingSource(db, "competition", 1);
    duringNextRating(() => { sqlite.exec("UPDATE layout_rating_baselines SET ssa=ssa+1 WHERE event_id=1"); });
    await expect(repairRatingSource(db, "casual", 1)).rejects.toThrow("CHECK constraint failed");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM round_ratings WHERE casual_round_code='OLDPIN'").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM rating_repair_checkpoints").get()?.count).toBe(0);
  });

  it("uses archived pins and a prior published baseline and never lends it to a new or earlier layout", async () => {
    const { db, sqlite } = await fixture();
    await repairRatingSource(db, "competition", 1);
    await repairRatingSource(db, "competition", 2);
    await repairRatingSource(db, "casual", 1, 38);
    await repairRatingSource(db, "casual", 2);
    await repairRatingSource(db, "casual", 4);
    expect(sqlite.prepare("SELECT casual_round_code, round_rating, baseline_event_id, weather_adjustment, unrated_reason FROM round_ratings WHERE stream='casual' ORDER BY casual_round_code").all())
      .toMatchObject([
        { casual_round_code: "NEWPIN", round_rating: null, baseline_event_id: null, unrated_reason: "no-prior-layout-baseline" },
        { casual_round_code: "OLDPIN", baseline_event_id: 1, weather_adjustment: 0.7 },
        { casual_round_code: "SAMEAS", round_rating: null, baseline_event_id: null, unrated_reason: "no-prior-layout-baseline" },
      ]);
    const original = readArchivedRatingHoles(positions(OLD))!;
    const moved = readArchivedRatingHoles(positions(MOVED))!;
    expect(await ratingLayoutRevision(LAYOUT, original)).not.toBe(await ratingLayoutRevision(LAYOUT, moved));
    await expect(getLayoutRatingBaseline(db, LAYOUT, positions(OLD), "2026-06-12")).resolves.toMatchObject({ eventId: 1 });
    await expect(getLayoutRatingBaseline(db, LAYOUT, undefined, "2026-06-12")).resolves.toBeNull();
    const display = await getMemberRatings(db, ALPHA);
    expect(display.casual.rounds.find((row) => row.round_code === "OLDPIN")).toMatchObject({ rating_method: "layout", baseline_event_id: 1 });
    expect(display.competitive.rounds.find((row) => row.id === 1)).toMatchObject({ rating_method: "provisional", anchor_count: 2 });
  });

  it.each(["format", "score", "basket", "deleted"] as const)(
    "withholds a baseline and dependent casual estimate immediately after a source %s correction",
    async (change) => {
      const { db, sqlite } = await fixture();
      await repairRatingSource(db, "competition", 1);
      await repairRatingSource(db, "casual", 1);
      expect((await getMemberRatings(db, ALPHA)).casual.rounds.find((row) => row.round_code === "OLDPIN")?.rating).toEqual(expect.any(Number));
      expect((await getMemberRatings(db, BETA)).competitive.rounds.find((row) => row.id != null && row.label === "Initial round")?.rating)
        .toEqual(expect.any(Number));

      if (change === "format") sqlite.exec("UPDATE events SET format='doubles' WHERE id=1");
      if (change === "score") sqlite.prepare("UPDATE results SET total=11, to_par=2, scorecard=? WHERE event_id=1 AND member_id=?")
        .run(card(OLD, 11), BETA);
      if (change === "basket") sqlite.prepare("UPDATE results SET scorecard=? WHERE event_id=1 AND member_id=?")
        .run(card(MOVED, 9), BETA);
      if (change === "deleted") sqlite.prepare("DELETE FROM results WHERE event_id=1 AND member_id=?").run(BETA);

      await expect(getLayoutRatingBaseline(db, LAYOUT, positions(OLD), "2026-06-12")).resolves.toBeNull();
      const alpha = await getMemberRatings(db, ALPHA);
      expect(alpha.casual.rounds.find((row) => row.round_code === "OLDPIN"))
        .toMatchObject({ rating: null, unrated_reason: "rating-source-changed" });
      expect(alpha.competitive.rounds.find((row) => row.label === "Initial round"))
        .toMatchObject({ rating: null, unrated_reason: change === "format" ? "not-singles-stroke" : "rating-source-changed" });
      expect((await listMemberResults(db, ALPHA)).find((row) => row.event_id === 1))
        .toMatchObject({ round_rating: null, rating: null });
      const corrected = (await getMemberRatings(db, BETA)).competitive.rounds.find((row) => row.label === "Initial round");
      expect((await listMemberCasualResults(db, ALPHA)).find((row) => row.round_code === "OLDPIN")).toMatchObject({ round_rating: null });
      if (change !== "deleted") {
        expect((await listMemberResults(db, BETA)).find((row) => row.event_id === 1)).toMatchObject({ round_rating: null, rating: null });
      }
      if (change === "deleted") expect(corrected).toBeUndefined();
      else expect(corrected).toMatchObject({ rating: null, unrated_reason: change === "format" ? "not-singles-stroke" : "rating-source-changed" });
      if (change === "basket") {
        await repairRatingSource(db, "competition", 1);
        expect(sqlite.prepare("SELECT round_rating, unrated_reason FROM round_ratings WHERE event_id=1 AND member_id=?").get(BETA))
          .toEqual({ round_rating: null, unrated_reason: "not-enough-prior-anchors" });
        expect(sqlite.prepare("SELECT rating FROM results WHERE event_id=1 AND member_id=?").get(BETA)?.rating).toBeNull();
      }
      await repairRatingSource(db, "casual", 1);
      expect(sqlite.prepare("SELECT round_rating, unrated_reason FROM round_ratings WHERE casual_round_code='OLDPIN'").get())
        .toEqual({ round_rating: null, unrated_reason: "no-prior-layout-baseline" });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM layout_rating_baselines WHERE event_id=1").get()?.count).toBe(1);
    },
  );

  it("counts only current qualifying scorecards in overall ratings and prior anchors and still displays legacy ratings", async () => {
    const { db, sqlite } = await fixture();
    sqlite.exec("DELETE FROM rating_anchor_snapshots WHERE member_id='m_alpha'");
    sqlite.exec("UPDATE rating_anchor_snapshots SET observed_at='2026-05-08T00:00:00.000Z' WHERE member_id='m_gamma'");
    sqlite.exec("UPDATE results SET rating=942 WHERE event_id=3");
    const delta = "m_delta";
    sqlite.prepare("INSERT INTO rating_anchor_snapshots (member_id,observed_at,effective_at,rating) VALUES (?,'2026-05-08T00:00:00.000Z','2026-05-06T00:00:00.000Z',1005)").run(delta);
    const event = sqlite.prepare("INSERT INTO events (id, name, type, status, format, date, course_id, layout_id) VALUES (?,'Sample','league_round','final','stroke',?,1,4)");
    const insert = sqlite.prepare("INSERT INTO results (event_id,member_id,name,place,total,to_par,scorecard,created_at) VALUES (?,?,?,1,9,0,?,?)");
    for (let id = 10; id < 18; id += 1) {
      const date = "2026-06-" + (id + 1);
      event.run(id, date);
      for (const member of [ALPHA, BETA, GAMMA, delta]) insert.run(id, member, member, card(OLD, 9), date + " 20:00:00");
      await repairRatingSource(db, "competition", id);
    }

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
      const asOf = "2026-08-25T00:00:00.000Z";
      expect((await getMemberRatings(db, ALPHA)).competitive).toMatchObject({ eligible_rated_rounds: 8, live_rating: expect.any(Number) });
      expect((await priorRatingAnchors(db, [ALPHA], asOf)).get(ALPHA)).toEqual(expect.any(Number));

      // A peer's corrected card changes the field without changing Alpha's result.
      sqlite.prepare("UPDATE results SET total=10, to_par=1, scorecard=? WHERE event_id=10 AND member_id=?")
        .run(card(OLD, 10), BETA);
      expect((await getMemberRatings(db, ALPHA)).competitive).toMatchObject({ eligible_rated_rounds: 7, live_rating: null });
      expect((await priorRatingAnchors(db, [ALPHA], asOf)).has(ALPHA)).toBe(false);
      await repairRatingSource(db, "competition", 10);
      expect((await getMemberRatings(db, ALPHA)).competitive).toMatchObject({ eligible_rated_rounds: 8, live_rating: expect.any(Number) });
      expect((await priorRatingAnchors(db, [ALPHA], asOf)).get(ALPHA)).toEqual(expect.any(Number));

      sqlite.exec("UPDATE events SET format='doubles' WHERE id=10");
      for (const reprocessed of [false, true]) {
        if (reprocessed) await repairRatingSource(db, "competition", 10);
        const history = (await getMemberRatings(db, ALPHA)).competitive;
        expect(history).toMatchObject({ eligible_rated_rounds: 7, live_rating: null });
        expect(history.rounds.find((row) => row.label === "Old unsupported result")).toMatchObject({ rating: 942, rating_method: "archived" });
        expect((await priorRatingAnchors(db, [ALPHA], asOf)).has(ALPHA)).toBe(false);
      }
      expect(sqlite.prepare("SELECT round_rating FROM round_ratings WHERE event_id=10 AND member_id=?").get(ALPHA)?.round_rating)
        .toEqual(expect.any(Number));
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves rating mirrors out of field revisions and removes the revision when an event is deleted", async () => {
    const { db, sqlite } = await fixture();
    const revision = () => sqlite.prepare("SELECT revision FROM rating_event_revisions WHERE event_id=1").get()?.revision;
    const original = revision();
    await repairRatingSource(db, "competition", 1);
    expect(revision()).toBe(original);
    sqlite.exec("UPDATE results SET rating=850, name='Edited spelling', place=place WHERE event_id=1");
    expect(revision()).toBe(original);
    expect((await getMemberRatings(db, ALPHA)).competitive.rounds.find((row) => row.label === "Initial round")?.rating).toBe(1000);
    sqlite.exec("DELETE FROM events WHERE id=1");
    expect(revision()).toBeUndefined();
    await expect(getLayoutRatingBaseline(db, LAYOUT, positions(OLD), "2026-06-12")).resolves.toBeNull();
  });

  it("prefers the actual archived start over an edited event calendar and queues a failed finalize for immediate repair", async () => {
    const { db, sqlite } = await fixture();
    sqlite.exec(`
      UPDATE results SET scorecard = json_set(scorecard, '$[0].layoutAtPlay.roundStartedAt', '2026-06-10T15:00:00Z')
        WHERE event_id = 1;
      UPDATE events SET date = '2026-10-01', starts_at = '2026-10-01T11:00:00Z' WHERE id = 1;
    `);
    await queueRatingRepair(db, "competition", 1, "2026-09-01T00:00:00.000Z");
    expect(sqlite.prepare("SELECT last_code, retry_at FROM rating_repair_issues WHERE source_id=1").get())
      .toEqual({ last_code: "finalize-write-failed", retry_at: "2026-09-01T00:00:00.000Z" });
    expect((await runRatingRepairCycle(db, "2026-09-01T00:00:00.000Z")).retriedSources).toBe(1);
    expect(sqlite.prepare("SELECT DISTINCT round_date FROM round_ratings WHERE event_id=1").get())
      .toEqual({ round_date: "2026-06-10T15:00:00.000Z" });
  });

  it("captures a dated rating from the PDGA API and ignores undated ones, reading nothing else", async () => {
    const { db, sqlite } = await fixture();
    const records = {
      "member:m_123": JSON.stringify({ memberId: "m_123", pdgaNo: "123", name: "Dated Member" }),
      "member:m_456": JSON.stringify({ memberId: "m_456", pdgaNo: "456", name: "Undated Member" }),
    };
    const env = { DB: db, PDGA_API_USERNAME: "club", PDGA_API_PASSWORD: "pw", PDGA_API_BASE: "https://api.test.pdga",
      RATELIMIT: { get: async () => null, put: async () => {}, delete: async () => {} },
      ROSTER: {
        list: async () => ({ keys: Object.keys(records).map((name) => ({ name })), list_complete: true }),
        get: async (key: keyof typeof records) => records[key] ?? null,
      } } as unknown as Env;
    sqlite.exec("CREATE TABLE pdga_api_players (pdga_number TEXT PRIMARY KEY, data TEXT, fetched_at INTEGER NOT NULL)");
    resetPdgaApiSession();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/user/login")) return Response.json({ sessid: "s", session_name: "SESS", token: "t" });
      return Response.json({ players: [
        { pdga_number: "123", first_name: "Dated", last_name: "Member", membership_status: "current", rating: "996", rating_effective_date: "2025-06-10" },
        { pdga_number: "456", first_name: "Undated", last_name: "Member", membership_status: "current", rating: "990" },
      ] });
    });
    try {
      expect((await runRatingsRecompute(env, new Date("2026-09-01T00:00:00.000Z"))).pdgaRefreshed).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(urls.every((url) => url.startsWith("https://api.test.pdga/services/json/"))).toBe(true);
    expect(sqlite.prepare("SELECT member_id, effective_at, rating FROM rating_anchor_snapshots WHERE member_id IN ('m_123','m_456')").all())
      .toEqual([{ member_id: "m_123", effective_at: "2025-06-10T00:00:00.000Z", rating: 996 }]);
  });

  it("leaves an old field's ratings as rated once the PDGA ratings that calibrated it are gone", async () => {
    const { db, sqlite } = await fixture();
    await repairRatingSource(db, "competition", 2);
    const rated = () => sqlite.prepare("SELECT member_id, round_rating, rating_method FROM round_ratings WHERE event_id=2 ORDER BY member_id").all();
    const before = rated();
    expect(before.some((row) => (row as { round_rating: number | null }).round_rating != null)).toBe(true);
    // PDGA's API license: anchors are kept only a few days. The rolling scan must not re-solve old fields without them.
    sqlite.exec("DELETE FROM rating_anchor_snapshots");
    expect(await repairRatingSource(db, "competition", 2, null, { keepRatedBefore: "2030-01-01T00:00:00.000Z" })).toMatchObject({ kept: true, rows: 0 });
    expect(rated()).toEqual(before);
    // A round played after the cutoff is still re-solved (here: without anchors, so it changes).
    expect(await repairRatingSource(db, "competition", 2, null, { keepRatedBefore: "2000-01-01T00:00:00.000Z" })).not.toHaveProperty("kept");
    expect(rated()).not.toEqual(before);
  });

  it("steps past a failing source, retries it on the next scheduled pass, and excludes unproven or ineligible rounds", async () => {
    const { db, sqlite, failAtStatement } = await fixture();
    failAtStatement(0);
    const first = await runRatingRepairCycle(db, "2026-09-01T00:00:00.000Z");
    expect(first.failedSources).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM round_ratings WHERE event_id=1").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM round_ratings WHERE event_id=2").get()?.count).toBe(3);
    expect(sqlite.prepare("SELECT last_code, attempts FROM rating_repair_issues WHERE stream='competition' AND source_id=1").get())
      .toEqual({ last_code: "source-repair-failed", attempts: 1 });
    const second = await runRatingRepairCycle(db, "2026-09-02T01:00:00.000Z");
    expect(second.retriedSources).toBeGreaterThanOrEqual(1);
    expect(second.failedSources).toBe(0);
    expect(sqlite.prepare("SELECT DISTINCT event_id FROM round_ratings WHERE event_id IS NOT NULL ORDER BY event_id").all())
      .toEqual([{ event_id: 1 }, { event_id: 2 }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM round_ratings WHERE casual_round_code='OLDSTYLE' OR member_id IN ('op_walkup', 'g_guest', 'm_bad_score')").get()?.count)
      .toBe(0);
    expect(sqlite.prepare("SELECT after_id FROM rating_repair_checkpoints WHERE stream='competition'").get()).toEqual({ after_id: 0 });
  });

  it("keeps casual 'layout' ratings and baselines valid after 7-day PDGA anchor deletion while still invalidating on event changes", async () => {
    const { db, sqlite } = await fixture();
    await repairRatingSource(db, "competition", 1);
    await repairRatingSource(db, "casual", 1, 38);
    expect((await getMemberRatings(db, ALPHA)).casual.rounds.find((row) => row.round_code === "OLDPIN")).toMatchObject({
      rating_method: "layout",
      baseline_event_id: 1,
      rating: expect.any(Number),
    });
    // Simulate the daily PDGA anchor purge removing all historical anchors 7+ days later.
    sqlite.exec("DELETE FROM rating_anchor_snapshots");
    expect((await getMemberRatings(db, ALPHA)).casual.rounds.find((row) => row.round_code === "OLDPIN")).toMatchObject({
      rating_method: "layout",
      baseline_event_id: 1,
      rating: expect.any(Number),
    });
    await expect(getLayoutRatingBaseline(db, LAYOUT, positions(OLD), "2026-06-12")).resolves.toMatchObject({ eventId: 1 });
    // Even without anchors, modifying a calibration competition score immediately withholds the casual rating.
    sqlite.prepare("UPDATE results SET total=11, to_par=2, scorecard=? WHERE event_id=1 AND member_id=?").run(card(OLD, 11), BETA);
    expect((await getMemberRatings(db, ALPHA)).casual.rounds.find((row) => row.round_code === "OLDPIN"))
      .toMatchObject({ rating: null, unrated_reason: "rating-source-changed" });
    await expect(getLayoutRatingBaseline(db, LAYOUT, positions(OLD), "2026-06-12")).resolves.toBeNull();
  });
});
