// Marketplace listings: browse, detail, create / edit / withdraw (members only), photos and seller
// payment settings.

import { corsHeaders, readJson } from "./http.js";
import { DISC_TYPES, ITEM_KINDS, MAX_PHOTOS, listingTitle, parseEmail, parseListing, parseSettings, type ItemKind } from "./market-input.js";
import { bagDisc } from "./bag-routes.js";
import type { DecodedImage } from "./photos.js";
import { marketUrl, notifyTrader, sendMarketEmail } from "./market-notify.js";
import { decodeListingPhoto, listingPhotoKey, LISTING_BODY_BYTES, PHOTO_BODY_BYTES } from "./market-photos.js";
import { queueListingCheck } from "./market-lost-check.js";
import {
  DEAL_COLUMNS, OFFER_COLUMNS, dealViews, ensureTrader, getListingRow, isSuspended, listingCards, listingPhotos,
  logDeal, num, offerViews, ownerByKey, payInfo, publicPhoto, RELIST_WINDOW_HOURS, sellerSettings, str, type Actor, type Row, viewerOf,
  LISTING_COLUMNS,
} from "./market-store.js";
import { changed, fail, limited, ok, requireListingSeller, requireSeller, type MarketCtx } from "./market-http.js";

const PAGE = 24;
const NOT_SUSPENDED = (column: string) =>
  `NOT EXISTS (SELECT 1 FROM market_suspensions s WHERE s.owner_id = ${column} AND s.lifted_at IS NULL)`;

function likeTerm(value: string): string {
  return "%" + value.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%";
}

function intParam(p: URLSearchParams, key: string, min: number, max: number): number | null {
  const raw = p.get(key);
  if (raw == null || !/^\d{1,6}$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

const SORTS: Record<string, string> = {
  newest: "l.created_at DESC, l.id DESC",
  price_asc: "l.price_cents IS NULL, l.price_cents ASC, l.id DESC",
  price_desc: "l.price_cents IS NULL, l.price_cents DESC, l.id DESC",
  condition: "l.condition DESC, l.created_at DESC, l.id DESC",
};

/** Whether a viewer may see a listing at all (detail, photos). Sellers and admins always can. */
export async function listingVisible(c: MarketCtx, row: Row): Promise<boolean> {
  const sellerId = str(row, "seller_id");
  if (c.actor && (c.actor.id === sellerId || c.actor.isAdmin)) return true;
  if (num(row, "hidden") === 1 || str(row, "status") === "withdrawn") return false;
  return !(await isSuspended(c.env, sellerId));
}

export async function browseListings(c: MarketCtx): Promise<Response> {
  const p = new URL(c.request.url).searchParams;
  const where = ["l.status IN ('active', 'pending')", "l.hidden = 0", NOT_SUSPENDED("l.seller_id")];
  const binds: unknown[] = [];
  const kind = p.get("kind");
  if (kind && (ITEM_KINDS as readonly string[]).includes(kind)) { where.push("l.item_kind = ?"); binds.push(kind); }
  const type = p.get("type");
  if (type && (DISC_TYPES as readonly string[]).includes(type)) { where.push("l.disc_type = ?"); binds.push(type); }
  const brand = (p.get("brand") || "").trim();
  if (brand && brand.length <= 40) { where.push("l.brand = ? COLLATE NOCASE"); binds.push(brand); }
  const plastic = (p.get("plastic") || "").trim();
  if (plastic && plastic.length <= 40) { where.push("l.plastic LIKE ? ESCAPE '\\'"); binds.push(likeTerm(plastic)); }
  const q = (p.get("q") || "").trim();
  if (q && q.length <= 60) {
    where.push("(l.brand LIKE ? ESCAPE '\\' OR l.mold LIKE ? ESCAPE '\\' OR l.plastic LIKE ? ESCAPE '\\' OR l.color LIKE ? ESCAPE '\\')");
    const term = likeTerm(q);
    binds.push(term, term, term, term);
  }
  const wmin = intParam(p, "wmin", 100, 200);
  if (wmin != null) { where.push("l.weight_g >= ?"); binds.push(wmin); }
  const wmax = intParam(p, "wmax", 100, 200);
  if (wmax != null) { where.push("l.weight_g <= ?"); binds.push(wmax); }
  const cond = intParam(p, "cond", 1, 10);
  if (cond != null) { where.push("l.condition >= ?"); binds.push(cond); }
  const pmin = intParam(p, "pmin", 0, 1000);
  if (pmin != null) { where.push("l.price_cents >= ?"); binds.push(pmin * 100); }
  const pmax = intParam(p, "pmax", 0, 1000);
  if (pmax != null) { where.push("l.price_cents <= ?"); binds.push(pmax * 100); }
  if (p.get("trade") === "1") where.push("l.open_to_trade = 1");
  const sellerKey = (p.get("seller") || "").trim();
  if (sellerKey) {
    const owner = await ownerByKey(c.env, sellerKey);
    where.push("l.seller_id = ?");
    binds.push(owner?.ownerId ?? "-");
  }
  const order = SORTS[p.get("sort") || "newest"] ?? SORTS.newest!;
  const offset = intParam(p, "offset", 0, 5000) ?? 0;
  const rows = (await c.env.DB.prepare(
    `SELECT ${LISTING_COLUMNS} FROM market_listings l WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${PAGE + 1} OFFSET ?`,
  ).bind(...binds, offset).all<Row>()).results ?? [];
  const [brands, plastics, viewer] = await Promise.all([
    c.env.DB.prepare(
      `SELECT DISTINCT brand AS v FROM market_listings WHERE status IN ('active', 'pending') AND hidden = 0 AND brand <> ''
       ORDER BY brand COLLATE NOCASE LIMIT 80`,
    ).all<{ v: string }>(),
    c.env.DB.prepare(
      `SELECT DISTINCT plastic AS v FROM market_listings WHERE status IN ('active', 'pending') AND hidden = 0 AND plastic <> ''
       ORDER BY plastic COLLATE NOCASE LIMIT 80`,
    ).all<{ v: string }>(),
    viewerOf(c.env, c.actor),
  ]);
  return ok(c, {
    listings: await listingCards(c.env, rows.slice(0, PAGE), c.actor?.id ?? null),
    more: rows.length > PAGE,
    facets: { brands: (brands.results ?? []).map((row) => row.v), plastics: (plastics.results ?? []).map((row) => row.v) },
    viewer,
  });
}

export async function listingDetail(c: MarketCtx, row: Row) {
  const env = c.env;
  const actor = c.actor;
  const id = num(row, "id");
  const sellerId = str(row, "seller_id");
  const [card] = await listingCards(env, [row], actor?.id ?? null);
  const isSeller = actor?.id === sellerId;
  const suspendedViewer = actor ? await isSuspended(env, actor.id) : false;
  const status = card!.status;
  const live = status === "active" || status === "pending";
  const pendingRow = status === "pending"
    ? await env.DB.prepare(`SELECT ${DEAL_COLUMNS} FROM market_deals d WHERE d.listing_id = ? AND d.status = 'pending'`).bind(id).first<Row>()
    : null;
  const viewerDeal = pendingRow && actor && (str(pendingRow, "buyer_id") === actor.id || isSeller)
    ? (await dealViews(env, [pendingRow], actor.id, suspendedViewer))[0] ?? null
    : null;
  const offerRows = isSeller
    ? (await env.DB.prepare(`SELECT ${OFFER_COLUMNS} FROM market_offers o JOIN market_listings l ON l.id = o.listing_id
        WHERE o.listing_id = ? AND o.status = 'open' ORDER BY o.id`).bind(id).all<Row>()).results ?? []
    : [];
  const myOfferRow = actor && !isSeller
    ? await env.DB.prepare(`SELECT ${OFFER_COLUMNS} FROM market_offers o JOIN market_listings l ON l.id = o.listing_id
        WHERE o.listing_id = ? AND o.buyer_id = ? AND o.status = 'open'`).bind(id, actor.id).first<Row>()
    : null;
  const priced = card!.priceCents != null;
  return {
    ...card!,
    flight: [row.speed, row.glide, row.turn, row.fade].some((v) => v != null)
      ? { speed: row.speed ?? null, glide: row.glide ?? null, turn: row.turn ?? null, fade: row.fade ?? null }
      : null,
    conditionNotes: str(row, "condition_notes"),
    tradeFor: str(row, "trade_for"),
    photos: await listingPhotos(env, id),
    seller: { ...card!.seller, photo: await publicPhoto(env, sellerId) },
    payLocked: !actor,
    pay: actor && status === "active" && priced && !card!.hidden ? await payInfo(env, sellerId, card!.priceCents) : null,
    canBuy: status === "active" && priced && !isSeller && !suspendedViewer && !card!.hidden,
    canOffer: status === "active" && card!.openToTrade && !isSeller && !suspendedViewer && !myOfferRow && !card!.hidden,
    canEdit: isSeller && status === "active",
    canRelist: isSeller && card!.relistUntil != null && !suspendedViewer,
    canReport: !isSeller && !suspendedViewer,
    myDeal: viewerDeal && viewerDeal.role === "buyer" ? viewerDeal : null,
    pendingDeal: viewerDeal && viewerDeal.role === "seller" ? viewerDeal : null,
    offers: await offerViews(env, offerRows),
    myOffer: myOfferRow ? (await offerViews(env, [myOfferRow]))[0] ?? null : null,
  };
}

export async function getListing(c: MarketCtx, id: number): Promise<Response> {
  const row = await getListingRow(c.env, id);
  if (!row || !(await listingVisible(c, row))) return fail(c, 404, "not_found");
  return ok(c, { listing: await listingDetail(c, row), viewer: await viewerOf(c.env, c.actor) });
}

/** Photos uploaded with the listing (may be none when photos come from My Bag). */
function photosFrom(body: Record<string, unknown>): DecodedImage[] | null {
  if (body.photos == null) return [];
  if (!Array.isArray(body.photos) || body.photos.length > MAX_PHOTOS) return null;
  const images = body.photos.map((item) => decodeListingPhoto(item));
  return images.every(Boolean) ? images.map((image) => image!) : null;
}

const BAG_REF = /^(?:disc:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|bag|accessory:[1-9]\d{0,9})$/;

/**
 * "Sell this" from My Bag: the seller's own bag item (a disc, the bag, or an accessory, matching what the listing
 * sells) and the bag photos they kept on the form. The photos are copied, so the bag keeps its private originals;
 * bag photos were already checked and stripped of metadata when they were added to the bag.
 */
async function bagSource(c: MarketCtx, sellerId: string, body: Record<string, unknown>, itemKind: ItemKind)
  : Promise<{ ref: string | null; images: DecodedImage[] } | Response> {
  if (body.bagRef == null || body.bagRef === "") return { ref: null, images: [] };
  const ref = typeof body.bagRef === "string" && BAG_REF.test(body.bagRef) ? body.bagRef : "";
  const [subject, id = ""] = ref.split(":");
  let item = "";
  if (subject === "disc" && itemKind === "disc" && (await bagDisc(c.env, sellerId, id))) item = id;
  else if (subject === "bag" && itemKind === "bag") item = "bag";
  else if (subject === "accessory" && itemKind === "accessory"
    && (await c.env.DB.prepare("SELECT 1 AS hit FROM bag_accessories WHERE id = ? AND owner = ?").bind(Number(id), sellerId).first())) {
    item = "acc-" + id;
  }
  if (!item) return fail(c, 400, "invalid_listing", "bagRef");
  const wanted: unknown[] = Array.isArray(body.bagPhotoIds) ? body.bagPhotoIds : [];
  if (wanted.length > MAX_PHOTOS || new Set(wanted).size !== wanted.length || !wanted.every((value) => Number.isInteger(value) && Number(value) > 0)) {
    return fail(c, 400, "invalid_photo");
  }
  const images: DecodedImage[] = [];
  for (const photoId of wanted) {
    const row = await c.env.DB.prepare("SELECT photo_key, photo_type FROM bag_photos WHERE id = ? AND owner = ? AND subject = ? AND disc_id = ?")
      .bind(photoId, sellerId, subject, item).first<{ photo_key: string; photo_type: string }>();
    const obj = row ? await c.env.PHOTOS.get(row.photo_key) : null;
    if (!row || !obj) return fail(c, 400, "invalid_photo");
    const type = row.photo_type as DecodedImage["contentType"];
    images.push({ bytes: new Uint8Array(await obj.arrayBuffer()), contentType: type, ext: type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg" });
  }
  return { ref, images };
}

export async function createListing(c: MarketCtx): Promise<Response> {
  const seller = await requireListingSeller(c);
  if (seller instanceof Response) return seller;
  if (!c.env.PHOTOS) return fail(c, 503, "storage_unavailable");
  // Buyer alerts go to the seller's email, so a member must add one before listing (never shown publicly).
  if (!parseEmail((await sellerSettings(c.env, seller.id))?.notifyEmail ?? "", 120)) return fail(c, 400, "seller_email_required");
  const body = (await readJson(c.request, LISTING_BODY_BYTES)) ?? {};
  const parsed = parseListing(body);
  if (!parsed.ok) return fail(c, 400, "invalid_listing", parsed.field);
  const uploaded = photosFrom(body);
  if (!uploaded) return fail(c, 400, "invalid_photo");
  const blocked = await limited(c, "mktlist:" + seller.id, 10, 3600);
  if (blocked) return blocked;
  const v = parsed.value;
  const source = await bagSource(c, seller.id, body, v.itemKind);
  if (source instanceof Response) return source;
  // Bag photos first (as the form shows them), then any taken for the listing: one to four in all.
  const images = [...source.images, ...uploaded];
  if (images.length < 1 || images.length > MAX_PHOTOS) return fail(c, 400, "invalid_photo");
  await ensureTrader(c.env, seller);
  const created = await c.env.DB.prepare(
    `INSERT INTO market_listings (seller_id, item_kind, gear_type, bag_ref, brand, mold, plastic, disc_type, speed, glide, turn, fade, weight_g,
       color, condition, condition_notes, price_cents, open_to_trade, trade_for, quantity, location, donate_percent, donate_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(seller.id, v.itemKind, v.gearType, source.ref, v.brand, v.mold, v.plastic, v.discType, v.speed, v.glide, v.turn, v.fade, v.weightG,
    v.color, v.condition, v.conditionNotes, v.priceCents, v.openToTrade ? 1 : 0, v.tradeFor, v.quantity, v.location, v.donatePercent, v.donateCents)
    .first<{ id: number }>();
  const id = Number(created?.id);
  if (!id) return fail(c, 500, "server_error");
  const stored: string[] = [];
  try {
    for (const [index, image] of images.entries()) {
      const key = listingPhotoKey(id, image.ext, crypto.randomUUID());
      await c.env.PHOTOS.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
      stored.push(key);
      await c.env.DB.prepare(
        "INSERT INTO market_listing_photos (listing_id, r2_key, content_type, bytes, sort_order) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, key, image.contentType, image.bytes.length, index).run();
    }
  } catch (error) {
    await Promise.all(stored.map((key) => c.env.PHOTOS.delete(key).catch(() => {})));
    await c.env.DB.prepare("DELETE FROM market_listing_photos WHERE listing_id = ?").bind(id).run().catch(() => {});
    await c.env.DB.prepare("DELETE FROM market_listings WHERE id = ?").bind(id).run().catch(() => {});
    throw error;
  }
  await logDeal(c.env, { listingId: id, actorId: seller.id, action: "list", to: "active" });
  // Privately: could this be a disc someone reported lost? Only the seller hears, and only on a strong match.
  queueListingCheck(c.env, c.ctx, id);
  const row = await getListingRow(c.env, id);
  return ok(c, { listing: await listingDetail(c, row!) }, 201);
}

function inputOf(row: Row): Record<string, unknown> {
  return {
    itemKind: str(row, "item_kind") || "disc", gearType: str(row, "gear_type"), brand: str(row, "brand"), mold: str(row, "mold"), plastic: str(row, "plastic"), discType: str(row, "disc_type"),
    speed: row.speed, glide: row.glide, turn: row.turn, fade: row.fade, weightG: row.weight_g, color: str(row, "color"),
    condition: row.condition, conditionNotes: str(row, "condition_notes"), priceCents: row.price_cents,
    openToTrade: num(row, "open_to_trade") === 1, tradeFor: str(row, "trade_for"), quantity: row.quantity, location: str(row, "location"),
    donatePercent: row.donate_percent ?? null, donateCents: row.donate_cents ?? null,
  };
}

async function ownListing(c: MarketCtx, seller: Actor, id: number): Promise<Row | Response> {
  const row = await getListingRow(c.env, id);
  if (!row) return fail(c, 404, "not_found");
  if (str(row, "seller_id") !== seller.id) return fail(c, 404, "not_found");
  return row;
}

export async function editListing(c: MarketCtx, id: number): Promise<Response> {
  const seller = await requireSeller(c);
  if (seller instanceof Response) return seller;
  const row = await ownListing(c, seller, id);
  if (row instanceof Response) return row;
  if (str(row, "status") !== "active") return fail(c, 409, "not_active");
  const body = (await readJson(c.request)) ?? {};
  const merged: Record<string, unknown> = inputOf(row);
  for (const key of Object.keys(merged)) if (key in body) merged[key] = body[key];
  // What a listing sells is fixed once it's listed (a disc stays a disc).
  merged.itemKind = str(row, "item_kind") || "disc";
  const parsed = parseListing(merged);
  if (!parsed.ok) return fail(c, 400, "invalid_listing", parsed.field);
  const v = parsed.value;
  const result = await c.env.DB.prepare(
    `UPDATE market_listings SET gear_type = ?, brand = ?, mold = ?, plastic = ?, disc_type = ?, speed = ?, glide = ?, turn = ?, fade = ?,
       weight_g = ?, color = ?, condition = ?, condition_notes = ?, price_cents = ?, open_to_trade = ?, trade_for = ?, quantity = ?,
       location = ?, donate_percent = ?, donate_cents = ?, updated_at = datetime('now')
     WHERE id = ? AND seller_id = ? AND status = 'active'`,
  ).bind(v.gearType, v.brand, v.mold, v.plastic, v.discType, v.speed, v.glide, v.turn, v.fade, v.weightG, v.color, v.condition, v.conditionNotes,
    v.priceCents, v.openToTrade ? 1 : 0, v.tradeFor, v.quantity, v.location, v.donatePercent, v.donateCents, id, seller.id).run();
  if (!changed(result)) return fail(c, 409, "not_active");
  await logDeal(c.env, { listingId: id, actorId: seller.id, action: "edit", from: "active", to: "active" });
  queueListingCheck(c.env, c.ctx, id);
  return ok(c, { listing: await listingDetail(c, (await getListingRow(c.env, id))!) });
}

export async function addListingPhoto(c: MarketCtx, id: number): Promise<Response> {
  const seller = await requireSeller(c);
  if (seller instanceof Response) return seller;
  if (!c.env.PHOTOS) return fail(c, 503, "storage_unavailable");
  const row = await ownListing(c, seller, id);
  if (row instanceof Response) return row;
  if (str(row, "status") !== "active") return fail(c, 409, "not_active");
  const body = (await readJson(c.request, PHOTO_BODY_BYTES)) ?? {};
  const image = decodeListingPhoto(body.image);
  if (!image) return fail(c, 400, "invalid_photo");
  const blocked = await limited(c, "mktphoto:" + seller.id, 30, 3600);
  if (blocked) return blocked;
  const key = listingPhotoKey(id, image.ext, crypto.randomUUID());
  await c.env.PHOTOS.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
  let ins;
  try {
    ins = await c.env.DB.prepare(
      `INSERT INTO market_listing_photos (listing_id, r2_key, content_type, bytes, sort_order)
       SELECT ?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM market_listing_photos WHERE listing_id = ?), 0)
       WHERE EXISTS (SELECT 1 FROM market_listings WHERE id = ? AND seller_id = ? AND status = 'active')
         AND (SELECT COUNT(*) FROM market_listing_photos WHERE listing_id = ?) < ?`,
    ).bind(id, key, image.contentType, image.bytes.length, id, id, seller.id, id, MAX_PHOTOS).run();
  } catch (error) {
    await c.env.PHOTOS.delete(key).catch(() => {});
    throw error;
  }
  if (!changed(ins)) {
    await c.env.PHOTOS.delete(key).catch(() => {});
    const latest = await getListingRow(c.env, id);
    return fail(c, 409, latest && str(latest, "status") !== "active" ? "not_active" : "too_many_photos");
  }
  return ok(c, { listing: await listingDetail(c, (await getListingRow(c.env, id))!) });
}

export async function deleteListingPhoto(c: MarketCtx, id: number, photoId: number): Promise<Response> {
  const seller = await requireSeller(c);
  if (seller instanceof Response) return seller;
  const row = await ownListing(c, seller, id);
  if (row instanceof Response) return row;
  if (str(row, "status") !== "active") return fail(c, 409, "not_active");
  const photo = await c.env.DB.prepare("SELECT id, r2_key FROM market_listing_photos WHERE id = ? AND listing_id = ?")
    .bind(photoId, id).first<{ id: number; r2_key: string }>();
  if (!photo) return fail(c, 404, "not_found");
  const del = await c.env.DB.prepare(
    `DELETE FROM market_listing_photos
     WHERE id = ? AND listing_id = ?
       AND EXISTS (SELECT 1 FROM market_listings WHERE id = ? AND seller_id = ? AND status = 'active')
       AND (SELECT COUNT(*) FROM market_listing_photos WHERE listing_id = ?) > 1`,
  ).bind(photoId, id, id, seller.id, id).run();
  if (!changed(del)) {
    const stillHere = await c.env.DB.prepare("SELECT 1 FROM market_listing_photos WHERE id = ? AND listing_id = ?").bind(photoId, id).first();
    if (!stillHere) return fail(c, 404, "not_found");
    const latest = await getListingRow(c.env, id);
    if (latest && str(latest, "status") !== "active") return fail(c, 409, "not_active");
    return fail(c, 409, "photo_required");
  }
  await c.env.PHOTOS?.delete(photo.r2_key).catch(() => {});
  return ok(c, { listing: await listingDetail(c, (await getListingRow(c.env, id))!) });
}

/** Withdraw: hidden from everyone else at once, but kept (photos too) for 24 hours so the seller can relist.
 *  The cron sweep (market-sweep.ts) makes it final and deletes the photos after that. */
export async function withdrawListing(c: MarketCtx, id: number): Promise<Response> {
  if (!c.actor) return fail(c, 401, "unauthorized");
  if (c.actor.kind !== "member") return fail(c, 403, "members_only");
  const seller = c.actor; // a suspended seller may still take a listing down
  const row = await ownListing(c, seller, id);
  if (row instanceof Response) return row;
  const result = await c.env.DB.prepare(
    `UPDATE market_listings SET status = 'withdrawn', withdrawn_at = datetime('now'), withdrawal_final = 0, updated_at = datetime('now')
     WHERE id = ? AND seller_id = ? AND status = 'active'`,
  ).bind(id, seller.id).run();
  if (!changed(result)) return fail(c, 409, "not_active");
  const offers = (await c.env.DB.prepare("SELECT id, buyer_id FROM market_offers WHERE listing_id = ? AND status = 'open'")
    .bind(id).all<{ id: number; buyer_id: string }>()).results ?? [];
  await c.env.DB.prepare("UPDATE market_offers SET status = 'declined', responded_at = datetime('now') WHERE listing_id = ? AND status = 'open'")
    .bind(id).run();
  await logDeal(c.env, { listingId: id, actorId: seller.id, action: "withdraw", from: "active", to: "withdrawn", note: "relist possible for 24 h" });
  const title = listingTitle({ brand: str(row, "brand"), plastic: str(row, "plastic"), mold: str(row, "mold") });
  for (const offer of offers) {
    notifyTrader(c.env, c.ctx, offer.buyer_id, {
      title: "Trade offer closed: " + title,
      body: `${seller.name} took ${title} off the marketplace, so your trade offer was closed.`,
      refKey: "mkt:offer:" + offer.id + ":withdrawn",
      hash: "market",
    });
  }
  return ok(c, { listing: await listingDetail(c, (await getListingRow(c.env, id))!) });
}

/** Relist a withdrawn listing within 24 hours: back to active with the same details and photos. */
export async function relistListing(c: MarketCtx, id: number): Promise<Response> {
  const seller = await requireListingSeller(c);
  if (seller instanceof Response) return seller;
  const row = await ownListing(c, seller, id);
  if (row instanceof Response) return row;
  if (str(row, "status") !== "withdrawn") return fail(c, 409, "not_withdrawn");
  const result = await c.env.DB.prepare(
    `UPDATE market_listings SET status = 'active', withdrawn_at = NULL, updated_at = datetime('now')
     WHERE id = ? AND seller_id = ? AND status = 'withdrawn' AND withdrawal_final = 0
       AND withdrawn_at > datetime('now', '-${RELIST_WINDOW_HOURS} hours')
       AND EXISTS (SELECT 1 FROM market_listing_photos p WHERE p.listing_id = market_listings.id)`,
  ).bind(id, seller.id).run();
  if (!changed(result)) return fail(c, 409, "relist_expired");
  await logDeal(c.env, { listingId: id, actorId: seller.id, action: "relist", from: "withdrawn", to: "active" });
  queueListingCheck(c.env, c.ctx, id);
  return ok(c, { listing: await listingDetail(c, (await getListingRow(c.env, id))!) });
}

/** Listing photos are public only while the listing is publicly visible (an <img> carries no token). */
export async function servePhoto(c: MarketCtx, photoId: number): Promise<Response> {
  const row = await c.env.DB.prepare(
    `SELECT p.r2_key, p.content_type, l.status, l.hidden, l.seller_id FROM market_listing_photos p
     JOIN market_listings l ON l.id = p.listing_id WHERE p.id = ?`,
  ).bind(photoId).first<{ r2_key: string; content_type: string; status: string; hidden: number; seller_id: string }>();
  if (!row || row.hidden === 1 || row.status === "withdrawn" || (await isSuspended(c.env, row.seller_id))) return fail(c, 404, "not_found");
  const obj = await c.env.PHOTOS?.get(row.r2_key);
  if (!obj) return fail(c, 404, "not_found");
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": row.content_type,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...corsHeaders(c.origin),
    },
  });
}

export async function settingsRoute(c: MarketCtx, method: string): Promise<Response> {
  if (!c.actor) return fail(c, 401, "unauthorized");
  if (c.actor.kind !== "member") return fail(c, 403, "members_only");
  if (method === "GET") {
    return ok(c, { settings: (await sellerSettings(c.env, c.actor.id)) ?? { paypalMe: "", cashtag: "", zelle: "", notifyEmail: "" } });
  }
  if (method !== "PUT") return fail(c, 404, "not_found");
  const blocked = await limited(c, "mktsettings:" + c.actor.id, 30, 3600);
  if (blocked) return blocked;
  // Fields left out keep their current value, so the sell form can save just the email inline.
  const current = (await sellerSettings(c.env, c.actor.id)) ?? { paypalMe: "", cashtag: "", zelle: "", notifyEmail: "" };
  const body = (await readJson(c.request)) ?? {};
  const merged: Record<string, unknown> = { ...current };
  for (const key of ["paypalMe", "cashtag", "zelle", "notifyEmail"]) if (key in body) merged[key] = body[key];
  const parsed = parseSettings(merged);
  if (!parsed.ok) return fail(c, 400, "invalid_settings", parsed.field);
  const v = parsed.value;
  await c.env.DB.prepare(
    `INSERT INTO market_seller_settings (member_id, paypal_me, cashtag, zelle, notify_email) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET paypal_me = excluded.paypal_me, cashtag = excluded.cashtag, zelle = excluded.zelle,
       notify_email = excluded.notify_email, updated_at = datetime('now')`,
  ).bind(c.actor.id, v.paypalMe, v.cashtag, v.zelle, v.notifyEmail).run();
  await ensureTrader(c.env, c.actor);
  if (v.notifyEmail && v.notifyEmail !== current.notifyEmail) {
    // Best-effort confirmation so a typo is noticed right away.
    const job = sendMarketEmail(c.env, v.notifyEmail, "You're set up to sell on the GVDG marketplace", [
      `Hi ${c.actor.name},`, "",
      "You're set up to sell on the GVDG marketplace — buyer alerts will come here.",
      "This address is never shown to buyers or other members.", "",
      "Your marketplace: " + marketUrl(c.env, "my-market"), "",
      "If this wasn't you, change the email in My marketplace > Payment settings.", "",
      "- Greenville Disc Golf Club Pro Shop",
    ].join("\n")).catch(() => false);
    try { c.ctx?.waitUntil?.(job); } catch { /* settles on its own */ }
  }
  return ok(c, { settings: v });
}

