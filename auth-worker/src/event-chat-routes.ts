import type { Env } from "./env.js";
import * as db from "./db.js";
import { requireAuth } from "./authz.js";
import { clientIp, json, readJson } from "./http.js";
import { asInt } from "./input.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { getMember } from "./roster.js";

const BODY_MAX = 280;
const NAME_MAX = 32;
const LIST_LIMIT = 100;
const POST_LIMIT = 20;
const POST_WINDOW_SEC = 60;

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function publicMessage(row: Record<string, unknown> | null) {
  if (!row) return null;
  const body = typeof row.body === "string" ? row.body : "";
  const author = typeof row.author_name === "string" && row.author_name.trim() ? row.author_name.trim() : "Fan";
  if (!body) return null;
  return {
    id: row.id ?? null,
    author_name: author,
    body,
    created_at: row.created_at ?? null,
  };
}

export async function handleEventChat(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
): Promise<Response | null> {
  if (seg[0] !== "events" || seg.length !== 3 || seg[2] !== "chat") return null;
  const eventId = asInt(seg[1]);
  if (eventId == null) return json({ error: "not_found" }, 404, origin);
  const event = (await db.getEvent(env.DB, eventId)) as { id?: number; status?: string } | null;
  if (!event) return json({ error: "not_found" }, 404, origin);
  const open = event.status === "live";

  if (method === "GET") {
    if (!open) return json({ open: false, messages: [] }, 200, origin);
    const rows = await db.listEventChat(env.DB, eventId, LIST_LIMIT);
    const messages = (Array.isArray(rows) ? rows : [])
      .map((row) => publicMessage(row as Record<string, unknown>))
      .filter(Boolean)
      .reverse();
    return json({ open: true, messages }, 200, origin);
  }

  if (method === "POST") {
    if (!open) return json({ error: "chat_closed" }, 409, origin);
    const claims = await requireAuth(request, env);
    const ip = clientIp(request);
    const rateKey = "event-chat:" + (claims?.sub || ip);
    if (await kvRateLimited(env, rateKey, POST_LIMIT, POST_WINDOW_SEC)) {
      return json({ error: "rate_limited" }, 429, origin);
    }
    const body = (await readJson(request)) ?? {};
    const raw = typeof body.body === "string" ? body.body.trim() : "";
    if (raw.length > BODY_MAX) return json({ error: "message_too_long" }, 413, origin);
    const text = cleanText(raw, BODY_MAX);
    if (!text) return json({ error: "empty_message" }, 400, origin);
    const member = claims ? (claims.member ?? (await getMember(env.ROSTER, claims.sub))) : null;
    const authorName = member?.name
      ? cleanText(member.name, NAME_MAX)
      : cleanText(body.name, NAME_MAX);
    if (!authorName) return json({ error: "name_required" }, 400, origin);
    const row = (await db.createEventChat(env.DB, {
      event_id: eventId,
      member_id: claims?.sub ?? null,
      author_name: authorName,
      body: text,
    })) as Record<string, unknown> | null;
    const message = publicMessage(row);
    if (!message) return json({ error: "server_error" }, 500, origin);
    return json({ message }, 201, origin);
  }

  return null;
}
