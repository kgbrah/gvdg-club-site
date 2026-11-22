import type { KVLike } from "./ratelimit.js";
import { base64Bytes } from "./photos.js";
import { getMember } from "./roster.js";

// Live rounds send each player's photo as a short signed link, not the image itself: the photo (15-35 KB of base64)
// rode along on every live update to every phone on the card, and into each phone's saved card. The link is
//   /member-photos/<memberId>/<sig>?v=<version>
// sig: HMAC of the member id with the Worker's secret (only someone who received the round's data has it); v: a hash
// of the photo, so a new photo is a new link and the image itself can be cached for good.
const PHOTO_LINK_RE = /^\/member-photos\/([A-Za-z0-9_.-]{1,80})\/([a-f0-9]{16})$/;

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...sig].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The signed link for a member's uploaded photo, or null (no secret, a guest, or a photo that's already a link). */
export async function memberPhotoLink(secret: string | undefined, memberId: string | null | undefined, photo: string | null | undefined): Promise<string | null> {
  if (!secret || !memberId || !/^m_[A-Za-z0-9_.-]{1,78}$/.test(memberId) || !photo || !photo.startsWith("data:image/")) return null;
  const [sig, version] = await Promise.all([hmacHex(secret, "member-photo:" + memberId), sha256Hex(photo)]);
  return `/member-photos/${memberId}/${sig.slice(0, 16)}?v=${version.slice(0, 12)}`;
}

/** GET /member-photos/:memberId/:sig — the member's current photo, cached for good (the link changes with the photo). */
export async function handleMemberPhoto(pathname: string, env: { ROSTER: KVLike; JWT_SECRET: string }): Promise<Response | null> {
  const match = PHOTO_LINK_RE.exec(pathname);
  if (!match) return null;
  const [, memberId, sig] = match;
  const expected = (await hmacHex(env.JWT_SECRET, "member-photo:" + memberId)).slice(0, 16);
  if (sig !== expected) {
    return new Response("not found", {
      status: 404,
      headers: { "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" },
    });
  }
  const photo = sanitizeProfilePhoto((await getMember(env.ROSTER, memberId!).catch(() => null))?.photo);
  if (!photo) {
    return new Response("not found", {
      status: 404,
      headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" },
    });
  }
  const [, type, data] = /^data:(image\/[a-z]+);base64,(.*)$/.exec(photo)!;
  const bytes = base64Bytes(data!);
  return new Response(bytes, {
    headers: {
      "Content-Type": type!,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const MAX_PROFILE_PHOTO_LEN = 200_000;

export function sanitizeProfilePhoto(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_PROFILE_PHOTO_LEN) return null;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  // pdga.com picture links (set automatically long ago) are no longer used: the club reads PDGA data only through
  // PDGA's developer API, which has no player photos.
  return null;
}

export async function withMemberPhotos<T extends { memberId?: string | null }>(
  kv: KVLike,
  players: readonly T[],
): Promise<Array<T & { photo?: string }>> {
  return Promise.all(players.map(async (player) => {
    const id = player.memberId;
    if (!id || id.startsWith("g_")) return player;
    try {
      const member = await getMember(kv, id);
      const photo = sanitizeProfilePhoto(member?.photo);
      return photo ? { ...player, photo } : player;
    } catch {
      return player;
    }
  }));
}
