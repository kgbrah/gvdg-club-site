// Lost & Found social side: celebrations after a confirmed return (1-2 photos whose writing is hidden the same
// way as a post's + a caption), the Returned wall with Top finders, finder profiles (karma), reports, "My posts",
// and the small summary that rides along the member inbox summary (no extra request on member Home).

import type { Env } from "./env.js";
import { notifyAdmins } from "./admin-push.js";
import { readJson } from "./http.js";
import { discTitle, LF_REPORT_REASONS, MAX_CELEBRATION_PHOTOS, parseCaption } from "./lf-input.js";
import { processCelebration } from "./lf-process.js";
import {
  CELEBRATION_COLUMNS, CLAIM_COLUMNS, MATCH_COLUMNS, POST_COLUMNS, celebrationCards, getClaimRow, karmaOf, matchReasonLabels, parseReasons,
  people, postCards, recentReturns, strength, topFinders,
} from "./lf-store.js";
import { LF_BODY_BYTES, requirePerson, storeOriginals } from "./lf-posts.js";
import { photosFrom } from "./lf-image-header.js";
import { photoView, uploaderPhotos } from "./lf-photos.js";
import { claimView } from "./lf-claims.js";
import { cleanText } from "./market-input.js";
import { changed, fail, limited, ok, type MarketCtx } from "./market-http.js";
import { ensureTrader, num, ownerByKey, str, viewerOf, type Row } from "./market-store.js";

export async function createCelebration(c: MarketCtx, claimId: number): Promise<Response> {
  const me = requirePerson(c);
  if (me instanceof Response) return me;
  if (!c.env.PHOTOS) return fail(c, 503, "storage_unavailable");
  const claim = await getClaimRow(c.env, claimId);
  const role = claim ? (str(claim, "finder_id") === me.id ? "finder" : str(claim, "owner_id") === me.id ? "owner" : null) : null;
  if (!claim || !role) return fail(c, 404, "not_found");
  if (str(claim, "status") !== "confirmed") return fail(c, 409, "not_confirmed");
  const reversed = await c.env.DB.prepare("SELECT 1 AS hit FROM lf_karma WHERE claim_id = ? AND reason = 'admin_reversal'").bind(claimId).first();
  if (reversed) return fail(c, 409, "not_confirmed");
  const body = (await readJson(c.request, LF_BODY_BYTES)) ?? {};
  const caption = parseCaption(body.caption);
  if (caption == null) return fail(c, 400, "invalid_celebration", "caption");
  if (!Array.isArray(body.photos) || body.photos.length < 1 || body.photos.length > MAX_CELEBRATION_PHOTOS) return fail(c, 400, "invalid_photo");
  const images = photosFrom(body.photos, 1, MAX_CELEBRATION_PHOTOS);
  if (!images) return fail(c, 400, "invalid_photo");
  const blocked = await limited(c, "lfceleb:" + me.id, 5, 3600);
  if (blocked) return blocked;
  await ensureTrader(c.env, me);
  let id = 0;
  try {
    const inserted = await c.env.DB.prepare("INSERT INTO lf_celebrations (claim_id, author_id, role, caption) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(claimId, me.id, role, caption).first<{ id: number }>();
    id = Number(inserted?.id) || 0;
  } catch {
    id = 0;
  }
  if (!id) return fail(c, 409, "already_celebrated");
  let stored: string[] = [];
  try {
    stored = await storeOriginals(c, { ownerId: me.id, celebrationId: id }, images);
  } catch (error) {
    await Promise.all(stored.map((key) => c.env.PHOTOS.delete(key).catch(() => {})));
    await c.env.DB.prepare("DELETE FROM lf_photos WHERE celebration_id = ?").bind(id).run().catch(() => {});
    await c.env.DB.prepare("DELETE FROM lf_celebrations WHERE id = ?").bind(id).run().catch(() => {});
    throw error;
  }
  const job = processCelebration(c.env, id);
  try { c.ctx?.waitUntil?.(job); } catch { /* settles on its own */ }
  const row = await c.env.DB.prepare(
    `SELECT ${CELEBRATION_COLUMNS} FROM lf_celebrations e JOIN lf_claims c ON c.id = e.claim_id JOIN lf_posts p ON p.id = c.found_id WHERE e.id = ?`,
  ).bind(id).first<Row>();
  return ok(c, { celebration: (await celebrationCards(c.env, [row!], me.id))[0], myPhotos: await uploaderPhotos(c, { celebrationId: id }) }, 201);
}

const WALL_WHERE = `e.hidden = 0 AND p.hidden = 0 AND c.status = 'confirmed'
  AND NOT EXISTS (SELECT 1 FROM lf_karma k WHERE k.claim_id = c.id AND k.reason = 'admin_reversal')`;

/** The Returned wall: celebrations, recent returns and Top finders. Public; no AI, cacheable. */
export async function returnedWall(c: MarketCtx): Promise<Response> {
  const p = new URL(c.request.url).searchParams;
  const compact = p.get("view") === "strip";
  const limitRaw = p.get("limit");
  const limit = limitRaw && /^\d{1,2}$/.test(limitRaw) ? Math.max(1, Math.min(24, Number(limitRaw))) : 24;
  const recent = await recentReturns(c.env, compact ? Math.min(limit, 8) : 12, compact ? 120 : 365);
  if (compact) {
    return ok(c, { recent }, 200);
  }
  const rows = (await c.env.DB.prepare(
    `SELECT ${CELEBRATION_COLUMNS} FROM lf_celebrations e JOIN lf_claims c ON c.id = e.claim_id JOIN lf_posts p ON p.id = c.found_id
     WHERE ${WALL_WHERE} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
  ).bind(limit).all<Row>()).results ?? [];
  return ok(c, {
    celebrations: await celebrationCards(c.env, rows, c.actor?.id ?? null),
    recent,
    topFinders: await topFinders(c.env, 5),
    viewer: await viewerOf(c.env, c.actor),
  });
}

export async function finderProfile(c: MarketCtx, key: string): Promise<Response> {
  const owner = await ownerByKey(c.env, key);
  if (!owner) return fail(c, 404, "not_found");
  const person = await people(c.env, [owner.ownerId]);
  const celebrations = (await c.env.DB.prepare(
    `SELECT ${CELEBRATION_COLUMNS} FROM lf_celebrations e JOIN lf_claims c ON c.id = e.claim_id JOIN lf_posts p ON p.id = c.found_id
     WHERE ${WALL_WHERE} AND (e.author_id = ? OR c.finder_id = ?) ORDER BY e.created_at DESC, e.id DESC LIMIT 12`,
  ).bind(owner.ownerId, owner.ownerId).all<Row>()).results ?? [];
  const posts = (await c.env.DB.prepare(
    `SELECT ${POST_COLUMNS} FROM lf_posts p WHERE p.owner_id = ? AND p.kind = 'found' AND p.status IN ('open', 'claimed') AND p.hidden = 0
       AND p.expires_at > datetime('now') ORDER BY p.created_at DESC LIMIT 12`,
  ).bind(owner.ownerId).all<Row>()).results ?? [];
  return ok(c, {
    person: person(owner.ownerId),
    celebrations: await celebrationCards(c.env, celebrations, c.actor?.id ?? null),
    posts: await postCards(c.env, posts, c.actor?.id ?? null),
    viewer: await viewerOf(c.env, c.actor),
  });
}

export async function fileReport(c: MarketCtx): Promise<Response> {
  const me = requirePerson(c);
  if (me instanceof Response) return me;
  const body = (await readJson(c.request)) ?? {};
  const kind = body.kind === "post" || body.kind === "celebration" ? body.kind : null;
  const id = typeof body.id === "number" && Number.isInteger(body.id) && body.id > 0 ? body.id : null;
  const reason = typeof body.reason === "string" && (LF_REPORT_REASONS as readonly string[]).includes(body.reason) ? body.reason : null;
  const details = cleanText(body.details, 300);
  if (!kind || !id || !reason || details == null) return fail(c, 400, "invalid_report");
  const owner = kind === "post"
    ? await c.env.DB.prepare("SELECT owner_id AS owner FROM lf_posts WHERE id = ? AND hidden = 0").bind(id).first<{ owner: string }>()
    : await c.env.DB.prepare("SELECT author_id AS owner FROM lf_celebrations WHERE id = ? AND hidden = 0").bind(id).first<{ owner: string }>();
  if (!owner) return fail(c, 404, "not_found");
  if (owner.owner === me.id) return fail(c, 403, "own_item");
  const blocked = await limited(c, "lfreport:" + me.id, 10, 3600);
  if (blocked) return blocked;
  await ensureTrader(c.env, me);
  const result = await c.env.DB.prepare(
    `INSERT INTO lf_reports (target_kind, target_id, reporter_id, reason, details) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(target_kind, target_id, reporter_id) DO UPDATE SET reason = excluded.reason, details = excluded.details,
       status = 'open', created_at = datetime('now'), resolved_at = NULL, resolved_by = NULL, resolution = NULL
     WHERE lf_reports.status <> 'open'`,
  ).bind(kind, id, me.id, reason, details).run();
  if (!changed(result)) return fail(c, 409, "already_reported");
  notifyAdmins(c.ctx, c.env, {
    title: kind === "celebration" ? "Lost & Found celebration reported" : "Lost & Found post reported",
    body: `A ${kind} was reported (${reason.replace("_", " ")}).`,
    url: "/admin.html#lost-found",
    tag: `lf-report:${kind}:${id}`,
  });
  return ok(c, { ok: true }, 201);
}

/** Everything for "My posts": my posts, "Is this yours?" suggestions, claims either way, karma. */
export async function myLostFound(c: MarketCtx): Promise<Response> {
  const me = requirePerson(c);
  if (me instanceof Response) return me;
  const env = c.env;
  const postRows = (await env.DB.prepare(
    `SELECT ${POST_COLUMNS} FROM lf_posts p WHERE p.owner_id = ? AND p.status <> 'merged'
     ORDER BY CASE p.status WHEN 'claimed' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, p.updated_at DESC LIMIT 60`,
  ).bind(me.id).all<Row>()).results ?? [];
  const matchRows = (await env.DB.prepare(
    `SELECT ${MATCH_COLUMNS} FROM lf_matches m JOIN lf_posts f ON f.id = m.found_id
     WHERE m.candidate_id = ? AND f.status IN ('open', 'claimed') AND f.hidden = 0 AND f.expires_at > datetime('now')
       AND (m.status = 'notified' OR (m.status = 'suggested' AND m.lost_id IS NOT NULL))
       AND NOT EXISTS (SELECT 1 FROM lf_claims x WHERE x.found_id = m.found_id AND x.owner_id = m.candidate_id AND x.status IN ('open', 'returned', 'confirmed'))
     ORDER BY m.score DESC, m.id DESC LIMIT 20`,
  ).bind(me.id).all<Row>()).results ?? [];
  const foundForMatches = matchRows.length
    ? (await env.DB.prepare(`SELECT ${POST_COLUMNS} FROM lf_posts p WHERE p.id IN (${matchRows.map(() => "?").join(",")})`)
      .bind(...matchRows.map((row) => num(row, "found_id"))).all<Row>()).results ?? []
    : [];
  const foundCards = new Map((await postCards(env, foundForMatches, me.id)).map((card) => [card.id, card]));
  const claimRows = (await env.DB.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM lf_claims c WHERE (c.owner_id = ? OR c.finder_id = ?)
       AND (c.status IN ('open', 'returned') OR (c.status = 'confirmed' AND c.confirmed_at >= datetime('now', '-60 days')))
     ORDER BY CASE c.status WHEN 'returned' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, c.id DESC LIMIT 40`,
  ).bind(me.id, me.id).all<Row>()).results ?? [];
  const claims = [];
  for (const row of claimRows) claims.push(await claimView(c, row, me));
  const karma = (await karmaOf(env, [me.id])).get(me.id) ?? { karma: 0, returned: 0 };
  // My photos whose writing is still being hidden ("Finish hiding the writing" when the poster left early).
  const hidingRows = (await env.DB.prepare(
    `SELECT ph.id, ph.post_id, ph.celebration_id, ph.width, ph.height, ph.redaction, ph.rejections, ph.attempts, ph.last_error, ph.sort_order,
            COALESCE(p.brand, cp.brand) AS brand, COALESCE(p.mold, cp.mold) AS mold, COALESCE(p.plastic, cp.plastic) AS plastic, COALESCE(p.color, cp.color) AS color
     FROM lf_photos ph LEFT JOIN lf_posts p ON p.id = ph.post_id
       LEFT JOIN lf_celebrations e ON e.id = ph.celebration_id LEFT JOIN lf_claims cc ON cc.id = e.claim_id LEFT JOIN lf_posts cp ON cp.id = cc.found_id
     WHERE ph.owner_id = ? AND ph.redaction IN ('pending', 'hiding', 'verifying', 'failed')
       AND (p.id IS NULL OR p.status IN ('open', 'claimed', 'returned'))
     ORDER BY ph.id DESC LIMIT 24`,
  ).bind(me.id).all<Row>()).results ?? [];
  return ok(c, {
    viewer: await viewerOf(env, me),
    karma,
    posts: await postCards(env, postRows, me.id),
    matches: matchRows.map((row) => ({
      id: num(row, "id"), status: str(row, "status"), strength: strength(num(row, "score")),
      reasons: matchReasonLabels(parseReasons(row.reasons)), found: foundCards.get(num(row, "found_id")) ?? null,
    })).filter((row) => row.found),
    claims,
    hiding: hidingRows.map((row) => ({
      ...photoView(row), postId: row.post_id == null ? null : num(row, "post_id"),
      celebrationId: row.celebration_id == null ? null : num(row, "celebration_id"), title: discTitle(row as never),
    })),
  });
}

/** Member Home: what waits on me in Lost & Found (matches to answer, returns to finish, photos whose writing I
 *  still need to hide) and the latest returns. Cheap: a few small queries. */
export async function lostFoundSummary(env: Env, memberId: string) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM lf_matches m JOIN lf_posts f ON f.id = m.found_id
          WHERE m.candidate_id = ? AND m.status = 'notified' AND f.status IN ('open', 'claimed') AND f.hidden = 0) +
       (SELECT COUNT(*) FROM lf_claims WHERE finder_id = ? AND status = 'open') +
       (SELECT COUNT(*) FROM lf_claims WHERE owner_id = ? AND status = 'returned') +
       (SELECT COUNT(*) FROM lf_photos WHERE owner_id = ? AND redaction = 'hiding') AS n`,
  ).bind(memberId, memberId, memberId, memberId).first<{ n: number }>();
  const recent = (await recentReturns(env, 3, 30)).map((item) => ({
    disc: item.disc, finder: { name: item.finder.name, karma: item.finder.karma, returned: item.finder.returned },
    course: item.course?.name ?? "", returnedAt: item.returnedAt, photo: item.photo?.url ?? null, claimId: item.claimId,
  }));
  return { waiting: Number(row?.n) || 0, recent };
}

