import type { Env } from "./env.js";
import { requireAuth } from "./authz.js";
import { json, readJson, RequestBodyTooLargeError } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import {
  ARCHIVE_MANIFEST, ARCHIVE_PAGE_SIZE, ARCHIVE_VERSION, MAX_ARCHIVE_ENTRY_BYTES, MAX_ARCHIVE_PART_BYTES,
  archiveBytes, archiveObject, parseArchiveEntry, type ArchiveEntry,
} from "./member-archive.js";
import { archiveCursor, exportArchivePage, readArchiveLibrary, removeArchiveEntry, restoreArchiveEntries } from "./member-archive-store.js";
import { hasHistoryAccess } from "./roster.js";

const BASE = "/me/archive";

export async function handleMemberArchiveRoute(
  request: Request, env: Env, origin: string | null, pathname: string, method: string,
): Promise<Response | null> {
  const deletion = /^\/me\/archive\/records\/(\d{1,16})$/.exec(pathname);
  if (pathname !== BASE && pathname !== BASE + "/restore" && pathname !== BASE + "/records" && !deletion) return null;
  const respond = (value: unknown, status = 200, extra = {}) => json(value, status, origin, { "Cache-Control": "private, no-store", ...extra });
  const actor = await requireAuth(request, env);
  if (!actor?.member || actor.member.memberId !== actor.sub || actor.member.mustChangePin) return respond({ error: "unauthorized" }, 401);
  const owner = actor.sub;
  const params = new URL(request.url).searchParams;
  if (pathname === BASE && method === "GET") {
    const hasHistory = hasHistoryAccess(actor.member);
    const rawCursor = params.get("cursor");
    const cursor = archiveCursor(rawCursor ?? (hasHistory ? "play:0:0" : "practice:"));
    if (!cursor) return respond({ error: "invalid_cursor" }, 400);
    if (!hasHistory && cursor.section === "play") return respond({ error: "membership_required" }, 403);
    const page = await exportArchivePage(env.DB, owner, cursor);
    return respond({ schemaVersion: ARCHIVE_VERSION, memberId: owner, exportedAt: new Date().toISOString(), definitions: ARCHIVE_MANIFEST, ...page });
  }
  if (pathname === BASE + "/records" && method === "GET") {
    const page = await readArchiveLibrary(env.DB, owner, params.get("cursor"));
    return page ? respond(page) : respond({ error: "invalid_cursor" }, 400);
  }
  if (deletion?.[1] && method === "DELETE") {
    return await removeArchiveEntry(env.DB, owner, deletion[1]) ? respond({ ok: true }) : respond({ error: "not_found" }, 404);
  }
  if (pathname !== BASE + "/restore" || method !== "POST") return respond({ error: "not_found" }, 404);
  if (await kvRateLimited(env, "archive-restore:" + owner, 240, 60)) {
    return respond({ error: "rate_limited" }, 429, { "Retry-After": "60", "Access-Control-Expose-Headers": "Retry-After" });
  }
  let file;
  try { file = await readJson(request, MAX_ARCHIVE_PART_BYTES); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) return respond({ error: "archive_part_too_large" }, 413);
    throw error;
  }
  const part = archiveObject(file, ["schemaVersion", "memberId", "entries", "mode"]);
  if (part?.schemaVersion !== ARCHIVE_VERSION || (part.mode !== "preview" && part.mode !== "restore") ||
      !Array.isArray(part.entries) || !part.entries.length || part.entries.length > ARCHIVE_PAGE_SIZE) {
    return respond({ error: "invalid_archive_part" }, 400);
  }
  if (part.memberId !== owner) return respond({ error: "wrong_owner" }, 403);
  const entries: ArchiveEntry[] = [];
  for (const [index, raw] of part.entries.entries()) {
    const row = archiveObject(raw);
    if (row && typeof row.owner === "string" && row.owner !== owner) return respond({ error: "wrong_owner", index }, 403);
    const entry = parseArchiveEntry(raw, owner);
    if (!entry) return respond({ error: "invalid_archive_entry", index }, 400);
    if (archiveBytes(JSON.stringify(entry)) > MAX_ARCHIVE_ENTRY_BYTES) return respond({ error: "archive_entry_too_large", index }, 413);
    entries.push(entry);
  }
  if (part.mode === "preview") return respond({ valid: entries.length });
  const result = await restoreArchiveEntries(env.DB, owner, entries, new Date().toISOString());
  return result.ok ? respond(result) : respond({ error: result.error }, 409);
}
