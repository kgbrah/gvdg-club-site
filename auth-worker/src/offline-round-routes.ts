import { OFFLINE_ID, offlineRoundOutcome, parseOfflineRound, type OfflineOwner } from "../../src/shared/offline-round.js";
import { requireRoundActor } from "./authz.js";
import type { Env } from "./env.js";
import { json, corsHeaders, readBytesLimited, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { offlineRoundActor, signOfflineOpenSession } from "./offline-round-auth.js";
import { byteRange, clipMoment, MAX_CLIP_BYTES, MAX_CLIPS_PER_ROUND, sniffVideo } from "./throw-clips.js";

const text = new TextEncoder();
const ROUND_LIMIT = 50;

type RoundRow = {
  id: number; local_id: string; payload_hash: string; owner_id: string; owner_kind: OfflineOwner["kind"];
  course_name: string; layout_name: string; finished_at: string; created_at: string; snapshot: string;
};

type ClipRow = {
  id: number; offline_round_id: number; client_id: string; payload_hash: string; r2_key: string;
  hole: number; player_index: number; player_name: string; content_type: string; bytes: number; highlight: number; moment: string | null; created_at: string;
};

function int(raw: string | null, min: number, max = Number.MAX_SAFE_INTEGER) {
  const value = raw && /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

async function digest(raw: Uint8Array<ArrayBuffer>) {
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function roundReceipt(row: Pick<RoundRow, "id" | "local_id" | "created_at">) {
  return { id: row.id, localId: row.local_id, uploadedAt: row.created_at, source: "offline" };
}

function clipReceipt(row: ClipRow) {
  return {
    id: row.id, clientId: row.client_id, roundId: row.offline_round_id, hole: row.hole, playerIndex: row.player_index,
    playerName: row.player_name, contentType: row.content_type, bytes: row.bytes, highlight: row.highlight === 1,
    moment: row.moment, createdAt: row.created_at, mediaPath: `/offline-rounds/${row.offline_round_id}/clips/${row.id}/media`,
  };
}

async function importRound(request: Request, env: Env, origin: string | null, owner: OfflineOwner) {
  const round = parseOfflineRound(await readJson(request, 640_000));
  if (!round) return json({ error: "invalid_offline_round" }, 400, origin);
  if (round.owner.id !== owner.id || round.owner.kind !== owner.kind) return json({ error: "offline_owner_mismatch" }, 403, origin);
  if (await kvRateLimited(env, "offline-round-import:" + owner.id, 20, 60)) return json({ error: "rate_limited" }, 429, origin);
  const snapshot = JSON.stringify(round);
  const hash = await digest(text.encode(snapshot));
  const inserted = await env.DB.prepare(`INSERT INTO offline_rounds
    (local_id, owner_id, owner_kind, payload_hash, course_name, layout_name, finished_at, snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(local_id) DO NOTHING RETURNING id, local_id, created_at`)
    .bind(round.localId, owner.id, owner.kind, hash, round.source.courseName, round.source.layoutName, round.finishedAt, snapshot)
    .first<RoundRow>();
  if (inserted) return json(roundReceipt(inserted), 201, origin);
  const existing = await env.DB.prepare("SELECT id, local_id, created_at, owner_id, owner_kind, payload_hash FROM offline_rounds WHERE local_id = ?")
    .bind(round.localId).first<RoundRow>();
  if (!existing || existing.owner_id !== owner.id || existing.owner_kind !== owner.kind || existing.payload_hash !== hash) {
    return json({ error: "offline_round_conflict" }, 409, origin);
  }
  return json(roundReceipt(existing), 200, origin);
}

async function listRounds(env: Env, origin: string | null, owner: OfflineOwner, search: URLSearchParams) {
  const before = search.has("before") ? int(search.get("before"), 1) : Number.MAX_SAFE_INTEGER;
  if (before == null) return json({ error: "invalid_cursor" }, 400, origin);
  const rows = await env.DB.prepare(`SELECT id, local_id, created_at, course_name, layout_name, finished_at FROM offline_rounds
    WHERE owner_kind = ? AND owner_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
    .bind(owner.kind, owner.id, before, ROUND_LIMIT + 1).all<RoundRow>();
  if (!rows.success) throw new Error("offline_list_failed");
  const shown = rows.results.slice(0, ROUND_LIMIT);
  return json({ rounds: shown.map((row) => ({ ...roundReceipt(row), courseName: row.course_name, layoutName: row.layout_name, finishedAt: row.finished_at })),
    before: rows.results.length > ROUND_LIMIT ? shown.at(-1)?.id : null }, 200, origin);
}

async function roundClips(env: Env, roundId: number) {
  const rows = await env.DB.prepare("SELECT * FROM offline_round_clips WHERE offline_round_id = ? ORDER BY id")
    .bind(roundId).all<ClipRow>();
  if (!rows.success) throw new Error("offline_clip_list_failed");
  return rows.results.map(clipReceipt);
}

async function uploadClip(request: Request, env: Env, origin: string | null, stored: RoundRow, owner: OfflineOwner) {
  if (!env.PHOTOS) return json({ error: "storage_unavailable" }, 503, origin);
  const params = new URL(request.url).searchParams;
  const clientId = params.get("clientId");
  const hole = int(params.get("hole"), 1, 36);
  const playerIndex = int(params.get("playerIndex"), 0, 15);
  if (!clientId || !OFFLINE_ID.test(clientId) || hole == null || playerIndex == null) return json({ error: "invalid_request" }, 400, origin);
  const round = parseOfflineRound(JSON.parse(stored.snapshot));
  const player = round?.players[playerIndex];
  if (!player || !round?.source.holes.some((candidate) => candidate.hole === hole)) return json({ error: "invalid_clip_target" }, 400, origin);
  if (await kvRateLimited(env, "offline-clip:" + owner.id, 8, 60)) return json({ error: "rate_limited" }, 429, origin);
  const bytes = await readBytesLimited(request, MAX_CLIP_BYTES);
  if (!bytes) return json({ error: "clip_too_large" }, 413, origin);
  const video = bytes.length >= 32 ? sniffVideo(bytes) : null;
  if (!video) return json({ error: "invalid_video" }, 400, origin);
  const highlight = params.get("highlight") === "1";
  const moment = highlight ? clipMoment(params.get("moment")) : null;
  const hash = await digest(text.encode(JSON.stringify([await digest(bytes), hole, playerIndex, highlight, moment])));
  const previous = () => env.DB.prepare("SELECT * FROM offline_round_clips WHERE offline_round_id = ? AND client_id = ?")
    .bind(stored.id, clientId).first<ClipRow>();
  function ack(row: ClipRow) {
    return row.payload_hash === hash ? json(clipReceipt(row), 200, origin) : json({ error: "offline_clip_conflict" }, 409, origin);
  }
  const existing = await previous();
  if (existing) return ack(existing);
  const key = `offline-throw-clips/${stored.id}/${clientId}-${hash}.${video.ext}`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: video.contentType } });
  try {
    const saved = await env.DB.prepare(`INSERT INTO offline_round_clips
      (offline_round_id, client_id, payload_hash, r2_key, hole, player_index, player_name, content_type, bytes, highlight, moment)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM offline_round_clips WHERE offline_round_id = ?) < ?
      ON CONFLICT(offline_round_id, client_id) DO NOTHING RETURNING *`)
      .bind(stored.id, clientId, hash, key, hole, playerIndex, player.name, video.contentType, bytes.length, Number(highlight), moment, stored.id, MAX_CLIPS_PER_ROUND)
      .first<ClipRow>();
    if (saved) return json(clipReceipt(saved), 201, origin);
    const replay = await previous();
    if (replay?.r2_key !== key) await env.PHOTOS.delete(key).catch(() => {});
    return replay ? ack(replay) : json({ error: "clip_limit" }, 409, origin);
  } catch (error) {
    const replay = await previous().catch(() => undefined);
    if (replay?.r2_key === key) return ack(replay);
    await env.PHOTOS.delete(key).catch(() => {});
    if (replay) return ack(replay);
    throw error;
  }
}

async function media(request: Request, env: Env, origin: string | null, roundId: number, clipId: number) {
  const row = await env.DB.prepare("SELECT r2_key, content_type, bytes FROM offline_round_clips WHERE offline_round_id = ? AND id = ?")
    .bind(roundId, clipId).first<ClipRow>();
  if (!row) return json({ error: "not_found" }, 404, origin);
  if (!env.PHOTOS) return json({ error: "storage_unavailable" }, 503, origin);
  const headers = { ...corsHeaders(origin), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Content-Type": row.content_type, "Accept-Ranges": "bytes" };
  const span = byteRange(request.headers.get("Range"), row.bytes);
  if (span === "invalid") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${row.bytes}` } });
  const object = await env.PHOTOS.get(row.r2_key, span ? { range: span } : undefined);
  if (!object) return json({ error: "not_found" }, 404, origin);
  return new Response(object.body, { status: span ? 206 : 200, headers: {
    ...headers, "Content-Length": String(span?.length ?? row.bytes),
    ...(span ? { "Content-Range": `bytes ${span.offset}-${span.offset + span.length - 1}/${row.bytes}` } : {}),
  } });
}

export async function handleOfflineRoundRoute(request: Request, env: Env, origin: string | null, path: string, method: string): Promise<Response | null> {
  if (path !== "/offline-rounds" && !path.startsWith("/offline-rounds/")) return null;
  if (path === "/offline-rounds/open-session" && method === "POST") {
    const actor = await requireRoundActor(request, env);
    if (actor?.kind !== "open") return json({ error: "unauthorized" }, 401, origin);
    return json({ offlineToken: await signOfflineOpenSession(actor.sub, env.JWT_SECRET), playerId: actor.sub }, 200, origin);
  }
  const owner = await offlineRoundActor(request, env);
  if (!owner) return json({ error: "unauthorized" }, 401, origin);
  if (path === "/offline-rounds/import" && method === "POST") return importRound(request, env, origin, owner);
  if (path === "/offline-rounds" && method === "GET") return listRounds(env, origin, owner, new URL(request.url).searchParams);
  const match = /^\/offline-rounds\/(\d+)(?:\/(clips)(?:\/(\d+)\/media)?)?$/.exec(path);
  if (!match) return json({ error: "not_found" }, 404, origin);
  const id = int(match[1] ?? null, 1);
  if (id == null) return json({ error: "not_found" }, 404, origin);
  const row = await env.DB.prepare("SELECT * FROM offline_rounds WHERE id = ? AND owner_kind = ? AND owner_id = ?")
    .bind(id, owner.kind, owner.id).first<RoundRow>();
  if (!row) return json({ error: "not_found" }, 404, origin);
  if (match[2] === "clips") {
    if (match[3] && method === "GET") {
      const clipId = int(match[3], 1);
      return clipId == null ? json({ error: "not_found" }, 404, origin) : media(request, env, origin, id, clipId);
    }
    if (!match[3] && method === "POST") return uploadClip(request, env, origin, row, owner);
  } else if (method === "GET") {
    const round = parseOfflineRound(JSON.parse(row.snapshot));
    if (!round) throw new Error("offline_snapshot_invalid");
    return json({ ...roundReceipt(row), round, outcome: offlineRoundOutcome(round), clips: await roundClips(env, id) }, 200, origin);
  }
  return json({ error: "not_found" }, 404, origin);
}
