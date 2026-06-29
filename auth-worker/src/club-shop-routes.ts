import type { Env } from "./env.js";
import type { D1Like } from "./db.js";
import * as shopDb from "./shop-db.js";
import { requireAuth } from "./authz.js";
import { getMember } from "./roster.js";
import { paypalBase, createOrder as ppCreateOrder, captureOrder as ppCaptureOrder } from "./payments.js";
import { json, readJson } from "./http.js";
import { asInt, asStr } from "./input.js";

type CartItem = {
  productId: number;
  quantity: number;
};

type StoreOrderLine = {
  product_id: number;
  name_snapshot: string;
  price_cents: number;
  quantity: number;
};

type PricedCart =
  | { ok: true; total: number; lines: StoreOrderLine[] }
  | { ok: false; status: number; body: Record<string, unknown> };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value || 0);
}

function rowText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function cartItems(body: Record<string, unknown> | null): CartItem[] | null {
  if (!Array.isArray(body?.items)) return null;
  const merged = new Map<number, number>();
  for (const raw of body.items) {
    if (!isRecord(raw)) return null;
    const productId = asInt(raw.product_id);
    const quantity = asInt(raw.quantity);
    if (productId == null || quantity == null || quantity < 1 || quantity > 20) return null;
    merged.set(productId, (merged.get(productId) ?? 0) + quantity);
  }
  const items = Array.from(merged.entries()).map(([productId, quantity]) => ({ productId, quantity }));
  return items.length ? items : null;
}

function productListOptions(request: Request): shopDb.StoreProductListOptions {
  const p = new URL(request.url).searchParams;
  const weight = asInt(p.get("weight"));
  return {
    q: asStr(p.get("q"), 80) ?? undefined,
    brand: asStr(p.get("brand"), 80) ?? undefined,
    color: asStr(p.get("color"), 60) ?? undefined,
    product_type: asStr(p.get("type"), 60) ?? undefined,
    weight_g: weight ?? undefined,
    sort: p.get("sort") ?? undefined,
  };
}

async function priceCart(database: D1Like, items: CartItem[]): Promise<PricedCart> {
  const products = await shopDb.getStoreProductsByIds(database, items.map((item) => item.productId));
  const byId = new Map(products.map((product) => [rowNumber(product, "id"), product]));
  let total = 0;
  const lines: StoreOrderLine[] = [];
  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product || rowNumber(product, "active") !== 1) return { ok: false, status: 409, body: { error: "product_unavailable", product_id: item.productId } };
    const stock = rowNumber(product, "stock_qty");
    if (stock < item.quantity) return { ok: false, status: 409, body: { error: "insufficient_stock", product_id: item.productId } };
    const price = rowNumber(product, "price_cents");
    total += price * item.quantity;
    lines.push({ product_id: item.productId, name_snapshot: rowText(product, "name"), price_cents: price, quantity: item.quantity });
  }
  if (total <= 0) return { ok: false, status: 400, body: { error: "invalid_order" } };
  return { ok: true, total, lines };
}

function parseStoredLines(value: unknown): StoreOrderLine[] | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  const lines: StoreOrderLine[] = [];
  for (const raw of parsed) {
    if (!isRecord(raw)) return null;
    const productId = asInt(raw.product_id);
    const quantity = asInt(raw.quantity);
    const price = asInt(raw.price_cents);
    const name = rowText(raw, "name_snapshot");
    if (productId == null || quantity == null || price == null || quantity < 1 || !name) return null;
    lines.push({ product_id: productId, name_snapshot: name, price_cents: price, quantity });
  }
  return lines;
}

async function validateStoredStock(database: D1Like, lines: StoreOrderLine[]): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  const products = await shopDb.getStoreProductsByIds(database, lines.map((line) => line.product_id));
  const byId = new Map(products.map((product) => [rowNumber(product, "id"), product]));
  for (const line of lines) {
    const product = byId.get(line.product_id);
    if (!product || rowNumber(product, "active") !== 1) return { ok: false, status: 409, body: { error: "product_unavailable", product_id: line.product_id } };
    if (rowNumber(product, "stock_qty") < line.quantity) return { ok: false, status: 409, body: { error: "insufficient_stock", product_id: line.product_id } };
  }
  return { ok: true };
}

async function submitStoreOrder(
  database: D1Like,
  memberId: string,
  memberName: string,
  total: number,
  lines: StoreOrderLine[],
  payment: { method: string; ref?: string | null },
) {
  const order = await shopDb.createStoreOrder(database, { member_id: memberId, member_name: memberName, total_cents: total, payment_method: payment.method, payment_ref: payment.ref ?? null });
  const orderId = isRecord(order) ? rowNumber(order, "id") : 0;
  if (!orderId) return null;
  for (const line of lines) {
    await shopDb.createStoreOrderItem(database, {
      order_id: orderId,
      product_id: line.product_id,
      name_snapshot: line.name_snapshot,
      price_cents: line.price_cents,
      quantity: line.quantity,
    });
    await shopDb.decrementStoreProductStock(database, line.product_id, line.quantity);
  }
  return { order, orderId };
}

export async function handleClubShop(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
): Promise<Response | null> {
  if (seg[0] !== "shop") return null;

  if (method === "GET" && seg[1] === "products") {
    return json({ products: await shopDb.listStoreProducts(env.DB, productListOptions(request)) }, 200, origin);
  }

  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const member = await getMember(env.ROSTER, claims.sub);
  if (!member) return json({ error: "unauthorized" }, 401, origin);

  if (method === "GET" && seg[1] === "wallet") {
    const [balance, transactions, orders] = await Promise.all([
      shopDb.walletBalance(env.DB, claims.sub),
      shopDb.listWalletTransactions(env.DB, claims.sub),
      shopDb.listStoreOrders(env.DB, claims.sub),
    ]);
    return json({ balance_cents: balance, transactions, orders }, 200, origin);
  }

  if (method === "POST" && seg[1] === "pay" && seg[2] === "create-order") {
    if (!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET)) return json({ error: "payments_not_configured" }, 503, origin);
    const items = cartItems(await readJson(request));
    if (!items) return json({ error: "invalid_order" }, 400, origin);
    const priced = await priceCart(env.DB, items);
    if (!priced.ok) return json(priced.body, priced.status, origin);
    const creds = { clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET, base: paypalBase(env.PAYPAL_ENV, env.PAYPAL_API_BASE) };
    try {
      const orderId = await ppCreateOrder(creds, priced.total, "GVDG pro shop order");
      await shopDb.createStorePaymentSession(env.DB, {
        paypal_order_id: orderId,
        member_id: claims.sub,
        member_name: member.name,
        items_json: JSON.stringify(priced.lines),
        total_cents: priced.total,
      });
      return json({ orderId }, 200, origin);
    } catch (e) {
      return json({ error: "paypal_error" }, 502, origin);
    }
  }

  if (method === "POST" && seg[1] === "pay" && seg[2] === "capture") {
    if (!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET)) return json({ error: "payments_not_configured" }, 503, origin);
    const body = (await readJson(request)) ?? {};
    const orderId = rowText(body, "orderId");
    if (!orderId) return json({ error: "invalid_request" }, 400, origin);
    const existingOrder = await shopDb.getStoreOrderByPaymentRef(env.DB, orderId);
    if (existingOrder) {
      if (rowText(existingOrder, "member_id") !== claims.sub) return json({ error: "forbidden" }, 403, origin);
      return json({ order: existingOrder, balance_cents: await shopDb.walletBalance(env.DB, claims.sub) }, 200, origin);
    }
    const session = await shopDb.getStorePaymentSession(env.DB, orderId);
    if (!session) return json({ error: "payment_session_not_found" }, 404, origin);
    if (rowText(session, "member_id") !== claims.sub) return json({ error: "forbidden" }, 403, origin);
    const lines = parseStoredLines(session.items_json);
    const total = rowNumber(session, "total_cents");
    if (!lines || total <= 0) return json({ error: "invalid_payment_session" }, 400, origin);
    if (rowText(session, "status") === "captured") return json({ error: "capture_in_progress" }, 409, origin);
    const stock = await validateStoredStock(env.DB, lines);
    if (!stock.ok) return json(stock.body, stock.status, origin);
    const creds = { clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET, base: paypalBase(env.PAYPAL_ENV, env.PAYPAL_API_BASE) };
    try {
      const cap = await ppCaptureOrder(creds, orderId);
      if (cap.status !== "COMPLETED" || cap.amountCents < total) return json({ error: "payment_incomplete" }, 402, origin);
      const afterCaptureOrder = await shopDb.getStoreOrderByPaymentRef(env.DB, orderId);
      if (afterCaptureOrder) {
        if (rowText(afterCaptureOrder, "member_id") !== claims.sub) return json({ error: "forbidden" }, 403, origin);
        return json({ order: afterCaptureOrder, balance_cents: await shopDb.walletBalance(env.DB, claims.sub) }, 200, origin);
      }
      const submitted = await submitStoreOrder(env.DB, claims.sub, member.name, total, lines, { method: "paypal", ref: orderId });
      if (!submitted) return json({ error: "order_failed" }, 500, origin);
      await shopDb.markStorePaymentSessionCaptured(env.DB, orderId);
      return json({ order: submitted.order, balance_cents: await shopDb.walletBalance(env.DB, claims.sub) }, 201, origin);
    } catch (e) {
      return json({ error: "paypal_error" }, 502, origin);
    }
  }

  if (method === "POST" && seg[1] === "orders") {
    const items = cartItems(await readJson(request));
    if (!items) return json({ error: "invalid_order" }, 400, origin);
    const priced = await priceCart(env.DB, items);
    if (!priced.ok) return json(priced.body, priced.status, origin);
    const balance = await shopDb.walletBalance(env.DB, claims.sub);
    if (balance < priced.total) return json({ error: "insufficient_store_credit", balance_cents: balance, total_cents: priced.total }, 402, origin);
    const submitted = await submitStoreOrder(env.DB, claims.sub, member.name, priced.total, priced.lines, { method: "store_credit" });
    if (!submitted) return json({ error: "order_failed" }, 500, origin);
    const transaction = await shopDb.createWalletTransaction(env.DB, {
      member_id: claims.sub,
      member_name: member.name,
      amount_cents: -priced.total,
      transaction_type: "debit",
      source: "store_purchase",
      order_id: submitted.orderId,
      note: "Pro shop order #" + submitted.orderId,
    });
    return json({ order: submitted.order, transaction, balance_cents: await shopDb.walletBalance(env.DB, claims.sub) }, 201, origin);
  }

  return json({ error: "not_found" }, 404, origin);
}
