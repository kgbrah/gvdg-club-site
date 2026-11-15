import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { D1Like, D1StatementLike } from "../src/db-types.js";
import { LiveEventDO } from "../src/live.js";
import type { LiveState } from "../src/live-types.js";
import { loadPlayHistory, parsePlayHistoryFilter, readPersonalPlayPage, readRoundShotHistory } from "../src/play-history.js";
import { listSeasonPlayRows } from "../src/db-results.js";

const COURSE_PIN = { lat: 0, lng: 0.002 };
const OLD_PIN = { lat: 0, lng: 0 };
const SHOT_ORIGIN = { lat: 0, lng: -0.000055, accuracyM: 0.3, observedAt: 1_786_000_100_000 };
const HOLE = { hole: 1, par: 3, target: COURSE_PIN };
const SHOTS = [
  { id: "10000000-0000-4000-a000-000000000001", kind: "throw", attempt: "throw", outcome: "missed", originLie: "tee", landingLie: "fairway", landing: SHOT_ORIGIN },
  { id: "10000000-0000-4000-a000-000000000002", kind: "throw", attempt: "putt", outcome: "missed", origin: SHOT_ORIGIN },
  { id: "10000000-0000-4000-a000-000000000003", kind: "throw", attempt: "putt", outcome: "made", origin: SHOT_ORIGIN },
];

function order(n: number) { return `000001786000000${n}:00000000-0000-4000-a000-00000000000${n}`; }

async function fixture() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of ["0001_init.sql", "0005_registration.sql", "0015_udisc_export.sql", "0016_casual_rounds.sql",
    "0018_live_scoring_metadata.sql", "0022_ratings.sql", "0038_udisc_history.sql", "0039_throw_clips.sql", "0049_private_shot_ledgers.sql", "0053_offline_rounds.sql"]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + migration, import.meta.url), "utf8"));
  }
  sqlite.exec("INSERT INTO events(id, name, type, date, status) VALUES (1, 'Ledger event', 'tournament', '2026-08-01', 'live')");
  const db: D1Like = {
    prepare(sql) {
      let values: unknown[] = [];
      return {
        bind(...args) { values = args; return this; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[], success: true }; },
        async first<T>() { return (sqlite.prepare(sql).get(...values) ?? null) as T | null; },
        async run() { return { results: [], success: true, meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
      };
    },
    async batch(queries: D1StatementLike[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const query of queries) results.push(await query.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
  const records = new Map<string, unknown>();
  const storage: LiveState["storage"] = {
    get: async <T>(key: string) => structuredClone(records.get(key)) as T | undefined,
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") records.set(key, structuredClone(value));
      else for (const [name, entry] of Object.entries(key)) records.set(name, structuredClone(entry));
    },
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  const state: LiveState = { storage, acceptWebSocket: () => {}, getWebSockets: () => [] };
  let live = new LiveEventDO(state, { DB: db });
  function request(path: string, data?: object, actor = "m_a", admin = false) {
    return live.fetch(new Request("https://do/" + path, {
      method: data ? "POST" : "GET", body: data ? JSON.stringify(data) : undefined,
      headers: { "X-Auth-Member": actor, "X-Auth-Admin": String(admin) },
    }));
  }
  function start(isCasual = false, doubles = false) {
    return request("start", {
      eventId: isCasual ? 0 : 1, casual: isCasual, roundCode: isCasual ? "SHOT12" : null,
      startedAt: "2026-08-01T10:00:00Z", courseName: "Test course", holes: [HOLE],
      liveScoringConfig: { groupFormat: doubles ? "doubles" : "singles", scoringStyle: "stroke" },
      players: [{ memberId: "m_a", name: "A", cardId: "c1", team: doubles ? "Pines" : null },
        { memberId: "m_b", name: "B", cardId: "c1", team: doubles ? "Pines" : null }],
    });
  }
  function reload() { live = new LiveEventDO(state, { DB: db }); }
  return { request, start, reload, db, sqlite };
}

it("preserves private score-scoped shots and their original geometry across retry, reload, and event archive", async () => {
  const { request, start, reload, db, sqlite } = await fixture();
  expect((await start()).status).toBe(200);
  const mine = await (await request("mine")).json() as { recoveryRoundId: string };
  const scope = { roundId: mine.recoveryRoundId, cardId: "c1", actorIndex: 0 };
  const edits = (n: number, previous: string | null, rows: object[]) => ({
    hole: 1, scorerIndex: 0, ledger: { targetId: "player:0", binding: "0", geometry: { tee: null, target: OLD_PIN }, rows },
    recovery: { ...scope, order: order(n), previous },
  });
  expect((await request("throws", edits(1, null, SHOTS), "m_b", true)).status).toBe(409);
  expect((await request("throws", { ...edits(1, null, SHOTS), recovery: { ...scope, actorIndex: 1, order: order(1), previous: null } }, "m_b", true)).status).toBe(403);
  expect((await request("throws", { hole: 1, scorerIndex: 0, throws: [{ lat: 1, lng: 2 }] })).status).toBe(200);
  expect(await (await request("throws", edits(1, null, SHOTS))).json()).toMatchObject({ ledger: { revision: order(1), rows: SHOTS } });
  reload();
  expect(await (await request("throws", edits(1, null, SHOTS))).json()).toMatchObject({ ledger: { version: 1 } });
  const altered = await request("throws", edits(1, null, SHOTS.slice(1)));
  expect(await altered.json()).toEqual({ error: "shot_request_reused" });
  const stale = await request("throws", edits(2, null, []));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "recovery_edit_conflict", ledger: { version: 1, rows: SHOTS } });
  const trim = await request("throws", edits(2, order(1), []));
  expect(await trim.json()).toMatchObject({ ledger: { version: 2, rows: [] } });
  expect((await request("throws", edits(3, order(2), SHOTS))).status).toBe(200);
  expect(await (await request("mine", undefined, "m_b")).json()).toMatchObject({ shotLedgers: {} });
  const publicRead = await (await request("snapshot")).json();
  expect(publicRead).not.toHaveProperty("shotLedgers");
  expect(JSON.stringify(publicRead)).not.toContain(SHOTS[1]!.id);
  expect((await request("score", { targetId: "player:0", hole: 1, strokes: 3 })).status).toBe(200);
  sqlite.exec(`CREATE TRIGGER reject_shots BEFORE INSERT ON round_shot_ledgers
    BEGIN SELECT RAISE(ABORT, 'temporary shot archive failure'); END`);
  await expect(request("finalize", { force: true }, "m_admin", true)).rejects.toThrow("temporary shot archive failure");
  expect(sqlite.prepare("SELECT id FROM results WHERE event_id = 1").all()).toEqual([]);
  expect((await request("mine")).status).toBe(200);
  sqlite.exec("DROP TRIGGER reject_shots");
  expect((await request("finalize", { force: true }, "m_admin", true)).status).toBe(200);
  expect((await request("finalize", { force: true }, "m_admin", true)).status).toBe(200);
  expect(sqlite.prepare("SELECT event_result_id FROM round_shot_ledgers").all()).toHaveLength(1);
  expect((await request("throws", edits(3, order(2), SHOTS))).status).toBe(200);
  expect((await request("throws", edits(4, order(3), SHOTS))).status).toBe(409);

  const stored = sqlite.prepare("SELECT * FROM results WHERE member_id = ?").get("m_a")!;
  expect(JSON.parse(String(stored.scorecard))).toMatchObject([{ strokes: 3, layoutAtPlay: { target: COURSE_PIN }, throws: [{ lat: 1, lng: 2, n: 1 }] }]);
  expect(String(stored.scorecard)).not.toContain(SHOTS[1]!.id);
  expect(JSON.parse(String(stored.breakdown))).toMatchObject({ c1x_putt_att: 2, c1x_putt_hit: 1, fir_hit: 1 });
  const season = await listSeasonPlayRows(db, 2026);
  expect(season.find((row) => row.member_id === "m_a")?.breakdown).toBe(stored.breakdown);
  const archive = await readRoundShotHistory(db, "m_a", "competitive", Number(stored.id));
  expect(archive).toMatchObject([{ hole: 1, strokes: 3, shotLedger: { matchesResult: true, geometry: { target: OLD_PIN }, rows: SHOTS } }]);
  expect(await readRoundShotHistory(db, "m_b", "competitive", Number(stored.id))).toBeNull();
  const exportPage = await readPersonalPlayPage(db, "m_a", { section: 0, after: 0 });
  expect(exportPage.rounds[0]?.holes[0]?.shotLedger?.rows).toHaveLength(3);
  const filters = parsePlayHistoryFilter(new URLSearchParams({ window: "all" }))!;
  expect((await loadPlayHistory(db, "m_a", filters)).totals).toMatchObject({ c1x_putt_att: 2, c1x_putt_hit: 1 });
  sqlite.prepare("DELETE FROM results WHERE id = ?").run(stored.id);
  expect(sqlite.prepare("SELECT event_result_id FROM round_shot_ledgers").all()).toEqual([]);
});

it("archives doubles observations for their recorder rather than copying shots to the partner", async () => {
  const { request, start, db, sqlite } = await fixture();
  expect((await start(true, true)).status).toBe(200);
  const mine = await (await request("mine")).json() as { recoveryRoundId: string; scoreTargets: { id: string }[] };
  const targetId = mine.scoreTargets[0]!.id;
  const save = await request("throws", {
    hole: 1, scorerIndex: 0,
    ledger: { targetId, binding: "0,1", geometry: { target: OLD_PIN }, rows: SHOTS },
    recovery: { roundId: mine.recoveryRoundId, actorIndex: 0, cardId: "c1", order: order(1), previous: null },
  });
  expect(await save.json()).toMatchObject({ ledger: { scope: "team", label: "Pines", rows: SHOTS } });
  expect((await request("score", { targetId, hole: 1, strokes: 3 })).status).toBe(200);
  expect((await request("finalize", {})).status).toBe(200);
  const ledgers = sqlite.prepare("SELECT member_id, casual_result_id FROM round_shot_ledgers").all();
  expect(ledgers).toMatchObject([{ member_id: "m_a" }]);
  expect(await readRoundShotHistory(db, "m_a", "casual", Number(ledgers[0]?.casual_result_id))).toMatchObject([
    { hole: 1, shotLedger: { scope: "team", matchesResult: true, rows: SHOTS } },
  ]);
  expect((await readPersonalPlayPage(db, "m_b", { section: 0, after: 0 })).rounds[0]?.holes[0]?.shotLedger).toBeUndefined();
});
