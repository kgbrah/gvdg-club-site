import type { Env } from "./env.js";
import * as db from "./db.js";
import * as shopDb from "./shop-db.js";
import { getMember } from "./roster.js";
import { checkWalletTransactionIdempotency, createWalletTransactionOnce } from "./wallet-idempotency.js";
import { json, readJson } from "./http.js";
import { asInt, asStr } from "./input.js";

type AdminCtpRouteContext = {
  readonly request: Request;
  readonly env: Env;
  readonly origin: string | null;
  readonly method: string;
  readonly seg: readonly string[];
  readonly adminId: string;
  readonly eventId: number | null;
};

type CtpRow = Readonly<Record<string, unknown>>;

const CTP_DELETE_WINNER_BLOCKERS = ["winner"] as const;

function textValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function defaultCtpPayoutNote(event: CtpRow, ctp: CtpRow): string {
  const parts = [`CTP payout: ${textValue(event.name) ?? "event"}`];
  const hole = textValue(ctp.hole);
  if (hole) parts.push(`hole ${hole}`);
  const division = textValue(ctp.division);
  if (division) parts.push(division);
  const prize = textValue(ctp.prize);
  if (prize) parts.push(prize);
  return parts.join(" - ");
}

function hasWinner(ctp: CtpRow): boolean {
  return textValue(ctp.winner_member_id) != null || textValue(ctp.winner_name) != null;
}

async function getCtp(env: Env, eventId: number, ctpId: number): Promise<CtpRow | null> {
  return env.DB.prepare("SELECT * FROM ctps WHERE id = ? AND event_id = ?").bind(ctpId, eventId).first<CtpRow>();
}

function changedRows(result: db.D1ResultLike): number | null {
  return result.meta?.changes ?? result.meta?.rows_written ?? null;
}

async function awardCtpStoreCredit(ctx: AdminCtpRouteContext, eventId: number, ctpId: number): Promise<Response> {
  const body = (await readJson(ctx.request)) ?? {};
  if (body.confirm_ctp_store_credit_award !== true) return json({ error: "ctp_store_credit_confirmation_required" }, 409, ctx.origin);
  const memberId = asStr(body.member_id, 80);
  const amount = asInt(body.amount_cents);
  const idempotencyKey = asStr(body.idempotency_key, 160);
  if (!memberId || amount == null || amount <= 0) return json({ error: "invalid_store_credit" }, 400, ctx.origin);
  if (!idempotencyKey) return json({ error: "idempotency_key_required" }, 400, ctx.origin);
  const event = await db.getEvent(ctx.env.DB, eventId);
  if (!event) return json({ error: "not_found" }, 404, ctx.origin);
  const member = await getMember(ctx.env.ROSTER, memberId);
  if (!member) return json({ error: "member_not_found" }, 404, ctx.origin);
  const txInput = {
    member_id: memberId,
    member_name: member.name,
    amount_cents: amount,
    transaction_type: "credit",
    source: "event_payout",
    event_id: eventId,
    note: asStr(body.note, 300),
    created_by: ctx.adminId,
    idempotency_key: idempotencyKey,
  };
  const idempotency = await checkWalletTransactionIdempotency(ctx.env.DB, txInput);
  if (!idempotency.ok) return json({ error: idempotency.error }, 409, ctx.origin);
  const winnerName = asStr(body.winner_name, 100) ?? member.name;
  const ctp = await db.setCtpWinner(ctx.env.DB, ctpId, eventId, memberId, winnerName);
  if (!ctp) return json({ error: "not_found" }, 404, ctx.origin);
  if (idempotency.transaction) {
    return json({ ctp, transaction: idempotency.transaction, balance_cents: await shopDb.walletBalance(ctx.env.DB, memberId), payouts: await shopDb.listEventStoreCreditPayouts(ctx.env.DB, eventId) }, 200, ctx.origin);
  }
  const txResult = await createWalletTransactionOnce(ctx.env.DB, { ...txInput, note: txInput.note ?? defaultCtpPayoutNote(event, ctp) });
  if (!txResult.ok) return json({ error: txResult.error }, 409, ctx.origin);
  return json({ ctp, transaction: txResult.transaction, balance_cents: await shopDb.walletBalance(ctx.env.DB, memberId), payouts: await shopDb.listEventStoreCreditPayouts(ctx.env.DB, eventId) }, txResult.created ? 201 : 200, ctx.origin);
}

async function deleteCtp(ctx: AdminCtpRouteContext, eventId: number, ctpId: number): Promise<Response> {
  const body = (await readJson(ctx.request)) ?? {};
  if (body.confirm_ctp_delete !== true) return json({ error: "ctp_delete_confirmation_required" }, 409, ctx.origin);
  const ctp = await getCtp(ctx.env, eventId, ctpId);
  if (!ctp) return json({ error: "not_found" }, 404, ctx.origin);
  if (hasWinner(ctp)) return json({ error: "ctp_delete_blocked", blockers: CTP_DELETE_WINNER_BLOCKERS }, 409, ctx.origin);
  const result = await ctx.env.DB
    .prepare("DELETE FROM ctps WHERE id = ? AND event_id = ? AND winner_member_id IS NULL AND winner_name IS NULL")
    .bind(ctpId, eventId)
    .run();
  if (changedRows(result) === 0) return json({ error: "ctp_delete_blocked", blockers: CTP_DELETE_WINNER_BLOCKERS }, 409, ctx.origin);
  return json({ ok: true }, 200, ctx.origin);
}

export async function handleAdminCtps(ctx: AdminCtpRouteContext): Promise<Response | null> {
  if (ctx.seg[3] !== "ctps") return null;
  const eventId = ctx.eventId;
  if (eventId == null) return json({ error: "not_found" }, 404, ctx.origin);
  if (ctx.method === "POST" && ctx.seg[4] == null) {
    const body = await readJson(ctx.request);
    const hole = body && asInt(body.hole);
    if (!body || hole == null || hole < 1) return json({ error: "invalid_ctp" }, 400, ctx.origin);
    if (body.confirm_ctp_create !== true) return json({ error: "ctp_create_confirmation_required" }, 409, ctx.origin);
    const ctp = await db.createCtp(ctx.env.DB, { event_id: eventId, hole, division: asStr(body.division, 60), prize: asStr(body.prize, 200) });
    return json({ ctp }, 201, ctx.origin);
  }
  const ctpId = ctx.seg[4] != null ? asInt(ctx.seg[4]) : null;
  if (ctpId == null) return json({ error: "not_found" }, 404, ctx.origin);
  if (ctx.method === "POST" && ctx.seg[5] === "store-credit") return awardCtpStoreCredit(ctx, eventId, ctpId);
  if (ctx.method === "PATCH" && ctx.seg[5] == null) {
    const body = (await readJson(ctx.request)) ?? {};
    if (body.confirm_ctp_winner_change !== true) return json({ error: "ctp_winner_confirmation_required" }, 409, ctx.origin);
    const ctp = await db.setCtpWinner(ctx.env.DB, ctpId, eventId, asStr(body.winner_member_id, 64), asStr(body.winner_name, 100));
    return ctp ? json({ ctp }, 200, ctx.origin) : json({ error: "not_found" }, 404, ctx.origin);
  }
  if (ctx.method === "DELETE" && ctx.seg[5] == null) return deleteCtp(ctx, eventId, ctpId);
  return null;
}
