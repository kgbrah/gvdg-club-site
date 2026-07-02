import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const MEMBERS = {
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
};

type CourseBlocker = "course_layouts" | "course_positions" | "events" | "tee_signs" | "casual_round_requests" | "round_ratings";
type LayoutBlocker = "events" | "casual_round_requests" | "round_ratings" | "layout_ssa";

type DbState = {
  readonly courseExists?: boolean;
  readonly layoutExists?: boolean;
  readonly courseBlockers?: Partial<Record<CourseBlocker, number>>;
  readonly layoutBlockers?: Partial<Record<LayoutBlocker, number>>;
  deletedCourseId?: number;
  deletedLayoutId?: number;
};

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
  };
}

function countFrom<T extends string>(blockers: Partial<Record<T, number>> | undefined, key: T): { readonly n: number } {
  return { n: blockers?.[key] ?? 0 };
}

function db(state: DbState) {
  return {
    prepare: (sql: string) => {
      let binds: readonly unknown[] = [];
      return {
        bind(...values: readonly unknown[]) {
          binds = values;
          return this;
        },
        all: async () => ({ results: [], success: true }),
        first: async () => {
          if (/SELECT id FROM courses WHERE id = \?/i.test(sql)) return state.courseExists === false ? null : { id: binds[0] };
          if (/SELECT id FROM course_layouts WHERE id = \?/i.test(sql)) return state.layoutExists === false ? null : { id: binds[0] };
          if (/FROM course_layouts WHERE course_id = \?/i.test(sql)) return countFrom(state.courseBlockers, "course_layouts");
          if (/FROM course_positions WHERE course_id = \?/i.test(sql)) return countFrom(state.courseBlockers, "course_positions");
          if (/FROM events WHERE course_id = \?/i.test(sql)) return countFrom(state.courseBlockers, "events");
          if (/FROM tee_signs WHERE course_id = \?/i.test(sql)) return countFrom(state.courseBlockers, "tee_signs");
          if (/FROM casual_round_requests WHERE course_id = \?/i.test(sql)) return countFrom(state.courseBlockers, "casual_round_requests");
          if (/FROM round_ratings WHERE course_id = \?/i.test(sql)) return countFrom(state.courseBlockers, "round_ratings");
          if (/FROM events WHERE layout_id = \?/i.test(sql)) return countFrom(state.layoutBlockers, "events");
          if (/FROM casual_round_requests WHERE layout_id = \?/i.test(sql)) return countFrom(state.layoutBlockers, "casual_round_requests");
          if (/FROM round_ratings WHERE layout_id = \?/i.test(sql)) return countFrom(state.layoutBlockers, "round_ratings");
          if (/FROM layout_ssa WHERE layout_id = \?/i.test(sql)) return countFrom(state.layoutBlockers, "layout_ssa");
          return null;
        },
        run: async () => {
          if (/DELETE FROM courses WHERE id = \?/i.test(sql)) state.deletedCourseId = Number(binds[0]);
          if (/DELETE FROM course_layouts WHERE id = \?/i.test(sql)) state.deletedLayoutId = Number(binds[0]);
          return { results: [], success: true };
        },
      };
    },
  };
}

function env(state: DbState) {
  return {
    ROSTER: kv(MEMBERS),
    RATELIMIT: kv(),
    DB: db(state),
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    LIVE: undefined,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function token() {
  return signSession({ sub: "m_admin", mustChangePin: false }, SECRET, 900);
}

async function call(path: string, method: string, state: DbState) {
  return worker.fetch(new Request("https://w" + path, { method, headers: { Origin: ORIGIN, authorization: "Bearer " + await token() } }), env(state));
}

describe("admin course and layout deletion safety", () => {
  it("blocks deleting courses that still have dependent records", async () => {
    const state: DbState = { courseBlockers: { course_layouts: 2, events: 1 } };
    const res = await call("/admin/courses/7", "DELETE", state);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "course_delete_blocked", blockers: ["course_layouts", "events"] });
    expect(state.deletedCourseId).toBeUndefined();
  });

  it("still deletes empty courses", async () => {
    const state: DbState = {};
    const res = await call("/admin/courses/7", "DELETE", state);

    expect(res.status).toBe(200);
    expect(state.deletedCourseId).toBe(7);
  });

  it("blocks deleting layouts referenced by events or ratings", async () => {
    const state: DbState = { layoutBlockers: { events: 1, round_ratings: 4 } };
    const res = await call("/admin/layouts/44", "DELETE", state);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "layout_delete_blocked", blockers: ["events", "round_ratings"] });
    expect(state.deletedLayoutId).toBeUndefined();
  });

  it("returns 404 when deleting a missing layout", async () => {
    const state: DbState = { layoutExists: false };
    const res = await call("/admin/layouts/44", "DELETE", state);

    expect(res.status).toBe(404);
    expect(state.deletedLayoutId).toBeUndefined();
  });
});
