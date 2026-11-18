// Short-lived session tokens for the GVDG member auth Worker.
// HS256 via `jose` (battle-tested, WebCrypto-based) — never hand-rolled.

import { SignJWT, jwtVerify } from "jose";

export interface SessionClaims {
  /** Subject, e.g. "pdga:12345" or "udisc:janedoe" — the member's stable id. */
  sub: string;
  /** True while the member is still on their admin-issued default PIN. */
  mustChangePin: boolean;
  /** PIN-version stamp. A PIN change/reset bumps the member record's pinVer, so a token minted
   *  before that no longer matches and is rejected server-side — i.e. stateless session revocation.
   *  Absent/legacy tokens (and members without the field) are treated as version 0. */
  pinVer?: number;
  /** Open-play (casual scoring without a club account). Member routes MUST reject these. */
  play?: boolean;
  /** Display name baked into an open-play token so join/create cannot spoof a different name. */
  name?: string;
}

function keyOf(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Sign a session token that expires `ttlSeconds` from now. */
export async function signSession(claims: SessionClaims, secret: string, ttlSeconds: number): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ mustChangePin: claims.mustChangePin, pinVer: claims.pinVer ?? 0 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSeconds)
    .sign(keyOf(secret));
}

/** Sign an open-play scoring token. Same HS256 key as member sessions, but `play: true` so
 *  requireAuth rejects it on every member/admin/shop/event-pay route. */
export async function signOpenPlaySession(
  claims: { readonly sub: string; readonly name: string },
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ play: true, name: claims.name })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSeconds)
    .sign(keyOf(secret));
}

/** Sign a guest marketplace token (a verified email, no club account). `mkt: true` makes verifySession
 *  reject it, so it can never act as a member session on any other route. */
export async function signMarketGuestSession(sub: string, secret: string, ttlSeconds: number): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ mkt: true })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSeconds)
    .sign(keyOf(secret));
}

/** Verify a guest marketplace token. Returns the guest owner id ("mg_<n>") or null. */
export async function verifyMarketGuestSession(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), { algorithms: ["HS256"] });
    // A sign-in link (glink) is never a session: it can only be exchanged at POST /market/guest/link.
    if (payload.mkt !== true || payload.glink === true || typeof payload.sub !== "string" || !/^mg_\d{1,12}$/.test(payload.sub)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/** Verify a session token. Returns the claims, or null on any failure (bad sig, expired, malformed).
 *  Guest marketplace tokens (`mkt`) are never sessions. */
/**
 * A guest's sign-in link, put in the emails we send them (they proved the inbox is theirs by getting it): exchanged once
 * per browser for a guest session, so a link opened on another device or in the mail app doesn't ask for a code again.
 * Marked mkt (so it is never a member session) and glink (so it is never a guest session either).
 */
export async function signGuestLink(sub: string, secret: string, ttlSeconds: number): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ mkt: true, glink: true })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSeconds)
    .sign(keyOf(secret));
}

export async function verifyGuestLink(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), { algorithms: ["HS256"] });
    if (payload.mkt !== true || payload.glink !== true || typeof payload.sub !== "string" || !/^mg_\d{1,12}$/.test(payload.sub)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export async function verifySession(token: string, secret: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    if (payload.mkt === true) return null;
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    return {
      sub: payload.sub,
      mustChangePin: payload.mustChangePin === true,
      pinVer: typeof payload.pinVer === "number" ? payload.pinVer : 0,
      play: payload.play === true,
      name: name ? name.slice(0, 60) : undefined,
    };
  } catch {
    return null;
  }
}
