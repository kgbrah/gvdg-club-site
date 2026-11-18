// Disc marketplace in the Pro Shop: one entry point for /market/* and /admin/market/*.
//
// Who can do what (decided by the club owner):
//   - anyone can browse listings, WANTED posts and feedback profiles;
//   - members and verified guests can buy, propose trades, post WANTED, leave feedback and report;
//   - only members can list a disc, set payment handles and answer a WANTED post with "I have one";
//   - payment handles are shown to signed-in members and verified guests only;
//   - admins moderate (reports, hide / unhide, remove feedback, suspend).
// All authorization happens here, server-side, from the bearer token; client-sent ids are never trusted.

import type { Env } from "./env.js";
import { handleMarketAdmin } from "./market-admin.js";
import { buyListing, dealAction, editFeedback, fileReport, leaveFeedback, myMarket, mySummary, offerAction, proposeTrade, replyFeedback } from "./market-deals.js";
import { startGuest, verifyGuest } from "./market-guest.js";
import { idOf, fail, ok, type MarketCtx, type WaitCtx } from "./market-http.js";
import {
  addListingPhoto, browseListings, createListing, deleteListingPhoto, editListing, getListing, relistListing, servePhoto, settingsRoute, withdrawListing,
} from "./market-listings.js";
import { emailConfigured } from "./market-notify.js";
import {
  LISTING_COLUMNS, feedbackRows, feedbackSummaries, feedbackViews, isSuspended, listingCards, ownerByKey, publicPhoto, resolveActor,
  summaryOf, viewerOf, type Row,
} from "./market-store.js";
import { browseWanted, closeWanted, createWanted, getWanted, replyWanted } from "./market-wanted.js";

async function traderProfile(c: MarketCtx, key: string): Promise<Response> {
  const owner = await ownerByKey(c.env, key);
  if (!owner) return fail(c, 404, "not_found");
  const suspended = await isSuspended(c.env, owner.ownerId);
  if (suspended && !(c.actor && (c.actor.isAdmin || c.actor.id === owner.ownerId))) return fail(c, 404, "not_found");
  const [summaries, asSellerRows, asBuyerRows] = await Promise.all([
    feedbackSummaries(c.env, [owner.ownerId]),
    feedbackRows(c.env, "f.subject_id = ? AND f.subject_role = 'seller'", [owner.ownerId], 25),
    feedbackRows(c.env, "f.subject_id = ? AND f.subject_role = 'buyer'", [owner.ownerId], 25),
  ]);
  const listings = (await c.env.DB.prepare(
    `SELECT ${LISTING_COLUMNS} FROM market_listings l WHERE l.seller_id = ? AND l.status IN ('active', 'pending') AND l.hidden = 0
     ORDER BY l.created_at DESC, l.id DESC LIMIT 24`,
  ).bind(owner.ownerId).all<Row>()).results ?? [];
  const viewerId = c.actor?.id ?? null;
  const viewerSuspended = c.actor ? await isSuspended(c.env, c.actor.id) : false;
  return ok(c, {
    trader: {
      key, name: owner.name, kind: owner.kind, photo: await publicPhoto(c.env, owner.ownerId),
      feedback: summaryOf(summaries, owner.ownerId),
    },
    asSeller: await feedbackViews(c.env, asSellerRows, viewerId, viewerSuspended),
    asBuyer: await feedbackViews(c.env, asBuyerRows, viewerId, viewerSuspended),
    listings: await listingCards(c.env, listings, viewerId),
    viewer: await viewerOf(c.env, c.actor),
  });
}

export function isMarketRoute(pathname: string): boolean {
  return pathname.startsWith("/market/") || pathname.startsWith("/admin/market/") || pathname === "/admin/market";
}

export async function handleMarket(
  request: Request, env: Env, origin: string | null, pathname: string, method: string, ctx?: WaitCtx,
): Promise<Response | null> {
  if (!isMarketRoute(pathname)) return null;
  const seg = pathname.split("/").filter(Boolean);
  const c: MarketCtx = { request, env, origin, ctx, actor: null };
  if (seg[0] === "admin") return handleMarketAdmin(c, method, seg);

  // Photos are fetched by <img> without a token; skip the identity lookup.
  if (method === "GET" && seg[1] === "photos" && seg.length === 3) {
    const id = idOf(seg[2]);
    return id ? servePhoto(c, id) : fail(c, 404, "not_found");
  }
  c.actor = await resolveActor(request, env);
  const [, area, a, b, d] = seg;

  if (area === "config" && seg.length === 2 && method === "GET") {
    return ok(c, { guestCheckout: emailConfigured(env), viewer: await viewerOf(env, c.actor) });
  }
  if (area === "guest" && seg.length === 3 && method === "POST") {
    if (a === "start") return startGuest(c);
    if (a === "verify") return verifyGuest(c);
  }
  if (area === "me" && method === "GET") {
    if (seg.length === 2) return myMarket(c);
    if (seg.length === 3 && a === "summary") return mySummary(c);
  }
  if (area === "settings" && seg.length === 2) return settingsRoute(c, method);
  if (area === "traders" && seg.length === 3 && method === "GET") return traderProfile(c, a || "");
  if (area === "reports" && seg.length === 2 && method === "POST") return fileReport(c);

  if (area === "listings") {
    if (seg.length === 2) {
      if (method === "GET") return browseListings(c);
      if (method === "POST") return createListing(c);
    }
    const id = idOf(a);
    if (!id) return fail(c, 404, "not_found");
    if (seg.length === 3) {
      if (method === "GET") return getListing(c, id);
      if (method === "PATCH") return editListing(c, id);
    }
    if (seg.length === 4 && method === "POST") {
      if (b === "buy") return buyListing(c, id);
      if (b === "offers") return proposeTrade(c, id);
      if (b === "withdraw") return withdrawListing(c, id);
      if (b === "relist") return relistListing(c, id);
      if (b === "photos") return addListingPhoto(c, id);
    }
    if (seg.length === 5 && b === "photos" && method === "DELETE") {
      const photoId = idOf(d);
      return photoId ? deleteListingPhoto(c, id, photoId) : fail(c, 404, "not_found");
    }
    return fail(c, 404, "not_found");
  }

  if (area === "offers" && seg.length === 4 && method === "POST") {
    const id = idOf(a);
    if (id && (b === "accept" || b === "decline" || b === "withdraw")) return offerAction(c, id, b);
  }
  if (area === "deals" && seg.length === 4 && method === "POST") {
    const id = idOf(a);
    if (id && (b === "complete" || b === "release" || b === "cancel")) return dealAction(c, id, b);
  }

  if (area === "feedback") {
    if (seg.length === 2 && method === "POST") return leaveFeedback(c);
    const id = idOf(a);
    if (id && seg.length === 3 && method === "PATCH") return editFeedback(c, id);
    if (id && seg.length === 4 && b === "reply" && method === "POST") return replyFeedback(c, id);
  }

  if (area === "wanted") {
    if (seg.length === 2) {
      if (method === "GET") return browseWanted(c);
      if (method === "POST") return createWanted(c);
    }
    const id = idOf(a);
    if (id && seg.length === 3 && method === "GET") return getWanted(c, id);
    if (id && seg.length === 4 && method === "POST") {
      if (b === "close") return closeWanted(c, id);
      if (b === "replies") return replyWanted(c, id);
    }
  }

  return fail(c, 404, "not_found");
}
