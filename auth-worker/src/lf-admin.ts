// Lost & Found moderation (adminGate only): reports (with the reported item's photos, each removable), AI match
// review, hide / unhide posts and celebrations, close and merge posts, karma reversal and removing a photo. Every
// action needs a reason and is logged. Admins never see ink text either: match review shows scores and reason
// codes only.

import { adminGate } from "./authz.js";
import { readJson } from "./http.js";
import { purgePostPhotos } from "./lf-process.js";
import {
  CELEBRATION_COLUMNS, KARMA_PER_RETURN, POST_COLUMNS, celebrationCards, celebrationPhotos, getPostRow, logModeration, matchReasonLabels,
  parseReasons, people, postCards, postPhotos, postTitle,
} from "./lf-store.js";
import { cleanLine } from "./market-input.js";
import { changed, fail, idOf, ok, type MarketCtx } from "./market-http.js";
import { num, str, type Row } from "./market-store.js";
import { getMember } from "./roster.js";

function reasonOf(body: Record<string, unknown>): string | null {
  const reason = cleanLine(body.reason, 200);
  return reason && reason.length >= 3 ? reason : null;
}

async function counts(c: MarketCtx) {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS reports FROM lf_reports WHERE status = 'open'").first<{ reports: number }>();
  return { openReports: Number(row?.reports) || 0 };
}

async function reportViews(c: MarketCtx, rows: Row[]) {
  const ownerIds: string[] = [];
  const targets = new Map<number, { title: string; status: string; hidden: boolean; text: string; ownerId: string; postId: number | null } | null>();
  for (const row of rows) {
    const id = num(row, "target_id");
    let target = null;
    if (str(row, "target_kind") === "post") {
      const post = await getPostRow(c.env, id);
      if (post) {
        target = { title: (str(post, "kind") === "found" ? "Found: " : "Lost: ") + postTitle(post), status: str(post, "status"),
          hidden: num(post, "hidden") === 1, text: [str(post, "course_name"), str(post, "area")].filter(Boolean).join(" · "),
          ownerId: str(post, "owner_id"), postId: id };
      }
    } else {
      const e = await c.env.DB.prepare(
        `SELECT e.author_id, e.caption, e.hidden, c.found_id FROM lf_celebrations e JOIN lf_claims c ON c.id = e.claim_id WHERE e.id = ?`,
      ).bind(id).first<Row>();
      if (e) target = { title: "Celebration", status: num(e, "hidden") === 1 ? "hidden" : "shown", hidden: num(e, "hidden") === 1,
        text: str(e, "caption"), ownerId: str(e, "author_id"), postId: num(e, "found_id") };
    }
    if (target) ownerIds.push(target.ownerId);
    targets.set(num(row, "id"), target);
  }
  const person = await people(c.env, [...ownerIds, ...rows.map((row) => str(row, "reporter_id"))]);
  // The reported item's photos, so an admin can take one down ("Shows private information").
  const ids = (kind: string) => rows.filter((row) => str(row, "target_kind") === kind).map((row) => num(row, "target_id"));
  const [postPics, celebrationPics] = await Promise.all([postPhotos(c.env, ids("post")), celebrationPhotos(c.env, ids("celebration"))]);
  return rows.map((row) => {
    const target = targets.get(num(row, "id"));
    const photos = (str(row, "target_kind") === "post" ? postPics : celebrationPics).get(num(row, "target_id")) ?? [];
    return {
      id: num(row, "id"), kind: str(row, "target_kind"), targetId: num(row, "target_id"), reason: str(row, "reason"),
      details: str(row, "details"), createdAt: str(row, "created_at"), reporter: person(str(row, "reporter_id")),
      target: target ? { title: target.title, status: target.status, hidden: target.hidden, text: target.text, postId: target.postId,
        owner: person(target.ownerId), photos } : null,
    };
  });
}

async function overview(c: MarketCtx): Promise<Response> {
  const env = c.env;
  const reports = (await env.DB.prepare(
    "SELECT id, target_kind, target_id, reporter_id, reason, details, created_at FROM lf_reports WHERE status = 'open' ORDER BY created_at, id LIMIT 50",
  ).all<Row>()).results ?? [];
  const matchRows = (await env.DB.prepare(
    `SELECT m.id, m.found_id, m.lost_id, m.candidate_id, m.score, m.reasons, m.ai_verdict, m.status, m.created_at, f.owner_id AS finder_id
     FROM lf_matches m JOIN lf_posts f ON f.id = m.found_id
     WHERE m.status IN ('suggested', 'notified') AND f.status IN ('open', 'claimed')
     ORDER BY m.score DESC, m.id DESC LIMIT 30`,
  ).all<Row>()).results ?? [];
  const posts = new Map<number, Row>();
  const postIds = [...new Set(matchRows.flatMap((row) => [num(row, "found_id"), row.lost_id == null ? 0 : num(row, "lost_id")]).filter(Boolean))];
  if (postIds.length) {
    for (const row of (await env.DB.prepare(`SELECT ${POST_COLUMNS} FROM lf_posts p WHERE p.id IN (${postIds.map(() => "?").join(",")})`)
      .bind(...postIds).all<Row>()).results ?? []) posts.set(num(row, "id"), row);
  }
  const hiddenPosts = (await env.DB.prepare(`SELECT ${POST_COLUMNS} FROM lf_posts p WHERE p.hidden = 1 ORDER BY p.updated_at DESC LIMIT 30`).all<Row>()).results ?? [];
  const hiddenCelebrations = (await env.DB.prepare(
    `SELECT ${CELEBRATION_COLUMNS} FROM lf_celebrations e JOIN lf_claims c ON c.id = e.claim_id JOIN lf_posts p ON p.id = c.found_id
     WHERE e.hidden = 1 ORDER BY e.id DESC LIMIT 30`,
  ).all<Row>()).results ?? [];
  const karmaRows = (await env.DB.prepare(
    `SELECT k.claim_id, k.person_id, k.created_at, c.owner_id, p.brand, p.mold, p.plastic, p.color,
            (SELECT 1 FROM lf_karma r WHERE r.claim_id = k.claim_id AND r.reason = 'admin_reversal') AS reversed
     FROM lf_karma k JOIN lf_claims c ON c.id = k.claim_id JOIN lf_posts p ON p.id = c.found_id
     WHERE k.reason = 'return_confirmed' ORDER BY k.id DESC LIMIT 30`,
  ).all<Row>()).results ?? [];
  const log = (await env.DB.prepare("SELECT id, admin_id, action, target_kind, target_id, reason, created_at FROM lf_mod_log ORDER BY id DESC LIMIT 30").all<Row>()).results ?? [];
  const person = await people(env, [
    ...matchRows.flatMap((row) => [str(row, "candidate_id"), str(row, "finder_id")]),
    ...karmaRows.flatMap((row) => [str(row, "person_id"), str(row, "owner_id")]),
  ]);
  const adminNames = new Map<string, string>();
  for (const id of new Set(log.map((row) => str(row, "admin_id")))) adminNames.set(id, (await getMember(env.ROSTER, id).catch(() => null))?.name || "Admin");
  const title = (row: Row) => postTitle(row);
  return ok(c, {
    counts: await counts(c),
    reports: await reportViews(c, reports),
    matches: matchRows.map((row) => {
      const found = posts.get(num(row, "found_id"));
      const lost = row.lost_id == null ? null : posts.get(num(row, "lost_id"));
      const codes = parseReasons(row.reasons);
      return {
        id: num(row, "id"), score: num(row, "score"), status: str(row, "status"), aiVerdict: row.ai_verdict ? str(row, "ai_verdict") : null,
        codes, reasons: matchReasonLabels(codes), createdAt: str(row, "created_at"),
        found: found ? { id: num(found, "id"), title: title(found), course: str(found, "course_name") } : null,
        lost: lost ? { id: num(lost, "id"), title: title(lost), course: str(lost, "course_name") } : null,
        finder: person(str(row, "finder_id")), candidate: person(str(row, "candidate_id")),
        via: row.lost_id == null ? "roster_name" : "lost_post",
      };
    }),
    hidden: { posts: await postCards(env, hiddenPosts, null), celebrations: await celebrationCards(env, hiddenCelebrations, null) },
    karma: karmaRows.map((row) => ({
      claimId: num(row, "claim_id"), finder: person(str(row, "person_id")), owner: person(str(row, "owner_id")), createdAt: str(row, "created_at"),
      disc: title(row), reversed: Boolean(row.reversed), points: KARMA_PER_RETURN,
    })),
    log: log.map((row) => ({
      id: num(row, "id"), action: str(row, "action"), targetKind: str(row, "target_kind"), targetId: str(row, "target_id"),
      reason: str(row, "reason"), by: adminNames.get(str(row, "admin_id")) ?? "Admin", createdAt: str(row, "created_at"),
    })),
  });
}

async function closeReportsFor(c: MarketCtx, adminId: string, kind: string, id: number, resolution: string): Promise<void> {
  await c.env.DB.prepare(
    `UPDATE lf_reports SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?, resolution = ?
     WHERE target_kind = ? AND target_id = ? AND status = 'open'`,
  ).bind(adminId, resolution.slice(0, 200), kind, id).run();
}

export async function handleLostFoundAdmin(c: MarketCtx, method: string, seg: string[]): Promise<Response> {
  const gate = await adminGate(c.request, c.env, c.origin);
  if (gate instanceof Response) return gate;
  const adminId = gate.adminId;
  // seg: ["admin", "lost-found", ...]
  if (method === "GET" && seg.length === 3 && seg[2] === "summary") return ok(c, await counts(c));
  if (method === "GET" && seg.length === 3 && seg[2] === "overview") return overview(c);
  if (method !== "POST") return fail(c, 404, "not_found");
  const body = (await readJson(c.request)) ?? {};
  const reason = reasonOf(body);
  const id = idOf(seg[3]);
  if (!id) return fail(c, 404, "not_found");
  if (!reason) return fail(c, 400, "reason_required");
  const action = seg[4];

  if (seg[2] === "reports" && seg.length === 4) {
    const verdict = body.action === "dismiss" || body.action === "resolve" ? body.action : null;
    if (!verdict) return fail(c, 400, "invalid_request");
    const result = await c.env.DB.prepare(
      "UPDATE lf_reports SET status = ?, resolved_at = datetime('now'), resolved_by = ?, resolution = ? WHERE id = ? AND status = 'open'",
    ).bind(verdict === "dismiss" ? "dismissed" : "resolved", adminId, reason, id).run();
    if (!changed(result)) return fail(c, 409, "not_open");
    await logModeration(c.env, adminId, "report_" + verdict, "report", id, reason);
    return ok(c, { ok: true });
  }

  if (seg[2] === "posts" && seg.length === 5) {
    const post = await getPostRow(c.env, id);
    if (!post) return fail(c, 404, "not_found");
    if (action === "hide" || action === "unhide") {
      const hide = action === "hide";
      const result = await c.env.DB.prepare("UPDATE lf_posts SET hidden = ?, updated_at = datetime('now') WHERE id = ? AND hidden = ?")
        .bind(hide ? 1 : 0, id, hide ? 0 : 1).run();
      if (!changed(result)) return fail(c, 409, hide ? "already_hidden" : "not_hidden");
      await logModeration(c.env, adminId, action, "post", id, reason);
      if (hide) await closeReportsFor(c, adminId, "post", id, "hidden: " + reason);
      return ok(c, { ok: true });
    }
    if (action === "close") {
      const result = await c.env.DB.prepare(
        `UPDATE lf_posts SET status = 'closed', close_reason = 'admin', closed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND status IN ('open', 'claimed')`,
      ).bind(id).run();
      if (!changed(result)) return fail(c, 409, "not_open");
      await c.env.DB.prepare("UPDATE lf_claims SET status = 'declined', closed_at = datetime('now') WHERE found_id = ? AND status IN ('open', 'returned')").bind(id).run();
      await c.env.DB.prepare("UPDATE lf_matches SET status = 'dismissed', updated_at = datetime('now') WHERE (found_id = ? OR lost_id = ?) AND status IN ('suggested', 'notified')").bind(id, id).run();
      await purgePostPhotos(c.env, id);
      await logModeration(c.env, adminId, "close", "post", id, reason);
      await closeReportsFor(c, adminId, "post", id, "closed: " + reason);
      return ok(c, { ok: true });
    }
    if (action === "merge") {
      // A duplicate post of the same disc: fold it into the other one (same kind), keep the other.
      const into = typeof body.into === "number" && Number.isInteger(body.into) && body.into > 0 ? body.into : null;
      const target = into && into !== id ? await getPostRow(c.env, into) : null;
      if (!target || str(target, "kind") !== str(post, "kind") || !["open", "claimed"].includes(str(target, "status"))) return fail(c, 400, "invalid_merge");
      const active = await c.env.DB.prepare("SELECT 1 AS hit FROM lf_claims WHERE found_id = ? AND status IN ('open', 'returned')").bind(id).first();
      if (active) return fail(c, 409, "return_in_progress");
      const result = await c.env.DB.prepare(
        `UPDATE lf_posts SET status = 'merged', merged_into = ?, close_reason = 'merged', closed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND status IN ('open', 'claimed')`,
      ).bind(into, id).run();
      if (!changed(result)) return fail(c, 409, "not_open");
      await c.env.DB.prepare("UPDATE lf_matches SET status = 'dismissed', updated_at = datetime('now') WHERE (found_id = ? OR lost_id = ?) AND status IN ('suggested', 'notified')").bind(id, id).run();
      await purgePostPhotos(c.env, id);
      await logModeration(c.env, adminId, "merge", "post", id, `into #${into}: ${reason}`);
      return ok(c, { ok: true });
    }
    return fail(c, 404, "not_found");
  }

  if (seg[2] === "celebrations" && seg.length === 5 && (action === "hide" || action === "unhide")) {
    const hide = action === "hide";
    const result = await c.env.DB.prepare("UPDATE lf_celebrations SET hidden = ? WHERE id = ? AND hidden = ?").bind(hide ? 1 : 0, id, hide ? 0 : 1).run();
    if (!changed(result)) return fail(c, 409, hide ? "already_hidden" : "not_hidden");
    await logModeration(c.env, adminId, action, "celebration", id, reason);
    if (hide) await closeReportsFor(c, adminId, "celebration", id, "hidden: " + reason);
    return ok(c, { ok: true });
  }

  if (seg[2] === "karma" && seg.length === 5 && action === "reverse") {
    const award = await c.env.DB.prepare("SELECT person_id FROM lf_karma WHERE claim_id = ? AND reason = 'return_confirmed'").bind(id)
      .first<{ person_id: string }>();
    if (!award) return fail(c, 404, "not_found");
    // Append-only: a reversal is a second ledger row, at most one per return (UNIQUE claim_id + reason).
    const result = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO lf_karma (person_id, claim_id, delta, reason, admin_id, note) VALUES (?, ?, ?, 'admin_reversal', ?, ?)",
    ).bind(award.person_id, id, -KARMA_PER_RETURN, adminId, reason).run();
    if (!changed(result)) return fail(c, 409, "already_reversed");
    await logModeration(c.env, adminId, "karma_reverse", "claim", id, reason);
    return ok(c, { ok: true });
  }

  if (seg[2] === "matches" && seg.length === 5 && action === "dismiss") {
    const result = await c.env.DB.prepare("UPDATE lf_matches SET status = 'dismissed', updated_at = datetime('now') WHERE id = ? AND status IN ('suggested', 'notified')")
      .bind(id).run();
    if (!changed(result)) return fail(c, 409, "not_open");
    await logModeration(c.env, adminId, "match_dismiss", "match", id, reason);
    return ok(c, { ok: true });
  }

  if (seg[2] === "photos" && seg.length === 5 && action === "remove") {
    const photo = await c.env.DB.prepare("SELECT id, photo_key, status FROM lf_photos WHERE id = ?").bind(id)
      .first<{ id: number; photo_key: string | null; status: string }>();
    if (!photo) return fail(c, 404, "not_found");
    const result = await c.env.DB.prepare("UPDATE lf_photos SET status = 'removed', photo_key = NULL WHERE id = ? AND status = 'public'").bind(id).run();
    if (!changed(result)) return fail(c, 409, "already_removed");
    if (photo.photo_key) await c.env.PHOTOS?.delete(photo.photo_key);
    await logModeration(c.env, adminId, "photo_remove", "photo", id, reason);
    return ok(c, { ok: true });
  }

  return fail(c, 404, "not_found");
}
