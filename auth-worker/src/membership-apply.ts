import type { Env } from "./env.js";
import { json, readJson, clientIp } from "./http.js";
import { asStr, parseOptionalEmail } from "./input.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { hashPin } from "./crypto.js";
import { createMember, resolveMember, getMember, putMember, type KVListLike } from "./roster.js";
import { duesCents, duesFor, duesOnline, linkDuesMember, membershipConfig, markManualDues, publicPayment, type PublicPayment } from "./membership-dues-db.js";
import { sendApplicationReceived, sendApprovalPush, sendWelcome } from "./membership-notify.js";
import { notifyAdmins } from "./admin-push.js";
import { carriedOverText, claimHeldFor } from "./held-accounts.js";

const PDGA_RE = /^\d{1,12}$/;
const UDISC_RE = /^[A-Za-z0-9._-]{1,50}$/;
const PIN_RE = /^\d{4}$/;
const APPLY_PREFIX = "apply:";
const APPLY_PDGA = (n: string) => `idx:apply:pdga:${n}`;
const APPLY_UDISC = (u: string) => `idx:apply:udisc:${u.toLowerCase()}`;
const APPLY_LIMIT = 6;
const APPLY_WINDOW_SEC = 3600;

export type MembershipApplication = {
  id: string;
  name: string;
  pdgaNo: string | null;
  udisc: string | null;
  pinHash: string;
  createdAt: string;
  /** Optional contact email (welcome/confirmation mail). Stored server-side only; never returned publicly. */
  email?: string | null;
  /** Unguessable capability the applicant's browser holds to pay dues / opt in to push for THIS application. */
  payToken?: string;
};

export type PublicApplication = Pick<MembershipApplication, "id" | "name" | "pdgaNo" | "udisc" | "createdAt"> & {
  hasEmail?: boolean;
  payment?: PublicPayment;
};

function pub(row: MembershipApplication): PublicApplication {
  return { id: row.id, name: row.name, pdgaNo: row.pdgaNo, udisc: row.udisc, createdAt: row.createdAt };
}

function newPayToken() {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
}

function applicationKey(id: string) {
  return APPLY_PREFIX + id;
}

function newApplicationId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

export async function readApplication(kv: KVListLike, id: string): Promise<MembershipApplication | null> {
  const raw = await kv.get(applicationKey(id));
  if (!raw) return null;
  try {
    const row = JSON.parse(raw) as MembershipApplication;
    if (!row || typeof row.id !== "string" || typeof row.pinHash !== "string") return null;
    return row;
  } catch {
    return null;
  }
}

async function writeApplication(kv: KVListLike, row: MembershipApplication) {
  await kv.put(applicationKey(row.id), JSON.stringify(row));
  if (row.pdgaNo) await kv.put(APPLY_PDGA(row.pdgaNo), row.id);
  if (row.udisc) await kv.put(APPLY_UDISC(row.udisc), row.id);
}

async function deleteApplication(kv: KVListLike, row: MembershipApplication) {
  await kv.delete(applicationKey(row.id));
  if (row.pdgaNo) await kv.delete(APPLY_PDGA(row.pdgaNo));
  if (row.udisc) await kv.delete(APPLY_UDISC(row.udisc));
}

export async function listApplications(kv: KVListLike, db?: Env["DB"]): Promise<PublicApplication[]> {
  const out: PublicApplication[] = [];
  const emails = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: APPLY_PREFIX, cursor });
    for (const key of page.keys) {
      const row = await readApplication(kv, key.name.slice(APPLY_PREFIX.length));
      if (row) {
        out.push(pub(row));
        if (row.email) emails.add(row.id);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const dues = await duesFor(db, out.map((a) => a.id));
  for (const a of out) {
    a.hasEmail = emails.has(a.id);
    a.payment = publicPayment(dues.get(a.id));
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
  return out;
}

export async function handleMembershipApply(request: Request, env: Env, origin: string | null, ctx?: ExecutionContext): Promise<Response> {
  if (await kvRateLimited(env, "membership-apply:" + clientIp(request), APPLY_LIMIT, APPLY_WINDOW_SEC)) {
    return json({ error: "rate_limited" }, 429, origin);
  }
  const body = (await readJson(request)) ?? {};
  const name = asStr(body.name, 80);
  const pdgaNo = asStr(body.pdgaNo, 12);
  const udisc = asStr(body.udisc, 50);
  const pin = asStr(body.pin, 4);
  const email = parseOptionalEmail(body.email);
  if (!email.ok) return json({ error: "invalid_email" }, 400, origin);
  if (!name) return json({ error: "name_required" }, 400, origin);
  if (!pdgaNo && !udisc) return json({ error: "pdga_or_udisc_required" }, 400, origin);
  if (pdgaNo && !PDGA_RE.test(pdgaNo)) return json({ error: "invalid_pdga" }, 400, origin);
  if (udisc && !UDISC_RE.test(udisc)) return json({ error: "invalid_udisc" }, 400, origin);
  if (!pin || !PIN_RE.test(pin)) return json({ error: "invalid_pin" }, 400, origin);

  const kv = env.ROSTER as unknown as KVListLike;
  if (pdgaNo && await resolveMember(kv, pdgaNo)) return json({ error: "member_exists" }, 409, origin);
  if (udisc && await resolveMember(kv, udisc)) return json({ error: "member_exists" }, 409, origin);
  if (pdgaNo && await kv.get(APPLY_PDGA(pdgaNo))) return json({ error: "already_pending" }, 409, origin);
  if (udisc && await kv.get(APPLY_UDISC(udisc))) return json({ error: "already_pending" }, 409, origin);

  const row: MembershipApplication = {
    id: newApplicationId(),
    name,
    pdgaNo: pdgaNo || null,
    udisc: udisc || null,
    pinHash: await hashPin(pin, env.PIN_PEPPER),
    createdAt: new Date().toISOString(),
    email: email.value,
    payToken: newPayToken(),
  };
  await writeApplication(kv, row);
  if (row.email) {
    try { ctx?.waitUntil?.(sendApplicationReceived(env, row, false).catch(() => {})); } catch { /* optional */ }
  }
  notifyAdmins(ctx, env, {
    title: "Membership application",
    body: `${name} applied to join.`,
    url: "/admin.html?tab=members",
    tag: `membership:${row.id}`,
  });
  return json({ application: pub(row), payToken: row.payToken, ...(await membershipConfig(env)) }, 201, origin);
}

export async function handleAdminMembershipApplications(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  adminId: string,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  if (seg[2] !== "applications") return null;
  const kv = env.ROSTER as unknown as KVListLike;

  if (method === "GET" && seg.length === 3) {
    return json({ applications: await listApplications(kv, env.DB), duesOnline: duesOnline(env), duesCents: duesCents(env) }, 200, origin);
  }

  if (method === "POST" && seg.length === 5) {
    const id = asStr(seg[3], 40);
    const action = seg[4];
    if (!id) return json({ error: "invalid_request" }, 400, origin);
    const row = await readApplication(kv, id);
    if (!row) return json({ error: "not_found" }, 404, origin);

    if (action === "mark-paid") {
      const b = (await readJson(request)) ?? {};
      const note = asStr(b.note, 200);
      const admin = await getMember(kv, adminId);
      const rec = await markManualDues(env.DB, row.id, duesCents(env), admin?.name ?? "Admin", adminId, note);
      if (!rec) return json({ error: "already_paid" }, 409, origin);
      return json({ payment: publicPayment(rec) }, 200, origin);
    }

    if (action === "reject") {
      await deleteApplication(kv, row);
      try { await env.DB.prepare("DELETE FROM membership_push_subscriptions WHERE application_id = ?").bind(row.id).run(); } catch { /* optional */ }
      return json({ ok: true }, 200, origin);
    }

    if (action === "approve") {
      const result = await createMember(kv, {
        name: row.name,
        pdgaNo: row.pdgaNo,
        udisc: row.udisc,
        isAdmin: false,
      }, row.pinHash);
      if (!result.ok) return json({ error: "member_" + result.reason }, result.reason === "invalid" ? 400 : 409, origin);
      // Already on the club's sheets: their held account (store credit, dues, bag tag) comes across.
      const carried = await claimHeldFor(env, result.member, adminId);
      await deleteApplication(kv, row);
      // One-time welcome card flag for the member's first sign-in (cleared by POST /me/welcome-seen).
      const created = await getMember(kv, result.member.memberId);
      if (created) await putMember(kv, { ...created, welcomePending: true });
      await linkDuesMember(env.DB, row.id, result.member.memberId);
      // Best-effort welcome email + push; never blocks or fails the approval.
      try {
        ctx?.waitUntil?.(Promise.all([
          sendWelcome(env, row).catch(() => {}),
          sendApprovalPush(env, row.id).catch(() => {}),
        ]));
      } catch { /* optional */ }
      return json({
        member: {
          memberId: result.member.memberId,
          name: result.member.name,
          pdgaNo: result.member.pdgaNo ?? null,
          udisc: result.member.udisc ?? null,
          isAdmin: false,
          mustChangePin: true,
        },
        carriedOver: carriedOverText(carried) || null,
      }, 200, origin);
    }
  }

  return json({ error: "not_found" }, 404, origin);
}
