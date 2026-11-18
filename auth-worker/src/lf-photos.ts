// Hiding the writing on a Lost & Found photo, done by the POSTER'S BROWSER (the Worker never decodes an image):
//
//   GET  /lost-found/photos/:id/boxes        the AI's boxes as normalised rectangles (never any text) + padding
//   GET  /lost-found/photos/:id/original     the poster's own original, only while the writing is being hidden
//   POST /lost-found/photos/:id/public-copy  the poster's copy with a solid patch over each box -> AI check
//
// All three answer only the photo's uploader; every other caller (other members, guests, the public) gets 404.
// The copy must be a JPEG, at most 1280 px, with the original's shape; it stays private until Gemini confirms no
// personal writing is legible (lf-process.ts verifyPhoto). The original is never served to anyone else.

import { corsHeaders, readJson } from "./http.js";
import { decodeLfPhoto, imageSize, sameAspect } from "./lf-image-header.js";
import { verifyPhoto } from "./lf-process.js";
import { PHOTO_BODY_BYTES } from "./market-photos.js";
import { changed, fail, limited, ok, type MarketCtx } from "./market-http.js";
import { num, str, type Row } from "./market-store.js";

export const PUBLIC_MAX_SIDE = 1280;
const HIDING = new Set(["pending", "hiding"]);

/** Patch padding the browser applies: 25% of the box (at least 2.5% of the photo), wider after each time the AI
 *  check found writing still readable. */
export function padFor(rejections: number): { pad: number; minPad: number } {
  const step = 1 + Math.max(0, Math.min(3, rejections));
  return { pad: Math.min(1, 0.25 * step), minPad: Math.min(0.1, 0.025 * step) };
}

const PHOTO_COLUMNS = `id, post_id, celebration_id, owner_id, original_key, original_type, candidate_key, width, height, redaction, rejections,
  attempts, last_error, sort_order`;

async function ownPhoto(c: MarketCtx, photoId: number): Promise<Row | Response> {
  const row = await c.env.DB.prepare(`SELECT ${PHOTO_COLUMNS} FROM lf_photos WHERE id = ?`).bind(photoId).first<Row>();
  // 404 for everyone but the uploader (including signed-out callers), so photo ids can't be probed.
  if (!row || !c.actor || str(row, "owner_id") !== c.actor.id) return fail(c, 404, "not_found");
  return row;
}

function safeBoxes(value: unknown): Array<{ x0: number; y0: number; x1: number; y1: number }> {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value || "[]")); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const round = (n: unknown) => Math.round(Math.max(0, Math.min(1, Number(n))) * 10_000) / 10_000;
  // Rectangles only: whatever else a stored item carries never leaves the Worker.
  return parsed.slice(0, 24).flatMap((box) => {
    if (!box || typeof box !== "object") return [];
    const b = box as Record<string, unknown>;
    const rect = { x0: round(b.x0), y0: round(b.y0), x1: round(b.x1), y1: round(b.y1) };
    return rect.x1 > rect.x0 && rect.y1 > rect.y0 ? [rect] : [];
  });
}

/** What the poster's page needs about one of their photos. */
export function photoView(row: Row, boxes: unknown = null) {
  const status = str(row, "redaction");
  return {
    id: num(row, "id"),
    status,
    width: num(row, "width"),
    height: num(row, "height"),
    sortOrder: num(row, "sort_order"),
    rejections: num(row, "rejections"),
    lastError: str(row, "last_error").split(":")[0],
    ...padFor(num(row, "rejections")),
    boxes: status === "hiding" ? safeBoxes(boxes) : [],
  };
}

/** The uploader's photos that still need something (or just finished), for the post page and My posts. */
export async function uploaderPhotos(c: MarketCtx, where: { postId?: number; celebrationId?: number }) {
  if (!c.actor) return [];
  const column = where.postId ? "post_id" : "celebration_id";
  const rows = (await c.env.DB.prepare(
    `SELECT ${PHOTO_COLUMNS} FROM lf_photos WHERE ${column} = ? AND owner_id = ? AND redaction <> 'removed' ORDER BY sort_order, id`,
  ).bind(where.postId ?? where.celebrationId, c.actor.id).all<Row>()).results ?? [];
  return rows.map((row) => photoView(row));
}

export async function photoBoxes(c: MarketCtx, photoId: number): Promise<Response> {
  const row = await ownPhoto(c, photoId);
  if (row instanceof Response) return row;
  const read = await c.env.DB.prepare("SELECT boxes_json FROM lf_extractions WHERE photo_id = ? AND status = 'ok'").bind(photoId)
    .first<{ boxes_json: string }>();
  return ok(c, { photo: photoView(row, read?.boxes_json ?? "[]") });
}

export async function photoOriginal(c: MarketCtx, photoId: number): Promise<Response> {
  const row = await ownPhoto(c, photoId);
  if (row instanceof Response) return row;
  if (!HIDING.has(str(row, "redaction")) || !row.original_key) return fail(c, 404, "not_found");
  const blocked = await limited(c, "lforig:" + c.actor!.id, 30, 3600);
  if (blocked) return blocked;
  const object = await c.env.PHOTOS?.get(str(row, "original_key"));
  if (!object) return fail(c, 404, "not_found");
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": str(row, "original_type"),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...corsHeaders(c.origin),
    },
  });
}

export async function uploadPublicCopy(c: MarketCtx, photoId: number): Promise<Response> {
  const row = await ownPhoto(c, photoId);
  if (row instanceof Response) return row;
  if (str(row, "redaction") !== "hiding") return fail(c, 409, "not_hiding");
  if (!c.env.PHOTOS) return fail(c, 503, "storage_unavailable");
  const blocked = await limited(c, "lfcopy:" + photoId, 12, 3600);
  if (blocked) return blocked;
  const body = (await readJson(c.request, PHOTO_BODY_BYTES)) ?? {};
  const image = decodeLfPhoto(body.image);
  // A JPEG (the browser's canvas export, so no metadata), no bigger than 1280 px, the original's shape.
  if (!image || image.contentType !== "image/jpeg") return fail(c, 400, "invalid_photo");
  const size = imageSize(image.bytes);
  if (!size || Math.max(size.width, size.height) > PUBLIC_MAX_SIDE) return fail(c, 400, "invalid_photo");
  if (!sameAspect({ width: num(row, "width"), height: num(row, "height") }, size)) return fail(c, 400, "wrong_shape");
  const key = `lost-found/candidate/${photoId}/${crypto.randomUUID()}.jpg`;
  await c.env.PHOTOS.put(key, image.bytes, { httpMetadata: { contentType: "image/jpeg" } });
  const moved = await c.env.DB.prepare(
    `UPDATE lf_photos SET redaction = 'verifying', candidate_key = ?, next_attempt_at = datetime('now'), last_error = ''
     WHERE id = ? AND owner_id = ? AND redaction = 'hiding'`,
  ).bind(key, photoId, c.actor!.id).run();
  if (!changed(moved)) {
    await c.env.PHOTOS.delete(key).catch(() => {});
    return fail(c, 409, "not_hiding");
  }
  // The AI check is a network wait, not CPU; the cron retries it if Gemini is busy.
  const job = verifyPhoto(c.env, photoId).catch(() => "skipped");
  try { c.ctx?.waitUntil?.(job); } catch { /* settles on its own */ }
  const fresh = await c.env.DB.prepare(`SELECT ${PHOTO_COLUMNS} FROM lf_photos WHERE id = ?`).bind(photoId).first<Row>();
  return ok(c, { photo: photoView(fresh!) }, 202);
}
