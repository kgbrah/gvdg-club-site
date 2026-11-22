// Guest accounts (the owner's rules): anyone can apply for a guest account (an admin approves it); a guest must give
// a valid email (they sign in with it) and phone number. Guests play, score, register for events, post in Lost &
// Found and buy in the marketplace, but don't list discs for sale. As a promotion, the first GUEST_PROMO_LIMIT approved
// guest applications also get round history and stats; after that those need a club membership.
//
//   GET /membership/guest-spots (public) -> { limit, left }
import type { Env } from "./env.js";
import { json } from "./http.js";

export const GUEST_PROMO_LIMIT = 100;

/** "+18645550123" for a US number typed any way ("(864) 555-0123", "864.555.0123", "1 864 555 0123"), or an
 *  international "+44 20 7946 0958" (8 to 15 digits). null when it isn't a phone number. */
export function parsePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 32 || !/^[+\d\s().-]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+")) return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0") ? "+" + digits : null;
  const us = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  // NANP: area code and exchange can't start with 0 or 1.
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(us) ? "+1" + us : null;
}

export async function guestSpots(env: Env): Promise<{ limit: number; used: number; left: number }> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM guest_promo").first<{ n: number }>().catch(() => null);
  const used = Number(row?.n) || 0;
  return { limit: GUEST_PROMO_LIMIT, used, left: Math.max(0, GUEST_PROMO_LIMIT - used) };
}

/** Give this new guest a promo spot if any are left (atomic: concurrent approvals can't pass the limit). */
export async function grantGuestPromo(env: Env, memberId: string, adminId: string | null): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO guest_promo (member_id, approved_by) SELECT ?, ?
     WHERE (SELECT COUNT(*) FROM guest_promo) < ? AND NOT EXISTS (SELECT 1 FROM guest_promo WHERE member_id = ?)`,
  ).bind(memberId, adminId, GUEST_PROMO_LIMIT, memberId).run();
  return Number(result.meta?.changes) > 0;
}

/** Release any promo spot held by a removed or promoted guest so the capped pool stays accurate. */
export async function releaseGuestPromo(env: Env, memberId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM guest_promo WHERE member_id = ?").bind(memberId).run();
}

export async function handleGuestSpots(env: Env, origin: string | null): Promise<Response> {
  const { limit, left } = await guestSpots(env);
  return json({ limit, left }, 200, origin, { "Cache-Control": "public, max-age=60" });
}
