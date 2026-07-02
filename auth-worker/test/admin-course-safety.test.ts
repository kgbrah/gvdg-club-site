import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";
import { d1Database, d1Statement, memoryKv, workerEnv } from "./worker-test-env.js";

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
  updateLayoutBinds?: readonly unknown[];
  deletedCourseId?: number;
  deletedLayoutId?: number;
  deletedPositionId?: number;
  replacedPositionCourseId?: number;
  insertedPositionLabels?: string[];
};

function countFrom<T extends string>(blockers: Partial<Record<T, number>> | undefined, key: T): { readonly n: number } {
  return { n: blockers?.[key] ?? 0 };
}

function db(state: DbState): D1Database {
  return d1Database((sql) => {
    let binds: readonly unknown[] = [];
    return d1Statement({
      bind: (values) => {
        binds = values;
      },
      first: () => {
        if (/SELECT id FROM courses WHERE id = \?/i.test(sql)) return state.courseExists === false ? null : { id: binds[0] };
        if (/SELECT \* FROM course_layouts WHERE id = \?/i.test(sql)) {
          return state.layoutExists === false
            ? null
            : { id: binds[0], name: "Gold", holes: JSON.stringify([{ hole: 1, par: 3 }]), total_par: 3 };
        }
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
        if (/UPDATE course_layouts/i.test(sql)) {
          state.updateLayoutBinds = binds;
          return { id: binds.at(-1), name: binds[0], holes: binds[1], total_par: binds[2] };
        }
        return null;
      },
      run: () => {
        if (/DELETE FROM courses WHERE id = \?/i.test(sql)) state.deletedCourseId = Number(binds[0]);
        if (/DELETE FROM course_layouts WHERE id = \?/i.test(sql)) state.deletedLayoutId = Number(binds[0]);
        if (/DELETE FROM course_positions WHERE id = \? AND course_id = \?/i.test(sql)) state.deletedPositionId = Number(binds[0]);
        if (/DELETE FROM course_positions WHERE course_id = \?/i.test(sql)) state.replacedPositionCourseId = Number(binds[0]);
        if (/INSERT INTO course_positions/i.test(sql)) {
          state.insertedPositionLabels = [...(state.insertedPositionLabels ?? []), String(binds[2] ?? "")];
        }
      },
    });
  });
}

function env(state: DbState) {
  return workerEnv({ roster: memoryKv(MEMBERS), db: db(state), secret: SECRET, origin: ORIGIN });
}

async function token() {
  return signSession({ sub: "m_admin", mustChangePin: false }, SECRET, 900);
}

async function requestAsAdmin(path: string, method: "DELETE" | "PATCH" | "PUT", state: DbState, body?: unknown) {
  const headers: Record<string, string> = { Origin: ORIGIN, authorization: "Bearer " + await token() };
  if (body != null) headers["content-type"] = "application/json";
  return worker.fetch(new Request("https://w" + path, { method, headers, body: body != null ? JSON.stringify(body) : undefined }), env(state));
}

function deleteAsAdmin(path: string, state: DbState, body?: unknown) {
  return requestAsAdmin(path, "DELETE", state, body);
}

function patchAsAdmin(path: string, state: DbState, body?: unknown) {
  return requestAsAdmin(path, "PATCH", state, body);
}

function putAsAdmin(path: string, state: DbState, body?: unknown) {
  return requestAsAdmin(path, "PUT", state, body);
}

describe("admin course and layout deletion safety", () => {
  it("blocks deleting courses that still have dependent records", async () => {
    const state: DbState = { courseBlockers: { course_layouts: 2, events: 1 } };
    const res = await deleteAsAdmin("/admin/courses/7", state, { confirm_course_delete: true });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "course_delete_blocked", blockers: ["course_layouts", "events"] });
    expect(state.deletedCourseId).toBeUndefined();
  });

  it("requires explicit confirmation before deleting empty courses", async () => {
    const state: DbState = {};
    const res = await deleteAsAdmin("/admin/courses/7", state);

    expect(res.status).toBe(409);
    expect(state.deletedCourseId).toBeUndefined();
  });

  it("still deletes empty courses after explicit confirmation", async () => {
    const state: DbState = {};
    const res = await deleteAsAdmin("/admin/courses/7", state, { confirm_course_delete: true });

    expect(res.status).toBe(200);
    expect(state.deletedCourseId).toBe(7);
  });

  it("blocks deleting layouts referenced by events or ratings", async () => {
    const state: DbState = { layoutBlockers: { events: 1, round_ratings: 4 } };
    const res = await deleteAsAdmin("/admin/layouts/44", state, { confirm_layout_delete: true });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "layout_delete_blocked", blockers: ["events", "round_ratings"] });
    expect(state.deletedLayoutId).toBeUndefined();
  });

  it("returns 404 when deleting a missing layout", async () => {
    const state: DbState = { layoutExists: false };
    const res = await deleteAsAdmin("/admin/layouts/44", state, { confirm_layout_delete: true });

    expect(res.status).toBe(404);
    expect(state.deletedLayoutId).toBeUndefined();
  });

  it("requires explicit confirmation before deleting empty layouts", async () => {
    const state: DbState = {};
    const res = await deleteAsAdmin("/admin/layouts/44", state);

    expect(res.status).toBe(409);
    expect(state.deletedLayoutId).toBeUndefined();
  });

  it("requires explicit confirmation before updating layout holes", async () => {
    const unconfirmedState: DbState = {};
    const unconfirmed = await patchAsAdmin("/admin/layouts/44", unconfirmedState, { name: "Gold", holes: [{ hole: 1, par: 4 }] });

    expect(unconfirmed.status).toBe(409);
    await expect(unconfirmed.json()).resolves.toMatchObject({ error: "layout_update_confirmation_required" });
    expect(unconfirmedState.updateLayoutBinds).toBeUndefined();

    const confirmedState: DbState = {};
    const confirmed = await patchAsAdmin(
      "/admin/layouts/44",
      confirmedState,
      { name: "Gold", holes: [{ hole: 1, par: 4 }], confirm_layout_update: true },
    );

    expect(confirmed.status).toBe(200);
    expect(confirmedState.updateLayoutBinds?.[0]).toBe("Gold");
    expect(confirmedState.updateLayoutBinds?.[2]).toBe(4);
    expect(confirmedState.updateLayoutBinds?.[3]).toBe(44);
  });

  it("requires explicit confirmation before deleting a tee or target position", async () => {
    const state: DbState = {};
    const res = await deleteAsAdmin("/admin/courses/7/positions/15", state);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "course_position_delete_confirmation_required" });
    expect(state.deletedPositionId).toBeUndefined();
  });

  it("deletes a tee or target position after explicit confirmation", async () => {
    const state: DbState = {};
    const res = await deleteAsAdmin("/admin/courses/7/positions/15", state, { confirm_course_position_delete: true });

    expect(res.status).toBe(200);
    expect(state.deletedPositionId).toBe(15);
  });

  it("requires explicit confirmation before replacing course tee and target positions", async () => {
    const positions = [{ kind: "tee", label: "Long", lat: 35.1, lng: -77.4 }];
    const unconfirmedState: DbState = {};
    const unconfirmed = await putAsAdmin("/admin/courses/7/positions", unconfirmedState, { positions });

    expect(unconfirmed.status).toBe(409);
    await expect(unconfirmed.json()).resolves.toMatchObject({ error: "course_positions_replace_confirmation_required" });
    expect(unconfirmedState.replacedPositionCourseId).toBeUndefined();

    const confirmedState: DbState = {};
    const confirmed = await putAsAdmin(
      "/admin/courses/7/positions",
      confirmedState,
      { positions, confirm_course_positions_replace: true },
    );

    expect(confirmed.status).toBe(200);
    expect(confirmedState.replacedPositionCourseId).toBe(7);
    expect(confirmedState.insertedPositionLabels).toEqual(["Long"]);
  });
});
