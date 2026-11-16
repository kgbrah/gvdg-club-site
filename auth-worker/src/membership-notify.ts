// Applicant-facing notifications for self-serve membership: an "application received" email on submit and
// a welcome email (+ optional Web Push) on approval. Email is gated on RESEND_API_KEY and a stored,
// valid address — a no-op otherwise. Everything is best-effort and never throws (callers use waitUntil).
// The PIN is NEVER included: the applicant already knows it, and only its hash is stored.
import type { Env } from "./env.js";
import type { D1Like } from "./db-types.js";
import { listEvents } from "./db-events.js";
import { encryptWebPush, fromB64url, loadVapidKeys, vapidAuthorization } from "./web-push.js";

const FACEBOOK_GROUP_URL = "https://www.facebook.com/groups/243452675724939";
const DEFAULT_FROM = "Greenville Disc Golf Club <club@gvdgclub.com>";
const DEFAULT_REPLY_TO = "greenvillediscgolf@gmail.com";

type Cfg = { RESEND_API_KEY?: string; MEMBERSHIP_NOTIFY_FROM?: string; REGISTER_NOTIFY_FROM?: string; EMAIL_REPLY_TO?: string; EXPECTED_ORIGIN?: string };

export interface UpcomingEvent { name: string; date: string }
export interface MailMessage { subject: string; html: string; text: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function siteBase(env: Env): string {
  const origin = (env as unknown as Cfg).EXPECTED_ORIGIN;
  return origin && /^https:\/\/[A-Za-z0-9.-]+$/.test(origin) ? origin : "https://gvdgclub.com";
}

export function membersUrl(env: Env): string {
  return siteBase(env) + "/gvdg-members.html";
}

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F4F4F9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F9;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E2E2EA;border-radius:12px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1A1A2E;">
<tr><td style="background:#2D5016;padding:20px 24px;color:#FFFFFF;font-size:13px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;">Greenville Disc Golf Club</td></tr>
<tr><td style="padding:24px;">
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:#1A1A2E;">${esc(title)}</h1>
${bodyHtml}
<p style="margin:22px 0 0;font-size:13px;color:#666666;">Questions? Just reply to this email.</p>
</td></tr></table></td></tr></table></body></html>`;
}

const p = (html: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#333333;">${html}</p>`;
const button = (href: string, label: string) =>
  `<p style="margin:18px 0;"><a href="${esc(href)}" style="display:inline-block;background:#C8410F;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:15px;padding:12px 20px;border-radius:8px;">${esc(label)}</a></p>`;

export function buildReceivedEmail(env: Env, opts: { name: string; identifier: string; duesPaid: boolean }): MailMessage {
  const first = opts.name.split(/\s+/)[0] || opts.name;
  const paidLine = opts.duesPaid ? "We got your $15 dues payment - thank you." : "";
  const html = shell("We got your application",
    p(`Hi ${esc(first)},`) +
    p(`Thanks for applying to the Greenville Disc Golf Club. An admin will review your application shortly and you will get another email when you are approved.${paidLine ? " " + esc(paidLine) : ""}`) +
    p(`When you are approved, sign in with <strong>${esc(opts.identifier)}</strong> and the PIN you chose on the application.`));
  const text = [
    `Hi ${first},`, "",
    "Thanks for applying to the Greenville Disc Golf Club. An admin will review your application shortly and you will get another email when you are approved." + (paidLine ? " " + paidLine : ""),
    "",
    `When you are approved, sign in with ${opts.identifier} and the PIN you chose on the application.`,
    "", "- Greenville Disc Golf Club",
  ].join("\n");
  return { subject: "We got your GVDG application", html, text };
}

export function buildWelcomeEmail(env: Env, opts: { name: string; identifier: string; events: UpcomingEvent[] }): MailMessage {
  const first = opts.name.split(/\s+/)[0] || opts.name;
  const url = membersUrl(env);
  const events = opts.events.slice(0, 3);
  const eventsHtml = events.length
    ? p("<strong>Coming up</strong>") + `<ul style="margin:0 0 14px;padding-left:20px;font-size:15px;line-height:1.55;color:#333333;">${events.map((e) => `<li>${esc(e.name)} - ${esc(e.date)}</li>`).join("")}</ul>`
    : "";
  const html = shell("Welcome to the club!",
    p(`Hi ${esc(first)}, you are approved - welcome to the Greenville Disc Golf Club.`) +
    p(`<strong>How to sign in:</strong> use <strong>${esc(opts.identifier)}</strong> and the PIN you chose when you applied. The first time in, the app will ask you to set your PIN once more.`) +
    button(url, "Open the member app") +
    p(`<strong>Install the app:</strong> open <a href="${esc(url)}" style="color:#C8410F;">${esc(url.replace(/^https:\/\//, ""))}</a> on your phone and choose "Add to Home Screen" (or "Install app") from your browser menu.`) +
    eventsHtml +
    p(`Say hi to everyone in the <a href="${esc(FACEBOOK_GROUP_URL)}" style="color:#C8410F;">club Facebook group</a>. See you on the course!`));
  const text = [
    `Hi ${first}, you are approved - welcome to the Greenville Disc Golf Club.`, "",
    `How to sign in: use ${opts.identifier} and the PIN you chose when you applied. The first time in, the app will ask you to set your PIN once more.`,
    "", `Member app: ${url}`,
    `Install the app: open that link on your phone and choose "Add to Home Screen" (or "Install app") from your browser menu.`,
    ...(events.length ? ["", "Coming up:", ...events.map((e) => `  ${e.name} - ${e.date}`)] : []),
    "", `Club Facebook group: ${FACEBOOK_GROUP_URL}`,
    "", "- Greenville Disc Golf Club",
  ].join("\n");
  return { subject: "Welcome to the Greenville Disc Golf Club", html, text };
}

/** Send one email through Resend. Returns false (silently) when unconfigured or on any failure. */
export async function sendMail(env: Env, to: string | null | undefined, msg: MailMessage): Promise<boolean> {
  const cfg = env as unknown as Cfg;
  if (!cfg.RESEND_API_KEY || !to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + cfg.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: cfg.MEMBERSHIP_NOTIFY_FROM || DEFAULT_FROM,
        to: [to],
        reply_to: cfg.EMAIL_REPLY_TO || DEFAULT_REPLY_TO,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function fmtDate(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const d = new Date(s.length === 10 ? s + "T12:00:00Z" : s);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : s;
}

/** Next few scheduled club events (cheap single query); [] on any failure. */
export async function upcomingEvents(db: D1Like | undefined, limit = 3): Promise<UpcomingEvent[]> {
  if (!db) return [];
  try {
    const rows = (await listEvents(db, { status: "scheduled" })) as { name?: string; date?: string }[];
    const today = new Date().toISOString().slice(0, 10);
    return rows
      .filter((r) => r && typeof r.name === "string" && typeof r.date === "string" && r.date.slice(0, 10) >= today)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(0, limit)
      .map((r) => ({ name: String(r.name), date: fmtDate(r.date) }));
  } catch {
    return [];
  }
}

export async function sendApplicationReceived(env: Env, app: { email?: string | null; name: string; pdgaNo: string | null; udisc: string | null }, duesPaid: boolean): Promise<void> {
  if (!app.email) return;
  await sendMail(env, app.email, buildReceivedEmail(env, { name: app.name, identifier: app.pdgaNo || app.udisc || "", duesPaid }));
}

export async function sendWelcome(env: Env, app: { email?: string | null; name: string; pdgaNo: string | null; udisc: string | null }): Promise<void> {
  if (!app.email || !(env as unknown as Cfg).RESEND_API_KEY) return;
  const events = await upcomingEvents(env.DB);
  await sendMail(env, app.email, buildWelcomeEmail(env, { name: app.name, identifier: app.pdgaNo || app.udisc || "", events }));
}

/** One-shot "approved" push to the applicant's stored subscription; the subscription is deleted afterwards
 *  (success or not) so an approved member is never left with a stray applicant subscription. */
export async function sendApprovalPush(env: Env, applicationId: string): Promise<void> {
  try {
    const row = await env.DB.prepare(
      "SELECT endpoint, p256dh, auth FROM membership_push_subscriptions WHERE application_id = ?",
    ).bind(applicationId).first<{ endpoint: string; p256dh: string; auth: string }>();
    if (!row) return;
    try {
      const cfg = env as unknown as { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string };
      const keys = await loadVapidKeys(cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY);
      const clientKey = fromB64url(row.p256dh);
      const auth = fromB64url(row.auth);
      if (keys && clientKey && clientKey.length === 65 && auth && auth.length === 16) {
        const payload = new TextEncoder().encode(JSON.stringify({
          kind: "member",
          title: "You're approved - welcome to GVDG",
          body: "Sign in with your PDGA # or UDisc name and the PIN you chose.",
          url: "/gvdg-members.html",
          tag: "membership-approved",
        }));
        const body = await encryptWebPush(payload, clientKey, auth);
        await fetch(row.endpoint, {
          method: "POST",
          redirect: "manual",
          headers: {
            Authorization: await vapidAuthorization(row.endpoint, keys),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: "86400",
          },
          body: body as BodyInit,
        });
      }
    } finally {
      await env.DB.prepare("DELETE FROM membership_push_subscriptions WHERE application_id = ?").bind(applicationId).run();
    }
  } catch {
    /* best-effort */
  }
}
