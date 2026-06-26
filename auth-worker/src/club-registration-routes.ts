import type { Env } from "./env.js";
import * as db from "./db.js";
import { requireAuth } from "./authz.js";
import { getMember } from "./roster.js";
import { computeOwed, paypalBase, createOrder as ppCreateOrder, captureOrder as ppCaptureOrder } from "./payments.js";
import { json, readJson } from "./http.js";
import { asInt, asStr } from "./input.js";

export async function handleClubRegistration(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
): Promise<Response | null> {
  if (seg[0] !== "events" || !(seg[2] === "registration" || seg[2] === "register" || seg[2] === "checkin" || seg[2] === "pay")) return null;
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const eid = asInt(seg[1]);
  if (eid == null) return json({ error: "not_found" }, 404, origin);

  if (seg[2] === "pay" && method === "POST") {
    if (!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET)) return json({ error: "payments_not_configured" }, 503, origin);
    const reg = (await db.getMyRegistration(env.DB, eid, claims.sub)) as { id: number; addons?: string; paid_entry?: number; payment_ref?: string } | null;
    if (!reg) return json({ error: "not_registered" }, 400, origin);
    const cfg = (await db.getEventConfig(env.DB, eid)) as { entry_fee_cents?: number; ctp_fee_cents?: number; ace_fee_cents?: number } | null;
    let addons: { ctp?: boolean; ace?: boolean } = {};
    try { addons = JSON.parse(reg.addons || "{}"); } catch { addons = {}; }
    const owed = computeOwed(cfg ?? {}, addons);
    if (owed <= 0) return json({ error: "nothing_owed" }, 400, origin);
    const creds = { clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET, base: paypalBase(env.PAYPAL_ENV, env.PAYPAL_API_BASE) };
    try {
      if (seg[3] === "create-order") {
        if (reg.paid_entry === 1) return json({ error: "already_paid" }, 409, origin);
        const orderId = await ppCreateOrder(creds, owed, "GVDG event entry");
        return json({ orderId }, 200, origin);
      }
      if (seg[3] === "capture") {
        const b = (await readJson(request)) ?? {};
        const orderId = asStr(b.orderId, 100);
        if (!orderId) return json({ error: "invalid_request" }, 400, origin);
        if (reg.paid_entry === 1) {
          return reg.payment_ref === orderId ? json({ registration: reg }, 200, origin) : json({ error: "already_paid" }, 409, origin);
        }
        const cap = await ppCaptureOrder(creds, orderId);
        if (cap.status !== "COMPLETED" || cap.amountCents < owed) return json({ error: "payment_incomplete" }, 402, origin);
        const updated = await db.markRegistrationPaid(env.DB, reg.id, orderId, cap.amountCents);
        return json({ registration: updated ?? (await db.getRegistration(env.DB, reg.id)) }, 200, origin);
      }
    } catch (e) {
      return json({ error: "paypal_error", reason: String(e instanceof Error ? e.message : e) }, 502, origin);
    }
    return json({ error: "not_found" }, 404, origin);
  }

  if (seg[2] === "registration" && method === "GET") {
    return json({ config: await db.getEventConfig(env.DB, eid), registration: await db.getMyRegistration(env.DB, eid, claims.sub) }, 200, origin);
  }
  if (seg[2] === "register" && method === "POST") {
    const status = await db.getEventStatus(env.DB, eid);
    if (status !== "scheduled" && status !== "live") return json({ error: "registration_closed" }, 403, origin);
    const cfg = (await db.getEventConfig(env.DB, eid)) as { registration_open?: number; divisions?: string } | null;
    if (!cfg || cfg.registration_open !== 1) return json({ error: "registration_closed" }, 403, origin);
    const b = (await readJson(request)) ?? {};
    const division = asStr(b.division, 60);
    let divs: string[] = [];
    try { divs = JSON.parse(cfg.divisions || "[]"); } catch { divs = []; }
    if (division && divs.length && !divs.includes(division)) return json({ error: "invalid_division" }, 400, origin);
    const member = await getMember(env.ROSTER, claims.sub);
    const addons = b.addons && typeof b.addons === "object" ? JSON.stringify({ ctp: !!(b.addons as Record<string, unknown>).ctp, ace: !!(b.addons as Record<string, unknown>).ace }) : null;
    const row = await db.registerForEvent(env.DB, { event_id: eid, member_id: claims.sub, name: member?.name ?? "Member", division, team: asStr(b.team, 40), addons });
    return json({ registration: row }, 201, origin);
  }
  if (seg[2] === "register" && method === "DELETE") {
    const reg = (await db.getMyRegistration(env.DB, eid, claims.sub)) as { paid_entry?: number } | null;
    if (reg?.paid_entry === 1) return json({ error: "paid_contact_admin" }, 403, origin);
    await db.withdrawRegistration(env.DB, eid, claims.sub);
    return json({ ok: true }, 200, origin);
  }
  if (seg[2] === "checkin" && method === "POST") {
    const row = await db.setCheckedIn(env.DB, eid, claims.sub, true);
    return row ? json({ registration: row }, 200, origin) : json({ error: "not_registered" }, 404, origin);
  }
  return json({ error: "not_found" }, 404, origin);
}
