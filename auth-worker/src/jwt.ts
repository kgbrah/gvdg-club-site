// Short-lived session tokens for the GVDG member auth Worker.
// HS256 via `jose` (battle-tested, WebCrypto-based) — never hand-rolled.

import { SignJWT, jwtVerify } from "jose";

export interface SessionClaims {
  /** Subject, e.g. "pdga:12345" or "udisc:janedoe" — the member's stable id. */
  sub: string;
  /** True while the member is still on their admin-issued default PIN. */
  mustChangePin: boolean;
}

function keyOf(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Sign a session token that expires `ttlSeconds` from now. */
export async function signSession(claims: SessionClaims, secret: string, ttlSeconds: number): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ mustChangePin: claims.mustChangePin })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSeconds)
    .sign(keyOf(secret));
}

/** Verify a session token. Returns the claims, or null on any failure (bad sig, expired, malformed). */
export async function verifySession(token: string, secret: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    return { sub: payload.sub, mustChangePin: payload.mustChangePin === true };
  } catch {
    return null;
  }
}
