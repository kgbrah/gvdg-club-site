import { requireAuth } from "./authz.js";
import type { Env } from "./env.js";
import { bearer, clientIp, corsHeaders, json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { ACTIVITY_UUID, activityGpx, activityTotals, parseActivityTrack, validActivityRoundKey, type ActivityTrack } from "./phone-activity-model.js";
import { getMember } from "./roster.js";
import type { WatchScope } from "./watch-do.js";

const PAIR_TTL = 5 * 60_000;
const DEVICE_TTL = 30 * 24 * 60 * 60_000;
const MAX_DEVICES = 4;
const PAGE_SIZE = 20;
const CODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN = /^gvdga_[a-zA-Z0-9_-]{43}$/;
const encoder = new TextEncoder();
const privacy = { "Cache-Control": "private, no-store" };

type Device = {
  id: string; platform: string; expires_at: number; approved_at: number | null;
  member_id: string | null; pin_version: number | null;
  round_key: string | null; round_id: string | null; card_id: string | null; actor_index: number | null;
};
type Saved = {
  id: number; client_id: string; member_id: string; payload_hash: string;
  started_at: number; stopped_at: number; distance_m: number; point_count: number; archived_at: string; deleted_at: string | null; snapshot: string;
};
type PrivateCard = {
  scope: WatchScope; status: string; courseName?: string; layoutName?: string; startingHole?: number;
  holes: Array<{ hole: number; basket: { lat: number; lng: number } | null }>;
};

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hash(value: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function codeHash(code: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("gvdg-activity-code:" + code))));
}

function normalize(raw: unknown) {
  if (typeof raw !== "string") return null;
  const value = raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(value) ? value : null;
}

function positiveId(raw: string | null) {
  const id = raw && /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function card(env: Env, memberId: string, roundKey: string, scope?: WatchScope): Promise<{ ok: true; data: PrivateCard } | { ok: false }> {
  const reply = await env.LIVE.get(env.LIVE.idFromName(roundKey)).fetch("https://do/watch-card", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Auth-Member": memberId },
    body: JSON.stringify(scope ? { scope } : {}),
  });
  return reply.ok ? { ok: true, data: await reply.json<PrivateCard>() } : { ok: false };
}

async function startPair(request: Request, env: Env, origin: string | null) {
  if (await kvRateLimited(env, "activity-pair:" + clientIp(request), 12, 300)) return json({ error: "rate_limited" }, 429, origin);
  const platform = (await readJson(request, 1024))?.platform;
  if (platform !== "ios" && platform !== "android") return json({ error: "invalid_platform" }, 400, origin);
  const now = Date.now();
  await env.DB.prepare(`DELETE FROM phone_activity_devices WHERE id IN
    (SELECT id FROM phone_activity_devices WHERE approved_at IS NULL AND expires_at <= ? LIMIT 40)`).bind(now).run();
  const token = "gvdga_" + base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = now + PAIR_TTL;
  const tokenHash = await hash(token);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => CODE[byte & 31]).join("");
    const row = await env.DB.prepare(`INSERT INTO phone_activity_devices (id, token_hash, code_hash, platform, expires_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(code_hash) DO NOTHING RETURNING id`)
      .bind(crypto.randomUUID(), tokenHash, await codeHash(code, env.JWT_SECRET), platform, expiresAt).first();
    if (row) return json({ code, token, expiresAt }, 201, origin, privacy);
  }
  return json({ error: "device_pairing_unavailable" }, 503, origin);
}

async function approvePair(request: Request, env: Env, origin: string | null, owner: string, pin: number) {
  if (await kvRateLimited(env, "activity-approve:" + owner, 10, 300) ||
      await kvRateLimited(env, "activity-approve-ip:" + clientIp(request), 30, 300)) return json({ error: "rate_limited" }, 429, origin);
  const body = await readJson(request, 1024);
  const code = normalize(body?.code);
  if (!code) return json({ error: "invalid_activity_code" }, 400, origin);
  const key = body?.roundKey ?? null;
  if (key != null && !validActivityRoundKey(key)) return json({ error: "invalid_activity_round" }, 400, origin);
  const codeDigest = await codeHash(code, env.JWT_SECRET);
  const candidate = await env.DB.prepare(`SELECT id FROM phone_activity_devices
    WHERE code_hash = ? AND approved_at IS NULL AND expires_at > ?`).bind(codeDigest, Date.now()).first<{ id: string }>();
  if (!candidate) return json({ error: "invalid_activity_code" }, 400, origin);
  let scope: WatchScope | null = null;
  if (key) {
    const result = await card(env, owner, key);
    if (!result.ok) return json({ error: "activity_round_unavailable" }, 409, origin);
    scope = result.data.scope;
  }
  const now = Date.now();
  const expiresAt = now + DEVICE_TTL;
  const device = await env.DB.prepare(`UPDATE phone_activity_devices
    SET member_id = ?, pin_version = ?, approved_at = ?, expires_at = ?, code_hash = NULL,
      round_key = ?, round_id = ?, card_id = ?, actor_index = ?
    WHERE id = ? AND code_hash = ? AND approved_at IS NULL AND expires_at > ?
      AND (SELECT COUNT(*) FROM phone_activity_devices
        WHERE member_id = ? AND pin_version = ? AND revoked_at IS NULL AND expires_at > ?) < ?
    RETURNING id`).bind(owner, pin, now, expiresAt, key, scope?.roundId ?? null, scope?.cardId ?? null,
      scope?.actorIndex ?? null, candidate.id, codeDigest, now, owner, pin, now, MAX_DEVICES).first<{ id: string }>();
  return device ? json({ deviceId: device.id, expiresAt }, 200, origin, privacy)
    : json({ error: "activity_pairing_not_approved" }, 409, origin);
}

async function paired(request: Request, env: Env): Promise<Device | null> {
  const token = bearer(request);
  if (!token || !TOKEN.test(token)) return null;
  const device = await env.DB.prepare(`SELECT id, member_id, pin_version, platform, round_key, round_id, card_id, actor_index,
    approved_at, expires_at FROM phone_activity_devices WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL`)
    .bind(await hash(token), Date.now()).first<Device>();
  if (!device?.member_id) return device;
  const member = await getMember(env.ROSTER, device.member_id);
  return member && !member.mustChangePin && (member.pinVer ?? 0) === device.pin_version ? device : null;
}

async function deviceState(env: Env, origin: string | null, device: Device) {
  let round = null;
  let roundUnavailable = false;
  if (device.round_key && device.round_id && device.actor_index != null) {
    const scope = { roundId: device.round_id, cardId: device.card_id, actorIndex: device.actor_index };
    const result = await card(env, device.member_id!, device.round_key, scope);
    if (result.ok) {
      const data = result.data;
      round = { key: device.round_key, generation: device.round_id, status: data.status,
        courseName: data.courseName ?? null, layoutName: data.layoutName ?? null, startingHole: data.startingHole ?? null,
        holes: data.holes.map(({ hole, basket }) => ({ hole, basket })) };
    } else roundUnavailable = true;
  }
  return json({ deviceId: device.id, memberId: device.member_id, expiresAt: device.expires_at, round, roundUnavailable }, 200, origin, privacy);
}

function receipt(row: Saved) {
  return { id: row.id, clientId: row.client_id, startedAt: row.started_at, stoppedAt: row.stopped_at, distanceM: row.distance_m,
    pointCount: row.point_count, archivedAt: row.archived_at };
}

async function importTrack(request: Request, env: Env, origin: string | null, device: Device & { member_id: string }) {
  const owner = device.member_id;
  if (await kvRateLimited(env, "activity-upload:" + owner, 20, 60)) return json({ error: "rate_limited" }, 429, origin);
  const track = parseActivityTrack(await readJson(request, 580_000));
  if (!track) return json({ error: "invalid_activity_track" }, 400, origin);
  if (track.ownerId !== owner) return json({ error: "activity_owner_mismatch" }, 403, origin);
  if (track.round) {
    const authorized = await env.DB.prepare(`SELECT id FROM phone_activity_devices
      WHERE member_id = ? AND round_key = ? AND round_id = ? AND approved_at IS NOT NULL LIMIT 1`)
      .bind(owner, track.round.key, track.round.generation).first();
    if (!authorized) return json({ error: "activity_round_mismatch" }, 403, origin);
  }
  const { distanceM, pointCount } = activityTotals(track);
  const snapshot = JSON.stringify(track);
  const payloadHash = await hash(snapshot);
  const row = await env.DB.prepare(`INSERT INTO phone_activity_tracks
    (client_id, member_id, payload_hash, started_at, stopped_at, distance_m, point_count, snapshot)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM phone_activity_devices WHERE id = ? AND member_id = ? AND expires_at > ? AND revoked_at IS NULL
    ) ON CONFLICT(client_id) DO NOTHING RETURNING *`)
    .bind(track.clientId, owner, payloadHash, track.startedAt, track.stoppedAt, distanceM, pointCount, snapshot,
      device.id, owner, Date.now()).first<Saved>();
  if (row) return json(receipt(row), 201, origin, privacy);
  if (!await paired(request, env)) return json({ error: "activity_access_ended" }, 401, origin);
  const prior = await env.DB.prepare("SELECT * FROM phone_activity_tracks WHERE client_id = ?")
    .bind(track.clientId).first<Saved>();
  if (prior?.member_id === owner && prior.deleted_at) return json({ error: "activity_track_deleted" }, 410, origin);
  return prior?.member_id === owner && prior.payload_hash === payloadHash ? json(receipt(prior), 200, origin, privacy)
    : json({ error: "activity_track_conflict" }, 409, origin);
}

async function listTracks(env: Env, request: Request, origin: string | null, owner: string) {
  const params = new URL(request.url).searchParams;
  const before = params.has("before") ? positiveId(params.get("before")) : Number.MAX_SAFE_INTEGER;
  if (!before) return json({ error: "invalid_cursor" }, 400, origin);
  const rows = await env.DB.prepare(`SELECT id, client_id, started_at, stopped_at, distance_m, point_count, archived_at
    FROM phone_activity_tracks WHERE member_id = ? AND deleted_at IS NULL AND id < ? ORDER BY id DESC LIMIT ?`)
    .bind(owner, before, PAGE_SIZE + 1).all<Saved>();
  const page = rows.results.slice(0, PAGE_SIZE);
  return json({ tracks: page.map(receipt), before: rows.results.length > PAGE_SIZE ? page.at(-1)?.id : null }, 200, origin, privacy);
}

async function trackDetail(request: Request, env: Env, origin: string | null, id: number, owner: string) {
  if (request.method === "DELETE") {
    const removed = await env.DB.prepare(`UPDATE phone_activity_tracks SET snapshot = '{}', payload_hash = '', started_at = 0,
      stopped_at = 0, distance_m = 0, point_count = 0, deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE id = ? AND member_id = ? RETURNING id`)
      .bind(id, owner).first();
    return removed ? json({ id }, 200, origin, privacy) : json({ error: "not_found" }, 404, origin);
  }
  const row = await env.DB.prepare("SELECT * FROM phone_activity_tracks WHERE id = ? AND member_id = ? AND deleted_at IS NULL").bind(id, owner).first<Saved>();
  if (!row) return json({ error: "not_found" }, 404, origin);
  const track = JSON.parse(row.snapshot) as ActivityTrack;
  const format = new URL(request.url).searchParams.get("format");
  if (format && format !== "json" && format !== "gpx") return json({ error: "invalid_format" }, 400, origin);
  if (format === "gpx") return new Response(activityGpx(track), { headers: {
    ...corsHeaders(origin), ...privacy, "Content-Type": "application/gpx+xml; charset=utf-8",
    "X-Content-Type-Options": "nosniff", "Content-Disposition": 'attachment; filename="gvdg-activity.gpx"',
  } });
  return json({ ...receipt(row), track }, 200, origin, format === "json"
    ? { ...privacy, "Content-Disposition": 'attachment; filename="gvdg-activity.json"' } : privacy);
}

export async function handlePhoneActivityRoute(request: Request, env: Env, origin: string | null, path: string, method: string) {
  if (!path.startsWith("/activity/")) return null;
  if (path === "/activity/pairings" && method === "POST") return startPair(request, env, origin);
  if ((path === "/activity/device" && method === "GET") || (path === "/activity/tracks" && method === "POST")) {
    const device = await paired(request, env);
    if (!device) return json({ error: "activity_access_ended" }, 401, origin);
    if (!device.member_id) return json({ error: "activity_pairing_pending", expiresAt: device.expires_at }, 409, origin);
    return method === "GET" ? deviceState(env, origin, device) : importTrack(request, env, origin, { ...device, member_id: device.member_id });
  }
  const auth = await requireAuth(request, env);
  if (!auth?.member || auth.member.mustChangePin) return json({ error: "unauthorized" }, 401, origin);
  const owner = auth.sub;
  if (path === "/activity/pairings/approve" && method === "POST") return approvePair(request, env, origin, owner, auth.member.pinVer ?? 0);
  if (path === "/activity/pairings" && method === "GET") {
    const devices = await env.DB.prepare(`SELECT id, platform, approved_at, expires_at, round_key FROM phone_activity_devices
      WHERE member_id = ? AND pin_version = ? AND expires_at > ? AND revoked_at IS NULL ORDER BY approved_at DESC`)
      .bind(owner, auth.member.pinVer ?? 0, Date.now()).all<Device>();
    return json({ devices: devices.results.map((row) => ({ deviceId: row.id, platform: row.platform, approvedAt: row.approved_at,
      expiresAt: row.expires_at, roundKey: row.round_key })) }, 200, origin, privacy);
  }
  const deviceId = path.startsWith("/activity/pairings/") ? path.slice("/activity/pairings/".length) : "";
  if (method === "DELETE" && ACTIVITY_UUID.test(deviceId)) {
    const row = await env.DB.prepare(`UPDATE phone_activity_devices SET revoked_at = ?
      WHERE id = ? AND member_id = ? RETURNING id`).bind(Date.now(), deviceId, owner).first();
    return row ? json({ deviceId }, 200, origin, privacy) : json({ error: "not_found" }, 404, origin);
  }
  if (path === "/activity/tracks" && method === "GET") return listTracks(env, request, origin, owner);
  const id = path.startsWith("/activity/tracks/") ? positiveId(path.slice("/activity/tracks/".length)) : null;
  if (id && (method === "GET" || method === "DELETE")) return trackDetail(request, env, origin, id, owner);
  return json({ error: "not_found" }, 404, origin);
}
