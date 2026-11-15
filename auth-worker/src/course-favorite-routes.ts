import type { Env } from "./env.js";
import { requireAuth } from "./authz.js";
import { json } from "./http.js";

const PRIVATE = { "Cache-Control": "private, no-store" };

export async function handleCourseFavorites(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims?.member || claims.member.mustChangePin) return json({ error: "unauthorized" }, 401, origin, PRIVATE);
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/me/course-favorites") {
    const { results } = await env.DB.prepare(
      "SELECT course_id FROM member_course_favorites WHERE member_id = ? ORDER BY course_id",
    ).bind(claims.sub).all<{ course_id: number }>();
    return json({ courseIds: results.map(({ course_id }) => course_id) }, 200, origin, PRIVATE);
  }
  const match = /^\/me\/course-favorites\/(\d+)$/.exec(path);
  const courseId = Number(match?.[1]);
  if (!Number.isSafeInteger(courseId) || courseId <= 0) return json({ error: "not_found" }, 404, origin, PRIVATE);
  if (request.method === "PUT") {
    const course = await env.DB.prepare("SELECT id FROM courses WHERE id = ?").bind(courseId).first();
    if (!course) return json({ error: "not_found" }, 404, origin, PRIVATE);
    await env.DB.prepare("INSERT OR IGNORE INTO member_course_favorites (member_id, course_id) VALUES (?, ?)").bind(claims.sub, courseId).run();
    return json({ courseId, favorite: true }, 200, origin, PRIVATE);
  }
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM member_course_favorites WHERE member_id = ? AND course_id = ?").bind(claims.sub, courseId).run();
    return json({ courseId, favorite: false }, 200, origin, PRIVATE);
  }
  return json({ error: "method_not_allowed" }, 405, origin, PRIVATE);
}
