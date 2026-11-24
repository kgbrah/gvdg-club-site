// Club-wide admin announcements: persists admin posts to club_announcements, records
// member_notices for every active (non-held) member, and sends Web Push to every member
// with push notifications enabled.

import type { Env } from "./env.js";
import { requireMember } from "./authz.js";
import { json, readJson } from "./http.js";
import { asInt, asStr } from "./input.js";
import { recordMemberNotices } from "./member-messages.js";
import { notifyAllSubscribedMembers } from "./member-push.js";
import { getMember, listMembers } from "./roster.js";

type WaitCtx = { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

type AnnouncementRow = {
  id: number;
  title: string;
  body: string;
  href: string;
  created_by: string;
  author_name: string;
  created_at: string;
};

export function safeMemberHref(raw: unknown): string {
  if (
    typeof raw === "string"
    && raw.startsWith("/gvdg-members.html")
    && !raw.startsWith("//")
    && !raw.includes("\\")
    && !raw.includes("://")
  ) {
    return raw.slice(0, 180);
  }
  return "/gvdg-members.html#home";
}

function viewAnnouncement(row: AnnouncementRow) {
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body,
    href: safeMemberHref(row.href),
    authorName: row.author_name,
    createdAt: row.created_at,
  };
}

export async function broadcastClubAnnouncement(
  ctx: WaitCtx,
  env: Env,
  input: { kind: string; title: string; body: string; href: string; refKey: string; tag: string },
): Promise<number> {
  let activeMembers: Awaited<ReturnType<typeof listMembers>> = [];
  if (env.ROSTER) {
    try {
      activeMembers = (await listMembers(env.ROSTER)).filter((m) => m.held !== true);
    } catch {
      // Partial KV mock in tests or transient roster read issue; still deliver Web Push.
      activeMembers = [];
    }
  }
  const memberIds = activeMembers.map((m) => m.memberId);
  if (memberIds.length) {
    await recordMemberNotices(env, memberIds, {
      kind: input.kind,
      title: input.title,
      body: input.body,
      href: safeMemberHref(input.href),
      refKey: input.refKey,
    }, 1000).catch(() => {});
  }
  notifyAllSubscribedMembers(ctx, env, "announcements", {
    title: input.title,
    body: input.body,
    url: safeMemberHref(input.href),
    tag: input.tag,
  });
  return memberIds.length;
}

export async function handleMemberAnnouncements(
  request: Request,
  env: Env,
  origin: string | null,
  pathname: string,
  method: string,
): Promise<Response | null> {
  if (pathname !== "/announcements" || method !== "GET") return null;
  const auth = await requireMember(request, env, origin);
  if (auth instanceof Response) return auth;
  const rows = (await env.DB.prepare(
    `SELECT id, title, body, href, created_by, author_name, created_at
     FROM club_announcements
     WHERE created_at >= datetime('now', '-30 days')
     ORDER BY id DESC
     LIMIT 10`,
  ).all<AnnouncementRow>()).results ?? [];
  return json({ announcements: rows.map(viewAnnouncement) }, 200, origin);
}

export async function handleAdminAnnouncements(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  adminId: string,
  ctx?: WaitCtx,
): Promise<Response> {
  if (method === "GET" && seg.length === 2) {
    const rows = (await env.DB.prepare(
      `SELECT id, title, body, href, created_by, author_name, created_at
       FROM club_announcements
       ORDER BY id DESC
       LIMIT 30`,
    ).all<AnnouncementRow>()).results ?? [];
    return json({ announcements: rows.map(viewAnnouncement) }, 200, origin);
  }

  if (method === "POST" && seg.length === 2) {
    const body = (await readJson(request)) ?? {};
    const title = asStr(body.title, 80);
    const message = asStr(body.body, 500);
    if (!title || !message) return json({ error: "invalid_announcement" }, 400, origin);
    const href = safeMemberHref(body.href);
    const author = env.ROSTER ? (await getMember(env.ROSTER, adminId))?.name?.trim() : "";
    const authorName = author || "Club admin";
    const inserted = await env.DB.prepare(
      `INSERT INTO club_announcements (title, body, href, created_by, author_name)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`,
    ).bind(title, message, href, adminId, authorName).first<AnnouncementRow>();
    if (!inserted) return json({ error: "save_failed" }, 500, origin);

    const notifiedCount = await broadcastClubAnnouncement(ctx, env, {
      kind: "announcement",
      title,
      body: message,
      href,
      refKey: `announcement-${inserted.id}`,
      tag: `announcement-${inserted.id}`,
    });
    return json({ announcement: viewAnnouncement(inserted), notifiedCount }, 201, origin);
  }

  if (method === "DELETE" && seg.length === 3) {
    const id = asInt(seg[2]);
    if (id == null || id <= 0) return json({ error: "not_found" }, 404, origin);
    const info = await env.DB.prepare("DELETE FROM club_announcements WHERE id = ?").bind(id).run();
    if (!info.meta?.changes) return json({ error: "not_found" }, 404, origin);
    return json({ ok: true }, 200, origin);
  }

  return json({ error: "not_found" }, 404, origin);
}
