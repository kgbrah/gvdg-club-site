// Giving part of a sale to the club. A listing can carry a pledge (a percentage of the sale or a set amount; buyers see
// it). Once a sale is complete, the seller sends the donation to the club's PayPal (a paypal.me link with the amount
// filled in) and says so; buyers pay sellers directly, so the app can't see the money move, and an admin confirms it
// arrived before anything is awarded: +10 karma for every whole dollar (every donation earns the same: owner, "Let's
// make ALL donations reward +10 karma per dollar"; club-donations.ts has the direct ones), added to the seller's karma.
//
//   POST /market/deals/:id/donation            (the seller) { amountCents } -> { donation }
//   POST /admin/market/donations/:id/review    (admin) { decision: "received" | "not_received", reason? } -> { ok }
import { notifyAdmins } from "./admin-push.js";
import type { Env } from "./env.js";
import { readJson } from "./http.js";
import { dollars } from "./market-input.js";
import { fail, limited, ok, type MarketCtx } from "./market-http.js";
import { notifyTrader } from "./market-notify.js";
import { getDealRow, logDeal, logModeration, num, numOrNull, str, tradersByOwner, liteOf, type Row } from "./market-store.js";

/** The club's PayPal.me (the same account as the site's Donate link). */
export const CLUB_PAYPAL_ME = "greenvillediscgolf";
export const DONATION_MIN_CENTS = 100;
export const DONATION_MAX_CENTS = 100_000;

export function clubDonationUrl(cents: number): string {
  return `https://paypal.me/${CLUB_PAYPAL_ME}/${dollars(cents)}`;
}

/** Karma for every whole dollar of a confirmed donation (marketplace gifts and direct donations alike). */
export const KARMA_PER_DOLLAR = 10;

/** Karma for a confirmed donation: KARMA_PER_DOLLAR for every whole dollar. */
export function donationKarma(cents: number): number {
  return Math.max(0, Math.floor(cents / 100)) * KARMA_PER_DOLLAR;
}

/** What a pledge comes to on a sale: its percentage of the price, or its set amount (never more than the price). */
export function pledgedCents(priceCents: number | null, percent: number | null, cents: number | null): number | null {
  if (!priceCents || priceCents < DONATION_MIN_CENTS) return null;
  const raw = percent ? Math.round((priceCents * percent) / 100) : cents ?? null;
  if (!raw) return null;
  return Math.min(priceCents, Math.max(DONATION_MIN_CENTS, raw));
}

export interface DonationView {
  dealId: number;
  status: "none" | "sent" | "confirmed" | "not_received";
  amountCents: number | null;
  suggestedCents: number | null;
  pledged: boolean;
  karma: number;
  maxCents: number;
  payUrl: string | null;
  reviewNote: string;
}

/** The donation state of the seller's completed sales (sold with a price), keyed by deal id. */
export async function sellerDonations(env: Env, deals: Row[], sellerId: string): Promise<Map<number, DonationView>> {
  const out = new Map<number, DonationView>();
  const sales = deals.filter((row) => str(row, "seller_id") === sellerId && str(row, "status") === "completed"
    && str(row, "outcome") === "sold" && (numOrNull(row, "price_cents") ?? 0) >= DONATION_MIN_CENTS);
  if (!sales.length) return out;
  const marks = (ids: number[]) => ids.map(() => "?").join(",");
  const dealIds = sales.map((row) => num(row, "id"));
  const listingIds = [...new Set(sales.map((row) => num(row, "listing_id")))];
  const [pledges, donations] = await Promise.all([
    env.DB.prepare(`SELECT id, donate_percent, donate_cents FROM market_listings WHERE id IN (${marks(listingIds)})`).bind(...listingIds).all<Row>(),
    env.DB.prepare(`SELECT deal_id, amount_cents, status, karma, review_note FROM market_donations WHERE deal_id IN (${marks(dealIds)})`)
      .bind(...dealIds).all<Row>(),
  ]);
  const pledgeOf = new Map((pledges.results ?? []).map((row) => [num(row, "id"), row]));
  const donationOf = new Map((donations.results ?? []).map((row) => [num(row, "deal_id"), row]));
  for (const deal of sales) {
    const id = num(deal, "id");
    const price = numOrNull(deal, "price_cents")!;
    const pledge = pledgeOf.get(num(deal, "listing_id"));
    const suggested = pledgedCents(price, numOrNull(pledge, "donate_percent"), numOrNull(pledge, "donate_cents"));
    const given = donationOf.get(id);
    const amount = given ? num(given, "amount_cents") : suggested;
    const status = given ? (str(given, "status") as DonationView["status"]) : "none";
    out.set(id, {
      dealId: id, status, amountCents: given ? num(given, "amount_cents") : null, suggestedCents: suggested, pledged: suggested != null,
      karma: given ? num(given, "karma") : 0, maxCents: Math.min(price, DONATION_MAX_CENTS),
      payUrl: status === "confirmed" || !amount ? null : clubDonationUrl(amount),
      reviewNote: given && status === "not_received" ? str(given, "review_note") : "",
    });
  }
  return out;
}

/** The seller says they sent their donation for this sale (again, after "not received"; or a new amount before review). */
export async function sendDonation(c: MarketCtx, dealId: number): Promise<Response> {
  if (!c.actor) return fail(c, 401, "unauthorized");
  if (c.actor.kind !== "member") return fail(c, 403, "members_only");
  const deal = await getDealRow(c.env, dealId);
  if (!deal || str(deal, "seller_id") !== c.actor.id) return fail(c, 404, "not_found");
  const price = numOrNull(deal, "price_cents") ?? 0;
  if (str(deal, "status") !== "completed" || str(deal, "outcome") !== "sold" || price < DONATION_MIN_CENTS) return fail(c, 409, "not_a_sale");
  const body = (await readJson(c.request)) ?? {};
  const amount = Number(body.amountCents);
  if (!Number.isInteger(amount) || amount < DONATION_MIN_CENTS || amount > Math.min(price, DONATION_MAX_CENTS)) {
    return fail(c, 400, "invalid_amount");
  }
  const blocked = await limited(c, "mktdonate:" + c.actor.id, 20, 3600);
  if (blocked) return blocked;
  const existing = await c.env.DB.prepare("SELECT status FROM market_donations WHERE deal_id = ?").bind(dealId).first<{ status: string }>();
  if (existing?.status === "confirmed") return fail(c, 409, "already_confirmed");
  await c.env.DB.prepare(
    `INSERT INTO market_donations (deal_id, seller_id, amount_cents) VALUES (?, ?, ?)
     ON CONFLICT(deal_id) DO UPDATE SET amount_cents = excluded.amount_cents, status = 'sent', sent_at = datetime('now'),
       reviewed_at = NULL, reviewed_by = NULL, review_note = ''
     WHERE market_donations.status <> 'confirmed'`,
  ).bind(dealId, c.actor.id, amount).run();
  await logDeal(c.env, { listingId: num(deal, "listing_id"), dealId, actorId: c.actor.id, action: "donation_sent", note: "$" + dollars(amount) });
  notifyAdmins(c.ctx, c.env, {
    title: "Donation to confirm",
    body: `${c.actor.name} says they sent the club $${dollars(amount)} from the sale of ${str(deal, "listing_title")}. Check the club PayPal and confirm it.`,
    url: "/admin.html#marketplace",
    tag: "market-donation:" + dealId,
  });
  const views = await sellerDonations(c.env, [deal], c.actor.id);
  return ok(c, { donation: views.get(dealId) ?? null });
}

/** Donations waiting for an admin, oldest first, with who sent them and for what. */
export async function donationsToReview(env: Env) {
  const rows = (await env.DB.prepare(
    `SELECT d.id, d.deal_id, d.seller_id, d.amount_cents, d.sent_at, m.listing_id, m.listing_title, m.price_cents, m.completed_at
     FROM market_donations d JOIN market_deals m ON m.id = d.deal_id WHERE d.status = 'sent' ORDER BY d.sent_at, d.id LIMIT 50`,
  ).all<Row>()).results ?? [];
  const traders = await tradersByOwner(env, rows.map((row) => str(row, "seller_id")));
  return rows.map((row) => ({
    id: num(row, "id"), dealId: num(row, "deal_id"), listingId: num(row, "listing_id"), seller: liteOf(traders, str(row, "seller_id")),
    amountCents: num(row, "amount_cents"),
    listingTitle: str(row, "listing_title"), priceCents: numOrNull(row, "price_cents"), sentAt: str(row, "sent_at"),
    karma: donationKarma(num(row, "amount_cents")),
  }));
}

export async function pendingDonationCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM market_donations WHERE status = 'sent'").first<{ n: number }>();
  return Number(row?.n) || 0;
}

/** An admin checked the club PayPal: received (karma fixed now) or not received (the seller can send it again). */
export async function reviewDonation(c: MarketCtx, adminId: string, id: number, body: Record<string, unknown>): Promise<Response> {
  const decision = body.decision === "received" || body.decision === "not_received" ? body.decision : null;
  if (!decision) return fail(c, 400, "invalid_request");
  const note = typeof body.reason === "string" ? body.reason.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 200) : "";
  if (decision === "not_received" && note.length < 3) return fail(c, 400, "reason_required");
  const row = await c.env.DB.prepare(
    `SELECT d.id, d.deal_id, d.seller_id, d.amount_cents, m.listing_title, m.listing_id FROM market_donations d
     JOIN market_deals m ON m.id = d.deal_id WHERE d.id = ? AND d.status = 'sent'`,
  ).bind(id).first<Row>();
  if (!row) return fail(c, 409, "not_open");
  const amount = num(row, "amount_cents");
  const karma = decision === "received" ? donationKarma(amount) : 0;
  const result = await c.env.DB.prepare(
    `UPDATE market_donations SET status = ?, karma = ?, reviewed_at = datetime('now'), reviewed_by = ?, review_note = ?
     WHERE id = ? AND status = 'sent'`,
  ).bind(decision === "received" ? "confirmed" : "not_received", karma, adminId, note, id).run();
  if (!Number(result.meta?.changes)) return fail(c, 409, "not_open");
  await logModeration(c.env, adminId, decision === "received" ? "donation_confirmed" : "donation_not_received", "donation", id,
    note || `$${dollars(amount)} received`);
  const title = str(row, "listing_title");
  notifyTrader(c.env, c.ctx, str(row, "seller_id"), decision === "received"
    ? {
      title: `Thank you: +${karma} karma`,
      body: `The club received your $${dollars(amount)} donation from the sale of ${title}. That's +${karma} karma. Thank you for supporting the club!`,
      refKey: "mkt:donation:" + id + ":confirmed", hash: "my-market",
    }
    : {
      title: "Your club donation didn't arrive",
      body: `The club couldn't find your $${dollars(amount)} donation from the sale of ${title} (${note}). Check PayPal, then send it and mark it again in My marketplace.`,
      refKey: "mkt:donation:" + id + ":missing:" + Date.now(), hash: "my-market",
    });
  return ok(c, { ok: true });
}
