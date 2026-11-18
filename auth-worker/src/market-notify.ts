// Marketplace notifications. Members get an in-app notice (Messages > Updates, kind "market"), a Web Push
// on their "Messages" preference, and an email when they set a notification email in marketplace
// settings. Guests get email only, sent to their verified (encrypted-at-rest) address. Everything is
// best-effort and runs through waitUntil: a deal never fails because a notice could not be delivered.

import type { Env } from "./env.js";
import { decryptEmail } from "./market-crypto.js";
import { recordMemberNotices } from "./member-messages.js";
import { notifyMembers } from "./member-push.js";
import { siteBase } from "./membership-notify.js";

type WaitCtx = { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

export const MARKET_MEMBER_HREF = "/gvdg-members.html#marketplace";
const DEFAULT_FROM = "GVDG Pro Shop <shop@gvdgclub.com>";
const DEFAULT_REPLY_TO = "greenvillediscgolf@gmail.com";

type MailCfg = { RESEND_API_KEY?: string; ORDER_NOTIFY_FROM?: string; EMAIL_REPLY_TO?: string };

export function isGuestId(id: string): boolean {
  return /^mg_\d{1,12}$/.test(id);
}

export function emailConfigured(env: Env): boolean {
  const cfg = env as unknown as MailCfg;
  return typeof cfg.RESEND_API_KEY === "string" && cfg.RESEND_API_KEY.length > 0;
}

export function marketUrl(env: Env, hash = "my-market"): string {
  return siteBase(env) + "/pro-shop.html#" + hash;
}

/** One plain-text email through Resend. Returns false when unconfigured or on any failure. */
export async function sendMarketEmail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  const cfg = env as unknown as MailCfg;
  if (!cfg.RESEND_API_KEY || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + cfg.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: cfg.ORDER_NOTIFY_FROM || DEFAULT_FROM,
        to: [to],
        reply_to: cfg.EMAIL_REPLY_TO || DEFAULT_REPLY_TO,
        subject: subject.slice(0, 120),
        text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The address a trader receives marketplace mail at, or null. Never returned to any client. */
export async function traderEmail(env: Env, ownerId: string): Promise<string | null> {
  if (isGuestId(ownerId)) {
    const row = await env.DB.prepare("SELECT email_enc FROM market_guests WHERE id = ?")
      .bind(Number(ownerId.slice(3))).first<{ email_enc: string }>();
    return row ? decryptEmail(env.JWT_SECRET, row.email_enc) : null;
  }
  const row = await env.DB.prepare("SELECT notify_email FROM market_seller_settings WHERE member_id = ?")
    .bind(ownerId).first<{ notify_email: string }>();
  return row?.notify_email || null;
}

export interface MarketNote {
  title: string;
  body: string;
  /** Unique per event so a retried request cannot stack duplicate notices. */
  refKey: string;
  /** Where the email links to on the Pro Shop page (hash). */
  hash?: string;
  /** Skip the in-app notice and push (the caller already sent a direct message). */
  emailOnly?: boolean;
}

export async function deliverMarketNote(env: Env, ctx: WaitCtx, ownerId: string, note: MarketNote): Promise<void> {
  try {
    if (!isGuestId(ownerId) && !note.emailOnly) {
      await recordMemberNotices(env, [ownerId], {
        kind: "market", title: note.title, body: note.body, href: MARKET_MEMBER_HREF, refKey: note.refKey,
      });
      notifyMembers(ctx, env, [ownerId], "messages", { title: note.title, body: note.body, url: MARKET_MEMBER_HREF, tag: note.refKey });
    }
    if (!emailConfigured(env)) return;
    const to = await traderEmail(env, ownerId);
    if (!to) return;
    const text = [note.body, "", "Open the marketplace: " + marketUrl(env, note.hash || "my-market"), "", "- Greenville Disc Golf Club Pro Shop"].join("\n");
    await sendMarketEmail(env, to, note.title, text);
  } catch {
    /* notices are optional */
  }
}

/** Fire-and-forget wrapper for handlers. */
export function notifyTrader(env: Env, ctx: WaitCtx, ownerId: string, note: MarketNote): void {
  const job = deliverMarketNote(env, ctx, ownerId, note).catch(() => {});
  try {
    if (ctx?.waitUntil) ctx.waitUntil(job);
  } catch {
    /* settles on its own */
  }
}
