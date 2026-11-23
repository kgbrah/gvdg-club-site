// Online membership dues for self-serve applications. Credential-gated and fail-soft: dues checkout is
// available only when PAYPAL_CLIENT_ID + PAYPAL_SECRET are both configured (and MEMBERSHIP_DUES_ONLINE is
// not forced off). Otherwise the site behaves exactly as before (paypal.me link, admin confirms by hand).
// Server-trust rules match event registration: the amount is priced HERE, the slot is reserved before
// charging, and a capture counts only when order + capture are COMPLETED, USD, and cover the dues.
import type { Env } from "./env.js";
import { json, readJson, clientIp } from "./http.js";
import { asStr } from "./input.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { paypalBase, createOrder, captureOrder, isCaptureSettled, type CaptureResult, type PayPalCreds } from "./payments.js";
import { endpointOf, keyOf } from "./admin-push.js";
import type { KVListLike } from "./roster.js";
import { readApplication, type MembershipApplication } from "./membership-apply.js";
import { duesCents, duesOnline, membershipConfig, getDues, publicPayment, reserveDues, releaseDues, recordPaypalDues, claimOtherDues } from "./membership-dues-db.js";

function creds(env: Env): PayPalCreds {
  return { clientId: env.PAYPAL_CLIENT_ID as string, secret: env.PAYPAL_SECRET as string, base: paypalBase(env.PAYPAL_ENV, env.PAYPAL_API_BASE) };
}

function tokenMatches(app: MembershipApplication, given: string | null): boolean {
  const want = app.payToken;
  if (!want || !given || want.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Public routes under /membership/ (except POST /membership/apply, handled in membership-apply.ts). */
export async function handleMembershipPublic(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
): Promise<Response | null> {
  if (seg[0] !== "membership") return null;

  if (method === "GET" && seg.length === 2 && seg[1] === "config") {
    return json(await membershipConfig(env), 200, origin);
  }

  // /membership/apply/:id/(dues/(create-order|capture|other)|push)
  if (method !== "POST" || seg[1] !== "apply" || seg.length < 4) return null;
  const kind = seg[3] === "push" && seg.length === 4 ? "push" : seg[3] === "dues" && seg.length === 5 ? seg[4] : null;
  if (!kind || !["create-order", "capture", "other", "push"].includes(kind)) return null;

  if (await kvRateLimited(env, "membership-dues:" + clientIp(request), 40, 3600)) return json({ error: "rate_limited" }, 429, origin);
  const body = (await readJson(request)) ?? {};
  const id = asStr(seg[2], 40);
  const app = id ? await readApplication(env.ROSTER as unknown as KVListLike, id) : null;
  if (!app || !tokenMatches(app, asStr(body.payToken, 80))) return json({ error: "not_found" }, 404, origin);

  if (kind === "push") {
    const keys = (body.keys && typeof body.keys === "object" ? body.keys : {}) as Record<string, unknown>;
    const endpoint = endpointOf(body.endpoint);
    const p256dh = keyOf(keys.p256dh, 65, true);
    const auth = keyOf(keys.auth, 16);
    if (!endpoint || !p256dh || !auth) return json({ error: "invalid_subscription" }, 400, origin);
    await env.DB.prepare(
      `INSERT INTO membership_push_subscriptions (application_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT(application_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, created_at = datetime('now')`,
    ).bind(app.id, endpoint, p256dh, auth).run();
    return json({ ok: true }, 200, origin);
  }

  if (kind === "other") {
    await claimOtherDues(env.DB, app.id);
    return json({ payment: publicPayment(await getDues(env.DB, app.id)) }, 200, origin);
  }

  if (!duesOnline(env)) return json({ error: "payments_not_configured" }, 503, origin);
  const owed = duesCents(env);
  const existing = await getDues(env.DB, app.id);

  try {
    if (kind === "create-order") {
      if (existing?.paid_at) return json({ error: "already_paid" }, 409, origin);
      const orderId = await createOrder(creds(env), owed, "GVDG annual membership dues");
      return json({ orderId, amountCents: owed }, 200, origin);
    }

    // capture
    const orderId = asStr(body.orderId, 100);
    if (!orderId) return json({ error: "invalid_request" }, 400, origin);
    if (existing?.paid_at) {
      return existing.paypal_order_id === orderId
        ? json({ payment: publicPayment(existing) }, 200, origin) // idempotent retry: never re-capture or double-record
        : json({ error: "already_paid" }, 409, origin);
    }
    if (!(await reserveDues(env.DB, app.id, orderId))) return json({ error: "capture_in_progress" }, 409, origin);
    let cap: CaptureResult;
    try {
      cap = await captureOrder(creds(env), orderId);
    } catch (e) {
      await releaseDues(env.DB, app.id, orderId);
      throw e;
    }
    if (!isCaptureSettled(cap, owed)) {
      await releaseDues(env.DB, app.id, orderId);
      return json({ error: "payment_incomplete" }, 402, origin);
    }
    let rec = null;
    try {
      rec = await recordPaypalDues(env.DB, app.id, orderId, cap.captureId ?? "", cap.amountCents);
    } catch {
      await releaseDues(env.DB, app.id, orderId);
      return json({ error: "order_already_used" }, 409, origin);
    }
    if (!rec) rec = await getDues(env.DB, app.id); // a concurrent retry recorded it first
    return json({ payment: publicPayment(rec) }, 200, origin);
  } catch (e) {
    return json({ error: "paypal_error", reason: String(e instanceof Error ? e.message : e) }, 502, origin);
  }
}
