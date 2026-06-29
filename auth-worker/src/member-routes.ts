import type { Env } from "./env.js";
import { hashPin, verifyPin } from "./crypto.js";
import { signSession, verifySession } from "./jwt.js";
import { checkLockout, clearAttempts, recordFailure } from "./ratelimit.js";
import { canonicalLoginKey, getMember, resolveMember, setPin, updateProfile, type ProfilePatch } from "./roster.js";
import * as db from "./db.js";
import { bearer, clientIp, json, readJson } from "./http.js";
import { requireAuth, ttl } from "./authz.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { asInt } from "./input.js";

const DUMMY_HASH =
  "pbkdf2$sha256$120000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const LOGIN_BODY_BYTES = 2_048;
const PROFILE_BODY_BYTES = 350_000;
const LOGIN_IP_LIMIT = 20;
const LOGIN_IDENTIFIER_IP_LIMIT = 10;
const BOARD_LIMIT = 15;
const SETPIN_LIMIT = 5;
const MAX_PHOTO_LEN = 200_000;

function validPhoto(p: string): boolean {
  return p.length <= MAX_PHOTO_LEN && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p);
}

export async function handleLogin(request: Request, env: Env, origin: string | null): Promise<Response> {
  const body = await readJson(request, LOGIN_BODY_BYTES);
  const identifier = typeof body?.identifier === "string" ? body.identifier : "";
  const pin = typeof body?.pin === "string" ? body.pin : "";
  if (!identifier || !pin) return json({ error: "invalid_request" }, 400, origin);

  const rk = canonicalLoginKey(identifier);
  const ip = clientIp(request);
  const now = Date.now();

  if (await kvRateLimited(env, "login:ip:" + ip, LOGIN_IP_LIMIT, 60)) return json({ error: "rate_limited" }, 429, origin);
  if (await kvRateLimited(env, "login:ip_id:" + ip + ":" + rk, LOGIN_IDENTIFIER_IP_LIMIT, 60)) return json({ error: "rate_limited" }, 429, origin);

  const lock = await checkLockout(env.RATELIMIT, rk, now);
  if (lock.locked) {
    return json({ error: "locked_out", retryAfterSec: lock.retryAfterSec }, 423, origin, {
      "Retry-After": String(lock.retryAfterSec),
    });
  }

  const member = await resolveMember(env.ROSTER, identifier);
  const ok = await verifyPin(pin, member?.pinHash ?? DUMMY_HASH);

  if (!member || !ok) {
    await recordFailure(env.RATELIMIT, rk, now);
    return json({ error: "invalid_credentials" }, 401, origin);
  }

  await clearAttempts(env.RATELIMIT, rk);
  const token = await signSession({ sub: member.memberId, mustChangePin: member.mustChangePin }, env.JWT_SECRET, ttl(env));
  return json(
    {
      token,
      mustChangePin: member.mustChangePin,
      name: member.name,
      pdgaNo: member.pdgaNo ?? null,
      udisc: member.udisc ?? null,
      photo: member.photo ?? null,
      isAdmin: member.isAdmin === true,
    },
    200,
    origin,
  );
}

export async function handleMe(request: Request, env: Env, origin: string | null): Promise<Response> {
  const token = bearer(request);
  const claims = token ? await verifySession(token, env.JWT_SECRET) : null;
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const member = await getMember(env.ROSTER, claims.sub);
  if (!member) return json({ error: "unauthorized" }, 401, origin);
  return json(
    {
      sub: member.memberId,
      mustChangePin: member.mustChangePin,
      name: member.name,
      pdgaNo: member.pdgaNo ?? null,
      udisc: member.udisc ?? null,
      photo: member.photo ?? null,
      isAdmin: member.isAdmin === true,
    },
    200,
    origin,
  );
}

export async function handleMyResults(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  return json({ results: await db.listMemberResults(env.DB, claims.sub) }, 200, origin);
}

export async function handleMyRegistrations(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  return json({ registrations: await db.listMyRegistrations(env.DB, claims.sub) }, 200, origin);
}

export async function handleBoard(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const seg = new URL(request.url).pathname.split("/").filter(Boolean);
  const method = request.method.toUpperCase();

  if (method === "GET" && seg.length === 1) {
    return json({ posts: await db.getBoardFeed(env.DB, 50) }, 200, origin);
  }
  if (method === "POST" && seg.length === 1) {
    if (await kvRateLimited(env, "board:" + claims.sub, BOARD_LIMIT, 60)) return json({ error: "rate_limited" }, 429, origin);
    const b = await readJson(request);
    const body = b && typeof b.body === "string" ? b.body.trim() : "";
    if (!body) return json({ error: "empty_post" }, 400, origin);
    if (body.length > 4000) return json({ error: "post_too_long" }, 413, origin);
    const parentId = b!.parent_id == null ? null : asInt(b!.parent_id);
    if (parentId != null) {
      const parent = (await db.getBoardPost(env.DB, parentId)) as { parent_id?: number | null } | null;
      if (!parent || parent.parent_id != null) return json({ error: "bad_parent" }, 400, origin);
    }
    const member = await getMember(env.ROSTER, claims.sub);
    const row = await db.createBoardPost(env.DB, { parent_id: parentId, member_id: claims.sub, author_name: member?.name ?? "Member", body });
    return json({ post: row }, 201, origin);
  }
  if (method === "DELETE" && seg.length === 2) {
    const id = asInt(seg[1]);
    if (id == null) return json({ error: "not_found" }, 404, origin);
    const post = (await db.getBoardPost(env.DB, id)) as { member_id?: string } | null;
    if (!post) return json({ error: "not_found" }, 404, origin);
    const member = await getMember(env.ROSTER, claims.sub);
    if (post.member_id !== claims.sub && member?.isAdmin !== true) return json({ error: "forbidden" }, 403, origin);
    await db.deleteBoardPost(env.DB, id);
    return json({ ok: true }, 200, origin);
  }
  return json({ error: "not_found" }, 404, origin);
}

export async function handleProfile(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const body = await readJson(request, PROFILE_BODY_BYTES);
  if (!body) return json({ error: "invalid_request" }, 400, origin);

  const patch: ProfilePatch = {};
  if ("pdgaNo" in body) {
    const v = body.pdgaNo;
    if (v !== null && v !== "" && !(typeof v === "string" && /^\d+$/.test(v.trim()))) {
      return json({ error: "invalid_pdga" }, 400, origin);
    }
    patch.pdgaNo = v === null ? null : String(v).trim();
  }
  if ("udisc" in body) {
    const v = body.udisc;
    if (v !== null && v !== "" && !(typeof v === "string" && /^[A-Za-z0-9._-]{1,50}$/.test(v.trim()))) {
      return json({ error: "invalid_udisc" }, 400, origin);
    }
    patch.udisc = v === null ? null : String(v).trim();
  }
  if ("photo" in body) {
    const v = body.photo;
    if (v !== null && v !== "" && !(typeof v === "string" && validPhoto(v))) {
      return json({ error: "invalid_photo" }, 400, origin);
    }
    patch.photo = v === null || v === "" ? null : (v as string);
  }

  const result = await updateProfile(env.ROSTER, claims.sub, patch);
  if (!result.ok) return json({ error: "conflict", field: result.conflict }, 409, origin);
  const m = result.member;
  return json(
    { pdgaNo: m.pdgaNo ?? null, udisc: m.udisc ?? null, photo: m.photo ?? null, name: m.name, mustChangePin: m.mustChangePin },
    200,
    origin,
  );
}

export async function handleSetPin(request: Request, env: Env, origin: string | null): Promise<Response> {
  const token = bearer(request);
  const claims = token ? await verifySession(token, env.JWT_SECRET) : null;
  if (!claims) return json({ error: "unauthorized" }, 401, origin);

  // Rate-limit the change-PIN path per member so a stolen token can't be used to grind PINs.
  if (await kvRateLimited(env, "setpin:" + claims.sub, SETPIN_LIMIT, 60)) {
    return json({ error: "rate_limited" }, 429, origin);
  }

  const body = await readJson(request);
  const newPin = typeof body?.newPin === "string" ? body.newPin : "";
  if (!/^\d{4}$/.test(newPin)) return json({ error: "invalid_pin_format" }, 400, origin);

  // An established member (not on a forced first-login change) must prove the CURRENT PIN before
  // setting a new one, so a transiently-stolen 15-minute session token can't be turned into a
  // permanent account takeover. The forced-change flow has no current PIN to verify, so it is exempt.
  if (!claims.mustChangePin) {
    const member = await getMember(env.ROSTER, claims.sub);
    if (!member) return json({ error: "unauthorized" }, 401, origin);
    const currentPin = typeof body?.currentPin === "string" ? body.currentPin : "";
    if (!(await verifyPin(currentPin, member.pinHash))) {
      return json({ error: "invalid_credentials" }, 401, origin);
    }
  }

  await setPin(env.ROSTER, claims.sub, await hashPin(newPin));
  const fresh = await signSession({ sub: claims.sub, mustChangePin: false }, env.JWT_SECRET, ttl(env));
  return json({ token: fresh, mustChangePin: false }, 200, origin);
}
