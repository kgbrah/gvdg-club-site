import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";
import { parseCsvRows } from "../src/imports/csv.js";
import { handleMyPlayExport, handleMyPlayHistory } from "../src/play-history-routes.js";
import { escapePlayCsv, HISTORY_LIMIT_PER_SOURCE, loadPlayHistory, personalPlayExport, parsePlayHistoryFilter } from "../src/play-history.js";

type ExportDocument = ReturnType<typeof personalPlayExport>;
type History = Awaited<ReturnType<typeof loadPlayHistory>>;

const SECRET = "m".repeat(40);
const ORIGIN = "http://localhost:8080";
const MINE = "m_mine";
const OTHER = "m_other";
const TOKEN_SCOPE = { mustChangePin: false, pinVer: 2 };
const MARK = { lat: 0, lng: -0.000055, n: 1 };
const OLD_MARK = { lat: 0, lng: -0.000055, n: 1 };
const OTHER_MARK = { lat: 37.12345, lng: -77.23456, n: 1 };
const AS_PLAYED = { target: { lat: 0, lng: 0, label: "Old pin" }, tee: { lat: 0, lng: -0.001 }, distance_ft: 300 };

async function fixture() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_init.sql", "0005_registration.sql", "0015_udisc_export.sql", "0016_casual_rounds.sql",
    "0018_live_scoring_metadata.sql", "0038_udisc_history.sql", "0039_throw_clips.sql", "0049_private_shot_ledgers.sql"]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  sqlite.exec(`
    INSERT INTO courses (id, name) VALUES (1, '=1+2,"A"'), (2, 'Another course');
    INSERT INTO course_layouts (id, course_id, name, holes)
      VALUES (1, 1, 'Blue', '[{"hole":1,"par":3,"target":{"lat":35,"lng":-77}}]'), (2, 2, 'Blue', '[]');
    INSERT INTO events (id, name, type, date, course_id, layout_id) VALUES
      (1, 'Local league', 'league_round', '2026-01-02', 1, 1),
      (2, 'Other event', 'tournament', '2026-02-09', 2, 2),
      (3, 'Other player only', 'tournament', '2026-01-03', 2, 2),
      (4, 'Duplicate display name', 'tournament', '2025-08-01', 1, 1),
      (5, 'Missing snapshot', 'tournament', '2026-01-07', 1, 1);
    INSERT INTO casual_rounds (id, round_code, course_id, layout_id, course_name, layout_name, started_at, holes)
      VALUES (9, 'TEAM42', 1, 1, 'Club course', 'Blue', '2026-01-05T19:00:00.000Z', '[{"hole":1,"par":3}]'),
        (10, 'UTCNEW', 1, 1, 'Club course', 'Blue', '2026-01-01T02:00:00.000Z', '[{"hole":1,"par":4}]');
    INSERT INTO udisc_history (id, member_id, round_key, player_name, course_name, layout_name, played_at, total, to_par, holes)
      VALUES (1, 'm_other', 'other-private-round', 'Other person', 'Other private place', 'Blue', '2026-01-09T17:30:00', 7, 4, '[{"hole":1,"par":3,"strokes":7}]'),
        (2, 'm_mine', 'imported-id', 'Me', 'A UDisc course', 'Special', '2026-02-01T17:30:00', 5, 1, '[{"hole":1,"par":4,"strokes":5}]');
    INSERT INTO throw_clips (id, scope, scope_key, hole, player_name, player_index, filmed_by, r2_key, content_type, bytes)
      VALUES (13, 'event', '1', 1, 'Secret filmed player', 8, 'm_mine', 'r2-private-key', 'video/mp4', 1000),
        (14, 'round', 'OTHERCLIP', 1, 'Me', 1, 'm_other', 'private-other-clip', 'video/mp4', 4000);
  `);
  const game = sqlite.prepare("INSERT INTO results (id, event_id, member_id, name, total, to_par, scorecard) VALUES (?,?,?,?,?,?,?)");
  const p = (hole: number, strokes: number, throws?: object[], layoutAtPlay?: object, throwsProvenance?: string) => ({
    hole, strokes, par: 3, throws, layoutAtPlay, throwsProvenance,
  });
  game.run(7, 1, MINE, "Me", 6, 0, JSON.stringify([p(1, 2, [MARK], AS_PLAYED, "member"), p(2, 4)]));
  game.run(8, 2, MINE, "Me", 4, 1, JSON.stringify([p(1, 4)]));
  game.run(9, 3, OTHER, "Other person", 22, 19, JSON.stringify([p(1, 22, [OTHER_MARK], AS_PLAYED)]));
  game.run(10, 4, MINE, "Duplicate Name", 2, -1, JSON.stringify([p(1, 2, [OTHER_MARK])]));
  game.run(11, 4, OTHER, "Duplicate Name", 2, -1, JSON.stringify([p(1, 2, [OTHER_MARK])]));
  game.run(12, 5, MINE, "Me", 2, -1, JSON.stringify([p(1, 2, [OLD_MARK])]));
  const casual = sqlite.prepare("INSERT INTO casual_results (id, casual_round_id, member_id, name, total, to_par, scoring_group, breakdown, scorecard) VALUES (?,?,?,?,?,?,?,?,?)");
  casual.run(20, 9, MINE, "Me", 2, -1, '{"targetType":"pair","members":["Me","Other private player"]}',
    '{"holes":1,"birdies":1,"c1x_putt_hit":1,"c1x_putt_att":1}', JSON.stringify([p(1, 2, [OTHER_MARK], AS_PLAYED, "team")]));
  casual.run(21, 10, MINE, "Me", 4, 0, null, null, '[{"hole":1,"par":4,"strokes":4}]');

  const DB = {
    prepare(sql: string) {
      let values: never[] = [];
      return {
        bind(...args: never[]) { values = args; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...values), success: true }; },
      };
    },
  };
  const ROSTER = {
    get: async (key: string) => [MINE, OTHER].some((id) => key === "member:" + id) ?
      JSON.stringify({ name: "Someone", memberId: key.slice(7), pinHash: "x", ...TOKEN_SCOPE }) : null,
  };
  const env = { DB, ROSTER, JWT_SECRET: SECRET } as unknown as Env;
  return { sqlite, env, mine: await signSession({ sub: MINE, ...TOKEN_SCOPE }, SECRET, 900) };
}

function request(path: string, token?: string) {
  return new Request("https://api.test/" + path, { headers: token ? { Authorization: "Bearer " + token } : {} });
}

describe("personal play archive", () => {
  it("requires the owner’s active member session and rejects other token types", async () => {
    const { env } = await fixture();
    for (const token of [
      undefined,
      await signSession({ sub: MINE, pinVer: 1, mustChangePin: false }, SECRET, 900),
      await signSession({ sub: MINE, pinVer: 2, mustChangePin: true }, SECRET, 900),
      await signSession({ sub: "m_deleted", mustChangePin: false }, SECRET, 900),
      await signOpenPlaySession({ sub: "op_player", name: "Guest" }, SECRET, 900),
    ]) {
      expect((await handleMyPlayExport(request("my-play-export", token), env, ORIGIN)).status).toBe(401);
      expect((await handleMyPlayHistory(request("my-play-history", token), env, ORIGIN)).status).toBe(401);
    }
  });

  it("ignores a requested member ID and excludes partner marks, private clip metadata, and other rounds", async () => {
    const { env, mine } = await fixture();
    const result = await handleMyPlayExport(request("my-play-export?format=json&memberId=" + OTHER, mine), env, ORIGIN);
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(result.headers.get("Content-Disposition")).toBe('attachment; filename="gvdg-play-history.json"');
    const raw = await result.text();
    for (const secret of [OTHER, "Other private player", "Other player only", "r2-private-key", "OTHERCLIP", "37.12345", "Secret filmed player", "other-private-round"]) {
      expect(raw).not.toContain(secret);
    }
    const exported = JSON.parse(raw);
    expect(exported.memberId).toBe(MINE);
    expect(exported.rounds).toHaveLength(7);
    expect(exported.rounds.find((r: { eventId: number }) => r.eventId === 1)).toMatchObject({
      source: "competitive", courseId: 1, layoutId: 1, toPar: 0,
      holes: [{ hole: 1, strokes: 2, marks: [MARK], layoutAtPlay: { target: AS_PLAYED.target } }, { hole: 2, strokes: 4 }],
    });
    expect(exported.rounds.find((r: { eventId: number }) => r.eventId === 4).holes[0]).toMatchObject({ marks: [], marksStatus: "unattributed" });
    expect(exported.rounds.find((r: { eventId: number }) => r.eventId === 5).holes[0]).toMatchObject({ marks: [OLD_MARK], layoutAtPlay: null });
    expect(exported.rounds.find((r: { roundCode: string }) => r.roundCode === "TEAM42")).toMatchObject({
      group: "doubles", holes: [{ hole: 1, strokes: 2, marks: [], marksStatus: "unattributed" }],
      savedBreakdown: { holes: 1, birdies: 1 },
    });
    expect(exported.rounds.find((r: { roundCode: string }) => r.roundCode === "TEAM42").savedBreakdown).not.toHaveProperty("c1x_putt_hit");
    expect(exported.rounds.find((r: { source: string }) => r.source === "udisc")).toMatchObject({ importedRoundKey: "imported-id" });
    expect(exported.clips).toMatchObject([{ id: 13, mediaPath: "/events/1/live/clips/13/media", bytes: 1000 }]);
  });

  it("keeps JSON round and hole records recoverable from formula-safe CSV", async () => {
    const { env, mine } = await fixture();
    const json = await (await handleMyPlayExport(request("my-play-export", mine), env, ORIGIN)).json() as ExportDocument;
    const res = await handleMyPlayExport(request("my-play-export?format=csv", mine), env, ORIGIN);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="gvdg-play-history.csv"');
    const rows = parseCsvRows(await res.text());
    expect(rows[0]?.record_type).toBe("manifest");
    const round = rows.find((r) => r.round_id === "competitive:1:7" && r.record_type === "round");
    expect(round?.course).toBe("'=1+2,\"A\"");
    const reconstructed = rows.filter((r) => r.record_type === "round").map((row) => ({
      ...JSON.parse(row.data_json!),
      holes: rows.filter((r) => r.record_type === "hole" && r.round_id === row.round_id).map((r) => JSON.parse(r.data_json!)),
    }));
    expect(reconstructed).toEqual(json.rounds);
    expect(escapePlayCsv("first, \"quoted\"\nsecond")).toBe('"first, ""quoted""\nsecond"');
    for (const payload of ["+10", "-2+4", " @HYPERLINK()", "＝7", "\t123", "\r123"]) {
      expect(escapePlayCsv(payload)).toContain("'" + payload);
    }
    expect(escapePlayCsv(-2)).toBe("-2");
  });

  it("pages through the full private archive with stable keyset positions", async () => {
    const { env, mine, sqlite } = await fixture();
    sqlite.exec(`
      WITH RECURSIVE extras(i) AS (SELECT 100 UNION ALL SELECT i+1 FROM extras WHERE i<200)
      INSERT INTO udisc_history (id, member_id, round_key, player_name, course_name, played_at, holes)
      SELECT i, 'm_mine', 'extra-' || i, 'Me', 'My course', '2025-01-01T12:00:00', '[]' FROM extras;
    `);
    const first = await handleMyPlayExport(request("my-play-export", mine), env, ORIGIN);
    const cursor = first.headers.get("X-GVDG-Next-Export");
    expect(cursor).toMatch(/^2:\d+$/);
    expect(first.headers.get("Access-Control-Expose-Headers")).toContain("X-GVDG-Next-Export");
    const a = await first.json() as ExportDocument;
    expect(a.rounds).toHaveLength(100);
    const second = await handleMyPlayExport(request("my-play-export?cursor=" + cursor, mine), env, ORIGIN);
    expect(second.headers.get("X-GVDG-Next-Export")).toBeNull();
    const b = await second.json() as ExportDocument;
    expect(b.rounds).toHaveLength(8);
    expect(b.clips).toHaveLength(1);
    expect(new Set([...a.rounds, ...b.rounds].map((r) => r.id)).size).toBe(108);
  });
});

describe("personal play filtering and trends", () => {
  it("validates ranges and uses the Eastern calendar for current year", () => {
    expect(parsePlayHistoryFilter(new URLSearchParams("window=custom&from=2026-02-30&to=2026-04-01"))).toBeNull();
    expect(parsePlayHistoryFilter(new URLSearchParams("window=custom&from=2026-07-01&to=2026-04-01"))).toBeNull();
    expect(parsePlayHistoryFilter(new URLSearchParams("window=last&last=0"))).toBeNull();
    expect(parsePlayHistoryFilter(new URLSearchParams("window=last&last=201"))).toBeNull();
    expect(parsePlayHistoryFilter(new URLSearchParams("hole=37"))).toBeNull();
    expect(parsePlayHistoryFilter(new URLSearchParams(), new Date("2026-01-01T02:00:00.000Z"))).toMatchObject({ from: "2025-01-01", to: "2025-12-31" });
  });

  it("uses date, exact layout IDs, hole, group, and source before Last N; never reuses current map positions", async () => {
    const { env, mine } = await fixture();
    async function history(query: string) {
      const res = await handleMyPlayHistory(request("my-play-history?" + query, mine), env, ORIGIN);
      expect(res.status).toBe(200);
      return res.json() as Promise<History>;
    }
    const all = await history("window=all");
    expect(all.roundCount).toBe(5);
    expect(all.totals.holes).toBe(6);
    expect(all.scoreTrend.c1x).toEqual({ made: 1, attempts: 1, percentage: 100 });
    expect(all.scoreTrend.averageToParPerHole).toBe(-0.17);
    expect(all.coverage).toEqual({ noArchivedGeometry: 1, withheldMarkHoles: 1 });
    expect(all.recentRounds.find((r: { source: string }) => r.source === "casual")?.date).toBe("2025-12-31");

    const current = await history("window=custom&from=2026-01-02&to=2026-01-02&course=id:1&layout=id:1&hole=1");
    expect(current.roundCount).toBe(1);
    expect(current.recentRounds[0]!).toMatchObject({ course: '=1+2,"A"', scoredHoles: 1, strokes: 2, toPar: -1 });
    expect(current.scoreTrend.averageToParPerHole).toBe(-1);
    expect(current.options.holes).toEqual([1, 2]);
    expect(current.options.layouts).toMatchObject([{ key: "id:1", label: "Blue" }]);

    const latest = await history("window=last&last=1&course=id:1&source=competitive");
    expect(latest.recentRounds[0]?.date).toBe("2026-01-07");
    expect(latest.roundCount).toBe(1);
    expect(latest.scoreTrend.c1x.attempts).toBe(0);

    const doubles = await history("window=all&group=doubles");
    expect(doubles.roundCount).toBe(1);
    expect(doubles.totals.c1x_putt_att).toBe(0);
    expect(doubles.coverage.withheldMarkHoles).toBe(1);
    expect((await history("window=all&source=udisc&group=unknown")).roundCount).toBe(1);
    expect((await history("window=all&source=casual&group=singles")).roundCount).toBe(1);
  });
});

it("reports the history scan limit explicitly without limiting exports", async () => {
  const { env, mine, sqlite } = await fixture();
  sqlite.exec(`
    WITH RECURSIVE extras(i) AS (SELECT 100 UNION ALL SELECT i+1 FROM extras WHERE i < ${100 + HISTORY_LIMIT_PER_SOURCE - 1})
    INSERT INTO udisc_history (id, member_id, round_key, player_name, course_name, played_at, holes)
    SELECT i, 'm_mine', 'extra-' || i, 'Me', 'My course', '2025-01-01T12:00:00', '[]' FROM extras;
  `);
  const res = await handleMyPlayHistory(request("my-play-history?window=all&source=udisc&group=unknown", mine), env, ORIGIN);
  expect(await res.json()).toMatchObject({
    truncated: true, maxSavedRoundsPerSource: HISTORY_LIMIT_PER_SOURCE, roundCount: HISTORY_LIMIT_PER_SOURCE,
  });
  const exportResponse = await handleMyPlayExport(request("my-play-export?cursor=2:0", mine), env, ORIGIN);
  expect(await exportResponse.json()).toMatchObject({ rounds: [expect.objectContaining({ importedRoundKey: "imported-id" }), ...Array.from({ length: 99 }, () => expect.anything())] });
});
