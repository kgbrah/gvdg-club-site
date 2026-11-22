import { isOpenPlayId, requireAuth, requireRoundActor } from "./authz.js";
import type { Env } from "./env.js";
import { bearer, clientIp, json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { getMember } from "./roster.js";
import { parseWatchScore, type WatchScope } from "./watch-do.js";

const PAIRING_MS = 5 * 60 * 1000;
const ACCESS_MS = 72 * 60 * 60 * 1000;
const MAX_PAIRED = 4;
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEVICE_TOKEN = /^gvdgw_[A-Za-z0-9_-]{43}$/;
const DEVICE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const textEncoder = new TextEncoder();

type Pairing = {
  id: string;
  expires_at: number;
  approved_at: number | null;
  actor_id: string | null;
  pin_version: number | null;
  round_key: string | null;
  round_id: string | null;
  card_id: string | null;
  actor_index: number | null;
};

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(token));
  return base64url(new Uint8Array(digest));
}

async function pairingHash(code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, textEncoder.encode("gvdg-watch-code:" + code));
  return base64url(new Uint8Array(digest));
}

function newCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => PAIRING_ALPHABET[byte & 31]).join("");
}

function normalizedCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? code : null;
}

function roundKey(code: unknown, event: unknown): string | null {
  const normalizedCode = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (normalizedCode && /^[A-Z0-9]{4,12}$/.test(normalizedCode) && !event) return "round:" + normalizedCode;
  if (code || (typeof event !== "number" && (typeof event !== "string" || !/^\d{1,15}$/.test(event)))) return null;
  const id = Number(event);
  return Number.isSafeInteger(id) && id > 0 ? "event:" + id : null;
}

async function phoneActor(request: Request, env: Env, key: string | null): Promise<{ id: string; pinVersion: number | null } | null> {
  const session = await requireAuth(request, env);
  if (session?.member && !session.member.mustChangePin) {
    return { id: session.sub, pinVersion: session.member.pinVer ?? 0 };
  }
  if (key?.startsWith("event:")) return null;
  const actor = await requireRoundActor(request, env);
  return actor?.kind === "open" ? { id: actor.sub, pinVersion: null } : null;
}

function proxy(env: Env, round: string, path: "watch-card" | "watch-score", member: string, body: unknown): Promise<Response> {
  return env.LIVE.get(env.LIVE.idFromName(round)).fetch("https://do/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Member": member },
    body: JSON.stringify(body),
  });
}

async function createPairing(request: Request, env: Env, origin: string | null): Promise<Response> {
  if (await kvRateLimited(env, "watch-start:" + clientIp(request), 16, 300)) {
    return json({ error: "rate_limited" }, 429, origin);
  }
  const now = Date.now();
  await env.DB.prepare(`DELETE FROM watch_pairings WHERE id IN (
    SELECT id FROM watch_pairings WHERE expires_at <= ? ORDER BY expires_at LIMIT 40
  )`).bind(now).run();
  const expiresAt = now + PAIRING_MS;
  const token = "gvdgw_" + base64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await tokenHash(token);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newCode();
    const stored = await env.DB.prepare(`INSERT INTO watch_pairings (id, token_hash, code_hash, expires_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(code_hash) DO NOTHING RETURNING id`)
      .bind(crypto.randomUUID(), hash, await pairingHash(code, env.JWT_SECRET), expiresAt).first<{ id: string }>();
    if (stored) return json({ code, token, expiresAt }, 201, origin);
  }
  return json({ error: "watch_pairing_unavailable" }, 503, origin);
}

async function approvePairing(request: Request, env: Env, origin: string | null): Promise<Response> {
  const body = await readJson(request, 1024);
  const key = roundKey(body?.roundCode, body?.eventId);
  if (!key) return json({ error: "invalid_round" }, 400, origin);
  const actor = await phoneActor(request, env, key);
  if (!actor) return json({ error: "unauthorized" }, 401, origin);
  if (await kvRateLimited(env, "watch-approve:" + actor.id, 10, 300) ||
      await kvRateLimited(env, "watch-approve-ip:" + clientIp(request), 30, 300)) {
    return json({ error: "rate_limited" }, 429, origin);
  }
  const code = normalizedCode(body?.code);
  if (!code) return json({ error: "invalid_watch_code" }, 400, origin);
  const hash = await pairingHash(code, env.JWT_SECRET);
  const pending = await env.DB.prepare("SELECT id FROM watch_pairings WHERE code_hash = ? AND expires_at > ? AND approved_at IS NULL")
    .bind(hash, Date.now()).first<{ id: string }>();
  if (!pending) return json({ error: "invalid_watch_code" }, 400, origin);

  const response = await proxy(env, key, "watch-card", actor.id, {});
  if (!response.ok) return json(await response.json(), response.status, origin);
  const { scope } = await response.json<{ scope: WatchScope }>();
  const now = Date.now();
  const expiresAt = now + ACCESS_MS;
  const row = await env.DB.prepare(`UPDATE watch_pairings
    SET actor_id = ?, pin_version = ?, round_key = ?, round_id = ?, card_id = ?, actor_index = ?,
        approved_at = ?, expires_at = ?, code_hash = NULL
    WHERE id = ? AND code_hash = ? AND expires_at > ? AND approved_at IS NULL
      AND (SELECT COUNT(*) FROM watch_pairings
           WHERE actor_id = ? AND round_key = ? AND round_id = ? AND expires_at > ? AND revoked_at IS NULL) < ?
    RETURNING id`)
    .bind(actor.id, actor.pinVersion, key, scope.roundId, scope.cardId, scope.actorIndex, now, expiresAt,
      pending.id, hash, now, actor.id, key, scope.roundId, now, MAX_PAIRED)
    .first<{ id: string }>();
  if (!row) return json({ error: "watch_pairing_not_approved" }, 409, origin);
  return json({ deviceId: row.id, expiresAt }, 200, origin);
}

async function watchAccess(request: Request, env: Env, origin: string | null, method: string): Promise<Response> {
  const token = bearer(request);
  if (!token || !DEVICE_TOKEN.test(token)) return json({ error: "unauthorized" }, 401, origin);
  const now = Date.now();
  const row = await env.DB.prepare(`SELECT id, expires_at, approved_at, actor_id, pin_version, round_key, round_id, card_id, actor_index
    FROM watch_pairings WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL`)
    .bind(await tokenHash(token), now).first<Pairing>();
  if (!row) return json({ error: "watch_access_ended" }, 401, origin);
  if (!row.actor_id || !row.round_key || !row.round_id || row.actor_index == null) {
    return json({ error: "watch_pairing_pending", expiresAt: row.expires_at }, 409, origin);
  }
  const actor = row.actor_id;
  if (!isOpenPlayId(actor)) {
    const member = await getMember(env.ROSTER, actor);
    if (!member || member.mustChangePin || (member.pinVer ?? 0) !== row.pin_version) {
      return json({ error: "watch_access_ended" }, 401, origin);
    }
  }
  const scope: WatchScope = { roundId: row.round_id, cardId: row.card_id, actorIndex: row.actor_index };
  if (method === "GET") {
    const response = await proxy(env, row.round_key, "watch-card", actor, { scope, deviceId: row.id });
    const data = await response.json<Record<string, unknown>>();
    if (!response.ok) return json(data, response.status, origin);
    return json({ ...data, expiresAt: row.expires_at }, 200, origin);
  }
  if (await kvRateLimited(env, "watch-score:" + row.id, 90, 60)) return json({ error: "rate_limited" }, 429, origin);
  const op = parseWatchScore(await readJson(request, 2048));
  if (!op) return json({ error: "invalid_watch_score" }, 400, origin);
  const response = await proxy(env, row.round_key, "watch-score", actor, { scope, deviceId: row.id, op });
  return json(await response.json(), response.status, origin);
}

async function watchDevices(request: Request, env: Env, origin: string | null): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const key = roundKey(params.get("roundCode"), params.get("eventId"));
  if (!key) return json({ error: "invalid_round" }, 400, origin);
  const actor = await phoneActor(request, env, key);
  if (!actor) return json({ error: "unauthorized" }, 401, origin);
  const cardRes = await proxy(env, key, "watch-card", actor.id, {}).catch(() => null);
  if (!cardRes || !cardRes.ok) return json({ devices: [] }, 200, origin);
  const cardData = await cardRes.json<{ scope?: WatchScope }>().catch(() => null);
  const roundId = cardData?.scope?.roundId;
  if (!roundId) return json({ devices: [] }, 200, origin);
  const rows = await env.DB.prepare(`SELECT id, approved_at, expires_at FROM watch_pairings
    WHERE actor_id = ? AND round_key = ? AND round_id = ? AND expires_at > ? AND revoked_at IS NULL ORDER BY approved_at DESC`)
    .bind(actor.id, key, roundId, Date.now()).all<Pairing>();
  return json({ devices: rows.results.map((row) => ({ deviceId: row.id, approvedAt: row.approved_at, expiresAt: row.expires_at })) }, 200, origin);
}

async function revokeDevice(request: Request, env: Env, origin: string | null, id: string): Promise<Response> {
  const actor = await phoneActor(request, env, null);
  if (!actor) return json({ error: "unauthorized" }, 401, origin);
  const row = await env.DB.prepare(`UPDATE watch_pairings SET revoked_at = ?
    WHERE id = ? AND actor_id = ? AND approved_at IS NOT NULL RETURNING id`)
    .bind(Date.now(), id, actor.id).first<{ id: string }>();
  return row ? json({ deviceId: row.id }, 200, origin) : json({ error: "not_found" }, 404, origin);
}

export async function handleWatchRoute(
  request: Request, env: Env, origin: string | null, path: string, method: string,
): Promise<Response | null> {
  if (!path.startsWith("/watch/")) return null;
  if (path === "/watch/pairings") {
    if (method === "POST") return createPairing(request, env, origin);
    if (method === "GET") return watchDevices(request, env, origin);
  }
  if (path === "/watch/pairings/approve" && method === "POST") return approvePairing(request, env, origin);
  if (path === "/watch/card" && method === "GET") return watchAccess(request, env, origin, method);
  if (path === "/watch/score" && method === "POST") return watchAccess(request, env, origin, method);
  const deviceId = path.slice("/watch/pairings/".length);
  if (path.startsWith("/watch/pairings/") && method === "DELETE" && DEVICE_ID.test(deviceId)) {
    return revokeDevice(request, env, origin, deviceId);
  }
  return json({ error: "not_found" }, 404, origin);
}
