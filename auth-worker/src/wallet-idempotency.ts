import type { D1Like } from "./db.js";
import { isUniqueViolation } from "./input.js";

type WalletTransactionRow = Record<string, unknown>;

export type IdempotentWalletTransactionInput = {
  readonly member_id: string;
  readonly member_name?: string | null;
  readonly amount_cents: number;
  readonly transaction_type: string;
  readonly source: string;
  readonly event_id?: number | null;
  readonly order_id?: number | null;
  readonly note?: string | null;
  readonly created_by?: string | null;
  readonly idempotency_key: string;
};

export type IdempotentWalletTransactionResult =
  | { readonly ok: true; readonly transaction: WalletTransactionRow; readonly created: boolean }
  | { readonly ok: false; readonly error: "idempotency_key_conflict" };

export type WalletTransactionIdempotencyCheck =
  | { readonly ok: true; readonly transaction: WalletTransactionRow | null }
  | { readonly ok: false; readonly error: "idempotency_key_conflict" };

function rowText(row: WalletTransactionRow, key: string): string | null {
  const value = row[key];
  if (value == null) return null;
  return typeof value === "string" ? value : String(value);
}

function rowNumber(row: WalletTransactionRow, key: string): number | null {
  const value = row[key];
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableNumber(value: number | null | undefined): number | null {
  return value == null ? null : value;
}

function sameNullableNumber(a: number | null, b: number | null): boolean {
  return a === b;
}

function transactionMatchesInput(row: WalletTransactionRow, input: IdempotentWalletTransactionInput): boolean {
  return rowText(row, "member_id") === input.member_id
    && rowNumber(row, "amount_cents") === input.amount_cents
    && rowText(row, "transaction_type") === input.transaction_type
    && rowText(row, "source") === input.source
    && sameNullableNumber(rowNumber(row, "event_id"), nullableNumber(input.event_id))
    && sameNullableNumber(rowNumber(row, "order_id"), nullableNumber(input.order_id));
}

async function findWalletTransactionByIdempotencyKey(db: D1Like, key: string): Promise<WalletTransactionRow | null> {
  return db.prepare("SELECT * FROM wallet_transactions WHERE idempotency_key = ?").bind(key).first();
}

function existingResult(row: WalletTransactionRow, input: IdempotentWalletTransactionInput): IdempotentWalletTransactionResult {
  if (!transactionMatchesInput(row, input)) return { ok: false, error: "idempotency_key_conflict" };
  return { ok: true, transaction: row, created: false };
}

export async function checkWalletTransactionIdempotency(
  db: D1Like,
  input: IdempotentWalletTransactionInput,
): Promise<WalletTransactionIdempotencyCheck> {
  const existing = await findWalletTransactionByIdempotencyKey(db, input.idempotency_key);
  if (!existing) return { ok: true, transaction: null };
  if (!transactionMatchesInput(existing, input)) return { ok: false, error: "idempotency_key_conflict" };
  return { ok: true, transaction: existing };
}

export async function createWalletTransactionOnce(
  db: D1Like,
  input: IdempotentWalletTransactionInput,
): Promise<IdempotentWalletTransactionResult> {
  const existing = await checkWalletTransactionIdempotency(db, input);
  if (!existing.ok) return existing;
  if (existing.transaction) return { ok: true, transaction: existing.transaction, created: false };

  try {
    const transaction = await db
      .prepare(
        `INSERT INTO wallet_transactions (member_id, member_name, amount_cents, transaction_type, source, event_id, order_id, note, created_by, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .bind(
        input.member_id,
        input.member_name ?? null,
        input.amount_cents,
        input.transaction_type,
        input.source,
        input.event_id ?? null,
        input.order_id ?? null,
        input.note ?? null,
        input.created_by ?? null,
        input.idempotency_key,
      )
      .first();
    if (!transaction) throw new Error("wallet_transaction_insert_failed");
    return { ok: true, transaction, created: true };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const raced = await findWalletTransactionByIdempotencyKey(db, input.idempotency_key);
    if (!raced) throw e;
    return existingResult(raced, input);
  }
}
