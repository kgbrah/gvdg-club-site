// D1 helpers for membership dues (table from migration 0058). Applications live in ROSTER KV; this table
// holds each application's payment record. All SQL is parameterized.
import type { D1Like } from "./db-types.js";
import type { Env } from "./env.js";
import { loadVapidKeys } from "./web-push.js";

export const DEFAULT_DUES_CENTS = 1500;

type DuesConfigVars = { MEMBERSHIP_DUES_CENTS?: string; MEMBERSHIP_DUES_ONLINE?: string; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string };

/** Annual dues in cents, priced server-side. Optional MEMBERSHIP_DUES_CENTS override (sane range only). */
export function duesCents(env: Env): number {
  const n = Number((env as unknown as DuesConfigVars).MEMBERSHIP_DUES_CENTS);
  return Number.isInteger(n) && n >= 100 && n <= 100_000 ? n : DEFAULT_DUES_CENTS;
}

/** The switch. True only with BOTH PayPal secrets present; MEMBERSHIP_DUES_ONLINE=off|0|false forces it off. */
export function duesOnline(env: Env): boolean {
  const force = String((env as unknown as DuesConfigVars).MEMBERSHIP_DUES_ONLINE ?? "").trim().toLowerCase();
  if (force === "off" || force === "0" || force === "false") return false;
  return Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET);
}



export type DuesRow = {
  application_id: string;
  method: "paypal" | "manual" | "none";
  amount_cents: number;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  reserved_order_id: string | null;
  claimed_other: number;
  paid_at: string | null;
  marked_by: string | null;
  note: string | null;
  member_id: string | null;
};

export type PublicPayment = {
  status: "paid" | "manual" | "unpaid";
  method: "paypal" | "manual" | "none";
  amountCents: number;
  paidAt: string | null;
  captureId: string | null;
  orderId: string | null;
  markedBy: string | null;
  note: string | null;
  claimedOther: boolean;
};

export const UNPAID: PublicPayment = {
  status: "unpaid", method: "none", amountCents: 0, paidAt: null, captureId: null, orderId: null, markedBy: null, note: null, claimedOther: false,
};

const COLS = "application_id, method, amount_cents, paypal_order_id, paypal_capture_id, reserved_order_id, claimed_other, paid_at, marked_by, note, member_id";

export function publicPayment(row: DuesRow | null | undefined): PublicPayment {
  if (!row) return { ...UNPAID };
  const paid = !!row.paid_at;
  return {
    status: paid ? (row.method === "paypal" ? "paid" : "manual") : "unpaid",
    method: row.method,
    amountCents: paid ? row.amount_cents : 0,
    paidAt: row.paid_at ? row.paid_at.replace(" ", "T") + (row.paid_at.endsWith("Z") ? "" : "Z") : null,
    captureId: row.paypal_capture_id,
    orderId: row.paypal_order_id,
    markedBy: row.marked_by,
    note: row.note,
    claimedOther: row.claimed_other === 1 && !paid,
  };
}

export async function getDues(db: D1Like, applicationId: string): Promise<DuesRow | null> {
  return (await db.prepare(`SELECT ${COLS} FROM membership_dues WHERE application_id = ?`).bind(applicationId).first<DuesRow>()) ?? null;
}

/** Payments for many applications at once. Fails soft (empty map) so the list works before the migration lands. */
export async function duesFor(db: D1Like | undefined, ids: string[]): Promise<Map<string, DuesRow>> {
  const out = new Map<string, DuesRow>();
  if (!db || !ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const marks = chunk.map(() => "?").join(",");
      const res = await db.prepare(`SELECT ${COLS} FROM membership_dues WHERE application_id IN (${marks})`).bind(...chunk).all<DuesRow>();
      for (const r of res.results ?? []) out.set(r.application_id, r);
    }
  } catch {
    /* table missing / D1 hiccup: show everything as unpaid rather than breaking the list */
  }
  return out;
}

/** Claim the capture slot for one PayPal capture attempt BEFORE charging. */
export async function reserveDues(db: D1Like, applicationId: string, orderId: string): Promise<boolean> {
  const row = await db.prepare(
    `INSERT INTO membership_dues (application_id, method, reserved_order_id) VALUES (?, 'none', ?)
     ON CONFLICT(application_id) DO UPDATE SET reserved_order_id = excluded.reserved_order_id, updated_at = datetime('now')
     WHERE membership_dues.paid_at IS NULL
       AND (membership_dues.reserved_order_id IS NULL OR membership_dues.updated_at <= datetime('now', '-5 minutes'))
     RETURNING application_id`,
  ).bind(applicationId, orderId).first();
  return row != null;
}

export async function releaseDues(db: D1Like, applicationId: string, orderId: string): Promise<void> {
  await db.prepare(
    "UPDATE membership_dues SET reserved_order_id = NULL, updated_at = datetime('now') WHERE application_id = ? AND paid_at IS NULL AND reserved_order_id = ?",
  ).bind(applicationId, orderId).run();
}

/** Record a settled PayPal capture. Guarded by paid_at IS NULL so a retry can never double-record. */
export async function recordPaypalDues(db: D1Like, applicationId: string, orderId: string, captureId: string, amountCents: number): Promise<DuesRow | null> {
  return (await db.prepare(
    `UPDATE membership_dues SET method = 'paypal', amount_cents = ?, paypal_order_id = ?, paypal_capture_id = ?,
       paid_at = datetime('now'), reserved_order_id = NULL, updated_at = datetime('now')
     WHERE application_id = ? AND paid_at IS NULL RETURNING ${COLS}`,
  ).bind(amountCents, orderId, captureId || null, applicationId).first<DuesRow>()) ?? null;
}

/** Applicant says "I already paid / paying another way" (method stays none). Never overrides a payment. */
export async function claimOtherDues(db: D1Like, applicationId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO membership_dues (application_id, method, claimed_other) VALUES (?, 'none', 1)
     ON CONFLICT(application_id) DO UPDATE SET claimed_other = 1, updated_at = datetime('now') WHERE membership_dues.paid_at IS NULL`,
  ).bind(applicationId).run();
}

/** Admin confirms payment received outside PayPal. Does not overwrite a PayPal capture. */
export async function markManualDues(db: D1Like, applicationId: string, amountCents: number, adminName: string, adminId: string, note: string | null): Promise<DuesRow | null> {
  return (await db.prepare(
    `INSERT INTO membership_dues (application_id, method, amount_cents, paid_at, marked_by, marked_by_id, note)
     VALUES (?, 'manual', ?, datetime('now'), ?, ?, ?)
     ON CONFLICT(application_id) DO UPDATE SET method = 'manual', amount_cents = excluded.amount_cents, paid_at = datetime('now'),
       marked_by = excluded.marked_by, marked_by_id = excluded.marked_by_id, note = excluded.note, reserved_order_id = NULL, updated_at = datetime('now')
     WHERE membership_dues.method <> 'paypal' OR membership_dues.paid_at IS NULL
     RETURNING ${COLS}`,
  ).bind(applicationId, amountCents, adminName, adminId, note).first<DuesRow>()) ?? null;
}

export async function linkDuesMember(db: D1Like, applicationId: string, memberId: string): Promise<void> {
  try {
    await db.prepare("UPDATE membership_dues SET member_id = ?, updated_at = datetime('now') WHERE application_id = ?").bind(memberId, applicationId).run();
  } catch { /* audit link only */ }
}

/** Public config the apply form / homepage read: the dues switch, price, PayPal client id and VAPID public key. */
export async function membershipConfig(env: Env) {
  const online = duesOnline(env);
  const cfg = env as unknown as DuesConfigVars;
  const vapid = await loadVapidKeys(cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY).catch(() => null);
  return {
    duesOnline: online,
    duesCents: duesCents(env),
    paypalClientId: online ? env.PAYPAL_CLIENT_ID ?? null : null,
    paypalEnv: online ? env.PAYPAL_ENV ?? "sandbox" : null,
    pushPublicKey: vapid?.publicKey ?? null,
  };
}

