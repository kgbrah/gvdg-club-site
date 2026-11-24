// Member Web Push. Members opt in from Account > Notifications; each device is one row in
// member_push_subscriptions and the per-category preference is kept equal across a member's devices.
// Sending is best-effort: it never throws, and it is a no-op without VAPID keys or a subscription.

import type { Env } from "./env.js";
import { requireMember } from "./authz.js";
import { json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { endpointOf, keyOf, postPush } from "./admin-push.js";
import { loadVapidKeys, type PushCryptoKeys } from "./web-push.js";

const text = new TextEncoder();
const MAX_DEVICES = 8;

export type PushCategory = "bagTags" | "messages" | "announcements";
const CATEGORY_COLUMN: Record<PushCategory, string> = {
  bagTags: "bag_tags",
  messages: "messages",
  announcements: "announcements",
};

export interface MemberPushNote {
  title: string;
  body: string;
  /** Must start with /gvdg-members.html; anything else falls back to the member app. */
  url: string;
  tag: string;
}

type WaitCtx = { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

interface SubRow {
  endpoint: string;
  member_id: string;
  p256dh: string;
  auth: string;
}

async function keysOf(env: Env): Promise<PushCryptoKeys | null> {
  const cfg = env as Env & { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string };
  return loadVapidKeys(cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY);
}

function memberUrl(url: string): string {
  if (typeof url === "string" && url.startsWith("/gvdg-members.html") && !url.startsWith("//") && !url.includes("\\") && !url.includes("://")) {
    return url;
  }
  return "/gvdg-members.html";
}

async function deliverMemberPushRows(env: Env, keys: PushCryptoKeys, rows: readonly SubRow[], note: MemberPushNote): Promise<void> {
  if (!rows.length) return;
  const payload = text.encode(JSON.stringify({
    kind: "member",
    title: note.title.slice(0, 80),
    body: note.body.slice(0, 180),
    url: memberUrl(note.url),
    tag: note.tag.slice(0, 80),
  }));
  for (let i = 0; i < rows.length; i += 15) {
    await Promise.all(rows.slice(i, i + 15).map(async (row) => {
      try {
        const status = await postPush(keys, row, payload);
        if (status === 404 || status === 410) {
          await env.DB.prepare("DELETE FROM member_push_subscriptions WHERE endpoint = ?").bind(row.endpoint).run();
        }
      } catch {
        /* one dead phone does not stop the others */
      }
    }));
  }
}

/** Fire-and-forget: the caller's request never waits on, or fails because of, a push. */
export function notifyMembers(ctx: WaitCtx, env: Env, memberIds: readonly string[], category: PushCategory, note: MemberPushNote): void {
  const job = sendMemberPush(env, memberIds, category, note).catch(() => {});
  try {
    ctx?.waitUntil?.(job);
  } catch {
    /* the promise still settles on its own */
  }
}

/** Send to every device of the listed members whose preference for `category` is on. */
export async function sendMemberPush(env: Env, memberIds: readonly string[], category: PushCategory, note: MemberPushNote): Promise<void> {
  try {
    const ids = [...new Set(memberIds.filter((id) => typeof id === "string" && id))].slice(0, 20);
    if (!ids.length) return;
    const keys = await keysOf(env);
    if (!keys) return;
    const column = CATEGORY_COLUMN[category];
    const marks = ids.map(() => "?").join(",");
    const listed = await env.DB.prepare(
      `SELECT endpoint, member_id, p256dh, auth FROM member_push_subscriptions
       WHERE member_id IN (${marks}) AND ${column} = 1 ORDER BY created_at LIMIT 60`,
    ).bind(...ids).all<SubRow>();
    await deliverMemberPushRows(env, keys, listed.results ?? [], note);
  } catch {
    /* alerts are optional */
  }
}

/** Broadcast a push notification to subscribed members (capped at 500 endpoints). */
export async function sendBroadcastMemberPush(
  env: Env,
  category: PushCategory,
  note: MemberPushNote,
  excludeMemberId?: string,
): Promise<void> {
  try {
    const keys = await keysOf(env);
    if (!keys) return;
    const column = CATEGORY_COLUMN[category];
    const stmt = excludeMemberId
      ? env.DB.prepare(
        `SELECT endpoint, member_id, p256dh, auth FROM member_push_subscriptions
         WHERE ${column} = 1 AND member_id != ? ORDER BY created_at LIMIT 500`,
      ).bind(excludeMemberId)
      : env.DB.prepare(
        `SELECT endpoint, member_id, p256dh, auth FROM member_push_subscriptions
         WHERE ${column} = 1 ORDER BY created_at LIMIT 500`,
      );
    const listed = await stmt.all<SubRow>();
    await deliverMemberPushRows(env, keys, listed.results ?? [], note);
  } catch {
    /* alerts are optional */
  }
}

/** Fire-and-forget club-wide member broadcast push. */
export function notifyAllSubscribedMembers(
  ctx: WaitCtx,
  env: Env,
  category: PushCategory,
  note: MemberPushNote,
  excludeMemberId?: string,
): void {
  const job = sendBroadcastMemberPush(env, category, note, excludeMemberId).catch(() => {});
  try {
    ctx?.waitUntil?.(job);
  } catch {
    /* the promise still settles on its own */
  }
}

/** GET / PUT / DELETE /me/push-subscription (member-authed). */
export async function handleMemberPush(request: Request, env: Env, origin: string | null, method: string): Promise<Response> {
  const session = await requireMember(request, env, origin);
  if (session instanceof Response) return session;
  const memberId = session.sub;
  const keys = await keysOf(env);

  if (method === "GET") {
    const rows = keys
      ? (await env.DB.prepare(
        "SELECT endpoint, bag_tags, messages, announcements FROM member_push_subscriptions WHERE member_id = ? ORDER BY created_at",
      ).bind(memberId).all<{ endpoint: string; bag_tags: number; messages: number; announcements: number }>()).results ?? []
      : [];
    const endpoint = new URL(request.url).searchParams.get("endpoint");
    return json({
      configured: Boolean(keys),
      publicKey: keys?.publicKey ?? null,
      devices: rows.length,
      subscribed: endpoint ? rows.some((row) => row.endpoint === endpoint) : rows.length > 0,
      prefs: {
        bagTags: rows.length ? rows.every((row) => row.bag_tags === 1) : true,
        messages: rows.length ? rows.every((row) => row.messages === 1) : true,
        announcements: rows.length ? rows.every((row) => row.announcements === 1) : true,
      },
    }, 200, origin);
  }

  if (!keys) return json({ error: "push_unconfigured" }, 503, origin);

  if (method === "PUT") {
    const body = (await readJson(request)) ?? {};
    const keysIn = body.keys && typeof body.keys === "object" ? body.keys as Record<string, unknown> : {};
    const endpoint = endpointOf(body.endpoint);
    const p256dh = keyOf(keysIn.p256dh, 65, true);
    const auth = keyOf(keysIn.auth, 16);
    const prefsIn = body.prefs && typeof body.prefs === "object" ? body.prefs as Record<string, unknown> : {};
    if (prefsIn.bagTags != null && typeof prefsIn.bagTags !== "boolean") return json({ error: "invalid_prefs" }, 400, origin);
    if (prefsIn.messages != null && typeof prefsIn.messages !== "boolean") return json({ error: "invalid_prefs" }, 400, origin);
    if (prefsIn.announcements != null && typeof prefsIn.announcements !== "boolean") return json({ error: "invalid_prefs" }, 400, origin);
    if (!endpoint || !p256dh || !auth) return json({ error: "invalid_subscription" }, 400, origin);
    if (await kvRateLimited(env, "mepush:" + memberId, 30, 3600)) return json({ error: "rate_limited" }, 429, origin);

    // New devices inherit the member's current preference; "on" is the default for a first device.
    const existing = (await env.DB.prepare(
      "SELECT endpoint, bag_tags, messages, announcements FROM member_push_subscriptions WHERE member_id = ? ORDER BY created_at",
    ).bind(memberId).all<{ endpoint: string; bag_tags: number; messages: number; announcements: number }>()).results ?? [];
    const inheritedBag = existing.length ? (existing.every((row) => row.bag_tags === 1) ? 1 : 0) : 1;
    const inheritedMessages = existing.length ? (existing.every((row) => row.messages === 1) ? 1 : 0) : 1;
    const inheritedAnnouncements = existing.length ? (existing.every((row) => row.announcements === 1) ? 1 : 0) : 1;
    const bagTags = typeof prefsIn.bagTags === "boolean" ? (prefsIn.bagTags ? 1 : 0) : inheritedBag;
    const messages = typeof prefsIn.messages === "boolean" ? (prefsIn.messages ? 1 : 0) : inheritedMessages;
    const announcements = typeof prefsIn.announcements === "boolean" ? (prefsIn.announcements ? 1 : 0) : inheritedAnnouncements;
    await env.DB.prepare(
      `INSERT INTO member_push_subscriptions (endpoint, member_id, p256dh, auth, bag_tags, messages, announcements)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         member_id = excluded.member_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         bag_tags = excluded.bag_tags,
         messages = excluded.messages,
         announcements = excluded.announcements`,
    ).bind(endpoint, memberId, p256dh, auth, bagTags, messages, announcements).run();
    if (typeof prefsIn.bagTags === "boolean") {
      await env.DB.prepare("UPDATE member_push_subscriptions SET bag_tags = ? WHERE member_id = ?").bind(bagTags, memberId).run();
    }
    if (typeof prefsIn.messages === "boolean") {
      await env.DB.prepare("UPDATE member_push_subscriptions SET messages = ? WHERE member_id = ?").bind(messages, memberId).run();
    }
    if (typeof prefsIn.announcements === "boolean") {
      await env.DB.prepare("UPDATE member_push_subscriptions SET announcements = ? WHERE member_id = ?").bind(announcements, memberId).run();
    }
    // Keep a sane number of devices: drop the oldest beyond the cap.
    await env.DB.prepare(
      `DELETE FROM member_push_subscriptions WHERE member_id = ? AND endpoint NOT IN (
         SELECT endpoint FROM member_push_subscriptions WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_DEVICES})`,
    ).bind(memberId, memberId).run();
    return json({ ok: true, prefs: { bagTags: bagTags === 1, messages: messages === 1, announcements: announcements === 1 } }, 200, origin);
  }

  if (method === "DELETE") {
    const body = (await readJson(request)) ?? {};
    const endpoint = endpointOf(body.endpoint);
    if (!endpoint) return json({ error: "invalid_subscription" }, 400, origin);
    await env.DB.prepare(
      "DELETE FROM member_push_subscriptions WHERE endpoint = ? AND member_id = ?",
    ).bind(endpoint, memberId).run();
    return json({ ok: true }, 200, origin);
  }

  return json({ error: "not_found" }, 404, origin);
}
