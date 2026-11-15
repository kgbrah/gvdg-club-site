import type { Env } from "./env.js";
import { json } from "./http.js";
import { asInt, asStr } from "./input.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import {
  byteRange,
  cardFromMine,
  clipMoment,
  clipTarget,
  MAX_CLIP_BYTES,
  MAX_CLIPS_PER_ROUND,
  MAX_HIGHLIGHTS_PER_ROUND,
  sniffVideo,
  throwClipKey,
  type ClipCard,
} from "./throw-clips.js";

export { cardFromMine };

interface ClipRow {
  id: number;
  hole: number;
  player_name: string;
  player_index: number | null;
  highlight: number;
  moment: string | null;
  created_at: string;
  filmed_by: string;
  r2_key: string;
  content_type: string;
}

function publicClip(row: ClipRow, scope: string, scopeKey: string) {
  const base = scope === "event" ? "/events/" + scopeKey : "/rounds/" + scopeKey;
  return {
    id: row.id,
    hole: row.hole,
    playerName: row.player_name,
    playerIndex: row.player_index,
    highlight: row.highlight === 1,
    moment: row.moment,
    createdAt: row.created_at,
    mediaPath: base + "/live/clips/" + row.id + "/media",
  };
}

async function readClip(env: Env, scope: string, scopeKey: string, id: number): Promise<ClipRow | null> {
  return env.DB.prepare(
    `SELECT id, hole, player_name, player_index, highlight, moment, created_at, filmed_by, r2_key, content_type
       FROM throw_clips WHERE id = ? AND scope = ? AND scope_key = ?`,
  ).bind(id, scope, scopeKey).first<ClipRow>();
}

async function readClientClip(env: Env, scope: string, scopeKey: string, actor: string, clientId: string): Promise<ClipRow | null> {
  return env.DB.prepare(
    `SELECT id, hole, player_name, player_index, highlight, moment, created_at, filmed_by, r2_key, content_type
       FROM throw_clips WHERE scope = ? AND scope_key = ? AND filmed_by = ? AND client_id = ?`,
  ).bind(scope, scopeKey, actor, clientId).first<ClipRow>();
}

function mediaHeaders(row: ClipRow, origin: string | null, size: number, span: { offset: number; length: number } | null) {
  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=300",
    "Content-Type": row.content_type || "video/mp4",
    "X-Content-Type-Options": "nosniff",
  };
  if (span) {
    const end = span.offset + span.length - 1;
    headers["Content-Length"] = String(span.length);
    headers["Content-Range"] = "bytes " + span.offset + "-" + end + "/" + size;
  } else if (size > 0) {
    headers["Content-Length"] = String(size);
  }
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

// Safari will not play a clip unless it can ask for a byte range.
async function clipMediaResponse(request: Request, env: Env, row: ClipRow, origin: string | null) {
  const bucket = env.PHOTOS;
  if (!bucket) return json({ error: "storage_unavailable" }, 503, origin);
  const head = await bucket.head(row.r2_key);
  if (!head) return json({ error: "not_found" }, 404, origin);
  const size = Number(head.size || 0);
  const span = byteRange(request.headers.get("Range"), size);
  if (span === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { ...mediaHeaders(row, origin, size, null), "Content-Range": "bytes */" + size },
    });
  }
  const obj = await bucket.get(row.r2_key, span ? { range: span } : undefined);
  if (!obj) return json({ error: "not_found" }, 404, origin);
  return new Response(obj.body, { status: span ? 206 : 200, headers: mediaHeaders(row, origin, size, span) });
}

export async function handleThrowClips(opts: {
  request: Request;
  env: Env;
  origin: string | null;
  method: string;
  scope: "round" | "event";
  scopeKey: string;
  tail: string[];
  authMember: string | null;
  card: ClipCard | null;
}): Promise<Response> {
  const { request, env, origin, method, scope, scopeKey, tail, authMember, card } = opts;
  if (!env.PHOTOS) return json({ error: "storage_unavailable" }, 503, origin);

  if (method === "GET" && tail.length === 0) {
    const rows = (await env.DB.prepare(
      `SELECT id, hole, player_name, player_index, highlight, moment, created_at, filmed_by, r2_key, content_type
         FROM throw_clips WHERE scope = ? AND scope_key = ?
        ORDER BY highlight DESC, id DESC LIMIT 40`,
    ).bind(scope, scopeKey).all<ClipRow>()).results ?? [];
    return json({ clips: rows.map((row) => publicClip(row, scope, scopeKey)) }, 200, origin);
  }

  const clipId = tail.length ? asInt(tail[0]) : null;
  if (method === "GET" && clipId != null && tail[1] === "media") {
    const row = await readClip(env, scope, scopeKey, clipId);
    if (!row) return json({ error: "not_found" }, 404, origin);
    return clipMediaResponse(request, env, row, origin);
  }

  if (!authMember) return json({ error: "unauthorized" }, 401, origin);

  if (method === "POST" && tail.length === 0) {
    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    if (clientId !== null) {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(clientId)) return json({ error: "invalid_request" }, 400, origin);
      if (!card?.recoveryRoundId || url.searchParams.get("recoveryRoundId") !== card.recoveryRoundId
          || url.searchParams.get("recoveryCardId") !== card.cardId
          || asInt(url.searchParams.get("recoveryActorIndex")) !== card.actorIndex) {
        return json({ error: "recovery_scope_changed" }, 409, origin);
      }
      const existing = await readClientClip(env, scope, scopeKey, authMember, clientId);
      if (existing) return json(publicClip(existing, scope, scopeKey), 200, origin);
    }
    if (await kvRateLimited(env, "clips:" + authMember, 8, 60)) return json({ error: "rate_limited" }, 429, origin);
    const hole = asInt(url.searchParams.get("hole"));
    const playerIndex = asInt(url.searchParams.get("playerIndex"));
    const playerName = asStr(url.searchParams.get("playerName") ?? undefined, 80) ?? "";
    if (hole == null || playerIndex == null) return json({ error: "invalid_request" }, 400, origin);
    const target = clipTarget(card, hole, playerIndex, playerName);
    if (!target.ok) return json({ error: target.error }, target.error === "round_not_live" ? 409 : 400, origin);

    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MAX_CLIP_BYTES) return json({ error: "clip_too_large" }, 413, origin);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength < 32 || bytes.byteLength > MAX_CLIP_BYTES) {
      return json({ error: bytes.byteLength > MAX_CLIP_BYTES ? "clip_too_large" : "invalid_video" }, bytes.byteLength > MAX_CLIP_BYTES ? 413 : 400, origin);
    }
    const video = sniffVideo(bytes);
    if (!video) return json({ error: "invalid_video" }, 400, origin);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM throw_clips WHERE scope = ? AND scope_key = ?",
    ).bind(scope, scopeKey).first<{ n: number }>();
    if (Number(count?.n ?? 0) >= MAX_CLIPS_PER_ROUND) return json({ error: "clip_limit" }, 409, origin);

    let highlight = url.searchParams.get("highlight") === "1";
    if (highlight) {
      const stars = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM throw_clips WHERE scope = ? AND scope_key = ? AND highlight = 1",
      ).bind(scope, scopeKey).first<{ n: number }>();
      if (Number(stars?.n ?? 0) >= MAX_HIGHLIGHTS_PER_ROUND) highlight = false;
    }
    const moment = highlight ? clipMoment(url.searchParams.get("moment")) : null;
    const key = throwClipKey(scope, scopeKey, video.ext, crypto.randomUUID());
    await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: video.contentType } });
    try {
      const inserted = await env.DB.prepare(
        `INSERT INTO throw_clips
          (scope, scope_key, hole, player_name, player_index, filmed_by, r2_key, content_type, bytes, highlight, moment, client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, scope_key, filmed_by, client_id) WHERE client_id IS NOT NULL DO NOTHING`,
      ).bind(scope, scopeKey, hole, target.name, playerIndex, authMember, key, video.contentType, bytes.byteLength, highlight ? 1 : 0, moment, clientId).run();
      if (clientId && !inserted.meta?.changes) {
        await env.PHOTOS.delete(key).catch(() => {});
        const existing = await readClientClip(env, scope, scopeKey, authMember, clientId);
        if (existing) return json(publicClip(existing, scope, scopeKey), 200, origin);
        return json({ error: "clip_save_incomplete" }, 503, origin);
      }
      const id = Number(inserted.meta?.last_row_id ?? 0);
      return json({ id, highlight, moment, playerName: target.name, hole }, 201, origin);
    } catch (error) {
      // A write that committed before a transport failure still owns its R2 object.
      if (clientId) {
        const existing = await readClientClip(env, scope, scopeKey, authMember, clientId).catch(() => undefined);
        if (existing) {
          if (existing.r2_key !== key) await env.PHOTOS.delete(key).catch(() => {});
          return json(publicClip(existing, scope, scopeKey), 200, origin);
        }
        if (existing === undefined) throw error;
      }
      await env.PHOTOS.delete(key).catch(() => {});
      throw error;
    }
  }

  if (clipId == null) return json({ error: "not_found" }, 404, origin);
  const row = await readClip(env, scope, scopeKey, clipId);
  if (!row) return json({ error: "not_found" }, 404, origin);
  const owns = row.filmed_by === authMember;

  if (method === "POST" && tail[1] === "highlight") {
    if (!owns && !(card && (card.status === "live" || card.status === "final") && card.cardmates.length)) {
      return json({ error: "forbidden" }, 403, origin);
    }
    const bodyText = await request.text();
    let want = true;
    try {
      const parsed = JSON.parse(bodyText) as { highlight?: unknown };
      if (typeof parsed.highlight === "boolean") want = parsed.highlight;
    } catch {
      return json({ error: "invalid_request" }, 400, origin);
    }
    if (want && row.highlight !== 1) {
      const stars = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM throw_clips WHERE scope = ? AND scope_key = ? AND highlight = 1",
      ).bind(scope, scopeKey).first<{ n: number }>();
      if (Number(stars?.n ?? 0) >= MAX_HIGHLIGHTS_PER_ROUND) return json({ error: "highlight_limit" }, 409, origin);
    }
    const moment = want ? (row.moment || "manual") : null;
    await env.DB.prepare(
      "UPDATE throw_clips SET highlight = ?, moment = ? WHERE id = ? AND scope = ? AND scope_key = ?",
    ).bind(want ? 1 : 0, moment, clipId, scope, scopeKey).run();
    return json({ id: clipId, highlight: want, moment }, 200, origin);
  }

  if (method === "DELETE" && tail.length === 1) {
    if (!owns) return json({ error: "forbidden" }, 403, origin);
    await env.DB.prepare("DELETE FROM throw_clips WHERE id = ? AND scope = ? AND scope_key = ?").bind(clipId, scope, scopeKey).run();
    await env.PHOTOS.delete(row.r2_key).catch(() => {});
    return json({ ok: true }, 200, origin);
  }

  return json({ error: "not_found" }, 404, origin);
}
