import type { Env } from "./env.js";
import { requireAuth } from "./authz.js";
import { json, readJson, RequestBodyTooLargeError } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { parsePracticeMutation } from "./practice-input.js";
import { exportPractice, practiceCursor, practiceHistory, readPractice, writePractice } from "./practice-store.js";

const BASE = "/me/practice";

export async function handlePracticeRoute(
  request: Request, env: Env, origin: string | null, pathname: string, method: string,
): Promise<Response | null> {
  if (pathname !== BASE && pathname !== BASE + "/export" && pathname !== BASE + "/mutations") return null;
  const respond = (data: unknown, status: number, headers: Record<string, string> = {}) =>
    json(data, status, origin, { "Cache-Control": "private, no-store", ...headers });
  const actor = await requireAuth(request, env);
  if (!actor?.member || actor.member.mustChangePin || actor.member.memberId !== actor.sub) return respond({ error: "unauthorized" }, 401);
  const owner = actor.sub;

  if (pathname === BASE + "/mutations" && method === "POST") {
    let input;
    try { input = await readJson(request, 8000); }
    catch (error) {
      if (error instanceof RequestBodyTooLargeError) return respond({ error: "request_too_large" }, 413);
      throw error;
    }
    if (input && typeof input.owner === "string" && input.owner !== owner) return respond({ error: "wrong_owner" }, 403);
    const mutation = parsePracticeMutation(input, owner);
    if (!mutation) return respond({ error: "invalid_practice_record" }, 400);
    if (await kvRateLimited(env, "practice-write:" + owner, 48, 60)) {
      return respond({ error: "rate_limited" }, 429, { "Retry-After": "60", "Access-Control-Expose-Headers": "Retry-After" });
    }
    const result = await writePractice(env.DB, owner, mutation);
    return result.ok ? respond(result, 200) : respond({ error: result.error }, 409);
  }

  if (pathname === BASE + "/export" && method === "GET") {
    if (await kvRateLimited(env, "practice-export:" + owner, 5, 60)) return respond({ error: "rate_limited" }, 429);
    return respond(await exportPractice(env.DB, owner), 200, { "Content-Disposition": 'attachment; filename="gvdg-practice-and-bag.json"' });
  }

  if (pathname === BASE && method === "GET") {
    const query = new URL(request.url).searchParams;
    const kind = query.get("kind");
    const cursor = query.get("before");
    let unexpected = false;
    query.forEach((_value, key) => { if (key !== "kind" && key !== "before") unexpected = true; });
    if (unexpected || query.getAll("kind").length > 1 || query.getAll("before").length > 1) return respond({ error: "invalid_practice_query" }, 400);
    if (await kvRateLimited(env, "practice-read:" + owner, 120, 60)) return respond({ error: "rate_limited" }, 429);
    if (kind !== null || cursor !== null) {
      const before = practiceCursor(cursor);
      if ((kind !== "throw" && kind !== "putting") || !before) return respond({ error: "invalid_practice_query" }, 400);
      return respond({ owner, ...await practiceHistory(env.DB, owner, kind, before) }, 200);
    }
    return respond(await readPractice(env.DB, owner), 200);
  }

  return respond({ error: "method_not_allowed" }, 405);
}
