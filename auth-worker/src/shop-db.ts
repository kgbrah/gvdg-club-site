import type { D1Like } from "./db.js";

export type StoreProductInput = {
  readonly category: string;
  readonly name: string;
  readonly brand?: string | null;
  readonly product_type?: string | null;
  readonly color?: string | null;
  readonly weight_g?: number | null;
  readonly price_cents: number;
  readonly stock_qty?: number | null;
  readonly image_url?: string | null;
  readonly description?: string | null;
  readonly active?: number | null;
  readonly created_by?: string | null;
};

export type StoreProductPatch = {
  category?: string | null;
  name?: string | null;
  brand?: string | null;
  product_type?: string | null;
  color?: string | null;
  weight_g?: number | null;
  price_cents?: number | null;
  stock_qty?: number | null;
  image_url?: string | null;
  description?: string | null;
  active?: number | null;
};

export type StoreProductListOptions = {
  readonly q?: string;
  readonly brand?: string;
  readonly color?: string;
  readonly weight_g?: number;
  readonly product_type?: string;
  readonly sort?: string;
  readonly includeInactive?: boolean;
};

export type WalletTransactionInput = {
  readonly member_id: string;
  readonly member_name?: string | null;
  readonly amount_cents: number;
  readonly transaction_type: string;
  readonly source: string;
  readonly event_id?: number | null;
  readonly order_id?: number | null;
  readonly note?: string | null;
  readonly created_by?: string | null;
};

type StoreOrderInput = {
  readonly member_id: string;
  readonly member_name?: string | null;
  readonly total_cents: number;
  readonly payment_method?: string;
  readonly payment_ref?: string | null;
};

type StoreOrderItemInput = {
  readonly order_id: number;
  readonly product_id: number;
  readonly name_snapshot: string;
  readonly price_cents: number;
  readonly quantity: number;
};

type StorePaymentSessionInput = {
  readonly paypal_order_id: string;
  readonly member_id: string;
  readonly member_name?: string | null;
  readonly items_json: string;
  readonly total_cents: number;
};

function storeProductOrderBy(sort: string | undefined): string {
  switch (sort) {
    case "brand": return "brand COLLATE NOCASE, name COLLATE NOCASE";
    case "color": return "color COLLATE NOCASE, brand COLLATE NOCASE, name COLLATE NOCASE";
    case "weight": return "weight_g IS NULL, weight_g, brand COLLATE NOCASE, name COLLATE NOCASE";
    case "type": return "product_type COLLATE NOCASE, brand COLLATE NOCASE, name COLLATE NOCASE";
    case "price_asc": return "price_cents ASC, name COLLATE NOCASE";
    case "price_desc": return "price_cents DESC, name COLLATE NOCASE";
    default: return "id DESC";
  }
}

function rowNumber(row: Record<string, unknown> | null, key: string): number {
  const value = row?.[key];
  return typeof value === "number" ? value : Number(value || 0);
}

export async function listStoreProducts(db: D1Like, opts: StoreProductListOptions = {}) {
  let sql = "SELECT * FROM store_products";
  const where: string[] = [];
  const binds: unknown[] = [];
  if (!opts.includeInactive) where.push("active = 1");
  if (opts.q) {
    const q = "%" + opts.q.toLowerCase() + "%";
    where.push("(LOWER(name) LIKE ? OR LOWER(brand) LIKE ? OR LOWER(product_type) LIKE ? OR LOWER(color) LIKE ?)");
    binds.push(q, q, q, q);
  }
  if (opts.brand) { where.push("LOWER(brand) = ?"); binds.push(opts.brand.toLowerCase()); }
  if (opts.color) { where.push("LOWER(color) = ?"); binds.push(opts.color.toLowerCase()); }
  if (opts.weight_g != null) { where.push("weight_g = ?"); binds.push(opts.weight_g); }
  if (opts.product_type) { where.push("LOWER(product_type) = ?"); binds.push(opts.product_type.toLowerCase()); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY " + storeProductOrderBy(opts.sort);
  return (await db.prepare(sql).bind(...binds).all()).results;
}

export async function getStoreProductsByIds(db: D1Like, ids: number[]) {
  const unique = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(",");
  return (await db.prepare(`SELECT * FROM store_products WHERE id IN (${placeholders})`).bind(...unique).all()).results;
}

export async function createStoreProduct(db: D1Like, p: StoreProductInput) {
  return db
    .prepare(
      `INSERT INTO store_products (category, name, brand, product_type, color, weight_g, price_cents, stock_qty, image_url, description, active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      p.category, p.name, p.brand ?? null, p.product_type ?? null, p.color ?? null, p.weight_g ?? null,
      p.price_cents, p.stock_qty ?? 0, p.image_url ?? null, p.description ?? null, p.active ?? 1, p.created_by ?? null,
    )
    .first();
}

export async function updateStoreProduct(db: D1Like, id: number, p: StoreProductPatch) {
  return db
    .prepare(
      `UPDATE store_products SET category=COALESCE(?,category), name=COALESCE(?,name), brand=COALESCE(?,brand),
        product_type=COALESCE(?,product_type), color=COALESCE(?,color), weight_g=COALESCE(?,weight_g),
        price_cents=COALESCE(?,price_cents), stock_qty=COALESCE(?,stock_qty), image_url=COALESCE(?,image_url),
        description=COALESCE(?,description), active=COALESCE(?,active), updated_at=datetime('now') WHERE id=? RETURNING *`,
    )
    .bind(
      p.category ?? null, p.name ?? null, p.brand ?? null, p.product_type ?? null, p.color ?? null,
      p.weight_g ?? null, p.price_cents ?? null, p.stock_qty ?? null, p.image_url ?? null,
      p.description ?? null, p.active ?? null, id,
    )
    .first();
}

export async function deactivateStoreProduct(db: D1Like, id: number) {
  return db.prepare("UPDATE store_products SET active = 0, updated_at = datetime('now') WHERE id = ? RETURNING *").bind(id).first();
}

export async function walletBalance(db: D1Like, memberId: string): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS balance_cents FROM wallet_transactions WHERE member_id = ?").bind(memberId).first();
  return rowNumber(row, "balance_cents");
}

export async function createWalletTransaction(db: D1Like, t: WalletTransactionInput) {
  return db
    .prepare(
      `INSERT INTO wallet_transactions (member_id, member_name, amount_cents, transaction_type, source, event_id, order_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      t.member_id, t.member_name ?? null, t.amount_cents, t.transaction_type, t.source,
      t.event_id ?? null, t.order_id ?? null, t.note ?? null, t.created_by ?? null,
    )
    .first();
}

export async function listWalletTransactions(db: D1Like, memberId: string, limit = 50) {
  return (
    await db
      .prepare("SELECT * FROM wallet_transactions WHERE member_id = ? ORDER BY id DESC LIMIT ?")
      .bind(memberId, limit)
      .all()
  ).results;
}

export async function listRecentWalletTransactions(db: D1Like, limit = 100) {
  return (await db.prepare("SELECT * FROM wallet_transactions ORDER BY id DESC LIMIT ?").bind(limit).all()).results;
}

export async function listEventStoreCreditPayouts(db: D1Like, eventId: number) {
  return (
    await db
      .prepare("SELECT * FROM wallet_transactions WHERE event_id = ? AND source = 'event_payout' ORDER BY id DESC")
      .bind(eventId)
      .all()
  ).results;
}

export async function createStoreOrder(db: D1Like, o: StoreOrderInput) {
  return db
    .prepare("INSERT INTO store_orders (member_id, member_name, total_cents, payment_method, payment_ref, status) VALUES (?, ?, ?, ?, ?, 'submitted') RETURNING *")
    .bind(o.member_id, o.member_name ?? null, o.total_cents, o.payment_method ?? "store_credit", o.payment_ref ?? null)
    .first();
}

export async function getStoreOrderByPaymentRef(db: D1Like, paymentRef: string) {
  return db.prepare("SELECT * FROM store_orders WHERE payment_ref = ?").bind(paymentRef).first();
}

export async function getStoreOrderById(db: D1Like, id: number) {
  return db.prepare("SELECT * FROM store_orders WHERE id = ?").bind(id).first();
}

export async function createStoreOrderItem(db: D1Like, item: StoreOrderItemInput) {
  return db
    .prepare("INSERT INTO store_order_items (order_id, product_id, name_snapshot, price_cents, quantity) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .bind(item.order_id, item.product_id, item.name_snapshot, item.price_cents, item.quantity)
    .first();
}

export async function decrementStoreProductStock(db: D1Like, id: number, quantity: number) {
  const res = await db
    .prepare("UPDATE store_products SET stock_qty = stock_qty - ?, updated_at = datetime('now') WHERE id = ? AND active = 1 AND stock_qty >= ?")
    .bind(quantity, id, quantity)
    .run();
  // Fail SAFE for a conditional stock decrement: only report success when the driver positively confirms
  // a row changed. Never fall back to res.success (which is true even for a zero-row UPDATE) — that would
  // let the caller believe stock was reserved when it wasn't, overselling the product.
  const changed = res.meta?.changes ?? res.meta?.rows_written;
  return changed != null && changed > 0;
}

export async function incrementStoreProductStock(db: D1Like, id: number, quantity: number) {
  await db.prepare("UPDATE store_products SET stock_qty = stock_qty + ?, updated_at = datetime('now') WHERE id = ?").bind(quantity, id).run();
}

/** Attach each order's line items in one IN-query, grouped in memory. Safe for an empty list. */
async function attachOrderItems(db: D1Like, orders: Record<string, unknown>[]) {
  if (!orders.length) return orders;
  const ids = orders.map((o) => o.id as number);
  const res = await db.prepare(`SELECT * FROM store_order_items WHERE order_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).bind(...ids).all();
  const items = (res?.results ?? []) as Record<string, unknown>[];
  const byOrder = new Map<number, Record<string, unknown>[]>();
  for (const it of items) {
    const oid = it.order_id as number;
    (byOrder.get(oid) ?? byOrder.set(oid, []).get(oid)!).push(it);
  }
  return orders.map((o) => ({ ...o, items: byOrder.get(o.id as number) ?? [] }));
}

export async function listStoreOrders(db: D1Like, memberId: string) {
  const orders = (await db.prepare("SELECT * FROM store_orders WHERE member_id = ? ORDER BY id DESC").bind(memberId).all()).results as Record<string, unknown>[];
  return attachOrderItems(db, orders);
}

// ---- admin order fulfillment ----
export const ORDER_STATUSES = ["submitted", "processing", "ready", "shipped", "completed", "cancelled"] as const;
const UNFULFILLED_STATUSES = ["submitted", "processing"]; // new/in-progress orders needing admin action

export interface OrderFulfillmentPatch {
  status?: string;
  tracking_carrier?: string | null;
  tracking_number?: string | null;
  admin_note?: string | null;
  payment_ref?: string | null;
}

/** Admin view: all orders (optionally filtered by status), newest first, each with its line items. */
export async function listAllStoreOrders(db: D1Like, opts: { status?: string; limit?: number } = {}) {
  const limit = opts.limit ?? 200;
  const sql = "SELECT * FROM store_orders" + (opts.status ? " WHERE status = ?" : "") + " ORDER BY id DESC LIMIT ?";
  const orders = (await db.prepare(sql).bind(...(opts.status ? [opts.status, limit] : [limit])).all()).results as Record<string, unknown>[];
  return attachOrderItems(db, orders);
}

/** Count of orders still awaiting admin action — drives the in-app "new orders" badge. */
export async function countUnfulfilledStoreOrders(db: D1Like): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*) AS n FROM store_orders WHERE status IN (${UNFULFILLED_STATUSES.map(() => "?").join(",")})`)
    .bind(...UNFULFILLED_STATUSES)
    .first();
  return row && typeof (row as { n?: unknown }).n === "number" ? (row as { n: number }).n : 0;
}

/** Update an order's status and/or shipment tracking. `undefined` fields are left unchanged. */
export async function updateStoreOrderFulfillment(db: D1Like, id: number, patch: OrderFulfillmentPatch) {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?", "status_updated_at = datetime('now')");
    binds.push(patch.status);
  }
  if (patch.tracking_carrier !== undefined) { sets.push("tracking_carrier = ?"); binds.push(patch.tracking_carrier); }
  if (patch.tracking_number !== undefined) { sets.push("tracking_number = ?"); binds.push(patch.tracking_number); }
  if (patch.admin_note !== undefined) { sets.push("admin_note = ?"); binds.push(patch.admin_note); }
  if (patch.payment_ref !== undefined) { sets.push("payment_ref = ?"); binds.push(patch.payment_ref); }
  if (!sets.length) return db.prepare("SELECT * FROM store_orders WHERE id = ?").bind(id).first();
  binds.push(id);
  return db.prepare(`UPDATE store_orders SET ${sets.join(", ")} WHERE id = ? RETURNING *`).bind(...binds).first();
}

export async function createStorePaymentSession(db: D1Like, session: StorePaymentSessionInput) {
  return db
    .prepare("INSERT INTO store_payment_sessions (paypal_order_id, member_id, member_name, items_json, total_cents, status) VALUES (?, ?, ?, ?, ?, 'pending') RETURNING *")
    .bind(session.paypal_order_id, session.member_id, session.member_name ?? null, session.items_json, session.total_cents)
    .first();
}

export async function getStorePaymentSession(db: D1Like, paypalOrderId: string) {
  return db.prepare("SELECT * FROM store_payment_sessions WHERE paypal_order_id = ?").bind(paypalOrderId).first();
}

export async function reserveStorePaymentSessionCapture(db: D1Like, paypalOrderId: string) {
  return db
    .prepare("UPDATE store_payment_sessions SET status = 'capturing' WHERE paypal_order_id = ? AND status = 'pending' RETURNING *")
    .bind(paypalOrderId)
    .first();
}

export async function releaseStorePaymentSessionCapture(db: D1Like, paypalOrderId: string) {
  return db
    .prepare("UPDATE store_payment_sessions SET status = 'pending' WHERE paypal_order_id = ? AND status = 'capturing' RETURNING *")
    .bind(paypalOrderId)
    .first();
}

export async function markStorePaymentSessionCaptured(db: D1Like, paypalOrderId: string) {
  return db
    .prepare("UPDATE store_payment_sessions SET status = 'captured', captured_at = datetime('now') WHERE paypal_order_id = ? AND status IN ('pending', 'capturing') RETURNING *")
    .bind(paypalOrderId)
    .first();
}
