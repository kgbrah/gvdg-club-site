import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleCourseHealth } from "../src/course-operator-routes.js";
import type { D1Like, D1StatementLike } from "../src/db-types.js";
import type { Env } from "../src/env.js";
import { parseCsvRows } from "../src/imports/csv.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";

const ORIGIN = "https://gvdgclub.com";
const SECRET = "x".repeat(40);
const ROOT = "/admin/course-health";
const RANGE = "?from=2026-04-01&to=2026-04-30";

function task(requestId: string, title = "Fix hole three basket") {
  return { requestId, title, details: "Replace the bent chain", priority: "high", status: "open", dueDate: "2026-11-30" };
}

async function fixture() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_init.sql", "0003_course_positions.sql", "0008_tee_signs.sql", "0015_udisc_export.sql",
    "0016_casual_rounds.sql", "0025_event_courses.sql", "0028_course_map_marks.sql",
    "0048_course_discovery.sql", "0052_course_maintenance.sql"]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  sqlite.exec(`
    INSERT INTO courses (id, name, location) VALUES (1, '=Park,"Green"', 'Greenville'), (2, 'Other course', 'Ayden');
    INSERT INTO course_layouts (id, course_id, name, holes, expected_holes, created_at, updated_at) VALUES
      (10,1,'Main','[{"hole":1,"par":3,"tee":{"lat":35.601,"lng":-77.37},"target":{"lat":35.602,"lng":-77.37},
                       "verified":{"par":3,"tee_sign_id":1,"tee_sign_key":"private-photo-1"}},
                      {"hole":2,"par":3,"tee":{"lat":35.603,"lng":-77.37},
                       "verified":{"par":3,"tee_sign_id":2,"tee_sign_key":"rejected-photo"}}]',
       3, '2023-04-01 00:00:00','2026-08-02 00:00:00');
    INSERT INTO course_map_consensus (layout_id,hole,kind,lat,lng,samples,members,published,updated_at)
      VALUES (10,2,'target',100,-77,2,2,1,'2026-09-30 00:00:00');
    INSERT INTO tee_signs (id,course_id,hole_number,r2_key,content_type,bytes,uploaded_by,status,reviewed_at) VALUES
      (1,1,1,'private-photo-1','image/jpeg',440,'private-member','official','2024-01-02 00:00:00'),
      (2,1,2,'rejected-photo','image/jpeg',440,'private-member','rejected','2025-01-02 00:00:00'),
      (3,1,2,'candidate-photo','image/jpeg',440,'private-member','candidate',NULL);
    INSERT INTO events (id,type,name,status,course_id,date) VALUES
      (1,'league_round','Final single','final',1,'2026-04-01'),
      (2,'league_round','Final multi','final',1,'2026-04-15'),
      (3,'league_round','Live','live',1,'2026-04-15'),
      (4,'league_round','Old','final',1,'2026-03-31'),
      (5,'league_round','Retargeted after play','final',2,'2026-04-30'),
      (6,'league_round','Conflicting course archive','final',1,'2026-04-30');
    INSERT INTO event_courses (event_id,course_id) VALUES (2,1),(2,2);
    INSERT INTO results (event_id,member_id,name,place,total,scorecard) VALUES
      (1,'m_person_one','Person one',1,10,'not JSON'),
      (1,'m_person_one','Duplicate row',1,10,NULL),
      (1,'g_temporary','Guest entry',2,0,NULL),
      (1,'m_dnf','Did not finish',NULL,9,NULL),
      (2,'m_ambiguous','Ambiguous assignment',2,12,NULL),
      (2,'m_person_one','Archived course one',2,10,'["ignored",{"layoutAtPlay":{"courseId":1}}]'),
      (2,'m_other','Archived course two',2,10,'[{"layoutAtPlay":{"courseId":2}}]'),
      (3,'m_live','Live score',1,10,NULL),
      (4,'m_old','Out of period',1,10,NULL),
      (5,'m_person_two','Archive survives edited event course',1,10,'[{"layoutAtPlay":{"courseId":1}}]'),
      (6,'m_conflict','Split attribution',1,10,'[{"layoutAtPlay":{"courseId":1}},{"layoutAtPlay":{"courseId":2}}]');
    INSERT INTO casual_rounds (id,round_code,course_id,started_at,finalized_at) VALUES
      (1,'INTHE1',1,'2026-04-13T14:00:00.000Z','2026-04-14 14:00:00'),
      (2,'OTHER1',2,'2026-04-13T14:00:00.000Z','2026-04-13 18:00:00'),
      (3,'OLDER1',1,'2026-03-31T23:30:00.000Z','2026-04-01 18:00:00');
    INSERT INTO casual_results (casual_round_id,member_id,name,place,total) VALUES
      (1,'m_person_one','Participant',1,9),
      (1,'op_identity','Open play',2,10),
      (1,NULL,'No persistent identity',3,20),
      (1,'m_dnf','Did not finish',NULL,10),
      (2,'m_other','Other location',1,9),
      (3,'m_person_two','Out of period',1,9);
  `);
  let abortNextBatch = false;
  let failExport = false;
  let calls = 0;
  const db = {
    prepare(sql: string) {
      calls += 1;
      let values: unknown[] = [];
      const mutation = () => {
        const result = sqlite.prepare(sql).run(...values);
        return { results: [], success: true, meta: { changes: result.changes } };
      };
      const stmt = {
        bind(...bound: unknown[]) { values = bound; return stmt; },
        async run() { return mutation(); },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() {
          if (failExport && sql.includes("ORDER BY id LIMIT 100") && Number(values[1]) > 0) throw new Error("Export interrupted");
          return { results: sqlite.prepare(sql).all(...values), success: true };
        },
        mutation,
      };
      return stmt;
    },
    async batch(statements: (D1StatementLike & { mutation(): unknown })[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement, index) => {
          if (abortNextBatch && index === 1) {
            abortNextBatch = false;
            throw new Error("Injected operation failure");
          }
          return statement.mutation();
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Like;
  const env = { DB: db, ROSTER: { get: async (key: string) => key.startsWith("member:m_") ?
    JSON.stringify({ memberId: key.slice(7), name: "Member", pinHash: "", mustChangePin: false, isAdmin: key.startsWith("member:m_admin") })
    : null }, JWT_SECRET: SECRET } as unknown as Env;
  const jwt = await signSession({ sub: "m_admin", mustChangePin: false }, SECRET, 900);
  const jwt2 = await signSession({ sub: "m_admin2", mustChangePin: false }, SECRET, 900);
  return {
    sqlite, calls: () => calls, abort: () => { abortNextBatch = true; }, failExport: () => { failExport = true; },
    dispatch(path: string, method = "GET", body?: object, auth = jwt) {
      const headers = { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer " + auth } : {}) };
      return handleCourseHealth(new Request("https://auth.gvdgclub.com" + ROOT + path, {
        method, headers, body: body == null ? undefined : JSON.stringify(body),
      }), env, ORIGIN);
    },
    jwt2,
  };
}

type TaskResponse = { task: { id: number; revision: number; title: string }; replayed: boolean };

describe("admin course health", () => {
  it("requires administrator credentials before reading report or task data", async () => {
    const { dispatch, calls } = await fixture();
    const member = await signSession({ sub: "m_regular", mustChangePin: false }, SECRET, 900);
    const guest = await signOpenPlaySession({ sub: "op_guest", name: "Guest" }, SECRET, 900);
    expect((await dispatch("", "GET", undefined, "")).status).toBe(401);
    expect((await dispatch("/1" + RANGE, "GET", undefined, guest)).status).toBe(401);
    expect((await dispatch("/1/export" + RANGE, "GET", undefined, member)).status).toBe(403);
    expect((await dispatch("/1/tasks", "POST", task("test-not-admin-001"), member)).status).toBe(403);
    expect(calls()).toBe(0);
  });

  it("counts deduplicated completed activity within the selected course and calendar dates", async () => {
    const { dispatch } = await fixture();
    const response = await dispatch("/1" + RANGE);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const report = await response.text();
    expect(JSON.parse(report)).toMatchObject({
      participation: {
        completedRounds: 4, completedCompetitionRecords: 3, completedCasualCards: 1,
        completedPlayerEntries: 7, uniqueIdentifiedPlayers: 3, guestEntries: 2,
      },
      health: {
        coverage: "partial", holes: 3, mappedHoles: 1, approvedPars: 1, unverifiedPars: 2, pendingTeeSigns: 1, approvalsReviewedInWindow: 0,
        layouts: [{ name: "Main", unlistedHoles: 1, updatedAt: "2026-08-02T00:00:00.000Z" }],
      },
    });
    for (const secret of ["35.601", "-77.37", "m_person_one", "private-member", "private-photo-1", "op_identity"]) {
      expect(report).not.toContain(secret);
    }
    expect(await (await dispatch("/2" + RANGE)).json()).toMatchObject({ participation: {
      completedRounds: 2, completedPlayerEntries: 2, uniqueIdentifiedPlayers: 1,
    } });
    expect((await dispatch("/1?from=2026-02-31&to=2026-04-30")).status).toBe(400);
    expect((await dispatch("/1?from=2026-04-25&to=2026-04-10")).status).toBe(400);
    expect((await dispatch("/1?from=2025-01-01&to=2026-04-10")).status).toBe(400);
  });

  it("never treats a newer layout edit as a new tee sign approval", async () => {
    const { dispatch, sqlite } = await fixture();
    const before = await (await dispatch("/1" + RANGE)).json();
    expect(before).toMatchObject({ health: { approvedPars: 1, staleApprovals: 1, layouts: [{ issues: [
      { hole: 1, verification: "stale", reviewedAt: "2024-01-02T00:00:00.000Z" },
      { hole: 2, verification: "unverified", reviewedAt: null },
    ] }] } });
    expect(await (await dispatch("/1?from=2024-01-01&to=2024-01-05")).json())
      .toMatchObject({ health: { approvedPars: 1, approvalsReviewedInWindow: 1 } });
    sqlite.exec("UPDATE course_layouts SET name='Recently renamed' WHERE id=10");
    expect(await (await dispatch("/1" + RANGE)).json()).toMatchObject({ health: { approvedPars: 1, staleApprovals: 1,
      layouts: [{ name: "Recently renamed", freshness: "recent" }] } });
  });
});

describe("persistent course maintenance", () => {
  it("scopes the task and idempotency operation to its course", async () => {
    const { dispatch, sqlite } = await fixture();
    const body = task("maintenance-create-1");
    const responses = await Promise.all([dispatch("/1/tasks", "POST", body), dispatch("/1/tasks", "POST", body)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 201]);
    const created = await responses[0]!.json() as TaskResponse;
    expect((await dispatch("/2/tasks/" + created.task.id, "PATCH", { ...task("maintenance-edit-02"), expectedRevision: 1 })).status).toBe(404);
    expect((await dispatch("/1/tasks", "POST", { ...body, title: "Different original operation" })).status).toBe(409);
    expect((await dispatch("/2/tasks", "POST", body)).status).toBe(201);
    expect(sqlite.prepare("SELECT course_id,count(*) AS count FROM course_maintenance_tasks GROUP BY course_id ORDER BY course_id").all())
      .toEqual([{ course_id: 1, count: 1 }, { course_id: 2, count: 1 }]);
    expect((await dispatch("/1/tasks", "POST", { ...task("maintenance-invalid-1"), courseId: 2 })).status).toBe(400);
    expect((await dispatch("/1/tasks", "POST", { ...task("maintenance-invalid-2"), dueDate: "2026-02-31" })).status).toBe(400);
  });

  it("rejects concurrent stale edits and replays a lost response without overwriting newer data", async () => {
    const { dispatch, jwt2, sqlite } = await fixture();
    const created = await (await dispatch("/1/tasks", "POST", task("maintenance-create-2"))).json() as TaskResponse;
    const endpoint = "/1/tasks/" + created.task.id;
    const edits = [
      { ...task("maintenance-edit-03", "Replace the basket"), status: "in_progress", expectedRevision: 1 },
      { ...task("maintenance-edit-04", "Move the basket"), status: "completed", expectedRevision: 1 },
    ];
    const outcomes = await Promise.all(edits.map((body, index) => dispatch(endpoint, "PATCH", body, index ? jwt2 : undefined)));
    expect(outcomes.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winning = outcomes.findIndex((response) => response.status === 200);
    const conflict = outcomes.find((response) => response.status === 409);
    expect(await conflict?.json()).toMatchObject({ error: "stale_revision", current: { revision: 2, title: edits[winning]!.title } });
    expect((await dispatch(endpoint, "PATCH", { ...task("maintenance-edit-05", "Latest verified steps"), expectedRevision: 2 })).status).toBe(200);
    const retry = await dispatch(endpoint, "PATCH", edits[winning]);
    expect(await retry.json()).toMatchObject({ replayed: true, task: { revision: 3, title: "Latest verified steps" } });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM course_maintenance_operations").get()?.count).toBe(3);
  });

  it("rolls back the task when its operation record cannot be committed", async () => {
    const { dispatch, sqlite, abort } = await fixture();
    abort();
    const body = task("maintenance-create-3");
    await expect(dispatch("/1/tasks", "POST", body)).rejects.toThrow("Injected operation failure");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM course_maintenance_tasks").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM course_maintenance_operations").get()?.count).toBe(0);
    expect((await dispatch("/1/tasks", "POST", body)).status).toBe(201);
  });

  it("exports escaped CSV for all task pages and surfaces a failed export instead of a truncated file", async () => {
    const { dispatch, sqlite, failExport } = await fixture();
    await dispatch("/1/tasks", "POST", { ...task("maintenance-create-4", "=HYPERLINK(99)"), details: 'First, "quoted"\nSecond line' });
    sqlite.exec(`
      WITH RECURSIVE rows(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM rows WHERE i<101)
      INSERT INTO course_maintenance_tasks (course_id,title,priority,status,created_at,updated_at,last_request_key)
      SELECT 1, 'Bulk task ' || i, 'normal', 'completed', '2026-04-01', '2026-04-01', 'bulk-' || i FROM rows;
    `);
    const first = await (await dispatch("/1/tasks?status=completed")).json() as { tasks: { id: number }[]; nextBefore: number };
    expect(first.tasks).toHaveLength(40);
    const next = await (await dispatch("/1/tasks?status=completed&before=" + first.nextBefore)).json() as { tasks: { id: number }[] };
    expect(next.tasks[0]!.id).toBeLessThan(first.tasks.at(-1)!.id);
    const response = await dispatch("/1/export" + RANGE);
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="gvdg-course-1-health.csv"');
    const rows = parseCsvRows(await response.text());
    expect(rows.filter((row) => row.record_type === "task")).toHaveLength(102);
    expect(rows.find((row) => row.record_type === "task")).toMatchObject({
      course_name: "'=Park,\"Green\"", label: "'=HYPERLINK(99)", details: "First, \"quoted\"\nSecond line",
    });
    expect(rows.find((row) => row.metric === "completedRounds")).toMatchObject({ value: "4" });
    failExport();
    await expect((await dispatch("/1/export" + RANGE)).text()).rejects.toThrow("Export interrupted");
  });
});
