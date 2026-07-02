import type { D1Like } from "./db.js";

type CountRow = {
  readonly n?: number | string | null;
};

type IdRow = {
  readonly id?: number | string | null;
};

type CourseCountKey = "course_layouts" | "course_positions" | "events" | "tee_signs" | "casual_round_requests" | "round_ratings";
type LayoutCountKey = "events" | "casual_round_requests" | "round_ratings" | "layout_ssa";

type BlockerQuery<Key extends string> = {
  readonly key: Key;
  readonly sql: string;
};

export type CourseDeletionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "not_found" | "course_delete_blocked"; readonly blockers: readonly string[] };

export type LayoutDeletionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "not_found" | "layout_delete_blocked"; readonly blockers: readonly string[] };

const COURSE_DELETE_BLOCKER_QUERIES: readonly BlockerQuery<CourseCountKey>[] = [
  { key: "course_layouts", sql: "SELECT COUNT(*) AS n FROM course_layouts WHERE course_id = ?" },
  { key: "course_positions", sql: "SELECT COUNT(*) AS n FROM course_positions WHERE course_id = ?" },
  { key: "events", sql: "SELECT COUNT(*) AS n FROM events WHERE course_id = ?" },
  { key: "tee_signs", sql: "SELECT COUNT(*) AS n FROM tee_signs WHERE course_id = ?" },
  { key: "casual_round_requests", sql: "SELECT COUNT(*) AS n FROM casual_round_requests WHERE course_id = ?" },
  { key: "round_ratings", sql: "SELECT COUNT(*) AS n FROM round_ratings WHERE course_id = ?" },
];

const LAYOUT_DELETE_BLOCKER_QUERIES: readonly BlockerQuery<LayoutCountKey>[] = [
  { key: "events", sql: "SELECT COUNT(*) AS n FROM events WHERE layout_id = ?" },
  { key: "casual_round_requests", sql: "SELECT COUNT(*) AS n FROM casual_round_requests WHERE layout_id = ?" },
  { key: "round_ratings", sql: "SELECT COUNT(*) AS n FROM round_ratings WHERE layout_id = ?" },
  { key: "layout_ssa", sql: "SELECT COUNT(*) AS n FROM layout_ssa WHERE layout_id = ?" },
];

function countValue(row: CountRow | null): number {
  const value = row?.n;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function countRows(db: D1Like, sql: string, id: number): Promise<number> {
  return countValue(await db.prepare(sql).bind(id).first<CountRow>());
}

async function hasRow(db: D1Like, sql: string, id: number): Promise<boolean> {
  return (await db.prepare(sql).bind(id).first<IdRow>()) != null;
}

export async function checkCourseDeletion(db: D1Like, courseId: number): Promise<CourseDeletionCheck> {
  if (!(await hasRow(db, "SELECT id FROM courses WHERE id = ?", courseId))) return { ok: false, error: "not_found", blockers: [] };

  const blockers: string[] = [];
  for (const query of COURSE_DELETE_BLOCKER_QUERIES) {
    if (await countRows(db, query.sql, courseId) > 0) blockers.push(query.key);
  }

  return blockers.length ? { ok: false, error: "course_delete_blocked", blockers } : { ok: true };
}

export async function checkLayoutDeletion(db: D1Like, layoutId: number): Promise<LayoutDeletionCheck> {
  if (!(await hasRow(db, "SELECT id FROM course_layouts WHERE id = ?", layoutId))) return { ok: false, error: "not_found", blockers: [] };

  const blockers: string[] = [];
  for (const query of LAYOUT_DELETE_BLOCKER_QUERIES) {
    if (await countRows(db, query.sql, layoutId) > 0) blockers.push(query.key);
  }

  return blockers.length ? { ok: false, error: "layout_delete_blocked", blockers } : { ok: true };
}
