// Marketplace moderation (adminGate only): the report queue, hide / unhide listings and WANTED posts,
// remove abusive feedback, suspend or reinstate a trader. Every action needs a reason and is logged.

import { adminGate } from "./authz.js";
import { readJson } from "./http.js";
import { getMember } from "./roster.js";
import { cleanLine, listingTitle, wantedTitle } from "./market-input.js";
import {
  LISTING_COLUMNS, WANTED_COLUMNS, isSuspended, listingCards, liteOf, logModeration, num, ownerByKey, str, tradersByOwner,
  wantedViews, type Row,
} from "./market-store.js";
import { changed, fail, idOf, ok, type MarketCtx } from "./market-http.js";

function reasonOf(body: Record<string, unknown>): string | null {
  const reason = cleanLine(body.reason, 200);
  return reason && reason.length >= 3 ? reason : null;
}

async function openReports(c: MarketCtx): Promise<number> {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM market_reports WHERE status = 'open'").first<{ n: number }>();
  return Number(row?.n) || 0;
}

async function reportTargets(c: MarketCtx, rows: Row[]) {
  const ownerIds: string[] = [];
  const targets = new Map<number, { title: string; status: string; hidden: boolean; text: string; ownerId: string } | null>();
  for (const row of rows) {
    const kind = str(row, "target_kind");
    const id = num(row, "target_id");
    let target: { title: string; status: string; hidden: boolean; text: string; ownerId: string } | null = null;
    if (kind === "listing") {
      const l = await c.env.DB.prepare(
        "SELECT seller_id, brand, plastic, mold, status, hidden, condition_notes, location FROM market_listings WHERE id = ?",
      ).bind(id).first<Row>();
      if (l) target = { title: listingTitle({ brand: str(l, "brand"), plastic: str(l, "plastic"), mold: str(l, "mold") }), status: str(l, "status"),
        hidden: num(l, "hidden") === 1, text: [str(l, "condition_notes"), str(l, "location")].filter(Boolean).join(" · "), ownerId: str(l, "seller_id") };
    } else if (kind === "wanted") {
      const w = await c.env.DB.prepare("SELECT poster_id, brand, plastic, mold, disc_type, status, hidden, notes FROM market_wanted WHERE id = ?")
        .bind(id).first<Row>();
      if (w) target = { title: "WANTED: " + wantedTitle({ brand: str(w, "brand"), plastic: str(w, "plastic"), mold: str(w, "mold"), disc_type: str(w, "disc_type") }),
        status: str(w, "status"), hidden: num(w, "hidden") === 1, text: str(w, "notes"), ownerId: str(w, "poster_id") };
    } else {
      const f = await c.env.DB.prepare(
        `SELECT f.author_id, f.rating, f.comment, f.removed_at, d.listing_title FROM market_feedback f JOIN market_deals d ON d.id = f.deal_id WHERE f.id = ?`,
      ).bind(id).first<Row>();
      if (f) target = { title: `Feedback (${str(f, "rating")}) on ${str(f, "listing_title")}`, status: f.removed_at ? "removed" : "shown",
        hidden: Boolean(f.removed_at), text: str(f, "comment"), ownerId: str(f, "author_id") };
    }
    if (target) ownerIds.push(target.ownerId);
    targets.set(num(row, "id"), target);
  }
  const traders = await tradersByOwner(c.env, [...ownerIds, ...rows.map((row) => str(row, "reporter_id"))]);
  const suspended = new Map<string, boolean>();
  for (const ownerId of new Set(ownerIds)) suspended.set(ownerId, await isSuspended(c.env, ownerId));
  return rows.map((row) => {
    const target = targets.get(num(row, "id"));
    return {
      id: num(row, "id"),
      kind: str(row, "target_kind"),
      targetId: num(row, "target_id"),
      reason: str(row, "reason"),
      details: str(row, "details"),
      status: str(row, "status"),
      createdAt: str(row, "created_at"),
      reporter: liteOf(traders, str(row, "reporter_id")),
      target: target ? {
        title: target.title, status: target.status, hidden: target.hidden, text: target.text,
        owner: { ...liteOf(traders, target.ownerId), suspended: suspended.get(target.ownerId) === true },
      } : null,
    };
  });
}

async function overview(c: MarketCtx): Promise<Response> {
  const reports = (await c.env.DB.prepare(
    "SELECT id, target_kind, target_id, reporter_id, reason, details, status, created_at FROM market_reports WHERE status = 'open' ORDER BY created_at, id LIMIT 50",
  ).all<Row>()).results ?? [];
  const hiddenListings = (await c.env.DB.prepare(
    `SELECT ${LISTING_COLUMNS} FROM market_listings l WHERE l.hidden = 1 ORDER BY l.updated_at DESC LIMIT 30`,
  ).all<Row>()).results ?? [];
  const hiddenWanted = (await c.env.DB.prepare(
    `SELECT ${WANTED_COLUMNS} FROM market_wanted w WHERE w.hidden = 1 ORDER BY w.id DESC LIMIT 30`,
  ).all<Row>()).results ?? [];
  const suspensions = (await c.env.DB.prepare(
    "SELECT id, owner_id, reason, created_at, created_by FROM market_suspensions WHERE lifted_at IS NULL ORDER BY id DESC LIMIT 50",
  ).all<Row>()).results ?? [];
  const log = (await c.env.DB.prepare(
    "SELECT id, admin_id, action, target_kind, target_id, reason, created_at FROM market_mod_log ORDER BY id DESC LIMIT 30",
  ).all<Row>()).results ?? [];
  const people = await tradersByOwner(c.env, [...suspensions.map((row) => str(row, "owner_id"))]);
  const adminNames = new Map<string, string>();
  for (const id of new Set([...log.map((row) => str(row, "admin_id")), ...suspensions.map((row) => str(row, "created_by"))])) {
    const member = await getMember(c.env.ROSTER, id).catch(() => null);
    adminNames.set(id, member?.name || "Admin");
  }
  return ok(c, {
    reports: await reportTargets(c, reports),
    hidden: {
      listings: await listingCards(c.env, hiddenListings, null),
      wanted: await wantedViews(c.env, hiddenWanted, null),
    },
    suspensions: suspensions.map((row) => ({
      id: num(row, "id"), trader: liteOf(people, str(row, "owner_id")), reason: str(row, "reason"),
      createdAt: str(row, "created_at"), by: adminNames.get(str(row, "created_by")) ?? "Admin",
    })),
    log: log.map((row) => ({
      id: num(row, "id"), action: str(row, "action"), targetKind: str(row, "target_kind"), targetId: str(row, "target_id"),
      reason: str(row, "reason"), by: adminNames.get(str(row, "admin_id")) ?? "Admin", createdAt: str(row, "created_at"),
    })),
    counts: { openReports: await openReports(c) },
  });
}

async function closeReportsFor(c: MarketCtx, adminId: string, kind: string, id: number, resolution: string): Promise<void> {
  await c.env.DB.prepare(
    `UPDATE market_reports SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?, resolution = ?
     WHERE target_kind = ? AND target_id = ? AND status = 'open'`,
  ).bind(adminId, resolution.slice(0, 200), kind, id).run();
}

export async function handleMarketAdmin(c: MarketCtx, method: string, seg: string[]): Promise<Response> {
  const gate = await adminGate(c.request, c.env, c.origin);
  if (gate instanceof Response) return gate;
  const adminId = gate.adminId;
  // seg: ["admin", "market", ...]
  if (method === "GET" && seg.length === 3 && seg[2] === "summary") return ok(c, { openReports: await openReports(c) });
  if (method === "GET" && seg.length === 3 && seg[2] === "overview") return overview(c);
  if (method !== "POST") return fail(c, 404, "not_found");
  const body = (await readJson(c.request)) ?? {};
  const reason = reasonOf(body);

  if (seg[2] === "reports" && seg.length === 4) {
    const id = idOf(seg[3]);
    const action = body.action === "dismiss" || body.action === "resolve" ? body.action : null;
    if (!id || !action) return fail(c, 400, "invalid_request");
    if (!reason) return fail(c, 400, "reason_required");
    const result = await c.env.DB.prepare(
      `UPDATE market_reports SET status = ?, resolved_at = datetime('now'), resolved_by = ?, resolution = ? WHERE id = ? AND status = 'open'`,
    ).bind(action === "dismiss" ? "dismissed" : "resolved", adminId, reason, id).run();
    if (!changed(result)) return fail(c, 409, "not_open");
    await logModeration(c.env, adminId, "report_" + action, "report", id, reason);
    return ok(c, { ok: true });
  }

  if ((seg[2] === "listings" || seg[2] === "wanted") && seg.length === 5 && (seg[4] === "hide" || seg[4] === "unhide")) {
    const id = idOf(seg[3]);
    if (!id) return fail(c, 404, "not_found");
    if (!reason) return fail(c, 400, "reason_required");
    const hide = seg[4] === "hide";
    const table = seg[2] === "listings" ? "market_listings" : "market_wanted";
    const touch = seg[2] === "listings" ? ", updated_at = datetime('now')" : "";
    const result = await c.env.DB.prepare(`UPDATE ${table} SET hidden = ?${touch} WHERE id = ? AND hidden = ?`)
      .bind(hide ? 1 : 0, id, hide ? 0 : 1).run();
    if (!changed(result)) return fail(c, 409, hide ? "already_hidden" : "not_hidden");
    const kind = seg[2] === "listings" ? "listing" : "wanted";
    await logModeration(c.env, adminId, seg[4], kind, id, reason);
    if (hide) await closeReportsFor(c, adminId, kind, id, "hidden: " + reason);
    return ok(c, { ok: true });
  }

  if (seg[2] === "feedback" && seg.length === 5 && seg[4] === "remove") {
    const id = idOf(seg[3]);
    if (!id) return fail(c, 404, "not_found");
    if (!reason) return fail(c, 400, "reason_required");
    const result = await c.env.DB.prepare(
      "UPDATE market_feedback SET removed_at = datetime('now'), removed_by = ?, removed_reason = ? WHERE id = ? AND removed_at IS NULL",
    ).bind(adminId, reason, id).run();
    if (!changed(result)) return fail(c, 409, "already_removed");
    await logModeration(c.env, adminId, "remove", "feedback", id, reason);
    await closeReportsFor(c, adminId, "feedback", id, "removed: " + reason);
    return ok(c, { ok: true });
  }

  if (seg[2] === "suspensions" && seg.length === 3) {
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const owner = key ? await ownerByKey(c.env, key) : null;
    if (!owner) return fail(c, 404, "not_found");
    if (!reason) return fail(c, 400, "reason_required");
    if (owner.ownerId === adminId) return fail(c, 400, "invalid_request");
    if (await isSuspended(c.env, owner.ownerId)) return fail(c, 409, "already_suspended");
    await c.env.DB.prepare("INSERT INTO market_suspensions (owner_id, reason, created_by) VALUES (?, ?, ?)").bind(owner.ownerId, reason, adminId).run();
    await logModeration(c.env, adminId, "suspend", "trader", key, reason);
    return ok(c, { ok: true }, 201);
  }

  if (seg[2] === "suspensions" && seg.length === 5 && seg[4] === "lift") {
    const id = idOf(seg[3]);
    if (!id) return fail(c, 404, "not_found");
    if (!reason) return fail(c, 400, "reason_required");
    const row = await c.env.DB.prepare("SELECT owner_id FROM market_suspensions WHERE id = ?").bind(id).first<{ owner_id: string }>();
    const result = await c.env.DB.prepare(
      "UPDATE market_suspensions SET lifted_at = datetime('now'), lifted_by = ?, lift_reason = ? WHERE id = ? AND lifted_at IS NULL",
    ).bind(adminId, reason, id).run();
    if (!row || !changed(result)) return fail(c, 409, "not_active");
    const traders = await tradersByOwner(c.env, [row.owner_id]);
    await logModeration(c.env, adminId, "lift", "trader", liteOf(traders, row.owner_id).key || id, reason);
    return ok(c, { ok: true });
  }

  return fail(c, 404, "not_found");
}
