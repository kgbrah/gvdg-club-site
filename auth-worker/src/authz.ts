import type { Env } from "./env.js";
import { verifySession, type SessionClaims } from "./jwt.js";
import { getMember, type Member } from "./roster.js";
import { bearer, json } from "./http.js";

export const OPEN_PLAY_PREFIX = "op_";

export function secretOk(env: Env): boolean {
  return typeof env.JWT_SECRET === "string" && env.JWT_SECRET.length >= 32;
}

export function ttl(env: Env): number {
  const n = Number(env.SESSION_TTL_SEC);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

export function isOpenPlayId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(OPEN_PLAY_PREFIX);
}

/** Verify the session token AND that it hasn't been revoked by a PIN change/reset. Returns the
 *  claims plus the resolved member (or null member if the sub no longer exists — the roster read is
 *  reused by adminGate so it costs one KV get, not two). Returns null on bad/expired token,
 *  forced-change lockout, or a pinVer mismatch (the member's PIN was changed after this token was
 *  issued, invalidating every older token). A missing member is NOT itself a rejection, preserving
 *  the prior "a valid token is sufficient" contract for routes that don't require a roster record.
 *  Open-play tokens (`play: true`) are always rejected here — they may only score casual rounds. */
export async function requireAuth(
  request: Request,
  env: Env,
): Promise<(SessionClaims & { member: Member | null }) | null> {
  const token = bearer(request);
  const claims = token ? await verifySession(token, env.JWT_SECRET) : null;
  if (!claims || claims.mustChangePin || claims.play) return null;
  const member = await getMember(env.ROSTER, claims.sub);
  if (member && (member.pinVer ?? 0) !== (claims.pinVer ?? 0)) return null;
  return { ...claims, member };
}

export async function requireMember(request: Request, env: Env, origin: string | null): Promise<{ sub: string } | Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  return { sub: claims.sub };
}

export async function adminGate(request: Request, env: Env, origin: string | null): Promise<{ adminId: string } | Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const member = claims.member;
  if (!member || member.isAdmin !== true) return json({ error: "forbidden" }, 403, origin);
  return { adminId: member.memberId };
}

export type RoundActor = {
  readonly sub: string;
  readonly name: string;
  readonly kind: "member" | "open";
};

/** Member JWT or open-play JWT. Used only by casual-round write paths so a park player can
 *  keep score without a club PIN, without gaining /me, shop, board, or event-pay access. */
export async function requireRoundActor(request: Request, env: Env): Promise<RoundActor | null> {
  const token = bearer(request);
  const claims = token ? await verifySession(token, env.JWT_SECRET) : null;
  if (!claims) return null;
  if (claims.play) {
    if (!isOpenPlayId(claims.sub)) return null;
    return { sub: claims.sub, name: claims.name || "Player", kind: "open" };
  }
  if (claims.mustChangePin) return null;
  const member = await getMember(env.ROSTER, claims.sub);
  if (member && (member.pinVer ?? 0) !== (claims.pinVer ?? 0)) return null;
  return { sub: claims.sub, name: (member?.name || "Player").slice(0, 60), kind: "member" };
}
