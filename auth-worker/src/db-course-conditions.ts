import type { D1Like } from "./db-types.js";
import { readD1OrFallback } from "./d1-retry.js";

export const COURSE_CONDITION_STATUSES = ["dry", "playable", "wet", "flooded", "closed"] as const;
export type CourseConditionStatus = (typeof COURSE_CONDITION_STATUSES)[number];

export interface CourseConditionInput {
  course_id: number;
  member_id: string;
  member_name: string;
  status: CourseConditionStatus;
  note?: string | null;
}

const PUBLIC_COLUMNS =
  "cc.id, cc.course_id, c.name AS course_name, cc.member_name, cc.status, cc.note, cc.created_at";

export function isCourseConditionStatus(value: unknown): value is CourseConditionStatus {
  return typeof value === "string" && (COURSE_CONDITION_STATUSES as readonly string[]).includes(value);
}

export async function listLatestCourseConditions(db: D1Like) {
  return (await readD1OrFallback(
    () =>
      db
        .prepare(
          `SELECT ${PUBLIC_COLUMNS}
             FROM course_conditions cc
             JOIN courses c ON c.id = cc.course_id
            WHERE cc.id IN (SELECT MAX(id) FROM course_conditions GROUP BY course_id)
            ORDER BY c.name`,
        )
        .all(),
    () => ({ results: [], success: true }),
  )).results;
}

export async function listCourseConditions(db: D1Like, courseId: number, limit = 20) {
  return (await readD1OrFallback(
    () =>
      db
        .prepare(
          `SELECT ${PUBLIC_COLUMNS}
             FROM course_conditions cc
             JOIN courses c ON c.id = cc.course_id
            WHERE cc.course_id = ?
            ORDER BY cc.id DESC
            LIMIT ?`,
        )
        .bind(courseId, limit)
        .all(),
    () => ({ results: [], success: true }),
  )).results;
}

export async function createCourseCondition(db: D1Like, input: CourseConditionInput) {
  return db
    .prepare(
      "INSERT INTO course_conditions (course_id, member_id, member_name, status, note) VALUES (?, ?, ?, ?, ?) RETURNING id, course_id, member_name, status, note, created_at",
    )
    .bind(input.course_id, input.member_id, input.member_name, input.status, input.note ?? null)
    .first();
}
