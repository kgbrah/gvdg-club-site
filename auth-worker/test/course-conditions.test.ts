import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";

const SECRET = "x".repeat(40);
const ORIGIN = "https://gvdgclub.com";

const members = {
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }),
};

function kv(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}

function makeDb() {
  const courses = [
    { id: 1, name: "ECU North Rec Complex" },
    { id: 2, name: "West Meadowbrook Park" },
  ];
  const conditions: Record<string, unknown>[] = [];
  let nextId = 1;
  let reads = 0;
  return {
    reads: () => reads,
    rows: () => conditions,
    db: {
      prepare(sql: string) {
        const text = sql.replace(/\s+/g, " ");
        const stmt = {
          binds: [] as unknown[],
          bind(...values: unknown[]) {
            stmt.binds = values;
            return stmt;
          },
          async first() {
            if (text.includes("FROM courses WHERE id")) {
              const id = Number(stmt.binds[0]);
              return courses.find((course) => course.id === id) ?? null;
            }
            if (text.includes("INSERT INTO course_conditions")) {
              const [course_id, member_id, member_name, status, note] = stmt.binds;
              const course = courses.find((row) => row.id === Number(course_id));
              const row = {
                id: nextId++,
                course_id: Number(course_id),
                member_id,
                member_name,
                status,
                note,
                created_at: `2026-09-11 16:00:0${Math.min(9, conditions.length)}`,
                course_name: course?.name ?? "",
              };
              conditions.push(row);
              return row;
            }
            return null;
          },
          async all() {
            reads += 1;
            if (text.includes("MAX(id)")) {
              const latest = new Map<number, Record<string, unknown>>();
              for (const row of conditions) latest.set(Number(row.course_id), row);
              return { results: [...latest.values()], success: true };
            }
            if (text.includes("FROM course_conditions") && text.includes("course_id = ?")) {
              const id = Number(stmt.binds[0]);
              const limit = Number(stmt.binds[1] ?? 20);
              return {
                results: conditions.filter((row) => Number(row.course_id) === id).slice().reverse().slice(0, limit),
                success: true,
              };
            }
            if (text.includes("FROM courses ORDER BY")) {
              return { results: courses, success: true };
            }
            return { results: [], success: true };
          },
          async run() {
            return { results: [], success: true };
          },
        };
        return stmt;
      },
    },
  };
}

function env(db: unknown, rateLimit = kv()) {
  return {
    ROSTER: kv(members),
    RATELIMIT: rateLimit,
    DB: db,
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    LIVE: undefined,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function tok(sub = "m_jane") {
  return signSession({ sub, mustChangePin: false }, SECRET, 900);
}

async function call(path: string, method = "GET", token?: string, body?: unknown, workerEnv = env(makeDb().db)) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (token) headers.authorization = "Bearer " + token;
  if (body) headers["content-type"] = "application/json";
  return worker.fetch(
    new Request("https://w" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    workerEnv,
  );
}

describe("member course conditions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lets anyone read latest reports and omits member ids", async () => {
    const store = makeDb();
    const workerEnv = env(store.db);
    const posted = await call("/courses/1/conditions", "POST", await tok(), { status: "wet", note: "12 is a puddle" }, workerEnv);
    expect(posted.status).toBe(201);

    const listed = await call("/course-conditions", "GET", undefined, undefined, workerEnv);
    expect(listed.status).toBe(200);
    const payload = (await listed.json()) as { reports: Record<string, unknown>[] };
    expect(payload.reports).toHaveLength(1);
    expect(payload.reports[0]).toMatchObject({
      course_id: 1,
      course_name: "ECU North Rec Complex",
      member_name: "Jane",
      status: "wet",
      note: "12 is a puddle",
    });
    expect(payload.reports[0]!.member_id).toBeUndefined();
  });

  it("rejects unauthenticated writes, bad status, and unknown courses", async () => {
    expect((await call("/courses/1/conditions", "POST", undefined, { status: "wet" })).status).toBe(401);
    expect((await call("/courses/1/conditions", "POST", await tok(), { status: "muddy" })).status).toBe(400);
    expect((await call("/courses/99/conditions", "POST", await tok(), { status: "dry" })).status).toBe(404);
    expect((await call("/courses/nope/conditions", "POST", await tok(), { status: "dry" })).status).toBe(404);
  });

  it("rate-limits a member to 6 reports an hour", async () => {
    const workerEnv = env(makeDb().db);
    const token = await tok();
    let last = 201;
    for (let i = 0; i < 7; i++) {
      last = (await call("/courses/1/conditions", "POST", token, { status: "playable" }, workerEnv)).status;
    }
    expect(last).toBe(429);
  });

  it("returns per-course history and does not ride the 900s catalog cache", async () => {
    const cache = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (request: Request) => cache.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          cache.set(request.url, response.clone());
        },
      }),
    });
    const store = makeDb();
    const workerEnv = env(store.db);
    await call("/courses/1/conditions", "POST", await tok(), { status: "flooded" }, workerEnv);
    await call("/courses/2/conditions", "POST", await tok(), { status: "closed" }, workerEnv);

    const history = await call("/courses/1/conditions", "GET", undefined, undefined, workerEnv);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ reports: [{ course_id: 1, status: "flooded" }] });

    const first = await call("/course-conditions", "GET", undefined, undefined, workerEnv);
    const second = await call("/course-conditions", "GET", undefined, undefined, workerEnv);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json() as { reports: unknown[] }).reports).toHaveLength(2);
    expect(store.reads()).toBeGreaterThanOrEqual(3);
  });
});
