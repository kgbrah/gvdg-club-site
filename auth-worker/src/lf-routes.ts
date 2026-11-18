// Lost & Found: one entry point for /lost-found/* and /admin/lost-found/*.
//
// Who can do what (decided by the club owner):
//   - anyone can browse found and lost posts, the Returned wall and finder profiles;
//   - members and email-verified guests (the marketplace's guest identity) post, claim, mark returned,
//     confirm, message about a claim, celebrate and report;
//   - admins moderate (reports, AI match review, hide / unhide, close / merge, karma reversal, photos).
// All authorization happens here, server-side, from the bearer token; client-sent ids are never trusted.
// No route calls the AI on a public GET.

import type { Env } from "./env.js";
import { handleLostFoundAdmin } from "./lf-admin.js";
import { acceptMatch, claimAction, claimPost, declineMatch, getClaim, getMatch, postClaimMessage } from "./lf-claims.js";
import { browsePosts, closePost, createPost, getPost, removePostPhoto, servePublicPhoto, turnInPost } from "./lf-posts.js";
import { createCelebration, fileReport, finderProfile, myLostFound, returnedWall } from "./lf-social.js";
import { startGuest, verifyGuest } from "./market-guest.js";
import { fail, idOf, ok, type MarketCtx, type WaitCtx } from "./market-http.js";
import { emailConfigured } from "./market-notify.js";
import { resolveActor, viewerOf } from "./market-store.js";

export function isLostFoundRoute(pathname: string): boolean {
  return pathname.startsWith("/lost-found/") || pathname.startsWith("/admin/lost-found/") || pathname === "/admin/lost-found";
}

export async function handleLostFound(
  request: Request, env: Env, origin: string | null, pathname: string, method: string, ctx?: WaitCtx,
): Promise<Response | null> {
  if (!isLostFoundRoute(pathname)) return null;
  const seg = pathname.split("/").filter(Boolean);
  const c: MarketCtx = { request, env, origin, ctx, actor: null };
  if (seg[0] === "admin") return handleLostFoundAdmin(c, method, seg);

  // Photos are fetched by <img> without a token; only redacted public copies exist on this path.
  if (method === "GET" && seg[1] === "photos" && seg.length === 3) {
    const id = idOf(seg[2]);
    return id ? servePublicPhoto(c, id) : fail(c, 404, "not_found");
  }
  const [, area, a, b] = seg;
  // The homepage strip reads only public, cache-friendly data; skip the identity lookup.
  if (area === "returned" && seg.length === 2 && method === "GET" && new URL(request.url).searchParams.get("view") === "strip") {
    return returnedWall(c);
  }
  c.actor = await resolveActor(request, env);

  if (area === "config" && seg.length === 2 && method === "GET") {
    return ok(c, { guestVerify: emailConfigured(env), viewer: await viewerOf(env, c.actor) });
  }
  if (area === "guest" && seg.length === 3 && method === "POST") {
    // The same guest identity as the marketplace: one verified email works on both.
    if (a === "start") return startGuest(c, "lostfound");
    if (a === "verify") return verifyGuest(c);
  }
  if (area === "me" && seg.length === 2 && method === "GET") return myLostFound(c);
  if (area === "returned" && seg.length === 2 && method === "GET") return returnedWall(c);
  if (area === "people" && seg.length === 3 && method === "GET") return finderProfile(c, a || "");
  if (area === "reports" && seg.length === 2 && method === "POST") return fileReport(c);

  if (area === "posts") {
    if (seg.length === 2) {
      if (method === "GET") return browsePosts(c);
      if (method === "POST") return createPost(c);
    }
    const id = idOf(a);
    if (!id) return fail(c, 404, "not_found");
    if (seg.length === 3 && method === "GET") return getPost(c, id);
    if (seg.length === 4 && method === "POST") {
      if (b === "close") return closePost(c, id);
      if (b === "turn-in") return turnInPost(c, id);
      if (b === "claim") return claimPost(c, id);
    }
    if (seg.length === 6 && b === "photos" && seg[5] === "remove" && method === "POST") {
      const photoId = idOf(seg[4]);
      return photoId ? removePostPhoto(c, id, photoId) : fail(c, 404, "not_found");
    }
    return fail(c, 404, "not_found");
  }

  if (area === "matches") {
    const id = idOf(a);
    if (!id) return fail(c, 404, "not_found");
    if (seg.length === 3 && method === "GET") return getMatch(c, id);
    if (seg.length === 4 && method === "POST") {
      if (b === "mine") return acceptMatch(c, id);
      if (b === "not-mine") return declineMatch(c, id);
    }
    return fail(c, 404, "not_found");
  }

  if (area === "claims") {
    const id = idOf(a);
    if (!id) return fail(c, 404, "not_found");
    if (seg.length === 3 && method === "GET") return getClaim(c, id);
    if (seg.length === 4 && method === "POST") {
      if (b === "messages") return postClaimMessage(c, id);
      if (b === "celebrations") return createCelebration(c, id);
      if (b === "returned" || b === "confirm" || b === "not-yet" || b === "cancel" || b === "decline") return claimAction(c, id, b);
    }
    return fail(c, 404, "not_found");
  }

  return fail(c, 404, "not_found");
}
