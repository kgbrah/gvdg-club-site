// The club's guest identity, shared by the marketplace and Lost & Found: a display name + email, proven with
// a 6-digit code sent by email. Codes are stored hashed, expire after 10 minutes, are single use and allow 5
// guesses. Requests are rate-limited per email and per IP (one budget across both surfaces). Verifying returns
// a guest token (mkt JWT, never a member session) for a stable identity keyed by the verified email, so a
// guest who verified for one surface is the same person on the other (feedback and karma accrue to them).
// Without a Resend key the flow is unavailable (fail soft: members can still sign in).

import { clientIp, readJson } from "./http.js";
import { signMarketGuestSession, verifyGuestLink } from "./jwt.js";
import { codeHash, constantTimeEqualText, emailHash, encryptEmail, sixDigitCode } from "./market-crypto.js";
import { parseDisplayName, parseEmail } from "./market-input.js";
import { emailConfigured, sendMarketEmail } from "./market-notify.js";
import { ensureTrader } from "./market-store.js";
import { fail, limited, ok, type MarketCtx } from "./market-http.js";

export const GUEST_CODE_TTL_MIN = 10;
export const GUEST_CODE_ATTEMPTS = 5;
export const GUEST_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

/** Where the code was asked for; only the email wording differs, the identity is the same. */
export type GuestSurface = "market" | "lostfound";

function codeEmail(surface: GuestSurface, name: string, code: string): { subject: string; text: string } {
  if (surface === "lostfound") {
    return {
      subject: `Your GVDG verification code: ${code}`,
      text: [
        `Hi ${name},`, "",
        `Your Greenville Disc Golf Club verification code is ${code}.`,
        `It expires in ${GUEST_CODE_TTL_MIN} minutes and works once. It signs you in to Lost & Found and the marketplace.`, "",
        "If you didn't ask for this, you can ignore this email.", "",
        "- Greenville Disc Golf Club",
      ].join("\n"),
    };
  }
  return {
    subject: `Your GVDG marketplace code: ${code}`,
    text: [
      `Hi ${name},`, "",
      `Your Greenville Disc Golf Club marketplace code is ${code}.`,
      `It expires in ${GUEST_CODE_TTL_MIN} minutes and works once.`, "",
      "If you didn't ask for this, you can ignore this email.", "",
      "- Greenville Disc Golf Club Pro Shop",
    ].join("\n"),
  };
}

export async function startGuest(c: MarketCtx, surface: GuestSurface = "market"): Promise<Response> {
  if (!emailConfigured(c.env)) return fail(c, 503, "guest_unavailable");
  const body = (await readJson(c.request)) ?? {};
  const name = parseDisplayName(body.name);
  if (!name) return fail(c, 400, "invalid_name");
  const email = parseEmail(body.email, 120);
  if (!email) return fail(c, 400, "invalid_email");
  const hash = await emailHash(c.env.JWT_SECRET, email);
  const ipBlocked = await limited(c, "mktcode:ip:" + clientIp(c.request), 10, 3600);
  if (ipBlocked) return ipBlocked;
  const emailBlocked = await limited(c, "mktcode:e:" + hash, 3, GUEST_CODE_TTL_MIN * 60);
  if (emailBlocked) return emailBlocked;
  const code = sixDigitCode();
  // A new code replaces any earlier unused one for this email.
  await c.env.DB.prepare("UPDATE market_guest_codes SET used_at = datetime('now') WHERE email_hash = ? AND used_at IS NULL").bind(hash).run();
  await c.env.DB.prepare(
    `INSERT INTO market_guest_codes (email_hash, code_hash, display_name, email_enc, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', '+${GUEST_CODE_TTL_MIN} minutes'))`,
  ).bind(hash, await codeHash(c.env.JWT_SECRET, hash, code), name, await encryptEmail(c.env.JWT_SECRET, email)).run();
  const message = codeEmail(surface, name, code);
  const sent = await sendMarketEmail(c.env, email, message.subject, message.text);
  if (!sent) return fail(c, 502, "email_failed");
  return ok(c, { ok: true, expiresInSec: GUEST_CODE_TTL_MIN * 60 });
}

/** POST /market/guest/link { token }: a sign-in link from one of our emails becomes a guest session in this browser. */
export async function exchangeGuestLink(c: MarketCtx): Promise<Response> {
  const blocked = await limited(c, "mktlink:ip:" + clientIp(c.request), 30, 600);
  if (blocked) return blocked;
  const body = (await readJson(c.request)) ?? {};
  const link = typeof body.token === "string" && body.token.length < 2000 ? body.token : "";
  const sub = link ? await verifyGuestLink(link, c.env.JWT_SECRET) : null;
  if (!sub) return fail(c, 400, "link_expired");
  const guest = await c.env.DB.prepare("SELECT id, display_name FROM market_guests WHERE id = ?").bind(Number(sub.slice(3)))
    .first<{ id: number; display_name: string }>();
  if (!guest) return fail(c, 400, "link_expired");
  const key = await ensureTrader(c.env, { id: sub, kind: "guest", name: guest.display_name });
  const token = await signMarketGuestSession(sub, c.env.JWT_SECRET, GUEST_TOKEN_TTL_SEC);
  return ok(c, { token, guest: { key, name: guest.display_name } });
}

export async function verifyGuest(c: MarketCtx): Promise<Response> {
  const body = (await readJson(c.request)) ?? {};
  const email = parseEmail(body.email, 120);
  const code = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : "";
  if (!email || !/^\d{6}$/.test(code)) return fail(c, 400, "invalid_code");
  const ipBlocked = await limited(c, "mktverify:ip:" + clientIp(c.request), 30, 600);
  if (ipBlocked) return ipBlocked;
  const hash = await emailHash(c.env.JWT_SECRET, email);
  const row = await c.env.DB.prepare(
    `SELECT id, code_hash, display_name, email_enc, attempts FROM market_guest_codes
     WHERE email_hash = ? AND used_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`,
  ).bind(hash).first<{ id: number; code_hash: string; display_name: string; email_enc: string; attempts: number }>();
  if (!row || row.attempts >= GUEST_CODE_ATTEMPTS) return fail(c, 400, "invalid_code");
  const expected = await codeHash(c.env.JWT_SECRET, hash, code);
  if (!constantTimeEqualText(expected, row.code_hash)) {
    // Count the miss; the fifth wrong guess burns the code.
    await c.env.DB.prepare(
      "UPDATE market_guest_codes SET attempts = attempts + 1, used_at = CASE WHEN attempts + 1 >= ? THEN datetime('now') ELSE used_at END WHERE id = ?",
    ).bind(GUEST_CODE_ATTEMPTS, row.id).run();
    return fail(c, 400, "invalid_code");
  }
  // Single use: only the request that flips used_at wins.
  const claimed = await c.env.DB.prepare("UPDATE market_guest_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL")
    .bind(row.id).run();
  if (!((claimed.meta?.changes ?? 0) > 0)) return fail(c, 400, "invalid_code");
  await c.env.DB.prepare(
    `INSERT INTO market_guests (email_hash, email_enc, display_name) VALUES (?, ?, ?)
     ON CONFLICT(email_hash) DO UPDATE SET email_enc = excluded.email_enc, display_name = excluded.display_name,
       last_verified_at = datetime('now')`,
  ).bind(hash, row.email_enc, row.display_name).run();
  const guest = await c.env.DB.prepare("SELECT id, display_name FROM market_guests WHERE email_hash = ?").bind(hash)
    .first<{ id: number; display_name: string }>();
  if (!guest) return fail(c, 500, "server_error");
  const sub = "mg_" + guest.id;
  const key = await ensureTrader(c.env, { id: sub, kind: "guest", name: guest.display_name });
  const token = await signMarketGuestSession(sub, c.env.JWT_SECRET, GUEST_TOKEN_TTL_SEC);
  return ok(c, { token, guest: { key, name: guest.display_name } });
}
