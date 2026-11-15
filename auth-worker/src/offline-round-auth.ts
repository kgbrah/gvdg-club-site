import { jwtVerify, SignJWT } from "jose";
import { isOpenPlayId, requireAuth, requireRoundActor } from "./authz.js";
import type { Env } from "./env.js";
import { bearer } from "./http.js";
import type { OfflineOwner } from "../../src/shared/offline-round.js";

const encoder = new TextEncoder();
const ARCHIVE_AUDIENCE = "gvdg:offline-round-archive:v1";
const ARCHIVE_ISSUER = "gvdg:offline-archive";
export const OFFLINE_OPEN_TTL_SEC = 30 * 24 * 60 * 60;

async function archiveKey(secret: string) {
  const source = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", source, encoder.encode(ARCHIVE_AUDIENCE)));
}

export async function signOfflineOpenSession(sub: string, secret: string, ttl = OFFLINE_OPEN_TTL_SEC) {
  if (!isOpenPlayId(sub)) throw new Error("Invalid offline open-play subject");
  return new SignJWT({ offlinePlay: true })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer(ARCHIVE_ISSUER).setAudience(ARCHIVE_AUDIENCE)
    .setSubject(sub).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + ttl).sign(await archiveKey(secret));
}

export async function offlineRoundActor(request: Request, env: Env): Promise<OfflineOwner | null> {
  const token = bearer(request);
  if (!token) return null;
  const member = await requireAuth(request, env);
  if (member?.member && !member.member.mustChangePin) return { kind: "member", id: member.sub };
  const live = await requireRoundActor(request, env);
  if (live?.kind === "open") return { kind: "open", id: live.sub };
  try {
    const { payload } = await jwtVerify(token, await archiveKey(env.JWT_SECRET), {
      issuer: ARCHIVE_ISSUER, audience: ARCHIVE_AUDIENCE, algorithms: ["HS256"], requiredClaims: ["sub", "iat", "exp"],
      maxTokenAge: OFFLINE_OPEN_TTL_SEC,
    });
    return payload.offlinePlay === true && typeof payload.sub === "string" && isOpenPlayId(payload.sub)
      ? { kind: "open", id: payload.sub } : null;
  } catch {
    return null;
  }
}
