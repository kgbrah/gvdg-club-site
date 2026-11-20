// Every account has an email so a forgotten PIN never needs an admin (the owner: "require an email so users have a
// self recovery path").
//
//   POST /me/email/start  { email, pin? }  a signed-in member adds or changes their email: a 6-digit code goes to it.
//                                          Adding the first one needs nothing more (being signed in is enough; there's
//                                          no recovery address to take over). Changing an existing one needs the PIN
//                                          (or a passkey check, which is a fresh sign-in) unless they signed in within
//                                          15 minutes, so a borrowed phone can't point the account's recovery at
//                                          someone else; the old address is told either way.
//   POST /me/email/verify { code }         the code confirms the address; sign-in by email moves to it.
//   POST /pin-reset/start  { identifier }  "Forgot PIN?": a code goes to the email on file. The answer is the same
//                                          whether or not the account exists or has an email (no enumeration).
//   POST /pin-reset/verify { identifier, code, newPin }  sets the PIN (every other session signs out), clears the
//                                          lockouts and signs them in.
//
// Codes are HMAC-hashed in the RATELIMIT KV, expire in 15 minutes, are single use and allow 5 guesses.
import type { Env } from "./env.js";
import { requireAuth, ttl } from "./authz.js";
import { hashPin, verifyPin } from "./crypto.js";
import { clientIp, json, readJson } from "./http.js";
import { signSession } from "./jwt.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { codeHash, constantTimeEqualText, sixDigitCode } from "./market-crypto.js";
import { parseEmail } from "./market-input.js";
import { emailConfigured } from "./market-notify.js";
import { memberSessionBody } from "./member-routes.js";
import { sendMail } from "./membership-notify.js";
import { checkLockout, clearAttempts, recordFailure } from "./ratelimit.js";
import { canonicalLoginKey, emailOwner, getMember, loginKeysOf, resolveMember, setMemberEmail, setPin, type Member } from "./roster.js";

export const CODE_TTL_SEC = 15 * 60;
export const CODE_TRIES = 5;
/** A sign-in this recent proves it's them; after that, changing the email needs the PIN. */
export const RECENT_SIGN_IN_SEC = 15 * 60;

const EMAIL_CODE = (memberId: string) => `acct:emailcode:${memberId}`;
const RESET_CODE = (memberId: string) => `acct:pinreset:${memberId}`;
const PIN_CHECK = (memberId: string) => `acct:pincheck:${memberId}`;
const ACCOUNT_SENDS = (memberId: string) => `acct:email:m:${memberId}`;
const RESET_REQUESTS = (loginKey: string) => `acct:reset:id:${loginKey}`;

/** Admin › Members "Clear lockouts": every counter that can keep this member out - wrong-PIN lockouts on each sign-in
 *  name, the email step's PIN check and code sends, Forgot PIN requests, PIN changes. Deletes only what's there. */
export async function clearAccountLocks(env: Env, member: Pick<Member, "memberId" | "pdgaNo" | "udisc" | "email">): Promise<number> {
  const keys = [
    ...loginKeysOf(member).map((key) => "ratelimit:" + key),
    "ratelimit:" + PIN_CHECK(member.memberId),
    ACCOUNT_SENDS(member.memberId),
    ...loginKeysOf(member).map(RESET_REQUESTS),
    "setpin:" + member.memberId,
  ];
  let cleared = 0;
  for (const key of new Set(keys)) {
    if ((await env.RATELIMIT.get(key)) === null) continue;
    await env.RATELIMIT.delete(key);
    cleared += 1;
  }
  return cleared;
}

type StoredCode = { hash: string; tries: number; email?: string };

async function saveCode(env: Env, key: string, row: StoredCode): Promise<void> {
  await env.RATELIMIT.put(key, JSON.stringify(row), { expirationTtl: CODE_TTL_SEC });
}

async function readCode(env: Env, key: string): Promise<StoredCode | null> {
  try {
    const row = JSON.parse((await env.RATELIMIT.get(key)) || "null") as StoredCode | null;
    return row && typeof row.hash === "string" ? row : null;
  } catch {
    return null;
  }
}

/** "ok" uses the code up; "bad" spends a guess (the fifth bad guess burns it); "gone" = expired or never sent. */
async function takeCode(env: Env, key: string, scope: string, code: unknown): Promise<{ result: "ok" | "bad" | "gone"; row?: StoredCode }> {
  const row = await readCode(env, key);
  if (!row) return { result: "gone" };
  const text = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  if (/^\d{6}$/.test(text) && constantTimeEqualText(await codeHash(env.JWT_SECRET, scope, text), row.hash)) {
    await env.RATELIMIT.delete(key);
    return { result: "ok", row };
  }
  if (row.tries + 1 >= CODE_TRIES) {
    await env.RATELIMIT.delete(key);
    return { result: "gone" };
  }
  await saveCode(env, key, { ...row, tries: row.tries + 1 });
  return { result: "bad" };
}

function codeMessage(name: string, code: string, purpose: "email" | "reset") {
  const first = name.split(/\s+/)[0] || name;
  const lines = purpose === "reset"
    ? [`Hi ${first},`, "", `Your code to reset your Greenville Disc Golf Club PIN is ${code}.`, "",
      `It expires in ${CODE_TTL_SEC / 60} minutes and works once. Enter it in the app, then choose a new PIN.`, "",
      "If you didn't ask for this, you can ignore this email - your PIN hasn't changed.", "", "- Greenville Disc Golf Club"]
    : [`Hi ${first},`, "", `Your code to confirm this email for your Greenville Disc Golf Club account is ${code}.`, "",
      `It expires in ${CODE_TTL_SEC / 60} minutes. Once it's confirmed, you can reset your PIN yourself with this email if you ever forget it.`, "",
      "If you didn't ask for this, you can ignore this email.", "", "- Greenville Disc Golf Club"];
  const text = lines.join("\n");
  const html = lines.map((line) => line ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#222222;">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/(\d{6})/, "<strong style=\"font-size:20px;letter-spacing:2px;\">$1</strong>")}</p>` : "").join("");
  const subject = purpose === "reset" ? `Your GVDG PIN reset code: ${code}` : `Your GVDG email code: ${code}`;
  return { subject, text, html };
}

/** POST /me/email/start */
export async function handleEmailStart(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  const member = claims?.member;
  if (!claims || !member) return json({ error: "unauthorized" }, 401, origin);
  if (await kvRateLimited(env, "acct:email:ip:" + clientIp(request), 20, 3600)) return json({ error: "rate_limited" }, 429, origin);
  const body = (await readJson(request)) ?? {};
  const email = parseEmail(body.email, 120);
  if (!email) return json({ error: "invalid_email" }, 400, origin);
  if (member.email && member.email.toLowerCase() === email) return json({ error: "same_email" }, 400, origin);

  const nowSec = Math.floor(Date.now() / 1000);
  if (member.email && nowSec - (claims.at ?? 0) > RECENT_SIGN_IN_SEC) {
    const pin = typeof body.pin === "string" ? body.pin : "";
    if (!pin) return json({ error: "pin_required" }, 403, origin);
    const lock = await checkLockout(env.RATELIMIT, PIN_CHECK(member.memberId), Date.now());
    if (lock.locked) return json({ error: "locked_out", retryAfterSec: lock.retryAfterSec }, 423, origin);
    if (!(await verifyPin(pin, member.pinHash, env.PIN_PEPPER))) {
      await recordFailure(env.RATELIMIT, PIN_CHECK(member.memberId), Date.now());
      // 403, not 401: the apps read a 401 as "signed out".
      return json({ error: "wrong_pin" }, 403, origin);
    }
    await clearAttempts(env.RATELIMIT, PIN_CHECK(member.memberId));
  }

  const owner = await emailOwner(env.ROSTER, email);
  if (owner && owner !== member.memberId) return json({ error: "email_in_use" }, 409, origin);
  if (!emailConfigured(env)) return json({ error: "email_unavailable" }, 503, origin);
  // Only codes actually sent count (a PIN prompt or a wrong PIN has its own lockout), 6 an hour.
  if (await kvRateLimited(env, ACCOUNT_SENDS(member.memberId), 6, 3600)) return json({ error: "rate_limited" }, 429, origin);

  const code = sixDigitCode();
  await saveCode(env, EMAIL_CODE(member.memberId), { hash: await codeHash(env.JWT_SECRET, `email:${member.memberId}:${email}`, code), tries: 0, email });
  if (!(await sendMail(env, email, codeMessage(member.name, code, "email")))) return json({ error: "email_failed" }, 502, origin);
  return json({ ok: true, expiresInSec: CODE_TTL_SEC }, 200, origin);
}

/** POST /me/email/verify */
export async function handleEmailVerify(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  const member = claims?.member;
  if (!claims || !member) return json({ error: "unauthorized" }, 401, origin);
  const body = (await readJson(request)) ?? {};
  const pending = await readCode(env, EMAIL_CODE(member.memberId));
  if (!pending?.email) return json({ error: "code_expired" }, 400, origin);
  const taken = await takeCode(env, EMAIL_CODE(member.memberId), `email:${member.memberId}:${pending.email}`, body.code);
  if (taken.result === "gone") return json({ error: "code_expired" }, 400, origin);
  if (taken.result === "bad") return json({ error: "invalid_code" }, 400, origin);
  const previous = member.email ?? null;
  const saved = await setMemberEmail(env.ROSTER, member.memberId, pending.email);
  if (saved === "conflict") return json({ error: "email_in_use" }, 409, origin);
  if (saved === "missing") return json({ error: "unauthorized" }, 401, origin);
  // Tell the old address it moved (a heads-up if it wasn't them); best effort.
  if (previous && previous.toLowerCase() !== pending.email) {
    const text = [`Hi ${member.name.split(/\s+/)[0] || member.name},`, "",
      "The email on your Greenville Disc Golf Club account was just changed, so PIN reset codes now go to the new address.", "",
      "If that wasn't you, contact a club admin.", "", "- Greenville Disc Golf Club"].join("\n");
    await sendMail(env, previous, { subject: "Your GVDG account email was changed", text, html: text.split("\n").map((l) => l ? `<p>${l}</p>` : "").join("") }).catch(() => false);
  }
  return json({ email: pending.email, needsEmail: false, emailRequired: false }, 200, origin);
}

/** POST /pin-reset/start */
export async function handlePinResetStart(request: Request, env: Env, origin: string | null, ctx?: ExecutionContext): Promise<Response> {
  if (!emailConfigured(env)) return json({ error: "reset_unavailable" }, 503, origin);
  if (await kvRateLimited(env, "acct:reset:ip:" + clientIp(request), 10, 3600)) return json({ error: "rate_limited" }, 429, origin);
  const body = (await readJson(request)) ?? {};
  const identifier = typeof body.identifier === "string" ? body.identifier.trim().slice(0, 120) : "";
  if (!identifier) return json({ error: "invalid_request" }, 400, origin);
  if (await kvRateLimited(env, RESET_REQUESTS(canonicalLoginKey(identifier)), 3, CODE_TTL_SEC)) return json({ error: "rate_limited" }, 429, origin);

  const member = await resolveMember(env.ROSTER, identifier);
  if (member?.email && member.held !== true) {
    const code = sixDigitCode();
    await saveCode(env, RESET_CODE(member.memberId), { hash: await codeHash(env.JWT_SECRET, `reset:${member.memberId}`, code), tries: 0 });
    // Sent after the answer, so an account with an email answers as quickly as one without.
    const send = sendMail(env, member.email, codeMessage(member.name, code, "reset")).catch(() => false);
    if (ctx?.waitUntil) ctx.waitUntil(send);
    else await send;
  }
  return json({ ok: true, expiresInSec: CODE_TTL_SEC }, 200, origin);
}

/** POST /pin-reset/verify */
export async function handlePinResetVerify(request: Request, env: Env, origin: string | null): Promise<Response> {
  if (await kvRateLimited(env, "acct:resetv:ip:" + clientIp(request), 30, 3600)) return json({ error: "rate_limited" }, 429, origin);
  const body = (await readJson(request)) ?? {};
  const identifier = typeof body.identifier === "string" ? body.identifier.trim().slice(0, 120) : "";
  const newPin = typeof body.newPin === "string" ? body.newPin : "";
  if (!/^\d{4}$/.test(newPin)) return json({ error: "invalid_pin_format" }, 400, origin);
  const found = identifier ? await resolveMember(env.ROSTER, identifier) : null;
  if (!found) return json({ error: "code_expired" }, 400, origin);
  const taken = await takeCode(env, RESET_CODE(found.memberId), `reset:${found.memberId}`, body.code);
  if (taken.result === "gone") return json({ error: "code_expired" }, 400, origin);
  if (taken.result === "bad") return json({ error: "invalid_code" }, 400, origin);

  const pinVer = await setPin(env.ROSTER, found.memberId, await hashPin(newPin, env.PIN_PEPPER));
  for (const key of new Set([canonicalLoginKey(identifier), ...loginKeysOf(found)])) await clearAttempts(env.RATELIMIT, key);
  const member = (await getMember(env.ROSTER, found.memberId)) ?? found;
  const token = await signSession({ sub: member.memberId, mustChangePin: false, pinVer }, env.JWT_SECRET, ttl(env));
  return json({ token, ...memberSessionBody(member) }, 200, origin);
}
