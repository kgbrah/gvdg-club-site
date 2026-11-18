// My Bag extras on the server (member only): private photos of your own bag discs, of the whole bag and of your
// accessories, the accessories themselves, the "check found discs against my bag" switch (on unless you turn it
// off), and which bag discs you reported lost (with their posts' status).
//
//   GET    /me/bag                  -> { matchFound, photos: [{ id, discId }], bagPhotos: [{ id }],
//                                       accessories: [{ id, kind, name, notes, photos: [id] }], lost: [{ discId, postId, status, title }] }
//   PUT    /me/bag/settings         { matchFound: boolean }
//   POST   /me/bag/photos           { discId | bag: true | accessoryId, image (data URL) } -> { photo }
//                                   (3 a disc, 6 of the whole bag, 3 an accessory)
//   GET    /me/bag/photos/:id       the image (owner only, Bearer; never cached by shared caches)
//   DELETE /me/bag/photos/:id
//   POST   /me/bag/accessories      { kind, name, notes } -> { accessory }   (up to 40)
//   PATCH  /me/bag/accessories/:id  { kind?, name?, notes? }
//   DELETE /me/bag/accessories/:id  (its photos too)
//
// Photos are validated and stripped of metadata like marketplace photos and kept in R2 under bag/<owner>/; only
// their owner can fetch them. The found-disc matcher (lf-bag-match.ts) reads them server-side.
import { requireMember } from "./authz.js";
import type { Env } from "./env.js";
import { corsHeaders, json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { decodeListingPhoto, PHOTO_BODY_BYTES } from "./market-photos.js";
import { postStatus, postTitle } from "./lf-store.js";
import type { Row } from "./market-store.js";

export const BAG_PHOTOS_PER_DISC = 3;
export const BAG_PHOTOS_OF_BAG = 6;
export const PHOTOS_PER_ACCESSORY = 3;
export const MAX_ACCESSORIES = 40;
export const ACCESSORY_KINDS = ["cart", "towel", "mini", "rangefinder", "retriever", "umbrella", "shoes", "rain_gear", "seat", "light", "other"] as const;
const SERVED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function isBagRoute(pathname: string): boolean {
  return pathname === "/me/bag" || pathname.startsWith("/me/bag/");
}

function ownerFolder(owner: string): string {
  return owner.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

/** The owner's live (not deleted) bag disc record, or null. */
export async function bagDisc(env: Env, owner: string, discId: string): Promise<Record<string, unknown> | null> {
  if (!UUID.test(discId)) return null;
  const row = await env.DB.prepare("SELECT payload FROM member_practice_records WHERE owner = ? AND id = ? AND kind = 'disc' AND payload IS NOT NULL")
    .bind(owner, discId).first<{ payload: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** "Orange Innova Star Destroyer" from a bag disc record. */
export function bagDiscLabel(record: Record<string, unknown> | null): string {
  if (!record) return "disc";
  const text = (key: string) => (typeof record[key] === "string" ? String(record[key]).trim() : "");
  return [text("color"), text("brand"), text("plastic"), text("model")].filter(Boolean).join(" ").slice(0, 120) || "disc";
}

export async function bagMatchingOn(env: Env, owner: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT match_found FROM bag_settings WHERE owner = ?").bind(owner).first<{ match_found: number }>();
  return row ? row.match_found === 1 : true;
}

function clean(value: unknown, max: number): string | null {
  if (value == null) return "";
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : null;
}

function accessoryInput(body: Record<string, unknown> | null, partial: boolean) {
  const kind = body?.kind === undefined && partial ? undefined
    : (ACCESSORY_KINDS as readonly string[]).includes(String(body?.kind)) ? String(body?.kind) : null;
  const name = body?.name === undefined && partial ? undefined : clean(body?.name, 60);
  const notes = body?.notes === undefined && partial ? undefined : clean(body?.notes, 200);
  if (kind === null || name === null || notes === null) return null;
  return { kind, name, notes };
}

async function ownAccessory(env: Env, owner: string, id: number) {
  return env.DB.prepare("SELECT id, kind, name, notes FROM bag_accessories WHERE id = ? AND owner = ?").bind(id, owner)
    .first<{ id: number; kind: string; name: string; notes: string }>();
}

async function overview(env: Env, owner: string, origin: string | null): Promise<Response> {
  const [photos, lost, matchFound, accessories] = await Promise.all([
    env.DB.prepare("SELECT id, disc_id, subject FROM bag_photos WHERE owner = ? ORDER BY id").bind(owner).all<{ id: number; disc_id: string; subject: string }>(),
    env.DB.prepare(
      `SELECT id, bag_disc_id, status, expires_at, brand, plastic, mold, color FROM lf_posts
       WHERE owner_id = ? AND kind = 'lost' AND bag_disc_id IS NOT NULL AND status <> 'merged' ORDER BY id DESC LIMIT 200`,
    ).bind(owner).all<Row>(),
    bagMatchingOn(env, owner),
    env.DB.prepare("SELECT id, kind, name, notes FROM bag_accessories WHERE owner = ? ORDER BY id").bind(owner)
      .all<{ id: number; kind: string; name: string; notes: string }>(),
  ]);
  const photoRows = photos.results ?? [];
  const latest = new Map<string, Row>();
  for (const row of lost.results ?? []) if (!latest.has(String(row.bag_disc_id))) latest.set(String(row.bag_disc_id), row);
  return json({
    matchFound,
    photos: photoRows.filter((row) => row.subject === "disc").map((row) => ({ id: row.id, discId: row.disc_id })),
    bagPhotos: photoRows.filter((row) => row.subject === "bag").map((row) => ({ id: row.id })),
    accessories: (accessories.results ?? []).map((row) => ({
      id: row.id, kind: row.kind, name: row.name, notes: row.notes,
      photos: photoRows.filter((photo) => photo.subject === "accessory" && photo.disc_id === "acc-" + row.id).map((photo) => photo.id),
    })),
    lost: [...latest.values()].map((row) => ({ discId: String(row.bag_disc_id), postId: Number(row.id), status: postStatus(row), title: postTitle(row) })),
  }, 200, origin);
}

async function addPhoto(request: Request, env: Env, owner: string, origin: string | null): Promise<Response> {
  if (!env.PHOTOS) return json({ error: "photos_unavailable" }, 503, origin);
  const body = await readJson(request, PHOTO_BODY_BYTES);
  // What the photo shows: one of your bag discs, the whole bag, or one of your accessories.
  let subject: "disc" | "bag" | "accessory";
  let itemId: string;
  let max: number;
  if (body?.bag === true) {
    subject = "bag"; itemId = "bag"; max = BAG_PHOTOS_OF_BAG;
  } else if (body?.accessoryId != null) {
    const accessory = Number.isInteger(body.accessoryId) ? await ownAccessory(env, owner, Number(body.accessoryId)) : null;
    if (!accessory) return json({ error: "not_found" }, 404, origin);
    subject = "accessory"; itemId = "acc-" + accessory.id; max = PHOTOS_PER_ACCESSORY;
  } else {
    const discId = typeof body?.discId === "string" ? body.discId : "";
    if (!(await bagDisc(env, owner, discId))) return json({ error: "not_found" }, 404, origin);
    subject = "disc"; itemId = discId; max = BAG_PHOTOS_PER_DISC;
  }
  const image = decodeListingPhoto(body?.image);
  if (!image) return json({ error: "invalid_photo" }, 400, origin);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM bag_photos WHERE owner = ? AND subject = ? AND disc_id = ?")
    .bind(owner, subject, itemId).first<{ n: number }>();
  if ((count?.n ?? 0) >= max) return json({ error: "too_many_photos" }, 409, origin);
  if (await kvRateLimited(env, "bagphoto:" + owner, 30, 3600)) return json({ error: "rate_limited" }, 429, origin);
  const key = `bag/${ownerFolder(owner)}/${itemId}/${crypto.randomUUID()}.${image.ext}`;
  await env.PHOTOS.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
  const row = await env.DB.prepare("INSERT INTO bag_photos (owner, disc_id, subject, photo_key, photo_type, photo_bytes) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(owner, itemId, subject, key, image.contentType, image.bytes.length).first<{ id: number }>();
  const photo: Record<string, unknown> = { id: Number(row?.id), subject };
  if (subject === "disc") photo.discId = itemId;
  if (subject === "accessory") photo.accessoryId = Number(itemId.slice(4));
  return json({ photo }, 201, origin);
}

async function ownPhoto(env: Env, owner: string, id: number) {
  return env.DB.prepare("SELECT id, photo_key, photo_type FROM bag_photos WHERE id = ? AND owner = ?").bind(id, owner)
    .first<{ id: number; photo_key: string; photo_type: string }>();
}

async function servePhoto(env: Env, owner: string, id: number, origin: string | null): Promise<Response> {
  const row = await ownPhoto(env, owner, id);
  if (!row || !SERVED_TYPES.has(row.photo_type)) return json({ error: "not_found" }, 404, origin);
  const obj = await env.PHOTOS?.get(row.photo_key);
  if (!obj) return json({ error: "not_found" }, 404, origin);
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": row.photo_type,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...corsHeaders(origin),
    },
  });
}

async function removePhoto(env: Env, owner: string, id: number, origin: string | null): Promise<Response> {
  const row = await ownPhoto(env, owner, id);
  if (!row) return json({ error: "not_found" }, 404, origin);
  await env.DB.prepare("DELETE FROM bag_photos WHERE id = ? AND owner = ?").bind(id, owner).run();
  await env.PHOTOS?.delete(row.photo_key).catch(() => {});
  return json({ ok: true }, 200, origin);
}

export async function handleBag(request: Request, env: Env, origin: string | null, pathname: string, method: string): Promise<Response | null> {
  if (!isBagRoute(pathname)) return null;
  const who = await requireMember(request, env, origin);
  if (who instanceof Response) return who;
  const owner = who.sub;
  const seg = pathname.split("/").filter(Boolean); // ["me", "bag", ...]
  if (seg.length === 2 && method === "GET") return overview(env, owner, origin);
  if (seg.length === 3 && seg[2] === "settings" && method === "PUT") {
    const body = await readJson(request);
    if (typeof body?.matchFound !== "boolean") return json({ error: "invalid_request" }, 400, origin);
    await env.DB.prepare(
      `INSERT INTO bag_settings (owner, match_found, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(owner) DO UPDATE SET match_found = excluded.match_found, updated_at = excluded.updated_at`,
    ).bind(owner, body.matchFound ? 1 : 0).run();
    return json({ matchFound: body.matchFound }, 200, origin);
  }
  if (seg.length === 3 && seg[2] === "photos" && method === "POST") return addPhoto(request, env, owner, origin);
  if (seg.length === 3 && seg[2] === "accessories" && method === "POST") {
    const input = accessoryInput(await readJson(request), false);
    if (!input) return json({ error: "invalid_request" }, 400, origin);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM bag_accessories WHERE owner = ?").bind(owner).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_ACCESSORIES) return json({ error: "too_many_accessories" }, 409, origin);
    const row = await env.DB.prepare("INSERT INTO bag_accessories (owner, kind, name, notes) VALUES (?, ?, ?, ?) RETURNING id, kind, name, notes")
      .bind(owner, input.kind, input.name, input.notes).first<{ id: number; kind: string; name: string; notes: string }>();
    return json({ accessory: { ...row, photos: [] } }, 201, origin);
  }
  if (seg.length === 4 && seg[2] === "accessories" && /^\d{1,12}$/.test(seg[3] ?? "")) {
    const existing = await ownAccessory(env, owner, Number(seg[3]));
    if (!existing) return json({ error: "not_found" }, 404, origin);
    if (method === "PATCH") {
      const input = accessoryInput(await readJson(request), true);
      if (!input) return json({ error: "invalid_request" }, 400, origin);
      const next = { kind: input.kind ?? existing.kind, name: input.name ?? existing.name, notes: input.notes ?? existing.notes };
      await env.DB.prepare("UPDATE bag_accessories SET kind = ?, name = ?, notes = ?, updated_at = datetime('now') WHERE id = ? AND owner = ?")
        .bind(next.kind, next.name, next.notes, existing.id, owner).run();
      return json({ accessory: { id: existing.id, ...next } }, 200, origin);
    }
    if (method === "DELETE") {
      const rows = (await env.DB.prepare("SELECT id, photo_key FROM bag_photos WHERE owner = ? AND subject = 'accessory' AND disc_id = ?")
        .bind(owner, "acc-" + existing.id).all<{ id: number; photo_key: string }>()).results ?? [];
      await env.DB.prepare("DELETE FROM bag_photos WHERE owner = ? AND subject = 'accessory' AND disc_id = ?").bind(owner, "acc-" + existing.id).run();
      await env.DB.prepare("DELETE FROM bag_accessories WHERE id = ? AND owner = ?").bind(existing.id, owner).run();
      await Promise.all(rows.map((row) => env.PHOTOS?.delete(row.photo_key).catch(() => {})));
      return json({ ok: true }, 200, origin);
    }
  }
  if (seg.length === 4 && seg[2] === "photos" && /^\d{1,12}$/.test(seg[3] ?? "")) {
    const id = Number(seg[3]);
    if (method === "GET") return servePhoto(env, owner, id, origin);
    if (method === "DELETE") return removePhoto(env, owner, id, origin);
  }
  return json({ error: "not_found" }, 404, origin);
}

/** Cron: photos whose bag disc was deleted (a few a tick). */
export async function sweepBagPhotos(env: Env, limit = 20): Promise<number> {
  const rows = (await env.DB.prepare(
    `SELECT b.id, b.photo_key FROM bag_photos b LEFT JOIN member_practice_records r ON r.owner = b.owner AND r.id = b.disc_id AND r.kind = 'disc'
     WHERE b.subject = 'disc' AND (r.id IS NULL OR r.payload IS NULL) LIMIT ?`,
  ).bind(limit).all<{ id: number; photo_key: string }>()).results ?? [];
  for (const row of rows) {
    await env.DB.prepare("DELETE FROM bag_photos WHERE id = ?").bind(row.id).run();
    await env.PHOTOS?.delete(row.photo_key).catch(() => {});
  }
  return rows.length;
}
