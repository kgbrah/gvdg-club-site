// PDGA membership on the club site: a member's PDGA status and expiry (official API), links to join or renew at
// pdga.com, and the club's PDGA discount code, which an admin sets each year. PDGA asks clubs to share that code only
// within the club, so it goes to signed-in current club members (and admins), never to guests or the public.

import type { Env } from "./env.js";
import type { D1Like } from "./db-types.js";
import { requireAuth } from "./authz.js";
import { json, readJson } from "./http.js";
import { asStr } from "./input.js";
import { getMember } from "./roster.js";
import { membershipStatus } from "./membership-year.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { lookupPdgaPlayer, normalPdgaNumber, pdgaApiConfigured, PDGA_ATTRIBUTION, type PdgaApiEnv } from "./pdga-api.js";

export const PDGA_JOIN_URL = "https://www.pdga.com/membership";
export const PDGA_RENEW_URL = "https://www.pdga.com/membership/renew";
const PROMO_KEY = "pdga_promo";

export type PdgaPromo = { code: string; validThrough: string | null; updatedAt: string };

export async function getPdgaPromo(db: D1Like): Promise<PdgaPromo | null> {
  const row = await db.prepare("SELECT value, updated_at FROM club_settings WHERE key = ?").bind(PROMO_KEY).first<{ value: string; updated_at: string }>();
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as { code?: unknown; validThrough?: unknown };
    return typeof value.code === "string" && value.code
      ? { code: value.code, validThrough: typeof value.validThrough === "string" ? value.validThrough : null, updatedAt: row.updated_at }
      : null;
  } catch {
    return null;
  }
}

/** A code past its "valid through" date (a year, or a day) isn't offered. */
export function promoCurrent(promo: PdgaPromo | null, now = new Date()): promo is PdgaPromo {
  if (!promo) return false;
  if (!promo.validThrough) return true;
  const through = /^\d{4}$/.test(promo.validThrough) ? `${promo.validThrough}-12-31` : promo.validThrough;
  return now.toISOString().slice(0, 10) <= through;
}

/** GET /pdga/membership — the signed-in member's PDGA membership, join/renew links, and (for current club members) the code. */
export async function handlePdgaMembership(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const member = claims.member ?? await getMember(env.ROSTER, claims.sub);
  const club = membershipStatus(member);
  const clubMember = member?.isAdmin === true || (!club.guest && club.current);
  const promo = await getPdgaPromo(env.DB);
  const pdgaNumber = normalPdgaNumber(member?.pdgaNo ?? null);
  let player = null;
  let lookup: "ok" | "none" | "unavailable" = pdgaNumber ? "unavailable" : "none";
  if (pdgaNumber && pdgaApiConfigured(env as unknown as PdgaApiEnv)) {
    try {
      // ?fresh=1: the member is back from PDGA's renewal page, so ask PDGA now (at most 4 a minute per member).
      const fresh = new URL(request.url).searchParams.get("fresh") === "1"
        && !(await kvRateLimited(env, "pdga-fresh:" + claims.sub, 4, 60));
      const found = await lookupPdgaPlayer(env as unknown as PdgaApiEnv, pdgaNumber, fresh ? "all" : "none");
      lookup = "ok";
      player = found ? { name: found.name, membershipStatus: found.membershipStatus, membershipExpires: found.membershipExpires, url: found.url } : null;
    } catch { /* lookup stays "unavailable" */ }
  }
  return json({
    pdgaNumber, player, lookup, joinUrl: PDGA_JOIN_URL, renewUrl: PDGA_RENEW_URL,
    promo: clubMember && promoCurrent(promo) ? { code: promo.code, validThrough: promo.validThrough } : null,
    clubDiscountAvailable: promoCurrent(promo),
    attribution: PDGA_ATTRIBUTION,
  }, 200, origin);
}

/** Admin: GET/PUT /admin/club-settings/pdga-promo. An empty code clears it. */
export async function handleAdminPdgaPromo(request: Request, env: Env, origin: string | null, method: string, adminId: string): Promise<Response> {
  if (method === "GET") return json({ promo: await getPdgaPromo(env.DB) }, 200, origin);
  if (method !== "PUT") return json({ error: "not_found" }, 404, origin);
  const body = (await readJson(request)) ?? {};
  const code = (asStr(body.code, 40) ?? "").trim();
  if (!code) {
    await env.DB.prepare("DELETE FROM club_settings WHERE key = ?").bind(PROMO_KEY).run();
    return json({ promo: null }, 200, origin);
  }
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(code)) return json({ error: "invalid_code" }, 400, origin);
  const through = (asStr(body.validThrough, 10) ?? "").trim() || null;
  if (through && !/^\d{4}(-\d{2}-\d{2})?$/.test(through)) return json({ error: "invalid_valid_through" }, 400, origin);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO club_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(PROMO_KEY, JSON.stringify({ code, validThrough: through }), now, adminId).run();
  return json({ promo: await getPdgaPromo(env.DB) }, 200, origin);
}
