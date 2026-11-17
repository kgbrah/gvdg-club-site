// Marketplace data access and response shaping. Every query is parameterized; the only dynamic SQL is
// IN-list placeholders and WHERE/ORDER fragments picked from hardcoded literals.

import type { Env } from "./env.js";
import { requireAuth } from "./authz.js";
import { bearer } from "./http.js";
import { verifyMarketGuestSession } from "./jwt.js";
import { newTraderKey } from "./market-crypto.js";
import { listingTitle, payMethods, wantedTitle, type PayMethod, type SellerSettings } from "./market-input.js";
import { getMember } from "./roster.js";
import { sanitizeProfilePhoto } from "./profile-photo.js";

export type TraderKind = "member" | "guest";

export interface Actor {
  id: string;
  kind: TraderKind;
  name: string;
  isAdmin: boolean;
}

export interface Viewer {
  kind: TraderKind | "public";
  key: string | null;
  name: string | null;
  isAdmin: boolean;
}

export interface FeedbackSummary {
  positive: number;
  neutral: number;
  negative: number;
  count: number;
  percent: number | null;
}

export interface TraderLite {
  key: string;
  name: string;
  kind: TraderKind;
}

export type Row = Record<string, unknown>;

const EMPTY_SUMMARY: FeedbackSummary = { positive: 0, neutral: 0, negative: 0, count: 0, percent: null };
const DAY_MS = 86_400_000;
export const FEEDBACK_WINDOW_DAYS = 60;
export const FEEDBACK_EDIT_DAYS = 7;

export function str(row: Row | null | undefined, key: string): string {
  const v = row?.[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function num(row: Row | null | undefined, key: string): number {
  const v = row?.[key];
  return typeof v === "number" ? v : Number(v || 0);
}

export function numOrNull(row: Row | null | undefined, key: string): number | null {
  const v = row?.[key];
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) -> epoch ms. */
export function sqlTime(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(value.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? "" : "Z"));
}

export function sqlTimePlusDays(value: string | null | undefined, days: number): string | null {
  const at = sqlTime(value);
  if (!Number.isFinite(at)) return null;
  return new Date(at + days * DAY_MS).toISOString().replace("T", " ").slice(0, 19);
}

export function isGuestOwner(id: string): boolean {
  return /^mg_\d{1,12}$/.test(id);
}

/** Who is calling: a member session (roster record required), a verified guest, or nobody. */
export async function resolveActor(request: Request, env: Env): Promise<Actor | null> {
  const token = bearer(request);
  if (!token) return null;
  const claims = await requireAuth(request, env);
  if (claims) {
    const member = claims.member;
    if (!member) return null;
    return { id: member.memberId, kind: "member", name: (member.name || "Member").trim().slice(0, 60) || "Member", isAdmin: member.isAdmin === true };
  }
  const guestId = await verifyMarketGuestSession(token, env.JWT_SECRET);
  if (!guestId) return null;
  const row = await env.DB.prepare("SELECT id, display_name FROM market_guests WHERE id = ?")
    .bind(Number(guestId.slice(3))).first<{ id: number; display_name: string }>();
  if (!row) return null;
  return { id: guestId, kind: "guest", name: row.display_name, isAdmin: false };
}

/** Create (once) the public trader key for an owner and refresh the cached display name. */
export async function ensureTrader(env: Env, actor: Pick<Actor, "id" | "kind" | "name">): Promise<string> {
  await env.DB.prepare(
    `INSERT INTO market_traders (owner_id, trader_key, kind, display_name) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET display_name = excluded.display_name
     WHERE market_traders.display_name <> excluded.display_name`,
  ).bind(actor.id, newTraderKey(), actor.kind, actor.name).run();
  const row = await env.DB.prepare("SELECT trader_key FROM market_traders WHERE owner_id = ?").bind(actor.id).first<{ trader_key: string }>();
  return row?.trader_key ?? "";
}

export async function viewerOf(env: Env, actor: Actor | null): Promise<Viewer> {
  if (!actor) return { kind: "public", key: null, name: null, isAdmin: false };
  return { kind: actor.kind, key: await ensureTrader(env, actor), name: actor.name, isAdmin: actor.isAdmin };
}

export async function ownerByKey(env: Env, key: string): Promise<{ ownerId: string; kind: TraderKind; name: string } | null> {
  if (!/^[0-9a-f]{18}$/.test(key)) return null;
  const row = await env.DB.prepare("SELECT owner_id, kind, display_name FROM market_traders WHERE trader_key = ?")
    .bind(key).first<{ owner_id: string; kind: TraderKind; display_name: string }>();
  return row ? { ownerId: row.owner_id, kind: row.kind, name: row.display_name || (row.kind === "guest" ? "Guest" : "Member") } : null;
}

export async function tradersByOwner(env: Env, ownerIds: readonly string[]): Promise<Map<string, TraderLite>> {
  const ids = [...new Set(ownerIds.filter(Boolean))];
  const out = new Map<string, TraderLite>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = await env.DB.prepare(
      `SELECT owner_id, trader_key, kind, display_name FROM market_traders WHERE owner_id IN (${chunk.map(() => "?").join(",")})`,
    ).bind(...chunk).all<{ owner_id: string; trader_key: string; kind: TraderKind; display_name: string }>();
    for (const row of rows.results ?? []) {
      out.set(row.owner_id, { key: row.trader_key, name: row.display_name || (row.kind === "guest" ? "Guest" : "Member"), kind: row.kind });
    }
  }
  return out;
}

export function liteOf(map: Map<string, TraderLite>, ownerId: string): TraderLite {
  return map.get(ownerId) ?? { key: "", name: isGuestOwner(ownerId) ? "Guest" : "Member", kind: isGuestOwner(ownerId) ? "guest" : "member" };
}

export function summarize(positive: number, neutral: number, negative: number): FeedbackSummary {
  const rated = positive + negative;
  return { positive, neutral, negative, count: positive + neutral + negative, percent: rated ? Math.round((100 * positive) / rated) : null };
}

export async function feedbackSummaries(env: Env, ownerIds: readonly string[]): Promise<Map<string, FeedbackSummary>> {
  const ids = [...new Set(ownerIds.filter(Boolean))];
  const out = new Map<string, FeedbackSummary>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = await env.DB.prepare(
      `SELECT subject_id,
              SUM(CASE WHEN rating = 'positive' THEN 1 ELSE 0 END) AS pos,
              SUM(CASE WHEN rating = 'neutral' THEN 1 ELSE 0 END) AS neu,
              SUM(CASE WHEN rating = 'negative' THEN 1 ELSE 0 END) AS neg
       FROM market_feedback WHERE removed_at IS NULL AND subject_id IN (${chunk.map(() => "?").join(",")})
       GROUP BY subject_id`,
    ).bind(...chunk).all<{ subject_id: string; pos: number; neu: number; neg: number }>();
    for (const row of rows.results ?? []) out.set(row.subject_id, summarize(Number(row.pos) || 0, Number(row.neu) || 0, Number(row.neg) || 0));
  }
  return out;
}

export function summaryOf(map: Map<string, FeedbackSummary>, ownerId: string): FeedbackSummary {
  return map.get(ownerId) ?? { ...EMPTY_SUMMARY };
}

export async function isSuspended(env: Env, ownerId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS hit FROM market_suspensions WHERE owner_id = ? AND lifted_at IS NULL LIMIT 1")
    .bind(ownerId).first<{ hit: number }>();
  return Boolean(row);
}

/** A member's photo is shown only when their community profile is public. Guests never have one. */
export async function publicPhoto(env: Env, ownerId: string): Promise<string | null> {
  if (isGuestOwner(ownerId)) return null;
  try {
    const profile = await env.DB.prepare("SELECT audience FROM community_profiles WHERE member_id = ?").bind(ownerId).first<{ audience: string }>();
    if (profile?.audience !== "public") return null;
    const member = await getMember(env.ROSTER, ownerId);
    return sanitizeProfilePhoto(member?.photo);
  } catch {
    return null;
  }
}

export async function sellerSettings(env: Env, memberId: string): Promise<SellerSettings | null> {
  const row = await env.DB.prepare(
    "SELECT paypal_me, cashtag, zelle, notify_email FROM market_seller_settings WHERE member_id = ?",
  ).bind(memberId).first<{ paypal_me: string; cashtag: string; zelle: string; notify_email: string }>();
  return row ? { paypalMe: row.paypal_me, cashtag: row.cashtag, zelle: row.zelle, notifyEmail: row.notify_email } : null;
}

export async function payInfo(env: Env, sellerId: string, amountCents: number | null): Promise<{ amountCents: number; methods: PayMethod[] } | null> {
  if (amountCents == null || amountCents <= 0) return null;
  return { amountCents, methods: payMethods(await sellerSettings(env, sellerId), amountCents) };
}

// ---- Listings ----

export const LISTING_COLUMNS = `l.id, l.seller_id, l.brand, l.mold, l.plastic, l.disc_type, l.speed, l.glide, l.turn, l.fade,
  l.weight_g, l.color, l.condition, l.condition_notes, l.price_cents, l.open_to_trade, l.trade_for, l.quantity, l.location,
  l.status, l.hidden, l.created_at, l.updated_at,
  (SELECT p.id FROM market_listing_photos p WHERE p.listing_id = l.id ORDER BY p.sort_order, p.id LIMIT 1) AS photo_id`;

export async function getListingRow(env: Env, id: number): Promise<Row | null> {
  return env.DB.prepare(`SELECT ${LISTING_COLUMNS} FROM market_listings l WHERE l.id = ?`).bind(id).first<Row>();
}

export function photoUrl(id: number): string {
  return "/market/photos/" + id;
}

export function listingCard(row: Row, traders: Map<string, TraderLite>, summaries: Map<string, FeedbackSummary>, viewerId: string | null) {
  const sellerId = str(row, "seller_id");
  const photoId = numOrNull(row, "photo_id");
  return {
    id: num(row, "id"),
    title: listingTitle({ brand: str(row, "brand"), plastic: str(row, "plastic"), mold: str(row, "mold") }),
    brand: str(row, "brand"),
    mold: str(row, "mold"),
    plastic: str(row, "plastic"),
    discType: str(row, "disc_type"),
    weightG: numOrNull(row, "weight_g"),
    color: str(row, "color"),
    condition: num(row, "condition"),
    priceCents: numOrNull(row, "price_cents"),
    openToTrade: num(row, "open_to_trade") === 1,
    quantity: num(row, "quantity") || 1,
    location: str(row, "location"),
    status: str(row, "status"),
    hidden: num(row, "hidden") === 1,
    createdAt: str(row, "created_at"),
    photo: photoId ? { id: photoId, url: photoUrl(photoId) } : null,
    seller: { ...liteOf(traders, sellerId), feedback: summaryOf(summaries, sellerId) },
    mine: viewerId != null && viewerId === sellerId,
  };
}

export async function listingCards(env: Env, rows: Row[], viewerId: string | null) {
  const sellers = rows.map((row) => str(row, "seller_id"));
  const [traders, summaries] = await Promise.all([tradersByOwner(env, sellers), feedbackSummaries(env, sellers)]);
  return rows.map((row) => listingCard(row, traders, summaries, viewerId));
}

export async function listingPhotos(env: Env, listingId: number): Promise<Array<{ id: number; url: string }>> {
  const rows = await env.DB.prepare("SELECT id FROM market_listing_photos WHERE listing_id = ? ORDER BY sort_order, id")
    .bind(listingId).all<{ id: number }>();
  return (rows.results ?? []).map((row) => ({ id: row.id, url: photoUrl(row.id) }));
}

// ---- Deals, offers, feedback ----

export function parseOffered(value: unknown): number[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id) && id > 0).slice(0, 4) : [];
  } catch {
    return [];
  }
}

async function offeredTitles(env: Env, ids: number[]): Promise<Array<{ id: number; title: string }>> {
  if (!ids.length) return [];
  const rows = await env.DB.prepare(`SELECT id, brand, plastic, mold FROM market_listings WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids).all<Row>();
  const byId = new Map((rows.results ?? []).map((row) => [num(row, "id"), listingTitle({ brand: str(row, "brand"), plastic: str(row, "plastic"), mold: str(row, "mold") })]));
  return ids.filter((id) => byId.has(id)).map((id) => ({ id, title: byId.get(id)! }));
}

export async function offerViews(env: Env, rows: Row[]) {
  const traders = await tradersByOwner(env, rows.map((row) => str(row, "buyer_id")));
  return Promise.all(rows.map(async (row) => ({
    id: num(row, "id"),
    listingId: num(row, "listing_id"),
    listingTitle: str(row, "listing_title") || listingTitle({ brand: str(row, "brand"), plastic: str(row, "plastic"), mold: str(row, "mold") }),
    status: str(row, "status"),
    text: str(row, "body"),
    offered: await offeredTitles(env, parseOffered(row.offered_ids)),
    buyer: liteOf(traders, str(row, "buyer_id")),
    createdAt: str(row, "created_at"),
  })));
}

export const OFFER_COLUMNS = `o.id, o.listing_id, o.buyer_id, o.offered_ids, o.offered_text, o.body, o.status, o.created_at,
  l.brand, l.plastic, l.mold`;

export async function feedbackRows(env: Env, where: string, binds: unknown[], limit = 50): Promise<Row[]> {
  const rows = await env.DB.prepare(
    `SELECT f.id, f.deal_id, f.author_id, f.subject_id, f.subject_role, f.rating, f.comment, f.created_at, f.edited_at,
            d.listing_title, r.body AS reply_body, r.created_at AS reply_at
     FROM market_feedback f
     JOIN market_deals d ON d.id = f.deal_id
     LEFT JOIN market_feedback_replies r ON r.feedback_id = f.id
     WHERE f.removed_at IS NULL AND ${where}
     ORDER BY f.created_at DESC, f.id DESC LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}`,
  ).bind(...binds).all<Row>();
  return rows.results ?? [];
}

export async function feedbackViews(env: Env, rows: Row[], viewerId: string | null, viewerSuspended = false) {
  const traders = await tradersByOwner(env, rows.flatMap((row) => [str(row, "author_id"), str(row, "subject_id")]));
  const now = Date.now();
  return rows.map((row) => {
    const created = sqlTime(str(row, "created_at"));
    const hasReply = Boolean(row.reply_body);
    return {
      id: num(row, "id"),
      dealId: num(row, "deal_id"),
      listingTitle: str(row, "listing_title"),
      rating: str(row, "rating"),
      comment: str(row, "comment"),
      role: str(row, "subject_role"),
      author: liteOf(traders, str(row, "author_id")),
      subject: liteOf(traders, str(row, "subject_id")),
      createdAt: str(row, "created_at"),
      editedAt: row.edited_at ? str(row, "edited_at") : null,
      canEdit: !viewerSuspended && viewerId === str(row, "author_id") && !row.edited_at && now <= created + FEEDBACK_EDIT_DAYS * DAY_MS,
      canReply: !viewerSuspended && viewerId === str(row, "subject_id") && !hasReply,
      reply: hasReply ? { body: str(row, "reply_body"), createdAt: str(row, "reply_at") } : null,
    };
  });
}

export const DEAL_COLUMNS = `d.id, d.listing_id, d.seller_id, d.buyer_id, d.kind, d.offer_id, d.price_cents, d.listing_title,
  d.status, d.outcome, d.created_at, d.completed_at, d.closed_at`;

export async function getDealRow(env: Env, id: number): Promise<Row | null> {
  return env.DB.prepare(`SELECT ${DEAL_COLUMNS} FROM market_deals d WHERE d.id = ?`).bind(id).first<Row>();
}

export function feedbackOpen(deal: Row, now = Date.now()): boolean {
  if (str(deal, "status") !== "completed") return false;
  const completed = sqlTime(str(deal, "completed_at"));
  return Number.isFinite(completed) && now <= completed + FEEDBACK_WINDOW_DAYS * DAY_MS;
}

export async function dealViews(env: Env, rows: Row[], viewerId: string, viewerSuspended = false) {
  if (!rows.length) return [];
  const traders = await tradersByOwner(env, rows.flatMap((row) => [str(row, "buyer_id"), str(row, "seller_id")]));
  const dealIds = rows.map((row) => num(row, "id"));
  const feedback = await feedbackRows(env, `f.deal_id IN (${dealIds.map(() => "?").join(",")})`, dealIds, 100);
  const feedbackViewsList = await feedbackViews(env, feedback, viewerId, viewerSuspended);
  const byDeal = new Map<number, typeof feedbackViewsList>();
  feedbackViewsList.forEach((view, index) => {
    const dealId = num(feedback[index]!, "deal_id");
    byDeal.set(dealId, [...(byDeal.get(dealId) ?? []), view]);
  });
  const authors = new Map(feedback.map((row) => [num(row, "id"), str(row, "author_id")]));
  return Promise.all(rows.map(async (row) => {
    const id = num(row, "id");
    const role = str(row, "seller_id") === viewerId ? "seller" : "buyer";
    const views = byDeal.get(id) ?? [];
    const mine = views.find((view) => authors.get(view.id) === viewerId) ?? null;
    const theirs = views.find((view) => authors.get(view.id) !== viewerId) ?? null;
    const status = str(row, "status");
    let offerText: string | null = null;
    let offered: Array<{ id: number; title: string }> = [];
    if (str(row, "kind") === "trade" && row.offer_id != null) {
      const offer = await env.DB.prepare("SELECT body, offered_ids FROM market_offers WHERE id = ?").bind(num(row, "offer_id")).first<Row>();
      offerText = offer ? str(offer, "body") : null;
      offered = offer ? await offeredTitles(env, parseOffered(offer.offered_ids)) : [];
    }
    const open = feedbackOpen(row);
    return {
      id,
      listingId: num(row, "listing_id"),
      listingTitle: str(row, "listing_title"),
      kind: str(row, "kind"),
      status,
      outcome: row.outcome ? str(row, "outcome") : null,
      priceCents: numOrNull(row, "price_cents"),
      createdAt: str(row, "created_at"),
      completedAt: row.completed_at ? str(row, "completed_at") : null,
      role,
      buyer: liteOf(traders, str(row, "buyer_id")),
      seller: liteOf(traders, str(row, "seller_id")),
      pay: role === "buyer" && status === "pending" ? await payInfo(env, str(row, "seller_id"), numOrNull(row, "price_cents")) : null,
      offerText,
      offered,
      feedback: {
        mine,
        theirs,
        canLeave: !viewerSuspended && open && !mine,
        leaveUntil: status === "completed" ? sqlTimePlusDays(str(row, "completed_at"), FEEDBACK_WINDOW_DAYS) : null,
      },
    };
  }));
}

// ---- WANTED ----

export const WANTED_COLUMNS = `w.id, w.poster_id, w.brand, w.mold, w.plastic, w.disc_type, w.weight_min, w.weight_max,
  w.condition_min, w.max_price_cents, w.open_to_trade, w.notes, w.status, w.hidden, w.created_at, w.expires_at,
  (SELECT COUNT(*) FROM market_wanted_replies r WHERE r.wanted_id = w.id) AS reply_count`;

export function wantedStatus(row: Row, now = Date.now()): string {
  if (str(row, "status") === "closed") return "closed";
  return sqlTime(str(row, "expires_at")) <= now ? "expired" : "open";
}

export async function wantedViews(env: Env, rows: Row[], viewerId: string | null, withReplies = false) {
  const posters = rows.map((row) => str(row, "poster_id"));
  const [traders, summaries] = await Promise.all([tradersByOwner(env, posters), feedbackSummaries(env, posters)]);
  return Promise.all(rows.map(async (row) => {
    const posterId = str(row, "poster_id");
    const mine = viewerId != null && viewerId === posterId;
    const view: Record<string, unknown> = {
      id: num(row, "id"),
      title: wantedTitle({ brand: str(row, "brand"), plastic: str(row, "plastic"), mold: str(row, "mold"), disc_type: str(row, "disc_type") }),
      brand: str(row, "brand"),
      mold: str(row, "mold"),
      plastic: str(row, "plastic"),
      discType: row.disc_type ? str(row, "disc_type") : null,
      weightMin: numOrNull(row, "weight_min"),
      weightMax: numOrNull(row, "weight_max"),
      conditionMin: numOrNull(row, "condition_min"),
      maxPriceCents: numOrNull(row, "max_price_cents"),
      openToTrade: num(row, "open_to_trade") === 1,
      notes: str(row, "notes"),
      status: wantedStatus(row),
      hidden: num(row, "hidden") === 1,
      createdAt: str(row, "created_at"),
      expiresAt: str(row, "expires_at"),
      poster: { ...liteOf(traders, posterId), feedback: summaryOf(summaries, posterId) },
      mine,
      replyCount: num(row, "reply_count"),
    };
    if (withReplies && mine) view.replies = await wantedReplies(env, num(row, "id"));
    return view;
  }));
}

export async function wantedReplies(env: Env, wantedId: number) {
  const rows = (await env.DB.prepare(
    `SELECT r.id, r.body, r.listing_id, r.replier_id, r.created_at, l.brand, l.plastic, l.mold
     FROM market_wanted_replies r LEFT JOIN market_listings l ON l.id = r.listing_id
     WHERE r.wanted_id = ? ORDER BY r.id DESC LIMIT 50`,
  ).bind(wantedId).all<Row>()).results ?? [];
  const traders = await tradersByOwner(env, rows.map((row) => str(row, "replier_id")));
  return rows.map((row) => ({
    id: num(row, "id"),
    body: str(row, "body"),
    listing: row.listing_id != null ? { id: num(row, "listing_id"), title: listingTitle({ brand: str(row, "brand"), plastic: str(row, "plastic"), mold: str(row, "mold") }) } : null,
    from: liteOf(traders, str(row, "replier_id")),
    createdAt: str(row, "created_at"),
  }));
}

// ---- Logs ----

export async function logDeal(env: Env, entry: {
  listingId?: number | null; dealId?: number | null; offerId?: number | null; actorId: string; action: string;
  from?: string | null; to?: string | null; note?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO market_deal_log (listing_id, deal_id, offer_id, actor_id, action, from_status, to_status, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(entry.listingId ?? null, entry.dealId ?? null, entry.offerId ?? null, entry.actorId, entry.action,
    entry.from ?? null, entry.to ?? null, (entry.note ?? "").slice(0, 200)).run();
}

export async function logModeration(env: Env, adminId: string, action: string, targetKind: string, targetId: string | number, reason: string): Promise<void> {
  await env.DB.prepare("INSERT INTO market_mod_log (admin_id, action, target_kind, target_id, reason) VALUES (?, ?, ?, ?, ?)")
    .bind(adminId, action, targetKind, String(targetId), reason.slice(0, 200)).run();
}

/** "Deals waiting on you": seller-side pending deals, open offers on your listings, feedback still to leave. */
export async function waitingCount(env: Env, ownerId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM market_deals WHERE seller_id = ? AND status = 'pending') +
       (SELECT COUNT(*) FROM market_offers o JOIN market_listings l ON l.id = o.listing_id
          WHERE l.seller_id = ? AND o.status = 'open' AND l.status = 'active') +
       (SELECT COUNT(*) FROM market_deals d
          WHERE (d.seller_id = ? OR d.buyer_id = ?) AND d.status = 'completed'
            AND d.completed_at >= datetime('now', '-${FEEDBACK_WINDOW_DAYS} days')
            AND NOT EXISTS (SELECT 1 FROM market_feedback f WHERE f.deal_id = d.id AND f.author_id = ?)) AS n`,
  ).bind(ownerId, ownerId, ownerId, ownerId, ownerId).first<{ n: number }>();
  return Number(row?.n) || 0;
}
