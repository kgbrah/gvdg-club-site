// WANTED posts: members and verified guests post what they are looking for; members reply "I have one"
// with a listing and/or a message. Replies to a member go through member direct messages; replies to a
// guest are relayed by email (the guest's address is never shown to anyone). Posts expire after 60 days.

import { readJson } from "./http.js";
import { cleanText, COMMENT_MAX, DISC_TYPES, listingTitle, parseWanted, wantedTitle } from "./market-input.js";
import { isGuestId, notifyTrader, marketUrl, sendMarketEmail, traderEmail, emailConfigured } from "./market-notify.js";
import { sendMemberDirectMessage } from "./member-messages.js";
import {
  WANTED_COLUMNS, ensureTrader, isSuspended, num, str, viewerOf, wantedReplies, wantedStatus, wantedViews, type Row,
} from "./market-store.js";
import { changed, fail, limited, ok, requireSeller, requireTrader, type MarketCtx } from "./market-http.js";

const PAGE = 30;
export const WANTED_DAYS = 60;

function likeTerm(value: string): string {
  return "%" + value.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%";
}

async function getWantedRow(c: MarketCtx, id: number): Promise<Row | null> {
  return c.env.DB.prepare(`SELECT ${WANTED_COLUMNS} FROM market_wanted w WHERE w.id = ?`).bind(id).first<Row>();
}

async function wantedVisible(c: MarketCtx, row: Row): Promise<boolean> {
  const posterId = str(row, "poster_id");
  if (c.actor && (c.actor.id === posterId || c.actor.isAdmin)) return true;
  if (num(row, "hidden") === 1) return false;
  return !(await isSuspended(c.env, posterId));
}

export async function browseWanted(c: MarketCtx): Promise<Response> {
  const p = new URL(c.request.url).searchParams;
  const where = [
    "w.status = 'open'", "w.hidden = 0", "w.expires_at > datetime('now')",
    "NOT EXISTS (SELECT 1 FROM market_suspensions s WHERE s.owner_id = w.poster_id AND s.lifted_at IS NULL)",
  ];
  const binds: unknown[] = [];
  const type = p.get("type");
  if (type && (DISC_TYPES as readonly string[]).includes(type)) { where.push("w.disc_type = ?"); binds.push(type); }
  const q = (p.get("q") || "").trim();
  if (q && q.length <= 60) {
    const term = likeTerm(q);
    where.push("(w.brand LIKE ? ESCAPE '\\' OR w.mold LIKE ? ESCAPE '\\' OR w.plastic LIKE ? ESCAPE '\\' OR w.notes LIKE ? ESCAPE '\\')");
    binds.push(term, term, term, term);
  }
  const rawOffset = p.get("offset");
  const offset = rawOffset && /^\d{1,4}$/.test(rawOffset) ? Number(rawOffset) : 0;
  const rows = (await c.env.DB.prepare(
    `SELECT ${WANTED_COLUMNS} FROM market_wanted w WHERE ${where.join(" AND ")} ORDER BY w.created_at DESC, w.id DESC LIMIT ${PAGE + 1} OFFSET ?`,
  ).bind(...binds, offset).all<Row>()).results ?? [];
  return ok(c, {
    wanted: await wantedViews(c.env, rows.slice(0, PAGE), c.actor?.id ?? null),
    more: rows.length > PAGE,
    viewer: await viewerOf(c.env, c.actor),
  });
}

export async function getWanted(c: MarketCtx, id: number): Promise<Response> {
  const row = await getWantedRow(c, id);
  if (!row || !(await wantedVisible(c, row))) return fail(c, 404, "not_found");
  const [view] = await wantedViews(c.env, [row], c.actor?.id ?? null, true);
  return ok(c, { wanted: view, viewer: await viewerOf(c.env, c.actor) });
}

export async function createWanted(c: MarketCtx): Promise<Response> {
  const poster = await requireTrader(c);
  if (poster instanceof Response) return poster;
  const parsed = parseWanted((await readJson(c.request)) ?? {});
  if (!parsed.ok) return fail(c, 400, "invalid_wanted", parsed.field);
  const blocked = await limited(c, "mktwanted:" + poster.id, 5, 3600);
  if (blocked) return blocked;
  await ensureTrader(c.env, poster);
  const v = parsed.value;
  const created = await c.env.DB.prepare(
    `INSERT INTO market_wanted (poster_id, brand, mold, plastic, disc_type, weight_min, weight_max, condition_min, max_price_cents,
       open_to_trade, notes, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${WANTED_DAYS} days')) RETURNING id`,
  ).bind(poster.id, v.brand, v.mold, v.plastic, v.discType, v.weightMin, v.weightMax, v.conditionMin, v.maxPriceCents,
    v.openToTrade ? 1 : 0, v.notes).first<{ id: number }>();
  const row = await getWantedRow(c, Number(created?.id));
  return ok(c, { wanted: (await wantedViews(c.env, [row!], poster.id, true))[0] }, 201);
}

export async function closeWanted(c: MarketCtx, id: number): Promise<Response> {
  if (!c.actor) return fail(c, 401, "unauthorized");
  const row = await getWantedRow(c, id);
  if (!row || str(row, "poster_id") !== c.actor.id) return fail(c, 404, "not_found");
  const result = await c.env.DB.prepare(
    "UPDATE market_wanted SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND poster_id = ? AND status = 'open'",
  ).bind(id, c.actor.id).run();
  if (!changed(result)) return fail(c, 409, "not_open");
  return ok(c, { wanted: (await wantedViews(c.env, [(await getWantedRow(c, id))!], c.actor.id, true))[0] });
}

export async function replyWanted(c: MarketCtx, id: number): Promise<Response> {
  const seller = await requireSeller(c);
  if (seller instanceof Response) return seller;
  const row = await getWantedRow(c, id);
  if (!row || !(await wantedVisible(c, row)) || num(row, "hidden") === 1) return fail(c, 404, "not_found");
  const posterId = str(row, "poster_id");
  if (posterId === seller.id) return fail(c, 403, "own_item");
  if (wantedStatus(row) !== "open") return fail(c, 409, "not_open");
  const body = (await readJson(c.request)) ?? {};
  const text = cleanText(body.body, COMMENT_MAX);
  if (!text) return fail(c, 400, "invalid_reply", "body");
  let listing: { id: number; title: string } | null = null;
  if (body.listingId != null && body.listingId !== "") {
    const listingId = typeof body.listingId === "number" && Number.isInteger(body.listingId) && body.listingId > 0 ? body.listingId : null;
    const own = listingId
      ? await c.env.DB.prepare("SELECT id, brand, plastic, mold FROM market_listings WHERE id = ? AND seller_id = ? AND status = 'active' AND hidden = 0")
        .bind(listingId, seller.id).first<Row>()
      : null;
    if (!own) return fail(c, 400, "invalid_reply", "listingId");
    listing = { id: num(own, "id"), title: listingTitle({ brand: str(own, "brand"), plastic: str(own, "plastic"), mold: str(own, "mold") }) };
  }
  const blocked = await limited(c, "mktreply:" + seller.id, 20, 3600);
  if (blocked) return blocked;
  await ensureTrader(c.env, seller);
  const inserted = await c.env.DB.prepare(
    "INSERT INTO market_wanted_replies (wanted_id, replier_id, listing_id, body) VALUES (?, ?, ?, ?) RETURNING id",
  ).bind(id, seller.id, listing?.id ?? null, text).first<{ id: number }>();
  const replyId = Number(inserted?.id);
  const title = wantedTitle({ brand: str(row, "brand"), plastic: str(row, "plastic"), mold: str(row, "mold"), disc_type: str(row, "disc_type") });
  const listingLine = listing ? `\nListing: ${listing.title} - ${marketUrl(c.env, "market/listing/" + listing.id)}` : "";
  if (isGuestId(posterId)) {
    // Email relay: the guest sees the member's name and message, never the other way round.
    const relay = (async () => {
      if (!emailConfigured(c.env)) return;
      const to = await traderEmail(c.env, posterId);
      if (!to) return;
      await sendMarketEmail(c.env, to, `I have one: ${title}`, [
        `${seller.name} (GVDG member) replied to your WANTED post "${title}":`, "", text, listingLine.trim(), "",
        "See replies on your WANTED post: " + marketUrl(c.env, "wanted/" + id), "",
        "Your email address was not shared. - Greenville Disc Golf Club Pro Shop",
      ].filter((line, index, all) => line || all[index - 1] !== "").join("\n"));
    })().catch(() => {});
    try { c.ctx?.waitUntil?.(relay); } catch { /* settles on its own */ }
  } else {
    const message = `I have one for your WANTED post "${title}": ${text}${listing ? `\n${listing.title}: ${marketUrl(c.env, "market/listing/" + listing.id)}` : ""}`;
    const dm = sendMemberDirectMessage(c.env, c.ctx, seller.id, posterId, message).catch(() => null);
    try { c.ctx?.waitUntil?.(dm); } catch { /* settles on its own */ }
    notifyTrader(c.env, c.ctx, posterId, {
      title: "I have one: " + title,
      body: `${seller.name} replied to your WANTED post${listing ? " with " + listing.title : ""}.`,
      refKey: "mkt:wanted-reply:" + replyId,
      hash: "wanted/" + id,
      emailOnly: true,
    });
  }
  const replies = await wantedReplies(c.env, id);
  return ok(c, { reply: replies.find((reply) => reply.id === replyId) ?? null }, 201);
}
