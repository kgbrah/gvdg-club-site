import type { Env } from "./env.js";
import * as db from "./db.js";
import { requireAuth } from "./authz.js";
import { json, readJson } from "./http.js";
import { asInt } from "./input.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { getMember } from "./roster.js";
import { isCourseConditionStatus } from "./db-course-conditions.js";

const REPORT_LIMIT = 6;
const REPORT_WINDOW_SEC = 3600;
const NOTE_MAX = 280;
const HISTORY_DEFAULT = 20;
const HISTORY_MAX = 50;

function publicReport(row: Record<string, unknown> | null, courseName?: string | null) {
  if (!row) return null;
  const status = row.status;
  if (!isCourseConditionStatus(status)) return null;
  const note = typeof row.note === "string" && row.note.trim() ? row.note.trim() : null;
  const name = typeof row.course_name === "string" ? row.course_name : courseName ?? null;
  return {
    id: row.id ?? null,
    course_id: row.course_id ?? null,
    course_name: name,
    member_name: typeof row.member_name === "string" && row.member_name.trim() ? row.member_name.trim() : "Member",
    status,
    note,
    created_at: row.created_at ?? null,
  };
}

function publicReports(rows: unknown) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => publicReport(row as Record<string, unknown>))
    .filter(Boolean);
}

export async function handleCourseConditions(
  request: Request,
  env: Env,
  origin: string | null,
  pathname: string,
  method: string,
  seg: string[],
): Promise<Response | null> {
  if (method === "GET" && pathname === "/course-conditions") {
    const rows = await db.listLatestCourseConditions(env.DB);
    return json({ reports: publicReports(rows) }, 200, origin);
  }

  if (seg[0] === "courses" && seg.length === 3 && seg[2] === "conditions") {
    const courseId = asInt(seg[1]);
    if (courseId == null) return json({ error: "not_found" }, 404, origin);
    const course = (await db.getCourse(env.DB, courseId)) as { id?: number; name?: string } | null;
    if (!course) return json({ error: "not_found" }, 404, origin);

    if (method === "GET") {
      const requested = asInt(new URL(request.url).searchParams.get("limit"));
      const limit = Math.min(HISTORY_MAX, requested && requested > 0 ? requested : HISTORY_DEFAULT);
      const rows = await db.listCourseConditions(env.DB, courseId, limit);
      return json({ reports: publicReports(rows) }, 200, origin);
    }

    if (method === "POST") {
      const claims = await requireAuth(request, env);
      if (!claims) return json({ error: "unauthorized" }, 401, origin);
      if (await kvRateLimited(env, "conditions:" + claims.sub, REPORT_LIMIT, REPORT_WINDOW_SEC)) {
        return json({ error: "rate_limited" }, 429, origin);
      }
      const body = (await readJson(request)) ?? {};
      const status = body.status;
      if (!isCourseConditionStatus(status)) return json({ error: "invalid_status" }, 400, origin);
      const noteRaw = typeof body.note === "string" ? body.note.trim() : "";
      if (noteRaw.length > NOTE_MAX) return json({ error: "note_too_long" }, 413, origin);
      const member = claims.member ?? (await getMember(env.ROSTER, claims.sub));
      const row = (await db.createCourseCondition(env.DB, {
        course_id: courseId,
        member_id: claims.sub,
        member_name: member?.name ?? "Member",
        status,
        note: noteRaw || null,
      })) as Record<string, unknown> | null;
      const report = publicReport(row, course.name ?? null);
      if (!report) return json({ error: "server_error" }, 500, origin);
      return json({ report }, 201, origin);
    }
  }

  return null;
}
