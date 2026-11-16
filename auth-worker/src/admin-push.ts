// Admin Web Push. Best-effort: a failed alert must never fail the action that caused it.
// No-ops when VAPID keys are missing so local tests and an unconfigured worker stay quiet.

import type { Env } from "./env.js";
import type { D1Like } from "./db-types.js";
import { json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { encryptWebPush, fromB64url, loadVapidKeys, vapidAuthorization, type PushCryptoKeys } from "./web-push.js";

const text = new TextEncoder();

export interface AdminPushNote {
  title: string;
  body: string;
  url: string;
  tag: string;
}

interface PushRow {
  endpoint: string;
  member_id: string;
  p256dh: string;
  auth: string;
}

type WaitCtx = { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

function pushEnv(env: Env): Env & { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string } {
  return env as Env & { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string };
}

function adminUrl(url: string): string {
  if (typeof url === "string" && url.startsWith("/admin.html") && !url.startsWith("//") && !url.includes("\\") && !url.includes("://")) {
    return url;
  }
  return "/admin.html";
}

export function endpointOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 12 || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return value;
  } catch {
    return null;
  }
}

export function keyOf(value: unknown, bytes: number, uncompressed = false): string | null {
  if (typeof value !== "string") return null;
  const raw = fromB64url(value);
  if (!raw || raw.length !== bytes) return null;
  if (uncompressed && raw[0] !== 4) return null;
  return value;
}

async function keysOf(env: Env): Promise<PushCryptoKeys | null> {
  const cfg = pushEnv(env);
  return loadVapidKeys(cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY);
}

async function hasSubscription(db: D1Like, memberId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT endpoint FROM admin_push_subscriptions WHERE member_id = ? LIMIT 1",
  ).bind(memberId).first<{ endpoint: string }>();
  return Boolean(row);
}

async function rowByEndpoint(db: D1Like, endpoint: string): Promise<PushRow | null> {
  return db.prepare(
    "SELECT endpoint, member_id, p256dh, auth FROM admin_push_subscriptions WHERE endpoint = ?",
  ).bind(endpoint).first<PushRow>();
}

export function notifyAdmins(ctx: WaitCtx, env: Env, note: AdminPushNote): void {
  const job = sendAdminPush(env, note).catch(() => {});
  try {
    ctx?.waitUntil?.(job);
  } catch {
    /* the promise still settles on its own */
  }
}

export async function sendAdminPush(env: Env, note: AdminPushNote): Promise<void> {
  try {
    const keys = await keysOf(env);
    if (!keys) return;
    const listed = await env.DB.prepare(
      "SELECT endpoint, member_id, p256dh, auth FROM admin_push_subscriptions ORDER BY created_at LIMIT 50",
    ).all<PushRow>();
    const rows = listed.results ?? [];
    const payload = text.encode(JSON.stringify({
      title: note.title.slice(0, 80),
      body: note.body.slice(0, 180),
      url: adminUrl(note.url),
      tag: note.tag.slice(0, 80),
    }));
    await Promise.all(rows.map(async (row) => {
      try {
        const status = await postPush(keys, row, payload);
        if (status === 404 || status === 410) {
          await env.DB.prepare("DELETE FROM admin_push_subscriptions WHERE endpoint = ?").bind(row.endpoint).run();
        }
      } catch {
        /* one dead phone does not stop the others */
      }
    }));
  } catch {
    /* alerts are optional */
  }
}

export async function postPush(keys: PushCryptoKeys, row: PushRow, payload: Uint8Array): Promise<number> {
  const clientKey = fromB64url(row.p256dh);
  const auth = fromB64url(row.auth);
  if (!clientKey || clientKey.length !== 65 || clientKey[0] !== 4 || !auth || auth.length !== 16) {
    throw new Error("bad subscription");
  }
  const body = await encryptWebPush(payload, clientKey, auth);
  const response = await fetch(row.endpoint, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: await vapidAuthorization(row.endpoint, keys),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
    },
    body: body as BodyInit,
    signal: AbortSignal.timeout(8000),
  });
  return response.status;
}

export async function handleAdminPush(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  adminId: string,
): Promise<Response | null> {
  if (seg[1] !== "push" || seg.length !== 2) return null;
  const keys = await keysOf(env);

  if (method === "GET") {
    const subscribed = keys ? await hasSubscription(env.DB, adminId) : false;
    return json({
      configured: Boolean(keys),
      publicKey: keys?.publicKey ?? null,
      subscribed,
    }, 200, origin);
  }

  if (!keys) return json({ error: "push_unconfigured" }, 503, origin);

  if (method === "POST") {
    const body = (await readJson(request)) ?? {};
    const keysIn = body.keys && typeof body.keys === "object" ? body.keys as Record<string, unknown> : {};
    const endpoint = endpointOf(body.endpoint);
    const p256dh = keyOf(keysIn.p256dh, 65, true);
    const auth = keyOf(keysIn.auth, 16);
    if (!endpoint || !p256dh || !auth) return json({ error: "invalid_subscription" }, 400, origin);
    const prior = await rowByEndpoint(env.DB, endpoint);
    if (!(prior && prior.member_id === adminId && prior.p256dh === p256dh && prior.auth === auth)) {
      if (await kvRateLimited(env, "pushsub:" + adminId, 12, 3600)) {
        return json({ error: "rate_limited" }, 429, origin);
      }
      await env.DB.prepare(
        `INSERT INTO admin_push_subscriptions (endpoint, member_id, p256dh, auth)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           member_id = excluded.member_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           created_at = datetime('now')`,
      ).bind(endpoint, adminId, p256dh, auth).run();
    }
    return json({ ok: true }, 200, origin);
  }

  if (method === "DELETE") {
    const body = (await readJson(request)) ?? {};
    const endpoint = endpointOf(body.endpoint);
    if (!endpoint) return json({ error: "invalid_subscription" }, 400, origin);
    await env.DB.prepare(
      "DELETE FROM admin_push_subscriptions WHERE endpoint = ? AND member_id = ?",
    ).bind(endpoint, adminId).run();
    return json({ ok: true }, 200, origin);
  }

  return json({ error: "not_found" }, 404, origin);
}
