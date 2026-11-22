import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleBagTags } from "../src/bag-tag-routes.js";
import { buildCasualArchiveSnapshot } from "../src/casual-archive.js";
import { handleClubLive, startLiveEvent } from "../src/club-live-routes.js";
import { handleCasualRounds } from "../src/club-rounds-routes.js";
import { listLayoutHandicapRounds, listMemberCasualResults, listMemberResults } from "../src/db-results.js";
import type { D1Like, D1StatementLike } from "../src/db-types.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { LiveEventDO } from "../src/live.js";
import { computeLiveStandings } from "../src/live-scoring.js";
import type { LiveSocket, LiveState } from "../src/live-types.js";
import { summarizeMatchplay } from "../src/matchplay-scoring.js";
import { handleOfflineRoundRoute } from "../src/offline-round-routes.js";
import { aggregatePlayerRating, pointsPerThrow } from "../src/rating-engine.js";
import { computeRoundWinners, computeTeamStandings } from "../src/scoring.js";
import { handleWatchRoute } from "../src/watch-routes.js";
import type { OfflineRound } from "../../src/shared/offline-round.js";

const SECRET = "batch4-accuracy-secret-key-0123456789!!";
const ORIGIN = "https://gvdgclub.com";

class FakeState implements LiveState {
  readonly accepted: LiveSocket[] = [];
  private readonly stored: Record<string, unknown> = {};
  alarmAt: number | null = null;
  readonly storage = {
    get: async <T = unknown>(key: string) => this.stored[key] as T | undefined,
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") this.stored[key] = value;
      else Object.assign(this.stored, key);
    },
    getAlarm: async () => this.alarmAt,
    setAlarm: async (t: number) => { this.alarmAt = t; },
    deleteAlarm: async () => { this.alarmAt = null; },
  };
  acceptWebSocket(s: LiveSocket) { this.accepted.push(s); }
  getWebSockets(): LiveSocket[] { return this.accepted; }
}

async function createSqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  type Stmt = D1StatementLike & { run: () => Promise<unknown>; sql: string; values: unknown[] };
  const rawDb = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        sql,
        get values() { return bound; },
        bind(...args: unknown[]) { bound = args; return stmt; },
        async all<T = Record<string, unknown>>() {
          return { results: sqlite.prepare(sql).all(...bound as never[]) as T[], success: true };
        },
        async first<T = Record<string, unknown>>() {
          return (sqlite.prepare(sql).get(...bound as never[]) ?? null) as T | null;
        },
        async run() {
          const res = sqlite.prepare(sql).run(...bound as never[]);
          const idRow = sqlite.prepare("SELECT last_insert_rowid() AS id").get() as { id?: number } | undefined;
          return { results: [], success: true, meta: { changes: res.changes, last_row_id: idRow?.id } };
        },
      };
      return stmt;
    },
    async batch(statements: D1StatementLike[]) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) {
          const st = s as Stmt;
          out.push({ results: sqlite.prepare(st.sql).all(...st.values as never[]), success: true });
        }
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, db: rawDb as unknown as D1Like };
}

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
    list: async (opts?: { prefix?: string }) => ({
      keys: [...rows.keys()].filter((k) => k.startsWith(opts?.prefix || "")).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function act(live: LiveEventDO, path: string, member: string, body?: unknown, admin = false) {
  return live.fetch(new Request("https://do/" + path, {
    method: body !== undefined ? "POST" : "GET",
    headers: { "X-Auth-Member": member, ...(admin ? { "X-Auth-Admin": "true" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
}

describe("Batch 4 scoring, authz & data accuracy regressions", () => {
  it("P0-1: blocks competition re-start in startLiveEvent and LiveEventDO.start", async () => {
    const { sqlite, db } = await createSqliteDb();
    sqlite.exec(`INSERT INTO events (id, type, name, status, layout_id) VALUES (9001, 'league_round', 'Week 1', 'live', 1), (9002, 'league_round', 'Week 2', 'final', 1)`);
    const env = { DB: db, LIVE: { idFromName: (k: string) => k, get: () => ({ fetch: async () => new Response("{}") }) } } as unknown as Env;
    const liveRes = await startLiveEvent(env, ORIGIN, 9001);
    expect(liveRes.status).toBe(409);
    await expect(liveRes.json()).resolves.toEqual({ error: "already_started" });
    const finalRes = await startLiveEvent(env, ORIGIN, 9002);
    expect(finalRes.status).toBe(409);
    await expect(finalRes.json()).resolves.toEqual({ error: "round_already_final" });

    sqlite.exec(`INSERT INTO courses (id, name) VALUES (9001, 'Park B4'); INSERT INTO course_layouts (id, course_id, name, holes) VALUES (9001, 9001, 'Main', '[{"hole":1,"par":3}]'); INSERT INTO events (id, type, name, status, layout_id) VALUES (9003, 'league_round', 'Week 3', 'live', 9001)`);
    const live = new LiveEventDO(new FakeState(), { DB: db });
    await act(live, "start", "m_a", { eventId: 9003, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m_a", name: "A" }] });
    const restartLive = await act(live, "start", "m_a", { eventId: 9003, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m_a", name: "A" }] });
    expect(restartLive.status).toBe(409);
    await expect(restartLive.json()).resolves.toEqual({ error: "already_started" });
    await act(live, "score", "m_a", { index: 0, hole: 1, strokes: 3 });
    expect((await act(live, "finalize", "m_a", { force: true }, true)).status).toBe(200);
    const restartFinal = await act(live, "start", "m_a", { eventId: 9003, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m_a", name: "A" }] });
    expect(restartFinal.status).toBe(409);
    await expect(restartFinal.json()).resolves.toEqual({ error: "round_already_final" });
  });

  it("P0-2: guards DO /override with admin check, retains locations on finalize failure, and returns LiveStanding from casual finish-card", async () => {
    const { sqlite, db } = await createSqliteDb();
    sqlite.exec(`INSERT INTO courses (id, name) VALUES (9010, 'Park Fin'); INSERT INTO course_layouts (id, course_id, name, holes) VALUES (9010, 9010, 'Main', '[{"hole":1,"par":3}]'); INSERT INTO events (id, type, name, status, layout_id) VALUES (9010, 'tournament', 'Open', 'live', 9010)`);
    const live = new LiveEventDO(new FakeState(), { DB: db });
    await act(live, "start", "m_a", { eventId: 9010, holes: [{ hole: 1, par: 3, tee: { lat: 35.6, lng: -77.37 }, target: { lat: 35.601, lng: -77.37 } }], players: [{ memberId: "m_a", name: "A" }] });
    expect((await act(live, "override", "m_a", { hole: 1, par: 4 })).status).toBe(403);
    expect((await act(live, "override", "m_a", { hole: 1, par: 4 }, true)).status).toBe(200);
    expect((await act(live, "location", "m_a", { lat: 35.6005, lng: -77.37 })).status).toBe(200);
    sqlite.exec(`CREATE TRIGGER fail_res BEFORE INSERT ON results BEGIN SELECT RAISE(ABORT, 'db_fail'); END`);
    await expect(act(live, "finalize", "m_a", { force: true }, true)).rejects.toThrow("db_fail");
    const snapDuring = await (await live.fetch(new Request("https://do/snapshot"))).json() as { playerLocations: unknown[] };
    expect(snapDuring.playerLocations).toHaveLength(1);
    sqlite.exec(`DROP TRIGGER fail_res`);
    await act(live, "score", "m_a", { index: 0, hole: 1, strokes: 3 });
    expect((await act(live, "finalize", "m_a", { force: true }, true)).status).toBe(200);
    const snapAfter = await (await live.fetch(new Request("https://do/snapshot"))).json() as { playerLocations: unknown[] };
    expect(snapAfter.playerLocations).toEqual([]);

    const casual = new LiveEventDO(new FakeState(), { DB: db });
    await act(casual, "start", "m_owner", { casual: true, roundCode: "CAS123", holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m_owner", name: "Owner" }] });
    await act(casual, "score", "m_owner", { index: 0, hole: 1, strokes: 3 });
    const finished = await act(casual, "finish-card", "m_owner", {});
    expect(finished.status).toBe(200);
    await expect(finished.json()).resolves.toMatchObject({ status: "final", standings: [{ targetId: "player:0", name: "Owner" }] });
  });

  it("P0-5 & P0-6: finish-card blocks broken doubles card, putting finalize writes zeroed breakdown", async () => {
    const { sqlite, db } = await createSqliteDb();
    const broken = new LiveEventDO(new FakeState(), { DB: db });
    await act(broken, "start", "m_a", {
      casual: true, roundCode: "DBL1", holes: [{ hole: 1, par: 3 }],
      liveScoringConfig: { groupFormat: "doubles", scoringStyle: "stroke" },
      players: [
        { memberId: "m_a", name: "A", cardId: "c0", team: "Alpha" },
        { memberId: "m_b", name: "B", cardId: "c0", team: "Alpha" },
        { memberId: "m_c", name: "C", cardId: "c0", team: "Solo" },
      ],
    });
    expect((await act(broken, "finish-card", "m_a", {})).status).toBe(400);

    sqlite.exec(`INSERT INTO events (id, type, name, status) VALUES (9015, 'league_round', 'Putting', 'live')`);
    const putting = new LiveEventDO(new FakeState(), { DB: db });
    await act(putting, "start", "m_a", {
      eventId: 9015, holes: [{ hole: 1, par: 5 }, { hole: 2, par: 5 }],
      liveScoringConfig: { groupFormat: "singles", scoringStyle: "putting" },
      players: [{ memberId: "m_a", name: "A" }],
    });
    await act(putting, "score", "m_a", { index: 0, hole: 1, strokes: 1 });
    await act(putting, "score", "m_a", { index: 0, hole: 2, strokes: 5 });
    expect((await act(putting, "finalize", "m_a", { force: true }, true)).status).toBe(200);
    const row = sqlite.prepare("SELECT breakdown FROM results WHERE event_id = 9015").get() as { breakdown: string };
    expect(JSON.parse(row.breakdown)).toEqual({ aces: 0, eagles: 0, birdies: 0, pars: 0, bogeys: 0, doubles_plus: 0 });
  });

  it("P0-7: blocks non-card GET /sharing and non-card map-mark requests", async () => {
    const { db } = await createSqliteDb();
    const dos = new Map<string, LiveEventDO>();
    const getDo = (key: string) => {
      let d = dos.get(key);
      if (!d) { d = new LiveEventDO(new FakeState(), { DB: db }); dos.set(key, d); }
      return d;
    };
    const env = {
      DB: db, JWT_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN,
      ROSTER: kv({
        "member:m_owner": JSON.stringify({ memberId: "m_owner", name: "Owner", pinVer: 0, mustChangePin: false }),
        "member:m_stranger": JSON.stringify({ memberId: "m_stranger", name: "Stranger", pinVer: 0, mustChangePin: false }),
      }),
      RATELIMIT: kv(),
      LIVE: { idFromName: (k: string) => k, get: (k: string) => ({ fetch: (u: RequestInfo | URL, init?: RequestInit) => getDo(k).fetch(new Request(u, init)) }) },
    } as unknown as Env;

    const roundDo = getDo("round:SAFE44");
    await act(roundDo, "start", "m_owner", { casual: true, roundCode: "SAFE44", holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m_owner", name: "Owner", cardId: "c0" }] });
    expect((await act(roundDo, "sharing", "m_stranger")).status).toBe(403);
    expect((await act(roundDo, "sharing", "m_owner")).status).toBe(200);

    const evDo = getDo("event:5");
    await act(evDo, "start", "m_owner", { eventId: 5, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m_owner", name: "Owner", cardId: "c0" }] });
    const strangerToken = await signSession({ sub: "m_stranger", mustChangePin: false, pinVer: 0 }, SECRET, 300);

    const evMark = await handleClubLive(
      new Request("https://api.test/events/5/live/map-mark", { method: "POST", headers: { Authorization: "Bearer " + strangerToken }, body: JSON.stringify({ hole: 1, kind: "tee", lat: 35.1, lng: -77.1 }) }),
      env, ORIGIN, "POST", ["events", "5", "live", "map-mark"],
    );
    expect(evMark?.status).toBe(403);
    await expect(evMark?.json()).resolves.toEqual({ error: "not_on_card" });

    const rdMark = await handleCasualRounds(
      new Request("https://api.test/rounds/SAFE44/live/map-mark", { method: "POST", headers: { Authorization: "Bearer " + strangerToken }, body: JSON.stringify({ hole: 1, kind: "tee", lat: 35.1, lng: -77.1 }) }),
      env, ORIGIN, "POST", ["rounds", "SAFE44", "live", "map-mark"],
    );
    expect(rdMark?.status).toBe(403);
    await expect(rdMark?.json()).resolves.toEqual({ error: "not_on_card" });
  });

  it("P0-8 & P1-2: scores multiple Ryder cards per event, ignores 0-hole matches, and stops at shotgun clinch", () => {
    const sg = (label: string, targetId: string, members: string[]) => JSON.stringify({ label, targetId, members });
    const win = JSON.stringify({ status: "won 3&2", outcome: "won", holesWon: 3, holesLost: 0, holesTied: 0 });
    const loss = JSON.stringify({ status: "won 3&2", outcome: "lost", holesWon: 0, holesLost: 3, holesTied: 0 });
    const zeroDraw = JSON.stringify({ status: "AS", outcome: "draw", holesWon: 0, holesLost: 0, holesTied: 0 });
    const rows = [
      { event_id: 10, scoring_group: sg("Red", "m1", ["R1"]), match_result: win },
      { event_id: 10, scoring_group: sg("Red", "m2", ["R2"]), match_result: win },
      { event_id: 10, scoring_group: sg("Blue", "m1b", ["B1"]), match_result: loss },
      { event_id: 10, scoring_group: sg("Blue", "m2b", ["B2"]), match_result: loss },
      { event_id: 11, scoring_group: sg("Red", "z1", ["R3"]), match_result: zeroDraw },
    ];
    const teams = computeTeamStandings(rows);
    expect(teams.find((t) => t.team === "Red")?.points).toBe(4);
    expect(teams.find((t) => t.team === "Red")?.matches).toBe(2);
    expect(computeRoundWinners(rows)).toEqual({ 10: "red" });

    const holes = [{ hole: 1 }, { hole: 2 }, { hole: 3 }, { hole: 4 }];
    const players = [
      { memberId: "m1", name: "Left", startingHole: 3, cardId: "c1", scores: { 3: 2, 4: 2, 1: 2, 2: 5 }, division: null, scorecards: {} },
      { memberId: "m2", name: "Right", startingHole: 3, cardId: "c1", scores: { 3: 3, 4: 3, 1: 3, 2: 2 }, division: null, scorecards: {} },
    ];
    const summary = summarizeMatchplay({
      holes,
      players,
      targets: [
        { type: "player", id: "player:0", label: "Left", playerIndexes: [0], memberIds: ["m1"] },
        { type: "player", id: "player:1", label: "Right", playerIndexes: [1], memberIds: ["m2"] },
      ],
      targetName: (t) => t.label,
      scoreForTarget: (ps, t, hole) => ps[t.playerIndexes[0]!]?.scores[hole],
    });
    expect(summary.sides[0].match.status).toBe("won 3&1");
    expect(summary.sides[0].match.lead).toBe(3);
    expect(summary.sides[0].match.holesRemaining).toBe(1);
  });

  it("P1-3, P1-4, P1-11 & P1-13: handicap exclusion, live sorting/divisions, CTP cleanup, and casual archive grouping", async () => {
    const { sqlite, db } = await createSqliteDb();
    sqlite.exec(`
      INSERT INTO courses (id, name, udisc_url) VALUES (9005, 'Meadow B4', 'https://udisc.com/courses/meadow');
      INSERT INTO course_layouts (id, course_id, name, holes) VALUES (9005, 9005, 'Blue', '[{"hole":1,"par":3},{"hole":2,"par":3}]');
      INSERT INTO events (id, type, name, status, format, date, course_id, layout_id) VALUES
        (9101, 'tournament', 'Singles', 'final', 'stroke', '2026-10-10', 9005, 9005),
        (9102, 'league_round', 'Doubles', 'final', 'doubles', '2026-10-11', 9005, 9005),
        (9103, 'league_round', 'Putting', 'final', 'stroke', '2026-10-12', 9005, 9005);
      INSERT INTO event_config (event_id, play_format, live_scoring_config) VALUES
        (9101, 'singles', '{"groupFormat":"singles","scoringStyle":"stroke"}'),
        (9102, 'doubles', '{"groupFormat":"doubles","scoringStyle":"stroke"}'),
        (9103, 'singles', '{"groupFormat":"singles","scoringStyle":"putting"}');
      INSERT INTO results (event_id, member_id, name, place, total, to_par) VALUES
        (9101, 'm_1', 'Alex', 1, 54, 0),
        (9102, 'm_1', 'Alex', 1, 50, -4),
        (9103, 'm_1', 'Alex', 1, 15, 0);
      INSERT INTO casual_rounds (id, round_code, course_id, layout_id, course_name, layout_name, holes, scoring_config, finalized_at) VALUES
        (9101, 'PAIR9', 9005, 9005, 'Meadow B4', 'Blue', '[{"hole":1,"par":3},{"hole":2,"par":3}]', '{"groupFormat":"doubles","scoringStyle":"stroke"}', '2026-10-12'),
        (9102, 'PUTT9', 9005, 9005, 'Meadow B4', 'Blue', '[{"hole":1,"par":5}]', '{"groupFormat":"singles","scoringStyle":"putting"}', '2026-10-13');
      INSERT INTO casual_results (casual_round_id, member_id, name, place, total, to_par, live_player_index, scoring_group) VALUES
        (9101, 'm_1', 'Alex', 1, 5, -1, 0, '{"targetId":"pair:a","targetType":"pair","label":"A/B","members":["Alex","Bo"]}'),
        (9101, 'm_2', 'Bo', 1, 5, -1, 1, '{"targetId":"pair:a","targetType":"pair","label":"A/B","members":["Alex","Bo"]}'),
        (9101, 'm_3', 'DNF', NULL, 0, 0, 2, NULL),
        (9102, 'm_1', 'Alex', 1, 10, 0, 0, NULL);
    `);
    const handicapRows = await listLayoutHandicapRounds(db, 9005, "2026-01-01");
    expect(handicapRows).toHaveLength(1);
    const memberRows = await listMemberResults(db, "m_1") as { event_id: number; stroke_singles: number; course_name: string; layout_name: string; udisc_url: string }[];
    expect(memberRows.map((r) => [r.event_id, r.stroke_singles])).toEqual([[9103, 0], [9102, 0], [9101, 1]]);
    expect(memberRows[0]?.udisc_url).toBe("https://udisc.com/courses/meadow");
    const casualRows = await listMemberCasualResults(db, "m_1") as { round_code: string; stroke_singles: number }[];
    expect(casualRows.find((r) => r.round_code === "PUTT9")?.stroke_singles).toBe(0);

    const standings = computeLiveStandings({
      holes: [{ hole: 1, par: 3 }],
      config: { groupFormat: "singles", scoringStyle: "stroke" },
      players: [
        { memberId: "m_z", name: "Zero", division: "MA1", scores: {}, cardId: "c1", scorecards: {} },
        { memberId: "m_s", name: "Scored", division: "MPO", scores: { 1: 5 }, cardId: "c1", scorecards: {} },
      ],
      targets: [
        { type: "player", id: "player:0", label: "Zero", playerIndexes: [0], memberIds: ["m_z"] },
        { type: "player", id: "player:1", label: "Scored", playerIndexes: [1], memberIds: ["m_s"] },
      ],
    });
    expect(standings[0]?.name).toBe("Scored");
    expect(standings[0]?.division).toBe("MPO");

    const archive = await buildCasualArchiveSnapshot(db, "PAIR9");
    expect(archive?.standings).toHaveLength(2);
    expect((archive?.standings[0] as { playerIndexes: number[] }).playerIndexes).toEqual([0, 1]);
    expect((archive?.standings[1] as { thru: number }).thru).toBe(0);

    const ctpDo = new LiveEventDO(new FakeState(), { DB: db });
    await act(ctpDo, "start", "m_a", {
      eventId: 9022, holes: [{ hole: 1, par: 3 }],
      players: [
        { memberId: "m_a", name: "A", cardId: "c0" },
        { memberId: "m_b", name: "B", cardId: "c0" },
      ],
    });
    expect((await act(ctpDo, "ctp", "m_a", { ctpId: 1, hole: 1, nomineeIndex: 1 })).status).toBe(200);
    await act(ctpDo, "remove", "m_a", { memberId: "m_b" }, true);
    const snapCtp = await (await ctpDo.fetch(new Request("https://do/snapshot"))).json() as { liveCtps: unknown[] };
    expect(snapCtp.liveCtps).toMatchObject([{ id: 1, hole: 1, leaderPlayerIndex: null, leaderName: null }]);
  });

  it("P2-7, P2-8 & PDGA 2.15: lowercase watch roundCode + active round_id filter, bag-tag rollback, R2 cleanup & rating edge cases", async () => {
    const { sqlite, db } = await createSqliteDb();
    const watchToken = await signSession({ sub: "m_player", mustChangePin: false, pinVer: 0 }, SECRET, 300);
    sqlite.exec(`
      INSERT INTO watch_pairings (id, token_hash, expires_at, approved_at, actor_id, round_key, round_id, card_id, actor_index) VALUES
        ('11111111-1111-4111-8111-111111111111', 't_cur', ${Date.now() + 60_000}, ${Date.now()}, 'm_player', 'round:SAFE44', 'gen-current', 'c0', 0),
        ('22222222-2222-4222-8222-222222222222', 't_old', ${Date.now() + 60_000}, ${Date.now()}, 'm_player', 'round:SAFE44', 'gen-old', 'c0', 0);
    `);
    const watchEnv = {
      DB: db, JWT_SECRET: SECRET, ROSTER: kv({ "member:m_player": JSON.stringify({ memberId: "m_player", name: "Player", pinVer: 0, mustChangePin: false }) }),
      RATELIMIT: kv(),
      LIVE: { idFromName: () => "round:SAFE44", get: () => ({ fetch: async () => Response.json({ scope: { roundId: "gen-current", cardId: "c0", actorIndex: 0 }, targets: [] }) }) },
    } as unknown as Env;
    const devicesRes = await handleWatchRoute(
      new Request("https://watch.test/watch/pairings?roundCode=safe44", { headers: { Authorization: "Bearer " + watchToken } }),
      watchEnv, ORIGIN, "/watch/pairings", "GET",
    );
    expect(devicesRes?.status).toBe(200);
    await expect(devicesRes?.json()).resolves.toEqual({ devices: [{ deviceId: "11111111-1111-4111-8111-111111111111", approvedAt: expect.any(Number), expiresAt: expect.any(Number) }] });

    sqlite.exec(`
      INSERT INTO bag_tag_series (id, name) VALUES (9001, 'Series');
      INSERT INTO bag_tag_holders (series_id, tag_number, member_id, member_name) VALUES
        (9001, 1, 'm_ch', 'Ch'),
        (9001, 2, 'm_def', 'Def');
      INSERT INTO bag_tag_challenges (id, series_id, challenger_id, challenger_name, defender_id, defender_name, challenger_tag, defender_tag, challenger_score, defender_score, status)
        VALUES (9, 9001, 'm_ch', 'Ch', 'm_def', 'Def', 1, 2, 50, 52, 'pending');
      CREATE TRIGGER fail_moves BEFORE INSERT ON bag_tag_moves BEGIN SELECT RAISE(ABORT, 'move_fail'); END;
    `);
    const defToken = await signSession({ sub: "m_def", mustChangePin: false, pinVer: 0 }, SECRET, 300);
    const bagEnv = {
      DB: db, JWT_SECRET: SECRET, ROSTER: kv({ "member:m_def": JSON.stringify({ memberId: "m_def", name: "Def", pinVer: 0, mustChangePin: false }) }),
      RATELIMIT: kv(),
    } as unknown as Env;
    await expect(handleBagTags(
      new Request("https://api.test/bag-tags/challenges/9/confirm", { method: "POST", headers: { Authorization: "Bearer " + defToken } }),
      bagEnv, ORIGIN, "POST", ["bag-tags", "challenges", "9", "confirm"],
    )).rejects.toThrow("move_fail");
    expect(sqlite.prepare("SELECT status, closed_at FROM bag_tag_challenges WHERE id = 9").get()).toEqual({ status: "pending", closed_at: null });

    const r2Objects = new Map<string, Uint8Array>();
    sqlite.exec(`CREATE TRIGGER fail_offline_insert BEFORE INSERT ON offline_rounds BEGIN SELECT RAISE(ABORT, 'd1_offline_err'); END`);
    const offEnv = {
      DB: db, JWT_SECRET: SECRET, RATELIMIT: kv(),
      ROSTER: kv({ "member:m_off": JSON.stringify({ memberId: "m_off", name: "Off", pinVer: 0, mustChangePin: false }) }),
      PHOTOS: { put: async (k: string, b: Uint8Array) => void r2Objects.set(k, b), delete: async (k: string) => void r2Objects.delete(k) },
    } as unknown as Env;
    const offToken = await signSession({ sub: "m_off", mustChangePin: false, pinVer: 0 }, SECRET, 300);
    const offlineRound: OfflineRound = {
      version: 1, localId: "10000000-0000-4000-8000-000000000020", owner: { id: "m_off", kind: "member" }, startedAs: "account",
      source: { courseId: 1, courseName: "Park", layoutId: 1, layoutName: "Main", savedAt: "2026-04-21T18:00:00.000Z", revision: "r1", contentRevision: "c1", holes: [{ hole: 1, par: 3, par_source: null, distance_ft: 300, distance_source: null, tee: null, target: null }] },
      format: { groupFormat: "singles", scoringStyle: "stroke" }, players: [{ id: "10000000-0000-4000-8000-000000000001", name: "Off" }],
      startedAt: "2026-04-22T19:00:00.000Z", finishedAt: "2026-04-22T20:00:00.000Z", scores: { "player:0": { 1: 3 } }, shots: {}, marks: {},
    };
    await expect(handleOfflineRoundRoute(
      new Request("https://api.test/offline-rounds/import", { method: "POST", headers: { Authorization: "Bearer " + offToken, "Content-Type": "application/json" }, body: JSON.stringify(offlineRound) }),
      offEnv, ORIGIN, "/offline-rounds/import", "POST",
    )).rejects.toThrow("d1_offline_err");
    expect(r2Objects.size).toBe(0);

    expect(pointsPerThrow(100)).toBeGreaterThanOrEqual(0.5);
    expect(pointsPerThrow(81, 27)).toBeCloseTo(pointsPerThrow(54, 18) * (18 / 27), 8);
    const rated = (i: number, roundRating: number) => ({ roundRating, roundDate: `2026-06-0${i}T12:00:00Z` });
    const playerSummary = aggregatePlayerRating({
      now: "2026-07-01T00:00:00.000Z",
      rounds: [rated(1, 900), rated(2, 901), rated(3, 899), rated(4, 900), rated(5, 902), rated(6, 898), rated(7, 900), rated(8, 700)],
    });
    expect(playerSummary.ratedRounds).toBe(7);
    expect(playerSummary.rating).toBe(900);
  });
});
