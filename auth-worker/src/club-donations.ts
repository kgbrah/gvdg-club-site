// Donations straight to the club (the Donate buttons, the $1 prompts, fundraisers). PayPal.me can't tell the app who
// gave, so a signed-in member reports it and an admin confirms it arrived; confirmed, it's +10 karma for every whole
// dollar, like the marketplace's gifts (owner: "Let's make ALL donations reward +10 karma per dollar"; an admin
// confirms each one).
//
//   POST /me/donations                    (member) { amountCents, source } -> { donation }
//   GET  /me/donations                    (member) -> { donations: [...the last 10], karmaPerDollar }
//   GET  /admin/donations                 (admin)  -> { pending, recent, karmaPerDollar }
//   POST /admin/donations/:id/review      (admin)  { decision: "received" | "not_received", reason? } -> { donation }
import { notifyAdmins } from "./admin-push.js";
import { requireMember } from "./authz.js";
import type { Env } from "./env.js";
import { json, readJson } from "./http.js";
import { asInt, asStr } from "./input.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { DONATION_MAX_CENTS, DONATION_MIN_CENTS, KARMA_PER_DOLLAR, donationKarma } from "./market-donations.js";
import { recordMemberNotices } from "./member-messages.js";
import { notifyMembers } from "./member-push.js";
import { getMember } from "./roster.js";

type WaitCtx = { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

export const DONATION_SOURCES = ["club-card", "round", "event", "fundraiser", "other"] as const;
const MAX_PENDING = 3;
const REPORTS_PER_DAY = 6;

type DonationRow = {
  id: number; member_id: string; member_name: string; amount_cents: number; source: string; status: string; karma: number;
  created_at: string; reviewed_at: string | null; review_note: string | null;
};

function view(row: DonationRow) {
  return {
    id: row.id, memberId: row.member_id, memberName: row.member_name, amountCents: row.amount_cents, source: row.source,
    status: row.status, karma: row.karma, createdAt: row.created_at, reviewedAt: row.reviewed_at, reviewNote: row.review_note ?? "",
  };
}

const dollars = (cents: number) => (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));

/** POST/GET /me/donations. */
export async function handleMyDonations(request: Request, env: Env, origin: string | null, method: string, ctx?: WaitCtx): Promise<Response> {
  const auth = await requireMember(request, env, origin);
  if (auth instanceof Response) return auth;
  if (method === "GET") {
    const rows = (await env.DB.prepare(`SELECT * FROM club_donations WHERE member_id = ? ORDER BY id DESC LIMIT 10`).bind(auth.sub).all<DonationRow>()).results ?? [];
    return json({ donations: rows.map(view), karmaPerDollar: KARMA_PER_DOLLAR }, 200, origin);
  }
  if (method !== "POST") return json({ error: "not_found" }, 404, origin);
  const body = (await readJson(request)) ?? {};
  const amount = asInt(body.amountCents);
  if (amount == null || amount < DONATION_MIN_CENTS || amount > DONATION_MAX_CENTS) return json({ error: "invalid_amount" }, 400, origin);
  const source = (DONATION_SOURCES as readonly string[]).includes(String(body.source)) ? String(body.source) : "other";
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM club_donations WHERE member_id = ? AND status = 'pending'`).bind(auth.sub).first<{ n: number }>();
  if ((Number(pending?.n) || 0) >= MAX_PENDING) return json({ error: "too_many_pending" }, 409, origin);
  if (await kvRateLimited(env, "donation-report:" + auth.sub, REPORTS_PER_DAY, 86_400)) return json({ error: "rate_limited" }, 429, origin);
  const member = await getMember(env.ROSTER, auth.sub);
  const name = (member?.name || "Member").slice(0, 80);
  const row = await env.DB.prepare(`INSERT INTO club_donations (member_id, member_name, amount_cents, source) VALUES (?, ?, ?, ?) RETURNING *`)
    .bind(auth.sub, name, amount, source).first<DonationRow>();
  if (!row) return json({ error: "save_failed" }, 500, origin);
  notifyAdmins(ctx, env, { title: "Donation to confirm", body: `${name} says they gave $${dollars(amount)} by PayPal.`, url: "/admin.html#donations", tag: "donation-" + row.id });
  return json({ donation: view(row), karmaPerDollar: KARMA_PER_DOLLAR }, 201, origin);
}

/** GET /admin/donations and POST /admin/donations/:id/review (behind adminGate). */
export async function handleAdminDonations(request: Request, env: Env, origin: string | null, method: string, seg: string[], adminId: string, ctx?: WaitCtx): Promise<Response> {
  if (method === "GET" && seg.length === 2) {
    const [pending, recent] = await Promise.all([
      env.DB.prepare(`SELECT * FROM club_donations WHERE status = 'pending' ORDER BY id`).all<DonationRow>(),
      env.DB.prepare(`SELECT * FROM club_donations WHERE status != 'pending' ORDER BY reviewed_at DESC, id DESC LIMIT 20`).all<DonationRow>(),
    ]);
    return json({ pending: (pending.results ?? []).map(view), recent: (recent.results ?? []).map(view), karmaPerDollar: KARMA_PER_DOLLAR }, 200, origin);
  }
  const id = asInt(seg[2]);
  if (method === "POST" && id != null && seg[3] === "review") {
    const body = (await readJson(request)) ?? {};
    const decision = body.decision === "received" ? "confirmed" : body.decision === "not_received" ? "not_received" : null;
    if (!decision) return json({ error: "invalid_decision" }, 400, origin);
    const reason = (asStr(body.reason, 200) ?? "").trim() || null;
    const current = await env.DB.prepare(`SELECT * FROM club_donations WHERE id = ?`).bind(id).first<DonationRow>();
    if (!current) return json({ error: "not_found" }, 404, origin);
    if (current.status !== "pending") return json({ error: "already_reviewed" }, 409, origin);
    const karma = decision === "confirmed" ? donationKarma(current.amount_cents) : 0;
    const row = await env.DB.prepare(`UPDATE club_donations SET status = ?, karma = ?, reviewed_at = datetime('now'), reviewed_by = ?, review_note = ?
        WHERE id = ? AND status = 'pending' RETURNING *`).bind(decision, karma, adminId, reason, id).first<DonationRow>();
    if (!row) return json({ error: "already_reviewed" }, 409, origin);
    const note = decision === "confirmed"
      ? { title: "Thank you for your donation", body: `The club received your $${dollars(row.amount_cents)} donation. That's +${karma} karma. Thank you for supporting the club!` }
      : { title: "Donation not found", body: `The club couldn't find your $${dollars(row.amount_cents)} donation in its PayPal${reason ? ` (${reason})` : ""}. If you sent it, reply to a club admin.` };
    const href = "/gvdg-members.html#club-hub";
    const job = recordMemberNotices(env, [row.member_id], { kind: "donation", ...note, href, refKey: "donation-" + row.id }).catch(() => {});
    try { ctx?.waitUntil?.(job); } catch { /* settles on its own */ }
    notifyMembers(ctx, env, [row.member_id], "messages", { ...note, url: href, tag: "donation-" + row.id });
    return json({ donation: view(row) }, 200, origin);
  }
  return json({ error: "not_found" }, 404, origin);
}
