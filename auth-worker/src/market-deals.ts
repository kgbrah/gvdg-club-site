// Marketplace deals: buy, trade offers, the seller completing / releasing and the buyer cancelling,
// feedback (once per party per deal, 60-day window, one edit in 7 days, one reply), and reports.
//
// State machine (every transition is a compare-and-set UPDATE and is written to market_deal_log):
//   listing  active --buy / accept offer--> pending --complete--> sold | traded (or back to active if qty remains)
//            pending --release (seller) / cancel (buyer)--> active
//            active --withdraw--> withdrawn --relist (seller, within 24 h)--> active
//            withdrawn --(cron, after 24 h)--> withdrawn + final (photos deleted from R2; no relist)
//   deal     pending --> completed | released | cancelled
//   offer    open --> accepted | declined | withdrawn

import { sellerDonations } from "./market-donations.js";
import { readJson } from "./http.js";
import { notifyAdmins } from "./admin-push.js";
import { cleanText, COMMENT_MAX, dollars, listingTitle, parseIdList, RATINGS, REPORT_REASONS, type Rating } from "./market-input.js";
import { listingDetail, listingVisible } from "./market-listings.js";
import { notifyTrader } from "./market-notify.js";
import {
  DEAL_COLUMNS, FEEDBACK_EDIT_DAYS, OFFER_COLUMNS, WANTED_COLUMNS, dealViews, ensureTrader, feedbackOpen, feedbackRows,
  feedbackViews, getDealRow, getListingRow, isSuspended, listingCards, logDeal, num, offerViews, sellerSettings, sqlTime, str,
  viewerOf, waitingCount, wantedViews, type Actor, type Row,
} from "./market-store.js";
import { changed, fail, limited, ok, requireSeller, requireTrader, type MarketCtx } from "./market-http.js";

const DAY_MS = 86_400_000;

function titleOf(row: Row): string {
  return listingTitle({ brand: str(row, "brand"), plastic: str(row, "plastic"), mold: str(row, "mold") });
}

async function dealView(c: MarketCtx, id: number, actor: Actor) {
  const row = await getDealRow(c.env, id);
  return row ? (await dealViews(c.env, [row], actor.id))[0] ?? null : null;
}

export async function buyListing(c: MarketCtx, listingId: number): Promise<Response> {
  const buyer = await requireTrader(c);
  if (buyer instanceof Response) return buyer;
  const row = await getListingRow(c.env, listingId);
  if (!row || !(await listingVisible(c, row))) return fail(c, 404, "not_found");
  const sellerId = str(row, "seller_id");
  if (sellerId === buyer.id) return fail(c, 403, "own_listing");
  if (num(row, "hidden") === 1) return fail(c, 404, "not_found");
  if (row.price_cents == null) return fail(c, 409, "no_price");
  if (str(row, "status") !== "active") return fail(c, 409, "not_available");
  const blocked = await limited(c, "mktbuy:" + buyer.id, 20, 3600);
  if (blocked) return blocked;
  await ensureTrader(c.env, buyer);
  const priceCents = num(row, "price_cents");
  const claimed = await c.env.DB.prepare(
    "UPDATE market_listings SET status = 'pending', updated_at = datetime('now') WHERE id = ? AND status = 'active' AND hidden = 0 AND price_cents = ?",
  ).bind(listingId, priceCents).run();
  if (!changed(claimed)) return fail(c, 409, "not_available");
  const title = titleOf(row);
  let dealId = 0;
  try {
    const inserted = await c.env.DB.prepare(
      `INSERT INTO market_deals (listing_id, seller_id, buyer_id, kind, price_cents, listing_title)
       VALUES (?, ?, ?, 'buy', ?, ?) RETURNING id`,
    ).bind(listingId, sellerId, buyer.id, priceCents, title).first<{ id: number }>();
    dealId = Number(inserted?.id) || 0;
  } catch {
    dealId = 0;
  }
  if (!dealId) {
    await c.env.DB.prepare("UPDATE market_listings SET status = 'active' WHERE id = ? AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM market_deals WHERE listing_id = ? AND status = 'pending')")
      .bind(listingId, listingId).run();
    return fail(c, 409, "not_available");
  }
  await logDeal(c.env, { listingId, dealId, actorId: buyer.id, action: "buy", from: "active", to: "pending" });
  notifyTrader(c.env, c.ctx, sellerId, {
    title: "New buyer: " + title,
    body: `${buyer.name}${buyer.kind === "guest" ? " (guest)" : ""} is buying ${title} for $${dollars(num(row, "price_cents"))}. Mark it sold once you're paid, or release it.`,
    refKey: "mkt:deal:" + dealId + ":new",
    hash: "market/listing/" + listingId,
  });
  const listing = await listingDetail(c, (await getListingRow(c.env, listingId))!);
  return ok(c, { deal: await dealView(c, dealId, buyer), listing }, 201);
}

export async function proposeTrade(c: MarketCtx, listingId: number): Promise<Response> {
  const buyer = await requireTrader(c);
  if (buyer instanceof Response) return buyer;
  const row = await getListingRow(c.env, listingId);
  if (!row || !(await listingVisible(c, row)) || num(row, "hidden") === 1) return fail(c, 404, "not_found");
  const sellerId = str(row, "seller_id");
  if (sellerId === buyer.id) return fail(c, 403, "own_listing");
  if (num(row, "open_to_trade") !== 1) return fail(c, 409, "trade_not_open");
  if (str(row, "status") !== "active") return fail(c, 409, "not_available");
  const body = (await readJson(c.request)) ?? {};
  const ids = parseIdList(body.listingIds, 4);
  const text = cleanText(body.text, COMMENT_MAX);
  if (ids == null || text == null || (!ids.length && !text)) return fail(c, 400, "invalid_offer");
  if (ids.includes(listingId)) return fail(c, 400, "invalid_offer");
  let offeredText = "";
  if (ids.length) {
    if (buyer.kind !== "member") return fail(c, 400, "invalid_offer");
    const own = (await c.env.DB.prepare(
      `SELECT id, brand, plastic, mold FROM market_listings
       WHERE seller_id = ? AND status = 'active' AND hidden = 0 AND id IN (${ids.map(() => "?").join(",")})`,
    ).bind(buyer.id, ...ids).all<Row>()).results ?? [];
    if (own.length !== ids.length) return fail(c, 400, "invalid_offer");
    offeredText = own.map(titleOf).join(", ").slice(0, 300);
  }
  const existing = await c.env.DB.prepare("SELECT id FROM market_offers WHERE listing_id = ? AND buyer_id = ? AND status = 'open'")
    .bind(listingId, buyer.id).first();
  if (existing) return fail(c, 409, "offer_exists");
  const blocked = await limited(c, "mktoffer:" + buyer.id, 20, 3600);
  if (blocked) return blocked;
  await ensureTrader(c.env, buyer);
  const inserted = await c.env.DB.prepare(
    "INSERT INTO market_offers (listing_id, buyer_id, offered_ids, offered_text, body) VALUES (?, ?, ?, ?, ?) RETURNING id",
  ).bind(listingId, buyer.id, JSON.stringify(ids), offeredText, text).first<{ id: number }>();
  const offerId = Number(inserted?.id);
  await logDeal(c.env, { listingId, offerId, actorId: buyer.id, action: "offer", to: "open" });
  const title = titleOf(row);
  notifyTrader(c.env, c.ctx, sellerId, {
    title: "Trade offer: " + title,
    body: `${buyer.name} offered ${offeredText || "a trade"}${text ? ": " + text.slice(0, 100) : ""}. Accept or decline it on the listing.`,
    refKey: "mkt:offer:" + offerId,
    hash: "market/listing/" + listingId,
  });
  const offerRow = await c.env.DB.prepare(`SELECT ${OFFER_COLUMNS} FROM market_offers o JOIN market_listings l ON l.id = o.listing_id WHERE o.id = ?`)
    .bind(offerId).first<Row>();
  return ok(c, { offer: (await offerViews(c.env, [offerRow!]))[0] }, 201);
}

export async function offerAction(c: MarketCtx, offerId: number, action: string): Promise<Response> {
  const offerRow = await c.env.DB.prepare(`SELECT ${OFFER_COLUMNS}, l.seller_id, l.status AS listing_status, l.hidden
    FROM market_offers o JOIN market_listings l ON l.id = o.listing_id WHERE o.id = ?`).bind(offerId).first<Row>();
  if (action === "withdraw") {
    const buyer = await requireTrader(c);
    if (buyer instanceof Response) return buyer;
    if (!offerRow || str(offerRow, "buyer_id") !== buyer.id) return fail(c, 404, "not_found");
    const result = await c.env.DB.prepare("UPDATE market_offers SET status = 'withdrawn', responded_at = datetime('now') WHERE id = ? AND status = 'open'")
      .bind(offerId).run();
    if (!changed(result)) return fail(c, 409, "not_open");
    await logDeal(c.env, { listingId: num(offerRow, "listing_id"), offerId, actorId: buyer.id, action: "offer_withdraw", from: "open", to: "withdrawn" });
    return ok(c, { offer: (await offerViews(c.env, [{ ...offerRow, status: "withdrawn" }]))[0] });
  }
  const seller = await requireSeller(c);
  if (seller instanceof Response) return seller;
  if (!offerRow || str(offerRow, "seller_id") !== seller.id) return fail(c, 404, "not_found");
  if (str(offerRow, "status") !== "open") return fail(c, 409, "not_open");
  const listingId = num(offerRow, "listing_id");
  const title = titleOf(offerRow);
  const buyerId = str(offerRow, "buyer_id");
  if (action === "decline") {
    const result = await c.env.DB.prepare("UPDATE market_offers SET status = 'declined', responded_at = datetime('now') WHERE id = ? AND status = 'open'")
      .bind(offerId).run();
    if (!changed(result)) return fail(c, 409, "not_open");
    await logDeal(c.env, { listingId, offerId, actorId: seller.id, action: "offer_decline", from: "open", to: "declined" });
    notifyTrader(c.env, c.ctx, buyerId, {
      title: "Trade declined: " + title,
      body: `${seller.name} declined your trade offer for ${title}.`,
      refKey: "mkt:offer:" + offerId + ":declined",
      hash: "market/listing/" + listingId,
    });
    return ok(c, { offer: (await offerViews(c.env, [{ ...offerRow, status: "declined" }]))[0] });
  }
  if (action !== "accept") return fail(c, 404, "not_found");
  if (await isSuspended(c.env, buyerId)) return fail(c, 409, "buyer_suspended");
  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE market_offers SET status = 'accepted', responded_at = datetime('now')
       WHERE id = ? AND listing_id = ? AND status = 'open'
         AND EXISTS (SELECT 1 FROM market_listings WHERE id = ? AND seller_id = ? AND status = 'active' AND hidden = 0)`,
    ).bind(offerId, listingId, listingId, seller.id),
    c.env.DB.prepare(
      `UPDATE market_listings SET status = 'pending', updated_at = datetime('now')
       WHERE id = ? AND seller_id = ? AND status = 'active' AND hidden = 0
         AND EXISTS (SELECT 1 FROM market_offers WHERE id = ? AND status = 'accepted')
         AND NOT EXISTS (SELECT 1 FROM market_deals WHERE offer_id = ?)`,
    ).bind(listingId, seller.id, offerId, offerId),
    c.env.DB.prepare(
      `INSERT INTO market_deals (listing_id, seller_id, buyer_id, kind, offer_id, price_cents, listing_title)
       SELECT ?, ?, ?, 'trade', ?, NULL, ?
       WHERE EXISTS (SELECT 1 FROM market_offers WHERE id = ? AND status = 'accepted')
         AND EXISTS (SELECT 1 FROM market_listings WHERE id = ? AND status = 'pending')
         AND NOT EXISTS (SELECT 1 FROM market_deals WHERE offer_id = ?)
       RETURNING id`,
    ).bind(listingId, seller.id, buyerId, offerId, title, offerId, listingId, offerId),
  ]);
  const insertedRow = batchResults[2]?.results?.[0] as { id?: number } | undefined;
  const dealId = Number(insertedRow?.id) || 0;
  if (!batchResults[0] || !changed(batchResults[0]) || !batchResults[1] || !changed(batchResults[1]) || !dealId) return fail(c, 409, "not_available");
  await logDeal(c.env, { listingId, offerId, dealId, actorId: seller.id, action: "offer_accept", from: "active", to: "pending" });
  notifyTrader(c.env, c.ctx, buyerId, {
    title: "Trade accepted: " + title,
    body: `${seller.name} accepted your trade offer for ${title}. Arrange the swap, then they'll mark it traded.`,
    refKey: "mkt:offer:" + offerId + ":accepted",
    hash: "market/listing/" + listingId,
  });
  return ok(c, {
    offer: (await offerViews(c.env, [{ ...offerRow, status: "accepted" }]))[0],
    deal: await dealView(c, dealId, seller),
  });
}

export async function dealAction(c: MarketCtx, dealId: number, action: string): Promise<Response> {
  // Completing needs an unsuspended seller; backing out (release / cancel) is always allowed to the party.
  let who: Actor;
  if (action === "complete") {
    const seller = await requireSeller(c);
    if (seller instanceof Response) return seller;
    who = seller;
  } else {
    if (!c.actor) return fail(c, 401, "unauthorized");
    who = c.actor;
  }
  const deal = await getDealRow(c.env, dealId);
  const roleId = action === "cancel" ? "buyer_id" : "seller_id";
  if (!deal || str(deal, roleId) !== who.id) return fail(c, 404, "not_found");
  if (str(deal, "status") !== "pending") return fail(c, 409, "not_pending");
  const listingId = num(deal, "listing_id");
  const title = str(deal, "listing_title");
  const buyerId = str(deal, "buyer_id");
  const sellerId = str(deal, "seller_id");

  if (action === "release" || action === "cancel") {
    const next = action === "release" ? "released" : "cancelled";
    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE market_deals SET status = ?, closed_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .bind(next, dealId),
      c.env.DB.prepare(
        `UPDATE market_listings SET status = 'active', updated_at = datetime('now')
         WHERE id = ? AND status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM market_deals WHERE listing_id = ? AND status = 'pending')`,
      ).bind(listingId, listingId),
    ]);
    if (!batchResults[0] || !changed(batchResults[0])) return fail(c, 409, "not_pending");
    await logDeal(c.env, { listingId, dealId, actorId: who.id, action, from: "pending", to: next, note: "listing pending -> active" });
    notifyTrader(c.env, c.ctx, action === "release" ? buyerId : sellerId, action === "release"
      ? { title: "Released: " + title, body: `${who.name} released ${title}. It's back on the marketplace.`, refKey: "mkt:deal:" + dealId + ":released", hash: "market/listing/" + listingId }
      : { title: "Buyer backed out: " + title, body: `${who.name} cancelled. ${title} is active again.`, refKey: "mkt:deal:" + dealId + ":cancelled", hash: "market/listing/" + listingId });
    return ok(c, { deal: await dealView(c, dealId, who) });
  }

  if (action !== "complete") return fail(c, 404, "not_found");
  const body = (await readJson(c.request)) ?? {};
  const outcome = body.outcome === "sold" || body.outcome === "traded" ? body.outcome : str(deal, "kind") === "trade" ? "traded" : "sold";
  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE market_deals SET status = 'completed', outcome = ?, completed_at = datetime('now'), closed_at = datetime('now') WHERE id = ? AND status = 'pending'",
    ).bind(outcome, dealId),
    c.env.DB.prepare(
      `UPDATE market_listings
       SET status = CASE WHEN quantity > 1 THEN 'active' ELSE ? END,
           quantity = CASE WHEN quantity > 1 THEN quantity - 1 ELSE quantity END,
           updated_at = datetime('now')
       WHERE id = ? AND status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM market_deals WHERE listing_id = ? AND status = 'pending')`,
    ).bind(outcome, listingId, listingId),
    c.env.DB.prepare(
      `UPDATE market_offers SET status = 'declined', responded_at = datetime('now')
       WHERE listing_id = ? AND status = 'open'
         AND (SELECT status FROM market_listings WHERE id = ?) <> 'active'`,
    ).bind(listingId, listingId),
    c.env.DB.prepare("SELECT status, quantity FROM market_listings WHERE id = ?").bind(listingId),
  ]);
  if (!batchResults[0] || !changed(batchResults[0])) return fail(c, 409, "not_pending");
  const listingAfter = batchResults[3]?.results?.[0] as { status?: string; quantity?: number } | undefined;
  const remaining = listingAfter?.status === "active" ? Number(listingAfter.quantity) || 1 : 0;
  await logDeal(c.env, { listingId, dealId, actorId: who.id, action: "complete", from: "pending", to: outcome,
    note: remaining >= 1 ? `listing back to active, ${remaining} left` : "listing " + outcome });
  notifyTrader(c.env, c.ctx, buyerId, {
    title: (outcome === "traded" ? "Traded: " : "Sold to you: ") + title,
    body: `${who.name} marked ${title} ${outcome}. Leave feedback for them within 60 days.`,
    refKey: "mkt:deal:" + dealId + ":completed",
  });
  return ok(c, { deal: await dealView(c, dealId, who) });
}

// ---- Feedback ----

function ratingOf(value: unknown): Rating | null {
  return typeof value === "string" && (RATINGS as readonly string[]).includes(value) ? value as Rating : null;
}

async function feedbackView(c: MarketCtx, id: number, viewerId: string) {
  const rows = await feedbackRows(c.env, "f.id = ?", [id], 1);
  return rows.length ? (await feedbackViews(c.env, rows, viewerId))[0] ?? null : null;
}

export async function leaveFeedback(c: MarketCtx): Promise<Response> {
  const author = await requireTrader(c);
  if (author instanceof Response) return author;
  const body = (await readJson(c.request)) ?? {};
  const dealId = typeof body.dealId === "number" && Number.isInteger(body.dealId) && body.dealId > 0 ? body.dealId : null;
  const rating = ratingOf(body.rating);
  const comment = cleanText(body.comment, COMMENT_MAX);
  if (!dealId || !rating || comment == null) return fail(c, 400, "invalid_feedback");
  const deal = await getDealRow(c.env, dealId);
  if (!deal) return fail(c, 404, "not_found");
  const sellerId = str(deal, "seller_id");
  const buyerId = str(deal, "buyer_id");
  if (author.id !== sellerId && author.id !== buyerId) return fail(c, 403, "not_party");
  if (sellerId === buyerId) return fail(c, 403, "not_party");
  if (str(deal, "status") !== "completed") return fail(c, 409, "deal_not_complete");
  if (!feedbackOpen(deal)) return fail(c, 409, "window_closed");
  const blocked = await limited(c, "mktfb:" + author.id, 30, 3600);
  if (blocked) return blocked;
  const subjectId = author.id === sellerId ? buyerId : sellerId;
  const subjectRole = author.id === sellerId ? "buyer" : "seller";
  let id = 0;
  try {
    const inserted = await c.env.DB.prepare(
      "INSERT INTO market_feedback (deal_id, author_id, subject_id, subject_role, rating, comment) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    ).bind(dealId, author.id, subjectId, subjectRole, rating, comment).first<{ id: number }>();
    id = Number(inserted?.id) || 0;
  } catch {
    id = 0;
  }
  if (!id) return fail(c, 409, "already_left");
  await logDeal(c.env, { listingId: num(deal, "listing_id"), dealId, actorId: author.id, action: "feedback", note: rating });
  notifyTrader(c.env, c.ctx, subjectId, {
    title: "New feedback",
    body: `${author.name} left ${rating} feedback for ${str(deal, "listing_title")}.`,
    refKey: "mkt:feedback:" + id,
  });
  return ok(c, { feedback: await feedbackView(c, id, author.id) }, 201);
}

export async function editFeedback(c: MarketCtx, id: number): Promise<Response> {
  const author = await requireTrader(c);
  if (author instanceof Response) return author;
  const row = await c.env.DB.prepare("SELECT id, author_id, created_at, edited_at, removed_at FROM market_feedback WHERE id = ?")
    .bind(id).first<Row>();
  if (!row || row.removed_at || str(row, "author_id") !== author.id) return fail(c, 404, "not_found");
  if (row.edited_at) return fail(c, 409, "edit_used");
  if (Date.now() > sqlTime(str(row, "created_at")) + FEEDBACK_EDIT_DAYS * DAY_MS) return fail(c, 409, "edit_window_closed");
  const body = (await readJson(c.request)) ?? {};
  const rating = ratingOf(body.rating);
  const comment = cleanText(body.comment, COMMENT_MAX);
  if (!rating || comment == null) return fail(c, 400, "invalid_feedback");
  const result = await c.env.DB.prepare(
    "UPDATE market_feedback SET rating = ?, comment = ?, edited_at = datetime('now') WHERE id = ? AND author_id = ? AND edited_at IS NULL AND removed_at IS NULL",
  ).bind(rating, comment, id, author.id).run();
  if (!changed(result)) return fail(c, 409, "edit_used");
  return ok(c, { feedback: await feedbackView(c, id, author.id) });
}

export async function replyFeedback(c: MarketCtx, id: number): Promise<Response> {
  const subject = await requireTrader(c);
  if (subject instanceof Response) return subject;
  const row = await c.env.DB.prepare("SELECT id, author_id, subject_id, removed_at FROM market_feedback WHERE id = ?").bind(id).first<Row>();
  if (!row || row.removed_at) return fail(c, 404, "not_found");
  if (str(row, "subject_id") !== subject.id) return fail(c, 403, "not_subject");
  const body = (await readJson(c.request)) ?? {};
  const text = cleanText(body.body, COMMENT_MAX);
  if (!text) return fail(c, 400, "invalid_reply");
  try {
    await c.env.DB.prepare("INSERT INTO market_feedback_replies (feedback_id, author_id, body) VALUES (?, ?, ?)").bind(id, subject.id, text).run();
  } catch {
    return fail(c, 409, "reply_exists");
  }
  return ok(c, { feedback: await feedbackView(c, id, subject.id) }, 201);
}

// ---- Reports ----

export async function fileReport(c: MarketCtx): Promise<Response> {
  const reporter = await requireTrader(c);
  if (reporter instanceof Response) return reporter;
  const body = (await readJson(c.request)) ?? {};
  const kind = body.kind === "listing" || body.kind === "wanted" || body.kind === "feedback" ? body.kind : null;
  const id = typeof body.id === "number" && Number.isInteger(body.id) && body.id > 0 ? body.id : null;
  const reason = typeof body.reason === "string" && (REPORT_REASONS as readonly string[]).includes(body.reason) ? body.reason : null;
  const details = cleanText(body.details, COMMENT_MAX);
  if (!kind || !id || !reason || details == null) return fail(c, 400, "invalid_report");
  const owner = kind === "listing"
    ? await c.env.DB.prepare("SELECT seller_id AS owner FROM market_listings WHERE id = ?").bind(id).first<{ owner: string }>()
    : kind === "wanted"
      ? await c.env.DB.prepare("SELECT poster_id AS owner FROM market_wanted WHERE id = ?").bind(id).first<{ owner: string }>()
      : await c.env.DB.prepare("SELECT author_id AS owner FROM market_feedback WHERE id = ? AND removed_at IS NULL").bind(id).first<{ owner: string }>();
  if (!owner) return fail(c, 404, "not_found");
  if (owner.owner === reporter.id) return fail(c, 403, "own_item");
  const blocked = await limited(c, "mktreport:" + reporter.id, 10, 3600);
  if (blocked) return blocked;
  await ensureTrader(c.env, reporter);
  const result = await c.env.DB.prepare(
    `INSERT INTO market_reports (target_kind, target_id, reporter_id, reason, details) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(target_kind, target_id, reporter_id) DO UPDATE SET reason = excluded.reason, details = excluded.details,
       status = 'open', created_at = datetime('now'), resolved_at = NULL, resolved_by = NULL, resolution = NULL
     WHERE market_reports.status <> 'open'`,
  ).bind(kind, id, reporter.id, reason, details).run();
  if (!changed(result)) return fail(c, 409, "already_reported");
  notifyAdmins(c.ctx, c.env, {
    title: "Marketplace report",
    body: `A ${kind === "wanted" ? "WANTED post" : kind} was reported (${reason.replace("_", " ")}).`,
    url: "/admin.html#marketplace",
    tag: `market-report:${kind}:${id}`,
  });
  return ok(c, { ok: true }, 201);
}

// ---- My marketplace ----

export async function myMarket(c: MarketCtx): Promise<Response> {
  if (!c.actor) return fail(c, 401, "unauthorized");
  const me = c.actor;
  const env = c.env;
  const suspended = await isSuspended(env, me.id);
  const viewer = await viewerOf(env, me);
  const listingRows = (await env.DB.prepare(
    `SELECT l.id, l.seller_id, l.item_kind, l.gear_type, l.donate_percent, l.donate_cents, l.brand, l.mold, l.plastic, l.disc_type, l.weight_g,
            l.color, l.condition, l.price_cents, l.open_to_trade,
            l.quantity, l.location, l.status, l.hidden, l.created_at, l.withdrawn_at, l.withdrawal_final,
            (SELECT p.id FROM market_listing_photos p WHERE p.listing_id = l.id ORDER BY p.sort_order, p.id LIMIT 1) AS photo_id
     FROM market_listings l WHERE l.seller_id = ? ORDER BY CASE l.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, l.updated_at DESC
     LIMIT 60`,
  ).bind(me.id).all<Row>()).results ?? [];
  const pending = (await env.DB.prepare(
    `SELECT ${DEAL_COLUMNS} FROM market_deals d WHERE (d.seller_id = ? OR d.buyer_id = ?) AND d.status = 'pending' ORDER BY d.id DESC LIMIT 40`,
  ).bind(me.id, me.id).all<Row>()).results ?? [];
  const recent = (await env.DB.prepare(
    `SELECT ${DEAL_COLUMNS} FROM market_deals d WHERE (d.seller_id = ? OR d.buyer_id = ?) AND d.status = 'completed'
       AND d.completed_at >= datetime('now', '-60 days') ORDER BY d.completed_at DESC, d.id DESC LIMIT 40`,
  ).bind(me.id, me.id).all<Row>()).results ?? [];
  const offersIn = (await env.DB.prepare(
    `SELECT ${OFFER_COLUMNS} FROM market_offers o JOIN market_listings l ON l.id = o.listing_id
     WHERE l.seller_id = ? AND o.status = 'open' ORDER BY o.id DESC LIMIT 40`,
  ).bind(me.id).all<Row>()).results ?? [];
  const offersOut = (await env.DB.prepare(
    `SELECT ${OFFER_COLUMNS} FROM market_offers o JOIN market_listings l ON l.id = o.listing_id
     WHERE o.buyer_id = ? AND (o.status = 'open' OR o.responded_at >= datetime('now', '-30 days')) ORDER BY o.id DESC LIMIT 40`,
  ).bind(me.id).all<Row>()).results ?? [];
  const wantedRows = (await env.DB.prepare(
    `SELECT ${WANTED_COLUMNS} FROM market_wanted w WHERE w.poster_id = ? ORDER BY w.id DESC LIMIT 30`,
  ).bind(me.id).all<Row>()).results ?? [];
  const pendingViews = await dealViews(env, pending, me.id, suspended);
  // Completed sales: the seller's club donation for each (pledged or not), with where it stands.
  const donations = await sellerDonations(env, recent, me.id);
  const recentViews = (await dealViews(env, recent, me.id, suspended)).map((deal) => ({ ...deal, donation: donations.get(deal.id) ?? null }));
  return ok(c, {
    viewer,
    suspended,
    listings: await listingCards(env, listingRows, me.id),
    selling: pendingViews.filter((deal) => deal.role === "seller"),
    buying: pendingViews.filter((deal) => deal.role === "buyer"),
    offersIn: await offerViews(env, offersIn),
    offersOut: await offerViews(env, offersOut),
    wanted: await wantedViews(env, wantedRows, me.id, true),
    feedbackToLeave: recentViews.filter((deal) => deal.feedback.canLeave),
    recentDeals: recentViews,
    settings: me.kind === "member"
      ? (await sellerSettings(env, me.id)) ?? { paypalMe: "", cashtag: "", zelle: "", notifyEmail: "" }
      : null,
    waiting: await waitingCount(env, me.id),
  });
}

export async function mySummary(c: MarketCtx): Promise<Response> {
  if (!c.actor) return fail(c, 401, "unauthorized");
  return ok(c, { waiting: await waitingCount(c.env, c.actor.id) });
}

