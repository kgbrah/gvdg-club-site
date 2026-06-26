import type { Env } from "./env.js";
import { verifySession } from "./jwt.js";
import { getMember } from "./roster.js";
import { bearer, json } from "./http.js";

export function secretOk(env: Env): boolean {
  return typeof env.JWT_SECRET === "string" && env.JWT_SECRET.length >= 32;
}

export function ttl(env: Env): number {
  const n = Number(env.SESSION_TTL_SEC);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

export function rateKey(identifier: string): string {
  return identifier.trim().toLowerCase();
}

export async function requireAuth(request: Request, env: Env) {
  const token = bearer(request);
  const claims = token ? await verifySession(token, env.JWT_SECRET) : null;
  if (!claims || claims.mustChangePin) return null;
  return claims;
}

export async function requireMember(request: Request, env: Env, origin: string | null): Promise<{ sub: string } | Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  return { sub: claims.sub };
}

export async function adminGate(request: Request, env: Env, origin: string | null): Promise<{ adminId: string } | Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const member = await getMember(env.ROSTER, claims.sub);
  if (!member || member.isAdmin !== true) return json({ error: "forbidden" }, 403, origin);
  return { adminId: member.memberId };
}
