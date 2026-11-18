// Lost & Found photos. A photo is PUBLIC as uploaded: the data URL must be a real JPEG / PNG / WebP (magic bytes),
// within the size cap, and loses its EXIF / XMP / location metadata at the byte level (market-photos.ts). Posters
// are asked to cover names and phone numbers themselves. The Worker never decodes an image.
//
// The private AI read (lf-process.ts) may set a NUDGE on a photo: its uploader, and only its uploader, sees "this
// photo may show a name or phone number" with Replace photo / Keep it. Nobody is ever told what was read.
//
//   POST /lost-found/photos/:id/keep      uploader: keep the photo as it is (the nudge goes away)
//   POST /lost-found/photos/:id/replace   uploader: a new upload takes its place; the old file leaves R2 at once
//   POST /lost-found/photos/:id/remove    uploader: take the photo down
// Anyone else (other members, guests, signed out) gets 404 on all three.

import { corsHeaders, readJson } from "./http.js";
import { logClaim, photoUrl } from "./lf-store.js";
import { processCelebration, processPost } from "./lf-process.js";
import { decodeListingPhoto, PHOTO_BODY_BYTES } from "./market-photos.js";
import { changed, fail, limited, ok, type MarketCtx } from "./market-http.js";
import type { Row } from "./market-store.js";
import type { DecodedImage } from "./photos.js";

const SERVED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Photos from a request body: between min and max, each a valid, metadata-stripped image. null = bad input. */
export function photosFrom(value: unknown, min: number, max: number): DecodedImage[] | null {
  if (value == null && min === 0) return [];
  if (!Array.isArray(value) || value.length < min || value.length > max) return null;
  const images = value.map((item) => decodeListingPhoto(item));
  return images.every(Boolean) ? images.map((image) => image!) : null;
}

export interface PhotoOwner { ownerId: string; postId?: number; celebrationId?: number }

/** Store photos under server-chosen keys and record them (read_state 'pending' for the private AI read). Returns the
 *  R2 keys written, for rollback. */
export async function storePhotos(c: MarketCtx, owner: PhotoOwner, images: DecodedImage[], firstSort = 0): Promise<{ keys: string[]; ids: number[] }> {
  const keys: string[] = [];
  const ids: number[] = [];
  const folder = owner.postId ? "post-" + owner.postId : "celebration-" + owner.celebrationId;
  for (const [index, image] of images.entries()) {
    const key = `lost-found/${folder}/${crypto.randomUUID()}.${image.ext}`;
    await c.env.PHOTOS.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
    keys.push(key);
    const row = await c.env.DB.prepare(
      `INSERT INTO lf_photos (post_id, celebration_id, owner_id, photo_key, photo_type, photo_bytes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(owner.postId ?? null, owner.celebrationId ?? null, owner.ownerId, key, image.contentType, image.bytes.length, firstSort + index)
      .first<{ id: number }>();
    ids.push(Number(row?.id) || 0);
  }
  return { keys, ids };
}

/** The uploader's own view of their photos: the public URL and whether to show the nudge. Never what was read. */
export async function ownPhotos(c: MarketCtx, where: { postId?: number; celebrationId?: number }) {
  if (!c.actor) return [];
  const column = where.postId ? "post_id" : "celebration_id";
  const rows = (await c.env.DB.prepare(
    `SELECT id, nudge FROM lf_photos WHERE ${column} = ? AND owner_id = ? AND status = 'public' ORDER BY sort_order, id`,
  ).bind(where.postId ?? where.celebrationId, c.actor.id).all<{ id: number; nudge: string }>()).results ?? [];
  return rows.map((row) => ({ id: row.id, url: photoUrl(row.id), nudge: row.nudge === "shown" }));
}

interface OwnPhotoRow { id: number; post_id: number | null; celebration_id: number | null; photo_key: string | null; nudge: string; sort_order: number }

/** The caller's own, still-public photo, on a post that is still up (or a celebration). Anyone else: null (404). */
async function ownPhoto(c: MarketCtx, photoId: number): Promise<OwnPhotoRow | null> {
  if (!c.actor) return null;
  return c.env.DB.prepare(
    `SELECT ph.id, ph.post_id, ph.celebration_id, ph.photo_key, ph.nudge, ph.sort_order FROM lf_photos ph LEFT JOIN lf_posts p ON p.id = ph.post_id
     WHERE ph.id = ? AND ph.owner_id = ? AND ph.status = 'public' AND (ph.post_id IS NULL OR p.status IN ('open', 'claimed', 'returned'))`,
  ).bind(photoId, c.actor.id).first<OwnPhotoRow>();
}

export async function keepPhoto(c: MarketCtx, photoId: number): Promise<Response> {
  const photo = await ownPhoto(c, photoId);
  if (!photo) return fail(c, 404, "not_found");
  const result = await c.env.DB.prepare("UPDATE lf_photos SET nudge = 'kept' WHERE id = ? AND owner_id = ? AND nudge = 'shown'")
    .bind(photoId, c.actor!.id).run();
  if (!changed(result)) return fail(c, 409, "nothing_to_keep");
  return ok(c, { photo: { id: photoId, url: photoUrl(photoId), nudge: false } });
}

export async function removeOwnPhoto(c: MarketCtx, photoId: number, postId?: number): Promise<Response> {
  const photo = await ownPhoto(c, photoId);
  if (!photo || (postId != null && photo.post_id !== postId)) return fail(c, 404, "not_found");
  const result = await c.env.DB.prepare("UPDATE lf_photos SET status = 'removed', photo_key = NULL WHERE id = ? AND status = 'public'").bind(photoId).run();
  if (!changed(result)) return fail(c, 404, "not_found");
  if (photo.photo_key) await c.env.PHOTOS?.delete(photo.photo_key);
  await logClaim(c.env, { postId: photo.post_id, actorId: c.actor!.id, action: "photo_remove", note: "photo " + photoId });
  return ok(c, { ok: true });
}

/** A new upload takes the photo's place (same position). The old file is deleted from R2 straight away. The old
 *  photo's private read stays with the post (the writing on the disc still helps find its owner); the new photo
 *  is read too, so the nudge comes back only if a name or number still shows. */
export async function replacePhoto(c: MarketCtx, photoId: number): Promise<Response> {
  const photo = await ownPhoto(c, photoId);
  if (!photo) return fail(c, 404, "not_found");
  if (!c.env.PHOTOS) return fail(c, 503, "storage_unavailable");
  const body = (await readJson(c.request, PHOTO_BODY_BYTES)) ?? {};
  const image = decodeListingPhoto(body.image);
  if (!image) return fail(c, 400, "invalid_photo");
  const blocked = await limited(c, "lfreplace:" + c.actor!.id, 12, 3600);
  if (blocked) return blocked;
  // The new photo is stored first, so a failure part-way never leaves the post without its photo.
  const owner = photo.post_id != null ? { ownerId: c.actor!.id, postId: photo.post_id } : { ownerId: c.actor!.id, celebrationId: photo.celebration_id! };
  const { keys, ids } = await storePhotos(c, owner, [image], photo.sort_order);
  const newId = ids[0]!;
  const taken = await c.env.DB.prepare("UPDATE lf_photos SET status = 'removed', photo_key = NULL WHERE id = ? AND status = 'public'").bind(photoId).run();
  if (!changed(taken)) {
    // Someone (or another tab) took the old photo down meanwhile: undo the new one.
    await c.env.DB.prepare("UPDATE lf_photos SET status = 'removed', photo_key = NULL WHERE id = ?").bind(newId).run();
    await Promise.all(keys.map((key) => c.env.PHOTOS.delete(key).catch(() => {})));
    return fail(c, 404, "not_found");
  }
  if (photo.photo_key) await c.env.PHOTOS.delete(photo.photo_key);
  await logClaim(c.env, { postId: photo.post_id, actorId: c.actor!.id, action: "photo_replace", note: `photo ${photoId} -> ${newId}` });
  const job = photo.post_id != null ? processPost(c.env, c.ctx, photo.post_id) : processCelebration(c.env, photo.celebration_id!);
  try { c.ctx?.waitUntil?.(job); } catch { /* settles on its own */ }
  return ok(c, { photo: { id: newId, url: photoUrl(newId), nudge: false }, replaced: photoId }, 201);
}

/** GET /lost-found/photos/:id for <img>: only while the photo is up and its post or celebration is public. */
export async function servePhoto(c: MarketCtx, photoId: number, visible: (row: Row) => boolean): Promise<Response> {
  const row = await c.env.DB.prepare(
    `SELECT ph.photo_key, ph.photo_type, ph.status, p.status AS post_status, p.hidden AS post_hidden, p.expires_at,
            e.hidden AS celebration_hidden, e.id AS celebration_id, cp.hidden AS celebrated_post_hidden,
            (SELECT 1 FROM lf_karma k WHERE k.claim_id = e.claim_id AND k.reason = 'admin_reversal') AS reversed
     FROM lf_photos ph LEFT JOIN lf_posts p ON p.id = ph.post_id LEFT JOIN lf_celebrations e ON e.id = ph.celebration_id
       LEFT JOIN lf_claims cc ON cc.id = e.claim_id LEFT JOIN lf_posts cp ON cp.id = cc.found_id
     WHERE ph.id = ?`,
  ).bind(photoId).first<Row>();
  if (!row || row.status !== "public" || !row.photo_key || !SERVED_TYPES.has(String(row.photo_type)) || !visible(row)) return fail(c, 404, "not_found");
  const obj = await c.env.PHOTOS?.get(String(row.photo_key));
  if (!obj) return fail(c, 404, "not_found");
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": String(row.photo_type),
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...corsHeaders(c.origin),
    },
  });
}
