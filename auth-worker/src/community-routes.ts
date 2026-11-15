import type { Env } from "./env.js";
import { adminGate, requireAuth } from "./authz.js";
import { json, readJson, RequestBodyTooLargeError } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { getMember } from "./roster.js";
import {
  AMENITIES, CONDITIONS, CONNECTION_ACTIONS, MODERATION_ACTIONS, REPORT_REASONS, type Amenities,
  exact, metadataInput, oneOf, positiveId, profileInput, profileKey, reviewInput, revision, safeText,
} from "./community-input.js";
import { communityProgress } from "./community-progress.js";
import {
  communityContacts, communityProfileSettings, directoryProfiles, profileByKey, saveCommunityProfile,
  updateCommunityConnection, viewCommunityProfile,
} from "./community-profiles.js";
import {
  communityReviews, courseDifficulty, findCommunityCourses, moderateCommunityReview, moderationQueue,
  readCommunityCourse, removeCommunityReview, reportCommunityReview, saveCommunityMetadata, saveCommunityReview,
} from "./community-courses.js";

async function activeMember(request: Request, env: Env) {
  const claims = await requireAuth(request, env);
  if (!claims?.member || claims.member.memberId !== claims.sub || claims.member.mustChangePin) return null;
  return claims.sub;
}

function offsetQuery(query: URLSearchParams) {
  const raw = query.get("offset");
  return raw === null ? 0 : /^\d{1,3}$/.test(raw) ? Number(raw) : null;
}

export async function handleCommunityRoute(
  request: Request, env: Env, origin: string | null, pathname: string, method: string,
): Promise<Response | null> {
  if (!/^\/(?:community|me\/community|admin\/community)(?:\/|$)/.test(pathname)) return null;
  const respond = (data: unknown, status = 200) => json(data, status, origin, { "Cache-Control": "private, no-store" });
  const fail = (error: string, status: number) => respond({ error }, status);
  const query = new URL(request.url).searchParams;
  const offset = offsetQuery(query);
  if (offset === null) return fail("invalid_query", 400);

  async function body() {
    return readJson(request, 6000);
  }
  const limited = (key: string, owner: string, count: number) => kvRateLimited(env, "community:" + key + ":" + owner, count, 60);

  try {
    if (pathname === "/community/courses" && method === "GET") {
      const text = safeText(query.get("q") || "", 80);
      const rawDifficulty = query.get("difficulty");
      const difficulty = courseDifficulty(rawDifficulty);
      const amenities: Partial<Amenities> = {};
      if (text === null || (rawDifficulty && !difficulty)) return fail("invalid_query", 400);
      for (const key of AMENITIES) {
        const raw = query.get(key);
        if (!raw) continue;
        const value = oneOf(raw, CONDITIONS);
        if (!value) return fail("invalid_query", 400);
        amenities[key] = value;
      }
      const favorite = query.get("favorites");
      if (favorite !== null && favorite !== "1") return fail("invalid_query", 400);
      const favoriteMember = favorite ? await activeMember(request, env) : null;
      if (favorite && !favoriteMember) return fail("unauthorized", 401);
      return respond(await findCommunityCourses(env.DB, { query: text, difficulty, amenities, offset, favoriteMember: favoriteMember || undefined }));
    }

    const profileMatch = /^\/community\/profiles\/([^/]+)$/.exec(pathname);
    if (profileMatch && method === "GET") {
      const key = profileKey(profileMatch[1]);
      if (!key) return fail("not_found", 404);
      const row = await profileByKey(env.DB, key);
      if (!row) return fail("not_found", 404);
      const viewer = request.headers.has("Authorization") ? await activeMember(request, env) : null;
      const profile = await viewCommunityProfile(env.DB, row, viewer);
      if (!profile || !await getMember(env.ROSTER, row.memberId)) return fail("not_found", 404);
      return respond({ profile });
    }

    const reviewMatch = /^\/community\/courses\/(\d+)\/reviews$/.exec(pathname);
    if (reviewMatch && method === "GET") {
      const courseId = positiveId(reviewMatch[1]);
      const course = courseId && await readCommunityCourse(env.DB, courseId);
      if (!course || !courseId) return fail("course_not_found", 404);
      const viewer = request.headers.has("Authorization") ? await activeMember(request, env) : null;
      return respond({ course, ...await communityReviews(env.DB, courseId, viewer, offset) });
    }

    if (pathname.startsWith("/admin/community")) {
      const authorized = await adminGate(request, env, origin);
      if (authorized instanceof Response) return authorized;
      if (pathname === "/admin/community/reviews" && method === "GET") return respond(await moderationQueue(env.DB, offset));
      const moderation = /^\/admin\/community\/reviews\/(\d+)$/.exec(pathname);
      if (moderation && method === "PUT") {
        const id = positiveId(moderation[1]);
        const data = await body();
        const action = oneOf(data?.action, MODERATION_ACTIONS);
        const rev = revision(data?.revision);
        if (!exact(data, ["action", "revision"]) || !id || !action || !rev) return fail("invalid_moderation", 400);
        if (await limited("moderation", authorized.adminId, 60)) return fail("rate_limited", 429);
        return await moderateCommunityReview(env.DB, id, rev, action) ? respond({ ok: true }) : fail("review_changed", 409);
      }
      const metadata = /^\/admin\/community\/courses\/(\d+)$/.exec(pathname);
      if (metadata && method === "PUT") {
        const id = positiveId(metadata[1]);
        const data = metadataInput(await body());
        if (!id || !data) return fail("invalid_course_metadata", 400);
        if (await limited("metadata", authorized.adminId, 30)) return fail("rate_limited", 429);
        const saved = await saveCommunityMetadata(env.DB, id, data);
        return saved.error ? fail(saved.error, saved.error === "course_not_found" ? 404 : 409) : respond(saved);
      }
      return fail("not_found", 404);
    }

    const actor = await activeMember(request, env);
    if (!actor) return fail("unauthorized", 401);
    if (pathname === "/me/community" && method === "GET") {
      if (await limited("summary", actor, 45)) return fail("rate_limited", 429);
      const [profile, contacts, progress] = await Promise.all([
        communityProfileSettings(env.DB, actor), communityContacts(env.DB, actor), communityProgress(env.DB, actor),
      ]);
      return respond({ profile, ...contacts, progress });
    }
    if (pathname === "/me/community/profile" && method === "PUT") {
      const data = profileInput(await body());
      if (!data) return fail("invalid_profile", 400);
      if (await limited("profile", actor, 20)) return fail("rate_limited", 429);
      const profile = await saveCommunityProfile(env.DB, actor, data);
      return profile ? respond({ profile }) : fail("profile_changed", 409);
    }
    if (pathname === "/community/directory" && method === "GET") {
      const filter = safeText(query.get("q") || "", 60);
      if (filter === null) return fail("invalid_query", 400);
      if (await limited("directory", actor, 30)) return fail("rate_limited", 429);
      const page = await directoryProfiles(env.DB, actor, filter, offset);
      const profiles = await Promise.all(page.results.map(async ({ memberId, ...candidate }) =>
        (await getMember(env.ROSTER, memberId)) ? candidate : null));
      return respond({ profiles: profiles.filter(Boolean), more: page.more });
    }
    const connection = /^\/me\/community\/connections\/([^/]+)$/.exec(pathname);
    if (connection && method === "PUT") {
      const key = profileKey(connection[1]);
      const data = await body();
      const action = oneOf(data?.action, CONNECTION_ACTIONS);
      if (!key || !action || !exact(data, ["action"])) return fail("invalid_connection", 400);
      if (await limited("connection", actor, 36)) return fail("rate_limited", 429);
      const target = await profileByKey(env.DB, key);
      if (!target || ((action === "request" || action === "accept") && !await getMember(env.ROSTER, target.memberId))) return fail("not_found", 404);
      const error = await updateCommunityConnection(env.DB, actor, target, action);
      return error ? fail(error, 409) : respond(await communityContacts(env.DB, actor));
    }
    const ownReview = /^\/me\/community\/courses\/(\d+)\/review$/.exec(pathname);
    if (ownReview && (method === "PUT" || method === "DELETE")) {
      const id = positiveId(ownReview[1]);
      const data = await body();
      if (!id) return fail("course_not_found", 404);
      if (await limited("review", actor, 15)) return fail("rate_limited", 429);
      if (method === "DELETE") {
        const rev = revision(data?.revision);
        if (!rev || !exact(data, ["revision"])) return fail("invalid_review", 400);
        return await removeCommunityReview(env.DB, id, actor, rev) ? respond({ ok: true }) : fail("review_changed", 409);
      }
      const input = reviewInput(data);
      if (!input) return fail("invalid_review", 400);
      const result = await saveCommunityReview(env.DB, id, actor, input);
      return result.error ? fail(result.error, result.error === "course_not_found" ? 404 : 409) : respond(result);
    }
    const report = /^\/me\/community\/reviews\/(\d+)\/report$/.exec(pathname);
    if (report && method === "PUT") {
      const id = positiveId(report[1]);
      const data = await body();
      const rev = revision(data?.revision);
      const reason = oneOf(data?.reason, REPORT_REASONS);
      if (!id || !rev || !reason || !exact(data, ["reason", "revision"])) return fail("invalid_report", 400);
      if (await limited("report", actor, 10)) return fail("rate_limited", 429);
      return await reportCommunityReview(env.DB, id, rev, actor, reason) ? respond({ ok: true }) : fail("review_not_available", 404);
    }
    return fail("not_found", 404);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return fail("request_too_large", 413);
    throw error;
  }
}
