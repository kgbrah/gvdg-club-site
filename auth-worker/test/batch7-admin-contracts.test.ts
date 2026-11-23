import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { createPosition, deletePosition, replacePositions } from "../src/db-courses.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async (opts?: { prefix?: string; cursor?: string; limit?: number }) => {
      const prefix = opts?.prefix || "";
      const keys = [...rows.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { keys: keys.map((name) => ({ name })), list_complete: true };
    },
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  return {
    raw: db,
    prepare(sql: string) {
      let bound: unknown[] = [];
      const execSync = () => {
        if (/\bRETURNING\b/i.test(sql) || /^\s*(?:SELECT|WITH)\b/i.test(sql)) {
          const rows = db.prepare(sql).all(...(bound as never[]));
          return { results: rows, success: true, meta: { changes: rows.length, rows_written: rows.length } };
        }
        const info = db.prepare(sql).run(...(bound as never[]));
        return { results: [], success: true, meta: { changes: Number(info.changes), rows_written: Number(info.changes) } };
      };
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        execSync,
        async all() { return { results: db.prepare(sql).all(...(bound as never[])), success: true }; },
        async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
        async run() { return execSync(); },
      };
      return stmt;
    },
    async batch(list: Array<{ execSync?: () => unknown; run(): Promise<unknown> }>) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = [];
        for (const s of list) out.push(s.execSync ? s.execSync() : await s.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

type Db = Awaited<ReturnType<typeof sqliteDb>>;

function makeEnv(db: Db) {
  const roster = kv({
    "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin One", isAdmin: true, pdgaNo: "1", pinHash: "h", mustChangePin: false }),
    "idx:pdga:1": "m_admin",
  });
  return {
    ROSTER: roster,
    RATELIMIT: kv(),
    DB: db,
    JWT_SECRET: SECRET,
    SESSION_TTL_SEC: "900",
    ALLOWED_ORIGINS: ORIGIN,
  } as unknown as Env & { ROSTER: ReturnType<typeof kv> };
}

const tok = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);

async function call(env: Env, path: string, method = "GET", bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { Origin: ORIGIN, "CF-Connecting-IP": "198.51.100.42" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request("https://w.example" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function installCacheMock() {
  const deleted: string[] = [];
  const defaultCache = {
    match: async () => undefined,
    put: async () => undefined,
  };
  vi.stubGlobal("caches", {
    open: async () => defaultCache,
    delete: async (name: string) => {
      deleted.push(name);
      return true;
    },
  });
  return deleted;
}

describe("Batch 7: admin export, leagues, inline layouts, registrations, putting config & catalog cache", () => {
  it("POST /admin/export honors download_only: true even with an active endpoint and rejects non-boolean download_only", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    const adminToken = await tok("m_admin");
    db.raw.prepare("INSERT INTO data_archive_endpoints (label, endpoint_url, is_active, created_by) VALUES ('Sheet', 'https://archive.example.com/hook', 1, 'm_admin')").run();

    const fetchMock = vi.fn(async () => new Response("should not be called", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const downloadRes = await call(env, "/admin/export", "POST", adminToken, {
      download_only: true,
      dry_run: false,
    });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.data.mode).toBe("download");
    expect(downloadRes.data.exportData).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    const badRes = await call(env, "/admin/export", "POST", adminToken, {
      download_only: "maybe",
    });
    expect(badRes.status).toBe(400);
    expect(badRes.data.error).toBe("invalid_option");
  });

  it("POST and PATCH /admin/leagues preserve 23-char handicap formats and reject >40 char formats with 400 invalid_league", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    const adminToken = await tok("m_admin");

    const created = await call(env, "/admin/leagues", "POST", adminToken, {
      name: "Handicap Series",
      season: "2026",
      format: "singles-stroke-handicap",
    });
    expect(created.status).toBe(201);
    expect(created.data.league.format).toBe("singles-stroke-handicap");

    const leagueId = created.data.league.id;
    const updated = await call(env, `/admin/leagues/${leagueId}`, "PATCH", adminToken, {
      name: "Handicap Series",
      format: "doubles-stroke-handicap",
    });
    expect(updated.status).toBe(200);
    expect(updated.data.league.format).toBe("doubles-stroke-handicap");

    const tooLongCreate = await call(env, "/admin/leagues", "POST", adminToken, {
      name: "Bad League",
      format: "x".repeat(41),
    });
    expect(tooLongCreate.status).toBe(400);
    expect(tooLongCreate.data.error).toBe("invalid_league");

    const tooLongPatch = await call(env, `/admin/leagues/${leagueId}`, "PATCH", adminToken, {
      format: "y".repeat(41),
    });
    expect(tooLongPatch.status).toBe(400);
    expect(tooLongPatch.data.error).toBe("invalid_league");
  });

  it("PATCH /admin/events/:id creates and links inline layout and rejects explicit course_id: null", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    const adminToken = await tok("m_admin");
    const courseId = (db.raw.prepare("INSERT INTO courses (name, created_by) VALUES ('North Rec Test', 'm_admin') RETURNING id").get() as { id: number }).id;
    db.raw.prepare("INSERT INTO events (id, type, name, status, course_id, created_by) VALUES (1, 'tournament', 'Spring Open', 'scheduled', ?, 'm_admin')").run(courseId);

    const patched = await call(env, "/admin/events/1", "PATCH", adminToken, {
      layout: { name: "Red 9", holeCount: 9, defaultPar: 3 },
    });
    expect(patched.status).toBe(200);
    expect(patched.data.layout).toBeTruthy();
    expect(patched.data.layout.name).toBe("Red 9");
    expect(patched.data.event.layout_id).toBe(patched.data.layout.id);

    const beforeLayouts = (db.raw.prepare("SELECT COUNT(*) AS cnt FROM course_layouts").get() as { cnt: number }).cnt;
    const emptyCoursesLayout = await call(env, "/admin/events/1", "PATCH", adminToken, {
      event_courses: [],
      course_id: courseId,
      layout: { name: "Ghost Layout", holeCount: 9, defaultPar: 3 },
    });
    expect(emptyCoursesLayout.status).toBe(400);
    expect(emptyCoursesLayout.data.error).toBe("invalid_layout");
    const afterLayouts = (db.raw.prepare("SELECT COUNT(*) AS cnt FROM course_layouts").get() as { cnt: number }).cnt;
    expect(afterLayouts).toBe(beforeLayouts);

    const clearedCourse = await call(env, "/admin/events/1", "PATCH", adminToken, {
      course_id: null,
      layout: { name: "Orphan Layout", holeCount: 9, defaultPar: 3 },
    });
    expect(clearedCourse.status).toBe(400);
    expect(clearedCourse.data.error).toBe("invalid_layout");
  });

  it("PATCH /admin/events/:id/registrations/:rid clears fields to null, preserves omitted fields, validates division/team/starting_hole, and scopes to event_id", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    const adminToken = await tok("m_admin");
    db.raw.prepare("INSERT INTO events (id, type, name, status, created_by) VALUES (1, 'tournament', 'Event One', 'scheduled', 'm_admin'), (2, 'tournament', 'Event Two', 'scheduled', 'm_admin')").run();
    db.raw.prepare("INSERT INTO registrations (id, event_id, member_id, name, division, team, starting_hole, checked_in, paid_entry) VALUES (10, 1, 'm_ada', 'Ada Lovelace', 'MPO', 'Alpha', 4, 1, 1)").run();

    const cleared = await call(env, "/admin/events/1/registrations/10", "PATCH", adminToken, {
      division: null,
      team: null,
      starting_hole: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.data.registration.division).toBeNull();
    expect(cleared.data.registration.team).toBeNull();
    expect(cleared.data.registration.starting_hole).toBeNull();
    expect(cleared.data.registration.checked_in).toBe(1);
    expect(cleared.data.registration.paid_entry).toBe(1);

    const setHole = await call(env, "/admin/events/1/registrations/10", "PATCH", adminToken, {
      division: "FPO",
      starting_hole: 7,
    });
    expect(setHole.status).toBe(200);
    expect(setHole.data.registration.division).toBe("FPO");
    expect(setHole.data.registration.starting_hole).toBe(7);

    const emptyStrCleared = await call(env, "/admin/events/1/registrations/10", "PATCH", adminToken, {
      starting_hole: "",
    });
    expect(emptyStrCleared.status).toBe(200);
    expect(emptyStrCleared.data.registration.starting_hole).toBeNull();
    expect(emptyStrCleared.data.registration.division).toBe("FPO");

    const invalidDivision = await call(env, "/admin/events/1/registrations/10", "PATCH", adminToken, {
      division: "d".repeat(61),
    });
    expect(invalidDivision.status).toBe(400);
    expect(invalidDivision.data.error).toBe("invalid_registration");

    const invalidTeam = await call(env, "/admin/events/1/registrations/10", "PATCH", adminToken, {
      team: 123,
    });
    expect(invalidTeam.status).toBe(400);
    expect(invalidTeam.data.error).toBe("invalid_registration");

    const invalidHole = await call(env, "/admin/events/1/registrations/10", "PATCH", adminToken, {
      starting_hole: 0,
    });
    expect(invalidHole.status).toBe(400);
    expect(invalidHole.data.error).toBe("invalid_registration");

    const wrongEvent = await call(env, "/admin/events/2/registrations/10", "PATCH", adminToken, {
      division: "MA1",
    });
    expect(wrongEvent.status).toBe(404);
    expect(wrongEvent.data.error).toBe("not_found");
  });

  it("PUT /admin/events/:id/config and PATCH /admin/events/:id preserve custom putting stations when liveScoringConfig omits putting", async () => {
    const db = await sqliteDb();
    const env = makeEnv(db);
    const adminToken = await tok("m_admin");
    db.raw.prepare("INSERT INTO events (id, type, name, status, format, created_by) VALUES (1, 'league_round', 'Putting Night', 'scheduled', 'putting', 'm_admin')").run();
    const customStations = [
      { distanceFt: 15, putts: 5, points: 1 },
      { distanceFt: 25, putts: 5, points: 2 },
    ];
    db.raw.prepare("INSERT INTO event_config (event_id, registration_open, play_format, live_scoring_config) VALUES (1, 1, 'singles', ?)").run(
      JSON.stringify({ groupFormat: "singles", scoringStyle: "putting", handicap: false, putting: { stations: customStations } }),
    );

    const saved = await call(env, "/admin/events/1/config", "PUT", adminToken, {
      registration_open: true,
      play_format: "singles",
      divisions: ["Open"],
      liveScoringConfig: { scoringStyle: "putting", groupFormat: "singles", handicap: false },
    });
    expect(saved.status).toBe(200);
    const parsed = JSON.parse(saved.data.config.live_scoring_config);
    expect(parsed.scoringStyle).toBe("putting");
    expect(parsed.putting.stations).toEqual(customStations);

    const patchedEvent = await call(env, "/admin/events/1", "PATCH", adminToken, {
      name: "Putting Night Updated",
      format: "putting",
      play_format: "singles",
      liveScoringConfig: { groupFormat: "singles", scoringStyle: "putting", handicap: false },
    });
    expect(patchedEvent.status).toBe(200);
    const cfgAfterPatch = db.raw.prepare("SELECT live_scoring_config FROM event_config WHERE event_id = 1").get() as { live_scoring_config: string };
    expect(JSON.parse(cfgAfterPatch.live_scoring_config).putting.stations).toEqual(customStations);
  });

  it("createPosition, deletePosition, and replacePositions invalidate the public course catalog cache", async () => {
    const db = await sqliteDb();
    const courseId = (db.raw.prepare("INSERT INTO courses (name, created_by) VALUES ('Meadowbrook Test', 'm_admin') RETURNING id").get() as { id: number }).id;
    const deleted = installCacheMock();

    const pos = await createPosition(db as never, { course_id: courseId, kind: "tee", label: "Hole 1 White", lat: 35.61, lng: -77.37 });
    expect(pos?.id).toBeTruthy();
    expect(deleted).toEqual(["gvdg-course-catalog"]);

    await deletePosition(db as never, courseId, Number(pos!.id));
    expect(deleted).toEqual(["gvdg-course-catalog", "gvdg-course-catalog"]);

    await replacePositions(db as never, courseId, [{ course_id: courseId, kind: "target", label: "Hole 1 Basket", lat: 35.611, lng: -77.371 }]);
    expect(deleted).toEqual(["gvdg-course-catalog", "gvdg-course-catalog", "gvdg-course-catalog"]);
  });
});
