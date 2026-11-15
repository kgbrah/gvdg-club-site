import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { upsertUdiscHistory } from "../src/db-udisc-history.js";
import { parseUdiscHistory } from "../src/imports/udisc-history.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";
import { ARCHIVE_VERSION, type ArchiveEntry } from "../src/member-archive.js";
import { handleMemberArchiveRoute } from "../src/member-archive-routes.js";
import { handleOfflineRoundRoute } from "../src/offline-round-routes.js";
import { handlePracticeRoute } from "../src/practice-routes.js";

const OWNER = "m_archive";
const OTHER = "m_other";
const SECRET = "archive_test".repeat(4);
const ORIGIN = "https://gvdgclub.com";
const DAY = "2026-06-02";
const PLAYED = "2026-06-02 1530-0400";
const FINISHED = "2026-06-02 1645-0400";
const SESSION = { mustChangePin: false, pinVer: 4 };
const uuid = (value: number) => "44226890-895a-406b-ab45-" + String(value).padStart(12, "0");

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_init.sql", "0005_registration.sql", "0015_udisc_export.sql", "0016_casual_rounds.sql",
    "0018_live_scoring_metadata.sql", "0038_udisc_history.sql", "0039_throw_clips.sql", "0046_throw_clip_recovery.sql",
    "0049_private_shot_ledgers.sql", "0051_member_practice.sql", "0053_offline_rounds.sql", "0057_personal_data_archive.sql"]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  let failWriteAt = -1;
  type Statement = { sql: string; values: never[] };
  const DB = {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      return {
        sql, values: [] as never[],
        bind(...values: never[]) { this.values = values; return this; },
        async first() { return stmt.get(...this.values) ?? null; },
        async all() { return { success: true, results: stmt.all(...this.values) }; },
        async run() { return { success: true, results: [], meta: stmt.run(...this.values) }; },
      };
    },
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(({ sql, values }, index) => {
          if (index === failWriteAt) throw new Error("fixture_write_failed");
          const stmt = sqlite.prepare(sql);
          return { success: true, results: stmt.all(...values), meta: { changes: Number(sqlite.prepare("SELECT changes() AS n").get()?.n) } };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
  const rate = new Map<string, string>();
  const env = {
    DB, JWT_SECRET: SECRET,
    ROSTER: { async get(key: string) {
      return ["member:" + OWNER, "member:" + OTHER].includes(key) ?
        JSON.stringify({ ...SESSION, memberId: key.slice(7), name: key.slice(7), isAdmin: key.endsWith(OTHER) }) : null;
    } },
    RATELIMIT: { async get(key: string) { return rate.get(key) ?? null; }, async put(key: string, value: string) { rate.set(key, value); } },
  } as unknown as Env;
  const mine = await signSession({ sub: OWNER, ...SESSION }, SECRET, 300);
  const other = await signSession({ sub: OTHER, ...SESSION }, SECRET, 300);
  const guest = await signOpenPlaySession({ sub: "op_guest", name: "Guest" }, SECRET, 300);
  const request = (path: string, token: string, method: string, body?: unknown) => new Request("https://auth.gvdgclub.com" + path, {
    method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function route(path = "", token = mine, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const req = request("/me/archive" + path, token, method, body);
    return (await handleMemberArchiveRoute(req, env, ORIGIN, new URL(req.url).pathname, req.method))!;
  }
  async function sourcePractice(kind: string, id: number, record: unknown, owner = OWNER) {
    const path = "/me/practice/mutations";
    const req = request(path, owner === OWNER ? mine : other, "POST", {
      owner, id: uuid(id), opId: uuid(id + 100), kind, action: "save", expectedRevision: 0, record,
    });
    expect((await handlePracticeRoute(req, env, ORIGIN, path, req.method))?.status).toBe(200);
  }
  async function exportRows(token = mine) {
    let next: string | null = null;
    const rows: ArchiveEntry[] = [];
    const cursors = new Set();
    do {
      const res = await route(next ? "?cursor=" + encodeURIComponent(next) : "", token);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      const page = await res.json() as { entries: ArchiveEntry[]; next: string | null; schemaVersion: string };
      expect(page.schemaVersion).toBe(ARCHIVE_VERSION);
      rows.push(...page.entries);
      next = page.next;
      if (next) expect(cursors.has(next)).toBe(false);
      cursors.add(next);
    } while (next);
    return rows;
  }
  const part = (entries: unknown[], mode = "restore", memberId = OWNER) => ({ schemaVersion: ARCHIVE_VERSION, mode, memberId, entries });
  const librarySize = () => sqlite.prepare("SELECT COUNT(*) AS n FROM member_archive_records").get()?.n;
  return { sqlite, env, route, part, mine, other, guest, sourcePractice, exportRows, rate, librarySize,
    failWrite: (index: number) => { failWriteAt = index; } };
}

const disc = { brand: "Innova", model: "Teebird", plastic: "Star", weightGrams: 175, notes: "Test", inBag: true, archived: false };
const discEntry: ArchiveEntry = { owner: OWNER, kind: "disc", sourceId: uuid(1),
  data: { id: uuid(1), revision: 1, occurredOn: DAY, updatedAt: 1770000000000, record: disc } };

describe("authenticated personal archive", () => {
  it("round-trips original source clocks, measurements, hole geometry, and uploader video references", async () => {
    const { env, sqlite, sourcePractice, exportRows, route, part } = await fixture();
    const parsed = parseUdiscHistory("PlayerName,CourseName,LayoutName,StartDate,EndDate,Total,+/-,Hole1\n"
      + "Par,Played course,Old baskets," + PLAYED + "," + FINISHED + ",,,3\n"
      + "Me,Played course,Old baskets," + PLAYED + "," + FINISHED + ",4,1,4\n");
    if (!("rounds" in parsed)) throw new Error("test CSV could not be parsed");
    expect(parsed.rounds).toHaveLength(1);
    await upsertUdiscHistory(env.DB, OWNER, parsed.rounds);
    await upsertUdiscHistory(env.DB, OTHER, [{ ...parsed.rounds[0]!, courseName: "Other private place" }]);
    sqlite.exec(`
      INSERT INTO courses(id, name) VALUES (6, 'Course');
      INSERT INTO course_layouts(id, course_id, name, holes) VALUES (5, 6, 'Pin B', '[]');
      INSERT INTO casual_rounds(id, round_code, course_id, layout_id, course_name, layout_name, started_at, finalized_at, holes)
        VALUES (1, 'PLAY88', 6, 5, 'Course', 'Pin B', '2026-06-02T19:30:00.000Z', '2026-06-02T21:30:00.000Z', '[{"hole":1,"par":3}]');
      INSERT INTO casual_results(id, casual_round_id, member_id, name, total, to_par, scorecard)
        VALUES (1, 1, '${OWNER}', 'Me', 3, 0, '[{"hole":1,"par":3,"strokes":3,"layoutAtPlay":{"target":{"lat":35,"lng":-82,"label":"Old basket"},"distance_ft":265},"throws":[{"lat":35.001,"lng":-82,"n":1}]}]');
      INSERT INTO throw_clips (id, scope, scope_key, hole, player_name, player_index, filmed_by, r2_key, content_type, bytes, client_id)
        VALUES (1, 'round', 'PLAY88', 1, 'Private name', 3, '${OWNER}', 'my-storage-key', 'video/mp4', 3195, '${uuid(11)}'),
          (2, 'round', 'PLAY88', 1, 'Me', 0, '${OTHER}', 'other-storage-key', 'video/mp4', 3140, '${uuid(12)}');
    `);
    await sourcePractice("disc", 1, disc);
    await sourcePractice("disc", 3, { ...disc, model: "Private driver" }, OTHER);
    await sourcePractice("throw", 2, { discId: uuid(1), shotType: "backhand", date: DAY, distance: 315.25, unit: "ft",
      origin: { lat: 35.01, lng: -82, accuracyM: 1.5 }, end: { lat: 35.012, lng: -82, accuracyM: 3.5 } });
    await sourcePractice("putting", 4, { date: DAY, stations: [{ distance: 20, unit: "ft", makes: 5, attempts: 10 },
      { distance: 8, unit: "m", makes: 15, attempts: 20 }] });
    const rows = await exportRows();
    expect(rows).toHaveLength(6);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "round", data: expect.objectContaining({ clock: expect.objectContaining({ sourcePlayedAt: PLAYED, sourceFinishedAt: FINISHED }),
        round: expect.objectContaining({ playedAt: "2026-06-02T15:30:00", source: "udisc" }) }) }),
      expect.objectContaining({ kind: "round", data: expect.objectContaining({ clock: expect.objectContaining({
        startedAt: "2026-06-02T19:30:00.000Z", finalizedAt: "2026-06-02T21:30:00.000Z",
      }), round: expect.objectContaining({ holes: [expect.objectContaining({ layoutAtPlay: expect.objectContaining({ distanceFt: 265 }),
        marks: [{ lat: 35.001, lng: -82, n: 1 }] })] }) }) }),
      expect.objectContaining({ kind: "clip", data: expect.objectContaining({ mediaPath: "/rounds/PLAY88/live/clips/1/media", playerIndex: 3, clientId: uuid(11) }) }),
      expect.objectContaining({ kind: "throw", data: expect.objectContaining({
        record: expect.objectContaining({ distance: 315.25, unit: "ft", meters: 96.088, origin: { lat: 35.01, lng: -82, accuracyM: 1.5 } }),
      }) }),
      expect.objectContaining({ kind: "putting", data: expect.objectContaining({
        record: { date: DAY, stations: [{ distance: 20, unit: "ft", meters: 6.096, makes: 5, attempts: 10 },
          { distance: 8, unit: "m", meters: 8, makes: 15, attempts: 20 }] },
      }) }),
    ]));
    const raw = JSON.stringify(rows);
    for (const value of ["Other private place", "Private driver", "Private name", "my-storage-key", "other-storage-key", uuid(12)]) {
      expect(raw).not.toContain(value);
    }
    const nextSecret = "rotated".repeat(8);
    env.JWT_SECRET = nextSecret;
    const rotated = await signSession({ sub: OWNER, ...SESSION }, nextSecret, 300);
    const restored = await route("/restore", rotated, part(rows));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ saved: rows.length, duplicates: 0 });
    const library = await route("/records", rotated);
    expect((await library.json() as { rows: { entry: ArchiveEntry }[] }).rows.map(({ entry }) => entry)).toEqual(rows);
    expect((await exportRows(rotated)).slice(-6)).toEqual(rows);
    for (const [table, expected] of [["casual_results", 1], ["udisc_history", 2], ["member_practice_records", 4], ["results", 0]]) {
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM " + table).get()?.n).toBe(expected);
    }
  });

  it("retains an offline card, structured shots and video reference together", async () => {
    const { env, mine, sqlite, route, part, exportRows } = await fixture();
    const startedAt = DAY + "T21:03:00.000Z";
    const finishedAt = DAY + "T22:15:00.000Z";
    const firstThrow = { kind: "throw", id: uuid(1), recordedAt: Date.parse(startedAt), attempt: "throw", outcome: "missed",
      originLie: "tee", landingLie: "unknown", origin: { lat: 35.001, lng: -77 }, landing: { lat: 35.00005, lng: -77 } };
    const card = { version: 1, localId: uuid(20), owner: { kind: "member", id: OWNER }, startedAs: "account",
      source: { courseId: 922, courseName: "Offline Pines", layoutId: 802, layoutName: "Old basket",
        savedAt: startedAt, revision: "r-2026-04", contentRevision: "layout-2026-04",
        holes: [{ hole: 1, par: 3, par_source: "official", distance_ft: 331, distance_source: "survey",
          tee: { label: "Tee", lat: 35.001, lng: -77 }, target: { label: "Old basket", lat: 35, lng: -77 } }] },
      format: { groupFormat: "singles", scoringStyle: "stroke" },
      players: [{ id: uuid(1), name: "Owner" }], startedAt, finishedAt, scores: { "player:0": { 1: 2 } },
      marks: { 1: [{ lat: 35.00005, lng: -77, n: 1 }] }, shots: { 1: [firstThrow,
        { kind: "throw", id: uuid(2), recordedAt: Date.parse(startedAt) + 60_000, attempt: "putt", outcome: "made",
          originLie: "unknown", landingLie: "basket", puttDistanceFt: 18 }] },
    };
    const path = "/offline-rounds/import";
    const response = await handleOfflineRoundRoute(new Request("https://auth.gvdgclub.com" + path, {
      method: "POST", headers: { Authorization: "Bearer " + mine, "Content-Type": "application/json" }, body: JSON.stringify(card),
    }), env, ORIGIN, path, "POST");
    expect(response?.status).toBe(201);
    sqlite.prepare(`INSERT INTO offline_round_clips (offline_round_id, client_id, payload_hash, r2_key, hole, player_index,
      player_name, content_type, bytes, highlight, moment) VALUES (1, ?, 'xx', 'private-object', 1, 0, 'Owner', 'video/mp4', 2275, 1, 'Putt')`)
      .run(uuid(3));
    const entries = await exportRows();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      sourceId: "offline:" + uuid(20), data: { clock: { startedAt, finalizedAt: finishedAt },
        round: { source: "offline", offlineSnapshot: card, holes: [{ hole: 1, distanceFt: 331, shotLedger: { rows: [firstThrow, expect.any(Object)] } }] } },
    });
    expect(entries[1]).toMatchObject({ sourceId: "offline-clip:" + uuid(3), data: {
      mediaPath: "/offline-rounds/1/clips/1/media", playerName: "Owner", playerIndex: 0, highlight: true, moment: "Putt" } });
    expect((await route("/restore", undefined, part(entries))).status).toBe(200);
    const original = entries[0]!.data as { round: { offlineSnapshot: { owner: { id: string } } } };
    original.round.offlineSnapshot.owner.id = OTHER;
    expect((await route("/restore", undefined, part(entries))).status).toBe(400);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM offline_rounds").get()?.n).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM offline_round_clips").get()?.n).toBe(1);
  });

  it("requires owner identity for all operations and leaves preview and malformed chunks unchanged", async () => {
    const { route, part, other, guest, librarySize } = await fixture();
    expect((await route("", guest)).status).toBe(401);
    expect((await route("/records", "")).status).toBe(401);
    expect((await route("/restore", other, part([discEntry], "preview"))).status).toBe(403);
    expect((await route("/restore", other, part([discEntry], "restore", OTHER))).status).toBe(403);
    expect((await route("?cursor=practice")).status).toBe(400);
    expect((await route("/restore", undefined, part([discEntry], "preview"))).status).toBe(200);
    expect(librarySize()).toBe(0);
    const forged = { owner: OWNER, kind: "clip", sourceId: "live-clip:1", data: {
      id: 1, scope: "round", scopeKey: "PLAY88", hole: 1, bytes: 2000, contentType: "video/mp4", highlight: false, moment: null,
      createdAt: "2026-06-02 19:30:00", mediaPath: "https://example.com/private.mp4",
    } };
    expect((await route("/restore", undefined, part([discEntry, forged]))).status).toBe(400);
    expect((await route("/restore", undefined, part([{ ...discEntry, data: { ...discEntry.data, session: "credential" } }]))).status).toBe(400);
    expect(librarySize()).toBe(0);
    const ok = await route("/restore", undefined, part([discEntry]));
    expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await (await route("/records", other)).json())).toEqual({ rows: [], next: null });
    expect((await route("/records/1", other, undefined, "DELETE")).status).toBe(404);
    expect((await route("/records/1", undefined, undefined, "DELETE")).status).toBe(200);
    expect(librarySize()).toBe(0);
  });

  it("paginates both private collections and skips exact retries without overwriting a separate version", async () => {
    const { route, part, librarySize, exportRows, failWrite, sqlite } = await fixture();
    const second = { ...discEntry, data: { ...discEntry.data, revision: 2 } };
    failWrite(1);
    await expect(route("/restore", undefined, part([discEntry, second]))).rejects.toThrow("fixture_write_failed");
    expect(librarySize()).toBe(0);
    failWrite(-1);
    expect(await (await route("/restore", undefined, part([discEntry, discEntry, second]))).json()).toMatchObject({ saved: 2, duplicates: 1 });
    expect(await (await route("/restore", undefined, part([discEntry, second]))).json()).toMatchObject({ saved: 0, duplicates: 2 });
    const records = Array.from({ length: 21 }, (_, i) => {
      const id = uuid(i + 3);
      return { ...discEntry, sourceId: id, data: { ...discEntry.data, id } };
    });
    const insert = sqlite.prepare("INSERT INTO member_practice_records VALUES (?, ?, 'disc', 1, ?, ?, 'test', 0)");
    for (const record of records) insert.run(OWNER, record.sourceId, DAY, JSON.stringify(disc));
    for (const entries of [records.slice(0, 16), records.slice(16)]) {
      expect((await route("/restore", undefined, part(entries))).status).toBe(200);
    }
    const first = await (await route("/records")).json() as { rows: unknown[]; next: string };
    expect(first.rows).toHaveLength(16);
    const last = await (await route("/records?cursor=" + first.next)).json() as { rows: unknown[]; next: string | null };
    expect(last.rows).toHaveLength(7);
    expect(last.next).toBeNull();
    expect(await exportRows()).toHaveLength(44);
  });

  it("rejects oversized files and keeps the owner quota atomic even on retries", async () => {
    const { route, part, sqlite, librarySize, rate, other } = await fixture();
    const limitKey = "archive-restore:" + OWNER;
    rate.set(limitKey, "240");
    const limited = await route("/restore", undefined, part([discEntry]));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect((await route("/restore", other, part([discEntry]))).status).toBe(403);
    rate.delete(limitKey);
    expect((await route("/restore", undefined, part(Array(17).fill(discEntry)))).status).toBe(400);
    expect((await route("/restore", undefined, part([{ ...discEntry, pad: "X".repeat(750_000) }]))).status).toBe(413);
    sqlite.exec("DROP TRIGGER member_archive_owner_limit");
    sqlite.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 7999)
      INSERT INTO member_archive_records(owner, kind, source_id, fingerprint, payload, imported_at)
      SELECT ?, 'disc', 'seed-' || n, 'old', '{}', '2026-08-01' FROM numbers`).run(OWNER);
    const migration = readFileSync(new URL("../migrations/0057_personal_data_archive.sql", import.meta.url), "utf8");
    sqlite.exec(migration.slice(migration.indexOf("CREATE TRIGGER")));
    const second = { ...discEntry, data: { ...discEntry.data, revision: 2 } };
    expect((await route("/restore", undefined, part([discEntry, second]))).status).toBe(409);
    expect(librarySize()).toBe(7999);
    expect(await (await route("/restore", undefined, part([discEntry]))).json()).toMatchObject({ saved: 1 });
    expect(await (await route("/restore", undefined, part([discEntry]))).json()).toMatchObject({ saved: 0, duplicates: 1 });
  });
});
