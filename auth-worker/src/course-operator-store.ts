import type { D1Like, D1StatementLike } from "./db-types.js";
import {
  operatorCoverage, taskFingerprint, TASK_PAGE_SIZE,
  type CourseListing, type MaintenanceTask, type OperatorWindow, type Participation, type TaskChange, type TaskStatus,
} from "./course-operator.js";

const COURSES_COLUMNS = "id, name, location";
const TASK_COLUMNS = "id, course_id, title, details, priority, status, due_date, revision, created_at, updated_at";
type TaskRow = {
  id: number; course_id: number; title: string; details: string; priority: MaintenanceTask["priority"];
  status: TaskStatus; due_date: string | null; revision: number; created_at: string; updated_at: string;
};

function taskFromRow(row: TaskRow): MaintenanceTask {
  return {
    id: row.id, courseId: row.course_id, title: row.title, details: row.details,
    priority: row.priority, status: row.status, dueDate: row.due_date, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function listOperatorCourses(db: D1Like): Promise<CourseListing[]> {
  const result = await db.prepare("SELECT " + COURSES_COLUMNS + " FROM courses ORDER BY name COLLATE NOCASE, id").all<CourseListing>();
  if (!result.success) throw new Error("Course directory unavailable");
  return result.results;
}

export function getOperatorCourse(db: D1Like, courseId: number) {
  return db.prepare("SELECT " + COURSES_COLUMNS + " FROM courses WHERE id = ?").bind(courseId).first<CourseListing>();
}

export async function getOperatorCoverage(db: D1Like, courseId: number, window: OperatorWindow) {
  const [layouts, positions, signs] = await Promise.all([
    db.prepare("SELECT id, name, holes, expected_holes, created_at, updated_at FROM course_layouts WHERE course_id = ? ORDER BY name")
      .bind(courseId).all<Parameters<typeof operatorCoverage>[0][number]>(),
    db.prepare(
      `SELECT m.layout_id, m.hole, m.kind, m.lat, m.lng, m.updated_at
       FROM course_map_consensus m JOIN course_layouts l ON l.id = m.layout_id
       WHERE l.course_id = ? AND m.published = 1`,
    ).bind(courseId).all<Parameters<typeof operatorCoverage>[1][number]>(),
    db.prepare("SELECT id, hole_number, status, reviewed_at FROM tee_signs WHERE course_id = ? AND status IN ('official','candidate')")
      .bind(courseId).all<Parameters<typeof operatorCoverage>[2][number]>(),
  ]);
  if (!layouts.success || !positions.success || !signs.success) throw new Error("Course coverage unavailable");
  return operatorCoverage(layouts.results, positions.results, signs.results, window);
}

// Event layouts can change later. Prefer the scorecard's archive, and use the configured
// course only if the event has one unambiguous course. Count only ranked finalized results.
const PARTICIPATION_SQL = `
  WITH filtered_events AS (
    SELECT e.id AS round_id, e.course_id, r.id, r.member_id, r.scorecard
    FROM results r JOIN events e ON e.id = r.event_id
    WHERE e.status = 'final' AND r.place > 0 AND r.total >= 0
      AND substr(COALESCE(NULLIF(e.date, ''), r.created_at), 1, 10) BETWEEN ? AND ?
  ),
  event_course_assignments AS (
    SELECT f.round_id, f.course_id AS course_id FROM filtered_events f WHERE f.course_id IS NOT NULL
    UNION
    SELECT a.event_id, a.course_id FROM event_courses a
    WHERE EXISTS (SELECT 1 FROM filtered_events f WHERE f.round_id = a.event_id)
  ), single_event_courses AS (
    SELECT round_id, MIN(course_id) AS course_id FROM event_course_assignments GROUP BY round_id HAVING COUNT(*) = 1
  ), archived_courses AS (
    SELECT f.id AS result_id,
      MIN(CASE WHEN j.type = 'object' THEN
        CASE WHEN json_type(j.value, '$.layoutAtPlay.courseId') = 'integer' AND json_extract(j.value, '$.layoutAtPlay.courseId') > 0
        THEN json_extract(j.value, '$.layoutAtPlay.courseId') END END) AS first_course,
      MAX(CASE WHEN j.type = 'object' THEN
        CASE WHEN json_type(j.value, '$.layoutAtPlay.courseId') = 'integer' AND json_extract(j.value, '$.layoutAtPlay.courseId') > 0
        THEN json_extract(j.value, '$.layoutAtPlay.courseId') END END) AS last_course
    FROM filtered_events f
    JOIN json_each(CASE WHEN json_valid(f.scorecard) THEN f.scorecard ELSE '[]' END) j
    GROUP BY f.id
  ), completions AS (
    SELECT 'event:' || f.round_id AS round_key, 'competition' AS stream, f.id AS row_id, f.member_id
    FROM filtered_events f
    LEFT JOIN archived_courses a ON a.result_id = f.id
    LEFT JOIN single_event_courses c ON c.round_id = f.round_id
    WHERE CASE WHEN a.first_course IS NULL THEN c.course_id
               WHEN a.first_course = a.last_course THEN a.first_course END = ?
    UNION ALL
    SELECT 'casual:' || r.id, 'casual', res.id, res.member_id
    FROM casual_results res JOIN casual_rounds r ON r.id = res.casual_round_id
    WHERE r.course_id = ? AND res.place > 0 AND res.total >= 0
      AND substr(COALESCE(NULLIF(r.started_at, ''), r.finalized_at), 1, 10) BETWEEN ? AND ?
  ), identified AS (
    SELECT round_key, stream,
      CASE WHEN COALESCE(member_id, '') != '' THEN 'identity:' || member_id ELSE 'guest-row:' || row_id END AS entry_key,
      CASE WHEN substr(member_id, 1, 2) = 'm_' OR substr(member_id, 1, 3) = 'op_' THEN member_id END AS known_member
    FROM completions
  ), participation AS (
    SELECT DISTINCT round_key, stream, entry_key, known_member FROM identified
  )
  SELECT COUNT(DISTINCT round_key) AS completedRounds,
    COUNT(DISTINCT CASE WHEN stream = 'competition' THEN round_key END) AS completedCompetitionRecords,
    COUNT(DISTINCT CASE WHEN stream = 'casual' THEN round_key END) AS completedCasualCards,
    COUNT(*) AS completedPlayerEntries, COUNT(DISTINCT known_member) AS uniqueIdentifiedPlayers,
    COUNT(CASE WHEN known_member IS NULL THEN 1 END) AS guestEntries FROM participation
`;

export async function getOperatorParticipation(db: D1Like, courseId: number, window: OperatorWindow): Promise<Participation> {
  const result = await db.prepare(PARTICIPATION_SQL)
    .bind(window.from, window.to, courseId, courseId, window.from, window.to).first<Participation>();
  if (!result) throw new Error("Participation data unavailable");
  return result;
}

export async function listMaintenanceTasks(db: D1Like, courseId: number, status: TaskStatus | "all", before: number | null) {
  const args: unknown[] = [courseId];
  let sql = "SELECT " + TASK_COLUMNS + " FROM course_maintenance_tasks WHERE course_id = ?";
  if (status !== "all") {
    sql += " AND status = ?";
    args.push(status);
  }
  if (before != null) {
    sql += " AND id < ?";
    args.push(before);
  }
  const result = await db.prepare(sql + " ORDER BY id DESC LIMIT ?").bind(...args, TASK_PAGE_SIZE + 1).all<TaskRow>();
  if (!result.success) throw new Error("Maintenance tasks unavailable");
  const tasks = result.results.slice(0, TASK_PAGE_SIZE).map(taskFromRow);
  return { tasks, nextBefore: result.results.length > tasks.length ? tasks.at(-1)?.id ?? null : null };
}

async function taskById(db: D1Like, courseId: number, taskId: number) {
  const row = await db.prepare("SELECT " + TASK_COLUMNS + " FROM course_maintenance_tasks WHERE course_id = ? AND id = ?")
    .bind(courseId, taskId).first<TaskRow>();
  return row ? taskFromRow(row) : null;
}

type SavedOperation = { task_id: number; operation: "create" | "edit"; fingerprint: string; revision: number };
type TaskReply = { task: MaintenanceTask; replayed: boolean } |
  { error: "not_found" | "request_conflict" | "stale_revision"; current?: MaintenanceTask };

async function operationByKey(db: D1Like, courseId: number, requestId: string) {
  return db.prepare(
    "SELECT task_id, operation, fingerprint, revision FROM course_maintenance_operations WHERE course_id = ? AND request_key = ?",
  ).bind(courseId, requestId).first<SavedOperation>();
}

async function transactional(db: D1Like, statements: D1StatementLike[]) {
  if (!db.batch) throw new Error("Course task changes require a database transaction");
  const result = await db.batch(statements);
  if (result.some((statement) => !statement.success)) throw new Error("Maintenance transaction failed");
  return result;
}

export async function saveMaintenanceTask(db: D1Like, courseId: number, taskId: number | null, change: TaskChange): Promise<TaskReply> {
  const action = taskId == null ? "create" : "edit";
  const fingerprint = await taskFingerprint(taskId, change);
  const existing = await operationByKey(db, courseId, change.requestId);
  if (existing) {
    if (existing.operation !== action || existing.fingerprint !== fingerprint || (taskId != null && existing.task_id !== taskId)) {
      return { error: "request_conflict" };
    }
    const task = await taskById(db, courseId, existing.task_id);
    return task ? { task, replayed: true } : { error: "not_found" };
  }

  const { title, details, priority, status, dueDate } = change.input;
  const now = new Date().toISOString();
  const operation = db.prepare(
    `INSERT OR IGNORE INTO course_maintenance_operations (course_id, request_key, task_id, operation, fingerprint, revision)
     SELECT course_id, ?, id, ?, ?, revision FROM course_maintenance_tasks
     WHERE course_id = ? AND last_request_key = ? AND revision = ? AND (? IS NULL OR id = ?)`,
  ).bind(change.requestId, action, fingerprint, courseId, change.requestId, taskId == null ? 1 : change.expectedRevision! + 1, taskId, taskId);

  const mutate = taskId == null ? db.prepare(
    `INSERT INTO course_maintenance_tasks (course_id, title, details, priority, status, due_date, created_at, updated_at, last_request_key)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM course_maintenance_operations WHERE course_id = ? AND request_key = ?)`,
  ).bind(courseId, title, details, priority, status, dueDate, now, now, change.requestId, courseId, change.requestId) :
    db.prepare(
      `UPDATE course_maintenance_tasks SET title = ?, details = ?, priority = ?, status = ?, due_date = ?,
                                      updated_at = ?, last_request_key = ?, revision = revision + 1
       WHERE course_id = ? AND id = ? AND revision = ?
         AND NOT EXISTS (SELECT 1 FROM course_maintenance_operations WHERE course_id = ? AND request_key = ?)`,
    ).bind(title, details, priority, status, dueDate, now, change.requestId, courseId, taskId, change.expectedRevision, courseId, change.requestId);

  const result = await transactional(db, [mutate, operation]);
  const saved = await operationByKey(db, courseId, change.requestId);
  if (saved) {
    if (saved.operation !== action || saved.fingerprint !== fingerprint || (taskId != null && saved.task_id !== taskId)) {
      return { error: "request_conflict" };
    }
    const task = await taskById(db, courseId, saved.task_id);
    return task ? { task, replayed: Number(result[0]?.meta?.changes ?? 0) === 0 } : { error: "not_found" };
  }
  if (taskId == null) throw new Error("Maintenance request could not be confirmed");
  const current = await taskById(db, courseId, taskId);
  return current ? { error: "stale_revision", current } : { error: "not_found" };
}

export async function exportTaskPage(db: D1Like, courseId: number, after: number, through: number) {
  const result = await db.prepare("SELECT " + TASK_COLUMNS + " FROM course_maintenance_tasks WHERE course_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT 100")
    .bind(courseId, after, through).all<TaskRow>();
  if (!result.success) throw new Error("Maintenance export page unavailable");
  return result.results.map(taskFromRow);
}

export async function latestTaskId(db: D1Like, courseId: number): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(MAX(id), 0) AS last_id FROM course_maintenance_tasks WHERE course_id = ?")
    .bind(courseId).first<{ last_id: number }>();
  return row?.last_id ?? 0;
}
