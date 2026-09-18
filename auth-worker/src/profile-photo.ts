import type { KVLike } from "./ratelimit.js";
import { getMember } from "./roster.js";

export const MAX_PROFILE_PHOTO_LEN = 200_000;

export function sanitizeProfilePhoto(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_PROFILE_PHOTO_LEN) return null;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  if (/^https:\/\/([a-z0-9-]+\.)*pdga\.com\//i.test(value) && value.length <= 500 && !/[\s<>]/.test(value)) return value;
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
