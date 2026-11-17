// Member-to-member messages and the in-app list of updates a member has not opened yet.

import type { Env } from "./env.js";
import { requireMember } from "./authz.js";
import { json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { notifyMembers } from "./member-push.js";
import { getMember, listMembers } from "./roster.js";

const MAX_BODY = 500;

type ThreadRow = {
  id: number;
  member_low: string;
  member_high: string;
  updated_at: string;
  last_body: string;
  last_sender_id: string;
  last_read_id: number | null;
  unread: number;
};

type MessageRow = { id: number; sender_id: string; body: string; created_at: string };
type NoticeRow = {
  id: number;
  kind: string;
  title: string;
  body: string;
  href: string;
  created_at: string;
  seen_at: string | null;
};

function cleanBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (!text || text.length > MAX_BODY) return null;
  return text;
}

function pairOf(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function otherId(row: { member_low: string; member_high: string }, self: string): string {
  return row.member_low === self ? row.member_high : row.member_low;
}

async function publicName(env: Env, memberId: string): Promise<string> {
  const member = await getMember(env.ROSTER, memberId);
  const name = member?.name?.trim();
  return name || "Member";
}

export async function recordMemberNotices(
  env: Env,
  memberIds: readonly string[],
  notice: { kind: string; title: string; body: string; href: string; refKey: string },
): Promise<void> {
  const ids = [...new Set(memberIds.filter((id) => typeof id === "string" && id))].slice(0, 20);
  if (!ids.length) return;
  await Promise.all(ids.map((memberId) => env.DB.prepare(
    `INSERT OR IGNORE INTO member_notices (member_id, kind, title, body, href, ref_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    memberId,
    notice.kind.slice(0, 24),
    notice.title.slice(0, 80),
    notice.body.slice(0, 180),
    notice.href.slice(0, 180),
    notice.refKey.slice(0, 80),
  ).run()));
}

async function counts(env: Env, memberId: string): Promise<{ unread: number; unseen: number }> {
  const unread = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM member_threads t
     WHERE (t.member_low = ? OR t.member_high = ?)
       AND EXISTS (
         SELECT 1 FROM member_messages m
         LEFT JOIN member_thread_reads r ON r.thread_id = t.id AND r.member_id = ?
         WHERE m.thread_id = t.id AND m.sender_id != ? AND m.id > COALESCE(r.last_read_id, 0)
       )`,
  ).bind(memberId, memberId, memberId, memberId).first<{ n: number }>();
  const unseen = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM member_notices WHERE member_id = ? AND seen_at IS NULL AND kind != 'message'",
  ).bind(memberId).first<{ n: number }>();
  return { unread: Number(unread?.n) || 0, unseen: Number(unseen?.n) || 0 };
}

async function threadFor(env: Env, memberId: string, threadId: number): Promise<ThreadRow | null> {
  return env.DB.prepare(
    `SELECT t.id, t.member_low, t.member_high, t.updated_at, t.last_body, t.last_sender_id,
            r.last_read_id,
            (SELECT COUNT(*) FROM member_messages m
              WHERE m.thread_id = t.id AND m.sender_id != ? AND m.id > COALESCE(r.last_read_id, 0)) AS unread
     FROM member_threads t
     LEFT JOIN member_thread_reads r ON r.thread_id = t.id AND r.member_id = ?
     WHERE t.id = ? AND (t.member_low = ? OR t.member_high = ?)`,
  ).bind(memberId, memberId, threadId, memberId, memberId).first<ThreadRow>();
}

async function ensureThread(env: Env, self: string, other: string): Promise<number> {
  const [low, high] = pairOf(self, other);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO member_threads (member_low, member_high) VALUES (?, ?)",
  ).bind(low, high).run();
  const row = await env.DB.prepare(
    "SELECT id FROM member_threads WHERE member_low = ? AND member_high = ?",
  ).bind(low, high).first<{ id: number }>();
  return Number(row?.id);
}

async function appendMessage(env: Env, ctx: { waitUntil?: (promise: Promise<unknown>) => void } | undefined, self: string, threadId: number, body: string) {
  await env.DB.prepare(
    "INSERT INTO member_messages (thread_id, sender_id, body) VALUES (?, ?, ?)",
  ).bind(threadId, self, body).run();
  const saved = await env.DB.prepare(
    "SELECT id, created_at FROM member_messages WHERE thread_id = ? AND sender_id = ? ORDER BY id DESC LIMIT 1",
  ).bind(threadId, self).first<{ id: number; created_at: string }>();
  const messageId = Number(saved?.id) || 0;
  await env.DB.prepare(
    "UPDATE member_threads SET updated_at = datetime('now'), last_body = ?, last_sender_id = ? WHERE id = ?",
  ).bind(body, self, threadId).run();
  await env.DB.prepare(
    `INSERT INTO member_thread_reads (thread_id, member_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(thread_id, member_id) DO UPDATE SET last_read_id = excluded.last_read_id`,
  ).bind(threadId, self, messageId).run();
  const thread = await env.DB.prepare(
    "SELECT member_low, member_high FROM member_threads WHERE id = ?",
  ).bind(threadId).first<{ member_low: string; member_high: string }>();
  const recipient = thread ? otherId(thread, self) : "";
  if (recipient && messageId) {
    const name = await publicName(env, self);
    const href = `/gvdg-members.html#messages?thread=${threadId}`;
    await recordMemberNotices(env, [recipient], {
      kind: "message",
      title: name,
      body,
      href,
      refKey: `msg:${threadId}:${messageId}`,
    });
    notifyMembers(ctx, env, [recipient], "messages", {
      title: name,
      body,
      url: href,
      tag: `message:${threadId}`,
    });
  }
  return { id: messageId, at: saved?.created_at || "" };
}

async function markThreadRead(env: Env, memberId: string, threadId: number) {
  const latest = await env.DB.prepare(
    "SELECT COALESCE(MAX(id), 0) AS id FROM member_messages WHERE thread_id = ?",
  ).bind(threadId).first<{ id: number }>();
  await env.DB.prepare(
    `INSERT INTO member_thread_reads (thread_id, member_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(thread_id, member_id) DO UPDATE SET last_read_id = excluded.last_read_id`,
  ).bind(threadId, memberId, Number(latest?.id) || 0).run();
  await env.DB.prepare(
    `UPDATE member_notices SET seen_at = datetime('now')
     WHERE member_id = ? AND seen_at IS NULL AND ref_key LIKE ?`,
  ).bind(memberId, `msg:${threadId}:%`).run();
}

export async function handleMemberMessages(
  request: Request,
  env: Env,
  origin: string | null,
  pathname: string,
  method: string,
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<Response | null> {
  if (pathname !== "/me/notices" && pathname !== "/me/notices/seen" && !pathname.startsWith("/me/messages")) return null;
  const session = await requireMember(request, env, origin);
  if (session instanceof Response) return session;
  const self = session.sub;

  if (pathname === "/me/messages/summary" && method === "GET") {
    return json(await counts(env, self), 200, origin);
  }

  if (pathname === "/me/notices" && method === "GET") {
    const listed = await env.DB.prepare(
      `SELECT id, kind, title, body, href, created_at, seen_at FROM member_notices
       WHERE member_id = ? AND kind != 'message' ORDER BY id DESC LIMIT 30`,
    ).bind(self).all<NoticeRow>();
    return json({
      notices: (listed.results ?? []).map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        href: row.href,
        at: row.created_at,
        seen: Boolean(row.seen_at),
      })),
    }, 200, origin);
  }

  if (pathname === "/me/notices/seen" && method === "POST") {
    const body = (await readJson(request)) ?? {};
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id) => Number.isInteger(id) && id > 0).slice(0, 30)
      : [];
    if (ids.length) {
      const marks = ids.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE member_notices SET seen_at = datetime('now')
         WHERE member_id = ? AND seen_at IS NULL AND id IN (${marks})`,
      ).bind(self, ...ids).run();
    } else {
      await env.DB.prepare(
        "UPDATE member_notices SET seen_at = datetime('now') WHERE member_id = ? AND seen_at IS NULL AND kind != 'message'",
      ).bind(self).run();
    }
    return json({ ok: true, ...(await counts(env, self)) }, 200, origin);
  }

  if (pathname === "/me/messages/people" && method === "GET") {
    const query = new URL(request.url).searchParams.get("q")?.trim().toLowerCase() || "";
    if (query.length > 40) return json({ error: "invalid_query" }, 400, origin);
    const people = (await listMembers(env.ROSTER))
      .filter((person) => person.memberId !== self && (!query || person.name.toLowerCase().includes(query)))
      .slice(0, 8)
      .map((person) => ({ memberId: person.memberId, name: person.name }));
    return json({ people }, 200, origin);
  }

  if (pathname === "/me/messages" && method === "GET") {
    const listed = await env.DB.prepare(
      `SELECT t.id, t.member_low, t.member_high, t.updated_at, t.last_body, t.last_sender_id, r.last_read_id,
              (SELECT COUNT(*) FROM member_messages m
                WHERE m.thread_id = t.id AND m.sender_id != ? AND m.id > COALESCE(r.last_read_id, 0)) AS unread
       FROM member_threads t
       LEFT JOIN member_thread_reads r ON r.thread_id = t.id AND r.member_id = ?
       WHERE t.member_low = ? OR t.member_high = ?
       ORDER BY t.updated_at DESC, t.id DESC LIMIT 40`,
    ).bind(self, self, self, self).all<ThreadRow>();
    const threads = await Promise.all((listed.results ?? []).map(async (row) => {
      const withId = otherId(row, self);
      return {
        id: row.id,
        with: { memberId: withId, name: await publicName(env, withId) },
        preview: row.last_body,
        at: row.updated_at,
        fromMe: row.last_sender_id === self,
        unread: Number(row.unread) || 0,
      };
    }));
    return json({ ...(await counts(env, self)), threads }, 200, origin);
  }

  if (pathname === "/me/messages" && method === "POST") {
    const body = (await readJson(request)) ?? {};
    const text = cleanBody(body.body);
    const to = typeof body.to === "string" ? body.to.trim() : "";
    if (!text || !to || to === self) return json({ error: "invalid_message" }, 400, origin);
    const recipient = await getMember(env.ROSTER, to);
    if (!recipient) return json({ error: "not_found" }, 404, origin);
    if (await kvRateLimited(env, "dm:" + self, 30, 3600)) return json({ error: "rate_limited" }, 429, origin);
    const threadId = await ensureThread(env, self, to);
    if (!threadId) return json({ error: "server_error" }, 500, origin);
    const saved = await appendMessage(env, ctx, self, threadId, text);
    return json({ threadId, message: { id: saved.id, body: text, mine: true, at: saved.at } }, 201, origin);
  }

  const match = /^\/me\/messages\/(\d{1,12})$/.exec(pathname);
  if (!match) return json({ error: "not_found" }, 404, origin);
  const threadId = Number(match[1]);
  const thread = await threadFor(env, self, threadId);
  if (!thread) return json({ error: "not_found" }, 404, origin);

  if (method === "GET") {
    const listed = await env.DB.prepare(
      "SELECT id, sender_id, body, created_at FROM member_messages WHERE thread_id = ? ORDER BY id ASC LIMIT 200",
    ).bind(threadId).all<MessageRow>();
    await markThreadRead(env, self, threadId);
    const withId = otherId(thread, self);
    return json({
      thread: { id: thread.id, with: { memberId: withId, name: await publicName(env, withId) } },
      messages: (listed.results ?? []).map((row) => ({
        id: row.id,
        body: row.body,
        mine: row.sender_id === self,
        at: row.created_at,
      })),
      ...(await counts(env, self)),
    }, 200, origin);
  }

  if (method === "POST") {
    const body = (await readJson(request)) ?? {};
    const text = cleanBody(body.body);
    if (!text) return json({ error: "invalid_message" }, 400, origin);
    if (await kvRateLimited(env, "dm:" + self, 30, 3600)) return json({ error: "rate_limited" }, 429, origin);
    const saved = await appendMessage(env, ctx, self, threadId, text);
    return json({ message: { id: saved.id, body: text, mine: true, at: saved.at } }, 201, origin);
  }

  return json({ error: "not_found" }, 404, origin);
}
