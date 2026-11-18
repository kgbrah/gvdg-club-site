// Lost & Found posts: browse, detail, create (members and verified guests), close, "turned in to the club
// bin", and serving the post's photos. Photos are public as uploaded (type-checked, size-capped, metadata
// stripped); the poster is asked to cover names and phone numbers. The private "what's written on it" and the
// AI's read of the ink are never in any payload.

import { readJson } from "./http.js";
import { MAX_FOUND_PHOTOS, MAX_LOST_PHOTOS, parseBinNote, parsePost, POST_DAYS } from "./lf-input.js";
import { notifyPerson } from "./lf-notify.js";
import { processPost, purgePostPhotos } from "./lf-process.js";
import {
  CLAIM_COLUMNS, MATCH_COLUMNS, getPostRow, logClaim, matchReasonLabels, parseReasons, people, postCards, postStatus, postTitle, strength,
} from "./lf-store.js";
import { ownPhotos, photosFrom, removeOwnPhoto, servePhoto, storePhotos } from "./lf-photos.js";
import { bagDisc } from "./bag-routes.js";
import { queueLostCheck } from "./market-lost-check.js";
import type { DecodedImage } from "./photos.js";
import { changed, fail, limited, ok, type MarketCtx } from "./market-http.js";
import { ensureTrader, num, str, viewerOf, type Actor, type Row } from "./market-store.js";

const PAGE = 24;
/** Body cap for a post carrying up to three photos as base64 data URLs. */
export const LF_BODY_BYTES = 7_000_000;
const PUBLIC_STATUSES = ["open", "claimed", "returned"];

export function requirePerson(c: MarketCtx): Actor | Response {
  return c.actor ?? fail(c, 401, "unauthorized");
}

function likeTerm(value: string): string {
  return "%" + value.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%";
}

/** Whether a viewer may see a post at all (detail, photos). Posters and admins always can. */
export function postVisible(c: MarketCtx, row: Row): boolean {
  if (c.actor && (c.actor.id === str(row, "owner_id") || c.actor.isAdmin)) return true;
  if (num(row, "hidden") === 1) return false;
  return PUBLIC_STATUSES.includes(postStatus(row));
}

export async function browsePosts(c: MarketCtx): Promise<Response> {
  const p = new URL(c.request.url).searchParams;
  const kind = p.get("kind") === "lost" ? "lost" : "found";
  const where = ["p.kind = ?", "p.status IN ('open', 'claimed')", "p.hidden = 0", "p.expires_at > datetime('now')"];
  const binds: unknown[] = [kind];
  const course = p.get("course");
  if (course && /^\d{1,9}$/.test(course)) { where.push("p.course_id = ?"); binds.push(Number(course)); }
  const q = (p.get("q") || "").trim();
  if (q && q.length <= 60) {
    const term = likeTerm(q);
    where.push("(p.brand LIKE ? ESCAPE '\\' OR p.mold LIKE ? ESCAPE '\\' OR p.plastic LIKE ? ESCAPE '\\' OR p.color LIKE ? ESCAPE '\\' OR p.course_name LIKE ? ESCAPE '\\' OR p.area LIKE ? ESCAPE '\\')");
    binds.push(term, term, term, term, term, term);
  }
  const rawOffset = p.get("offset");
  const offset = rawOffset && /^\d{1,4}$/.test(rawOffset) ? Number(rawOffset) : 0;
  const rows = (await c.env.DB.prepare(
    `SELECT p.id, p.kind, p.owner_id, p.status, p.brand, p.mold, p.plastic, p.color, p.course_id, p.course_name, p.area, p.event_date,
            p.holding, p.bin_note, p.reward_note, p.ai_fields, p.hidden, p.created_at, p.expires_at, p.weight_g, p.hole
     FROM lf_posts p WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC, p.id DESC LIMIT ${PAGE + 1} OFFSET ?`,
  ).bind(...binds, offset).all<Row>()).results ?? [];
  return ok(c, {
    posts: await postCards(c.env, rows.slice(0, PAGE), c.actor?.id ?? null),
    more: rows.length > PAGE,
    viewer: await viewerOf(c.env, c.actor),
  });
}

async function claimViews(c: MarketCtx, rows: Row[]) {
  const person = await people(c.env, rows.flatMap((row) => [str(row, "owner_id"), str(row, "finder_id")]));
  return rows.map((row) => ({
    id: num(row, "id"),
    status: str(row, "status"),
    message: str(row, "message"),
    owner: person(str(row, "owner_id")),
    createdAt: str(row, "created_at"),
    returnedAt: row.returned_at ? str(row, "returned_at") : null,
    confirmedAt: row.confirmed_at ? str(row, "confirmed_at") : null,
  }));
}

export async function postDetail(c: MarketCtx, row: Row) {
  const env = c.env;
  const id = num(row, "id");
  const actor = c.actor;
  const [card] = await postCards(env, [row], actor?.id ?? null);
  const mine = card!.mine;
  const isFound = card!.kind === "found";
  const live = card!.status === "open" || card!.status === "claimed";
  const detail: Record<string, unknown> = { ...card! };
  if (mine) {
    // The poster's own private text, for their eyes only (it is never in any other payload).
    if (!isFound) {
      const own = await env.DB.prepare("SELECT private_ink FROM lf_posts WHERE id = ? AND owner_id = ?").bind(id, actor!.id).first<{ private_ink: string }>();
      detail.privateInk = own?.private_ink ?? "";
    }
    if (isFound) {
      const claims = (await env.DB.prepare(
        `SELECT ${CLAIM_COLUMNS} FROM lf_claims c WHERE c.found_id = ? AND c.status IN ('open', 'returned', 'confirmed') ORDER BY c.id`,
      ).bind(id).all<Row>()).results ?? [];
      detail.claims = await claimViews(c, claims);
      const notified = await env.DB.prepare("SELECT COUNT(*) AS n FROM lf_matches WHERE found_id = ? AND status IN ('notified', 'claimed')")
        .bind(id).first<{ n: number }>();
      detail.ownersNotified = Number(notified?.n) || 0;
    } else {
      const matches = (await env.DB.prepare(
        `SELECT ${MATCH_COLUMNS} FROM lf_matches m JOIN lf_posts f ON f.id = m.found_id
         WHERE m.lost_id = ? AND m.candidate_id = ? AND m.status IN ('suggested', 'notified') AND f.status IN ('open', 'claimed') AND f.hidden = 0
         ORDER BY m.score DESC LIMIT 10`,
      ).bind(id, actor!.id).all<Row>()).results ?? [];
      detail.matches = matches.map((match) => ({ id: num(match, "id"), foundId: num(match, "found_id"), strength: strength(num(match, "score")),
        reasons: matchReasonLabels(parseReasons(match.reasons)) }));
    }
    // The poster's own photos, with the private nudge where the read found a name or phone number (never the text).
    detail.myPhotos = await ownPhotos(c, { postId: id });
    detail.canClose = live;
    detail.canTurnIn = isFound && live && card!.holding !== "club_bin";
  } else if (actor) {
    const myClaim = await env.DB.prepare(
      `SELECT id, status FROM lf_claims WHERE found_id = ? AND owner_id = ? ORDER BY id DESC LIMIT 1`,
    ).bind(id, actor.id).first<{ id: number; status: string }>();
    detail.myClaim = myClaim ? { id: myClaim.id, status: myClaim.status } : null;
    const myMatch = await env.DB.prepare(
      "SELECT id, status FROM lf_matches WHERE found_id = ? AND candidate_id = ? AND status IN ('suggested', 'notified')",
    ).bind(id, actor.id).first<{ id: number; status: string }>();
    detail.myMatch = myMatch ? { id: myMatch.id } : null;
    detail.canClaim = isFound && live && card!.hidden === false && !(myClaim && (myClaim.status === "open" || myClaim.status === "returned"));
  } else {
    detail.canClaim = isFound && live;
    detail.claimLocked = true;
  }
  detail.canReport = !mine;
  return detail;
}

export async function getPost(c: MarketCtx, id: number): Promise<Response> {
  const row = await getPostRow(c.env, id);
  if (!row || !postVisible(c, row)) return fail(c, 404, "not_found");
  return ok(c, { post: await postDetail(c, row), viewer: await viewerOf(c.env, c.actor) });
}

export async function createPost(c: MarketCtx): Promise<Response> {
  const poster = requirePerson(c);
  if (poster instanceof Response) return poster;
  if (!c.env.PHOTOS) return fail(c, 503, "storage_unavailable");
  const body = (await readJson(c.request, LF_BODY_BYTES)) ?? {};
  const parsed = parsePost(body);
  if (!parsed.ok) return fail(c, 400, "invalid_post", parsed.field);
  const v = parsed.value;
  const images = v.kind === "found" ? photosFrom(body.photos, 1, MAX_FOUND_PHOTOS) : photosFrom(body.photos, 0, MAX_LOST_PHOTOS);
  if (!images) return fail(c, 400, "invalid_photo");
  // "I lost this disc" from My Bag: the member's own bag disc, plus the bag photos they chose to show on the post
  // (copied; the bag keeps its private originals).
  let bagDiscId: string | null = null;
  if (body.bagDiscId != null && body.bagDiscId !== "") {
    if (v.kind !== "lost" || poster.kind !== "member" || typeof body.bagDiscId !== "string" || !(await bagDisc(c.env, poster.id, body.bagDiscId))) {
      return fail(c, 400, "invalid_post", "bagDiscId");
    }
    bagDiscId = body.bagDiscId;
    const wanted = (Array.isArray(body.bagPhotoIds) ? body.bagPhotoIds : []).filter((id): id is number => Number.isInteger(id) && Number(id) > 0);
    for (const photoId of wanted.slice(0, Math.max(0, MAX_LOST_PHOTOS - images.length))) {
      const row = await c.env.DB.prepare("SELECT photo_key, photo_type FROM bag_photos WHERE id = ? AND owner = ? AND subject = 'disc' AND disc_id = ?")
        .bind(photoId, poster.id, bagDiscId).first<{ photo_key: string; photo_type: string }>();
      const obj = row ? await c.env.PHOTOS.get(row.photo_key) : null;
      if (!row || !obj) return fail(c, 400, "invalid_photo");
      const type = row.photo_type as DecodedImage["contentType"];
      images.push({ bytes: new Uint8Array(await obj.arrayBuffer()), contentType: type, ext: type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg" });
    }
  }
  let courseName = "";
  if (v.courseId != null) {
    const course = await c.env.DB.prepare("SELECT name FROM courses WHERE id = ?").bind(v.courseId).first<{ name: string }>();
    if (!course) return fail(c, 400, "invalid_post", "courseId");
    courseName = course.name.slice(0, 120);
  }
  const blocked = (await limited(c, "lfpost:" + poster.id, 6, 3600)) ?? (await limited(c, "lfpostday:" + poster.id, 20, 86_400));
  if (blocked) return blocked;
  await ensureTrader(c.env, poster);
  const created = await c.env.DB.prepare(
    `INSERT INTO lf_posts (kind, owner_id, brand, mold, plastic, color, course_id, course_name, area, weight_g, hole, event_date, holding,
       bin_note, reward_note, private_ink, bag_disc_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${POST_DAYS} days')) RETURNING id`,
  ).bind(v.kind, poster.id, v.brand, v.mold, v.plastic, v.color, v.courseId, courseName, v.area, v.weightG, v.hole, v.eventDate, v.holding,
    v.binNote, v.rewardNote, v.privateInk, bagDiscId).first<{ id: number }>();
  const id = Number(created?.id);
  if (!id) return fail(c, 500, "server_error");
  let stored: string[] = [];
  try {
    stored = (await storePhotos(c, { ownerId: poster.id, postId: id }, images)).keys;
  } catch (error) {
    await Promise.all(stored.map((key) => c.env.PHOTOS.delete(key).catch(() => {})));
    await c.env.DB.prepare("DELETE FROM lf_photos WHERE post_id = ?").bind(id).run().catch(() => {});
    await c.env.DB.prepare("DELETE FROM lf_posts WHERE id = ?").bind(id).run().catch(() => {});
    throw error;
  }
  await logClaim(c.env, { postId: id, actorId: poster.id, action: "post", to: "open", note: v.kind });
  // The private AI read and matching happen after the response (and on the cron if the AI is unavailable).
  const job = processPost(c.env, c.ctx, id);
  try { c.ctx?.waitUntil?.(job); } catch { /* settles on its own */ }
  // A lost disc may already be up for sale: its seller (only) hears on a strong match.
  if (v.kind === "lost") queueLostCheck(c.env, c.ctx, id);
  return ok(c, { post: await postDetail(c, (await getPostRow(c.env, id))!) }, 201);
}

async function ownPost(c: MarketCtx, id: number): Promise<Row | Response> {
  if (!c.actor) return fail(c, 401, "unauthorized");
  const row = await getPostRow(c.env, id);
  if (!row || str(row, "owner_id") !== c.actor.id) return fail(c, 404, "not_found");
  return row;
}

export async function closePost(c: MarketCtx, id: number): Promise<Response> {
  const row = await ownPost(c, id);
  if (row instanceof Response) return row;
  const actor = c.actor!;
  const returning = await c.env.DB.prepare("SELECT 1 AS hit FROM lf_claims WHERE found_id = ? AND status = 'returned'").bind(id).first();
  if (returning) return fail(c, 409, "return_in_progress");
  const result = await c.env.DB.prepare(
    `UPDATE lf_posts SET status = 'closed', close_reason = 'owner', closed_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND owner_id = ? AND status IN ('open', 'claimed')`,
  ).bind(id, actor.id).run();
  if (!changed(result)) return fail(c, 409, "not_open");
  const claims = (await c.env.DB.prepare("SELECT id, owner_id FROM lf_claims WHERE found_id = ? AND status = 'open'").bind(id).all<{ id: number; owner_id: string }>()).results ?? [];
  await c.env.DB.prepare("UPDATE lf_claims SET status = 'declined', closed_at = datetime('now') WHERE found_id = ? AND status = 'open'").bind(id).run();
  await c.env.DB.prepare("UPDATE lf_matches SET status = 'dismissed', updated_at = datetime('now') WHERE (found_id = ? OR lost_id = ?) AND status IN ('suggested', 'notified')")
    .bind(id, id).run();
  await logClaim(c.env, { postId: id, actorId: actor.id, action: "close", from: str(row, "status"), to: "closed" });
  // Photos are deleted with the post.
  await purgePostPhotos(c.env, id);
  const title = postTitle(row);
  for (const claim of claims) {
    notifyPerson(c.env, c.ctx, claim.owner_id, {
      title: "Lost & Found post closed", body: `The finder closed the post for the ${title}, so your claim was closed.`,
      refKey: "lf:claim:" + claim.id + ":closed", hash: "mine",
    });
  }
  return ok(c, { post: await postDetail(c, (await getPostRow(c.env, id))!) });
}

export async function turnInPost(c: MarketCtx, id: number): Promise<Response> {
  const row = await ownPost(c, id);
  if (row instanceof Response) return row;
  if (str(row, "kind") !== "found") return fail(c, 409, "not_found_post");
  const body = (await readJson(c.request)) ?? {};
  const note = parseBinNote(body.binNote);
  if (!note) return fail(c, 400, "invalid_post", "binNote");
  const result = await c.env.DB.prepare(
    `UPDATE lf_posts SET holding = 'club_bin', bin_note = ?, updated_at = datetime('now') WHERE id = ? AND owner_id = ? AND status IN ('open', 'claimed')`,
  ).bind(note, id, c.actor!.id).run();
  if (!changed(result)) return fail(c, 409, "not_open");
  await logClaim(c.env, { postId: id, actorId: c.actor!.id, action: "turn_in", note });
  return ok(c, { post: await postDetail(c, (await getPostRow(c.env, id))!) });
}

/** The poster takes a photo down; it leaves R2 at once. */
export async function removePostPhoto(c: MarketCtx, id: number, photoId: number): Promise<Response> {
  const row = await ownPost(c, id);
  if (row instanceof Response) return row;
  const removed = await removeOwnPhoto(c, photoId, id);
  if (removed.status !== 200) return removed;
  return ok(c, { post: await postDetail(c, (await getPostRow(c.env, id))!) });
}

/** A post's photo for <img>: only while the post itself is publicly visible. */
export async function servePostOrCelebrationPhoto(c: MarketCtx, photoId: number): Promise<Response> {
  return servePhoto(c, photoId, (row) => {
    if (row.celebration_id != null) {
      return num(row, "celebration_hidden") !== 1 && num(row, "celebrated_post_hidden") !== 1 && !row.reversed;
    }
    const status = postStatus({ status: row.post_status, expires_at: row.expires_at });
    return num(row, "post_hidden") !== 1 && PUBLIC_STATUSES.includes(status);
  });
}
