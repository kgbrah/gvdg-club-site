import type { Env } from "./env.js";
import type { D1Like } from "./db.js";
import * as shopDb from "./shop-db.js";
import { requireAuth } from "./authz.js";
import { getMember } from "./roster.js";
import { paypalBase, createOrder as ppCreateOrder, captureOrder as ppCaptureOrder } from "./payments.js";
import { notifyNewOrder } from "./order-notify.js";
import { createWalletDebitOnce, findWalletTransactionByIdempotencyKey } from "./wallet-idempotency.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { clientIp, json, readJson } from "./http.js";
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

type SubmittedStoreOrder =
  | { ok: true; order: unknown; orderId: number }
  | { ok: false; status: number; body: Record<string, unknown> };

type SubmitStoreOrderInput = {
  readonly env: Env;
  readonly ctx?: ExecutionContext;
  readonly memberId: string;
  readonly memberName: string;
  readonly total: number;
  readonly lines: readonly StoreOrderLine[];
  readonly payment: { readonly method: string; readonly ref?: string | null };
  readonly notify?: boolean;
};

type CancelSubmittedStoreOrderInput = {
  readonly database: D1Like;
  readonly orderId: number;
  readonly lines: readonly StoreOrderLine[];
  readonly adminNote: string;
};

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

// Who may act on a PayPal session/order: a "guest" row is open (the PayPal payment verification is the
// real control), a member's row only by that logged-in member.
function buyerMatches(rowMemberId: string, auth: { sub: string } | null): boolean {
  if (rowMemberId === "guest") return true;
  return !!auth && auth.sub === rowMemberId;
}

// A checkout caller may see their order, but not admin-only fields. The guest path has no per-caller
// auth, so never echo notes/tracking a third party holding the orderId could read.
function safeOrder(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const o: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  delete o.admin_note;
  delete o.tracking_carrier;
  delete o.tracking_number;
  return o;
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
  if (merged.size > 50) return null; // bound the cart so a huge id list can't overflow the SQL IN(...) params
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

async function releaseStoreOrderStock(database: D1Like, lines: readonly StoreOrderLine[]): Promise<void> {
  for (const line of lines) await shopDb.incrementStoreProductStock(database, line.product_id, line.quantity);
}

async function cancelSubmittedStoreOrder(input: CancelSubmittedStoreOrderInput): Promise<void> {
  await releaseStoreOrderStock(input.database, input.lines);
  await shopDb.updateStoreOrderFulfillment(input.database, input.orderId, {
    status: "cancelled",
    admin_note: input.adminNote,
    // Detach the cancelled order from its PayPal order id: no payment was captured for it, so leaving the
    // ref set would make getStoreOrderByPaymentRef match this dead row on a retry and wedge the buyer in a
    // permanent 409 "capture_in_progress" for a PayPal order that could still be captured cleanly.
    payment_ref: null,
  });
}

async function submitStoreOrder(input: SubmitStoreOrderInput): Promise<SubmittedStoreOrder> {
  const { env, ctx, memberId, memberName, total, lines, payment } = input;
  const order = await shopDb.createStoreOrder(env.DB, { member_id: memberId, member_name: memberName, total_cents: total, payment_method: payment.method, payment_ref: payment.ref ?? null });
  const orderId = isRecord(order) ? rowNumber(order, "id") : 0;
  if (!orderId) return { ok: false, status: 500, body: { error: "order_failed" } };
  const reserved: StoreOrderLine[] = [];
  try {
    for (const line of lines) {
      const stockReserved = await shopDb.decrementStoreProductStock(env.DB, line.product_id, line.quantity);
      if (!stockReserved) {
        await releaseStoreOrderStock(env.DB, reserved);
        await shopDb.updateStoreOrderFulfillment(env.DB, orderId, {
          status: "cancelled",
          admin_note: "Cancelled automatically: insufficient stock for product #" + line.product_id,
          payment_ref: null, // nothing was captured — detach so a retry isn't blocked by this dead row
        });
        return { ok: false, status: 409, body: { error: "insufficient_stock", product_id: line.product_id } };
      }
      reserved.push(line);
      await shopDb.createStoreOrderItem(env.DB, {
        order_id: orderId,
        product_id: line.product_id,
        name_snapshot: line.name_snapshot,
        price_cents: line.price_cents,
        quantity: line.quantity,
      });
    }
  } catch (e) {
    await releaseStoreOrderStock(env.DB, reserved);
    await shopDb.updateStoreOrderFulfillment(env.DB, orderId, { status: "cancelled", admin_note: "Cancelled automatically: order submission failed.", payment_ref: null });
    return { ok: false, status: 500, body: { error: "order_failed" } };
  }
  // New-order email to the club if configured (the admin Orders tab always shows it). Fire-and-forget.
  if (input.notify ?? true) ctx?.waitUntil(notifyNewOrder(env, order, lines));
  return { ok: true, order, orderId };
}

export async function handleClubShop(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  ctx?: ExecutionContext,
): Promise<Response | null> {
  if (seg[0] !== "shop") return null;

  if (method === "GET" && seg[1] === "products") {
    return json({ products: await shopDb.listStoreProducts(env.DB, productListOptions(request)) }, 200, origin);
  }

  // PayPal.me checkout — open to ANYONE (members or guests). Records a pending order so the admin can
  // fulfill it, then the client redirects to paypal.me/greenvillediscgolf. Stock is NOT decremented:
  // payment lands in PayPal and is reconciled by the admin (mark paid / shipped from the Orders tab).
  if (method === "POST" && seg[1] === "paypal-order") {
    if (await kvRateLimited(env, "ppintent:" + clientIp(request), 10, 60)) return json({ error: "rate_limited" }, 429, origin);
    const body = (await readJson(request)) ?? {};
    const items = cartItems(body);
    if (!items) return json({ error: "invalid_order" }, 400, origin);
    const auth = await requireAuth(request, env); // optional — a logged-in member gets their identity
    let buyerId = "guest";
    let buyerName = asStr(body.name, 80) ?? "";
    if (auth) { const m = await getMember(env.ROSTER, auth.sub); if (m) { buyerId = m.memberId; buyerName = m.name; } }
    if (!buyerName) return json({ error: "name_required" }, 400, origin);
    const priced = await priceCart(env.DB, items);
    if (!priced.ok) return json(priced.body, priced.status, origin);
    const order = await shopDb.createStoreOrder(env.DB, { member_id: buyerId, member_name: buyerName, total_cents: priced.total, payment_method: "paypal_redirect", payment_ref: null });
    const orderId = isRecord(order) ? rowNumber(order, "id") : 0;
    if (!orderId) return json({ error: "order_failed" }, 500, origin);
    for (const line of priced.lines) {
      await shopDb.createStoreOrderItem(env.DB, { order_id: orderId, product_id: line.product_id, name_snapshot: line.name_snapshot, price_cents: line.price_cents, quantity: line.quantity });
    }
    const contact = asStr(body.contact, 120);
    if (contact) await shopDb.updateStoreOrderFulfillment(env.DB, orderId, { admin_note: "Contact: " + contact });
    // No email here: this path is unauthenticated and payment isn't confirmed (paypal.me reconcile-later),
    // so an email per call would be a spam/flood vector. The admin sees it in the in-app Orders tab; the
    // new-order email fires only for PAID orders (store credit / captured PayPal) via submitStoreOrder.
    return json({ orderId, amount_cents: priced.total }, 201, origin);
  }

  // PayPal Checkout with AUTOMATIC confirmation — active whenever PAYPAL_CLIENT_ID/SECRET are set, for
  // members AND guests. create-order prices the cart and opens a PayPal order; capture verifies the
  // payment server-side (status COMPLETED + amount >= total) before the order is recorded and stock
  // decremented. This supersedes the paypal.me redirect above once credentials are configured.
  if (method === "POST" && seg[1] === "pay" && seg[2] === "create-order") {
    if (!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET)) return json({ error: "payments_not_configured" }, 503, origin);
    if (await kvRateLimited(env, "ppcreate:" + clientIp(request), 15, 60)) return json({ error: "rate_limited" }, 429, origin);
    const body = (await readJson(request)) ?? {};
    const items = cartItems(body);
    if (!items) return json({ error: "invalid_order" }, 400, origin);
    const auth = await requireAuth(request, env);
    let buyerId = "guest";
    let buyerName = asStr(body.name, 80) ?? "";
    if (auth) { const m = await getMember(env.ROSTER, auth.sub); if (m) { buyerId = m.memberId; buyerName = m.name; } }
    if (!buyerName) return json({ error: "name_required" }, 400, origin);
    const priced = await priceCart(env.DB, items);
    if (!priced.ok) return json(priced.body, priced.status, origin);
    const creds = { clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET, base: paypalBase(env.PAYPAL_ENV, env.PAYPAL_API_BASE) };
    try {
      const orderId = await ppCreateOrder(creds, priced.total, "GVDG pro shop order");
      await shopDb.createStorePaymentSession(env.DB, { paypal_order_id: orderId, member_id: buyerId, member_name: buyerName, items_json: JSON.stringify(priced.lines), total_cents: priced.total });
      return json({ orderId }, 200, origin);
    } catch (e) {
      return json({ error: "paypal_error" }, 502, origin);
    }
  }

  if (method === "POST" && seg[1] === "pay" && seg[2] === "capture") {
    if (!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET)) return json({ error: "payments_not_configured" }, 503, origin);
    if (await kvRateLimited(env, "ppcapture:" + clientIp(request), 20, 60)) return json({ error: "rate_limited" }, 429, origin);
    const body = (await readJson(request)) ?? {};
    const orderId = rowText(body, "orderId");
    if (!orderId) return json({ error: "invalid_request" }, 400, origin);
    const auth = await requireAuth(request, env);
    const balanceFor = async () => (auth ? shopDb.walletBalance(env.DB, auth.sub) : 0);
    const existingOrder = await shopDb.getStoreOrderByPaymentRef(env.DB, orderId); // idempotent: already captured
    if (existingOrder) {
      if (!buyerMatches(rowText(existingOrder, "member_id"), auth)) return json({ error: "forbidden" }, 403, origin);
      const existingSession = await shopDb.getStorePaymentSession(env.DB, orderId);
      if (existingSession && rowText(existingSession, "status") !== "captured") return json({ error: "capture_in_progress" }, 409, origin);
      return json({ order: safeOrder(existingOrder), balance_cents: await balanceFor() }, 200, origin);
    }
    const session = await shopDb.getStorePaymentSession(env.DB, orderId);
    if (!session) return json({ error: "payment_session_not_found" }, 404, origin);
    if (!buyerMatches(rowText(session, "member_id"), auth)) return json({ error: "forbidden" }, 403, origin);
    const lines = parseStoredLines(session.items_json);
    const total = rowNumber(session, "total_cents");
    if (!lines || total <= 0) return json({ error: "invalid_payment_session" }, 400, origin);
    if (rowText(session, "status") === "captured") return json({ error: "capture_in_progress" }, 409, origin);
    const stock = await validateStoredStock(env.DB, lines);
    if (!stock.ok) return json(stock.body, stock.status, origin);
    const creds = { clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET, base: paypalBase(env.PAYPAL_ENV, env.PAYPAL_API_BASE) };
    let sessionLocked = false;
    let submitted: SubmittedStoreOrder | null = null;
    let paymentCaptured = false;
    try {
      const lockedSession = await shopDb.reserveStorePaymentSessionCapture(env.DB, orderId);
      if (!lockedSession) return json({ error: "capture_in_progress" }, 409, origin);
      sessionLocked = true;
      submitted = await submitStoreOrder({
        env,
        ctx,
        memberId: rowText(session, "member_id"),
        memberName: rowText(session, "member_name"),
        total,
        lines,
        payment: { method: "paypal", ref: orderId },
        notify: false,
      });
      if (!submitted.ok) {
        await shopDb.releaseStorePaymentSessionCapture(env.DB, orderId);
        return json(submitted.body, submitted.status, origin);
      }
      const cap = await ppCaptureOrder(creds, orderId);
      paymentCaptured = true;
      const settledOk = cap.status === "COMPLETED" && cap.captureStatus === "COMPLETED" && cap.currency === "USD" && cap.amountCents >= total;
      if (!settledOk) {
        // A COMPLETED order whose capture is PENDING is an eCheck/bank payment: the funds are on their way
        // and WILL settle — voiding the order locally would strand the buyer's money (paid, no order). So
        // keep the order, flag it for admin reconciliation, and mark the session captured (terminal +
        // idempotent) so replays return this pending order. Only a genuinely failed/declined capture (no
        // money moving) is cancelled and detached so the buyer can retry cleanly.
        const capturePending = cap.status === "COMPLETED" && cap.captureStatus === "PENDING" && cap.currency === "USD" && cap.amountCents >= total;
        if (capturePending) {
          await shopDb.updateStoreOrderFulfillment(env.DB, submitted.orderId, {
            admin_note: "PayPal capture PENDING (eCheck/bank) — verify the payment has SETTLED in PayPal before fulfilling.",
          });
          await shopDb.markStorePaymentSessionCaptured(env.DB, orderId);
          ctx?.waitUntil(notifyNewOrder(env, submitted.order, lines));
          return json({ order: safeOrder(submitted.order), pending: true, balance_cents: await balanceFor() }, 202, origin);
        }
        await cancelSubmittedStoreOrder({
          database: env.DB,
          orderId: submitted.orderId,
          lines,
          adminNote: "Cancelled automatically: PayPal capture was declined or not completed.",
        });
        await shopDb.markStorePaymentSessionCaptured(env.DB, orderId);
        return json({ error: "payment_incomplete" }, 402, origin);
      }
      await shopDb.markStorePaymentSessionCaptured(env.DB, orderId);
      ctx?.waitUntil(notifyNewOrder(env, submitted.order, lines));
      return json({ order: safeOrder(submitted.order), balance_cents: await balanceFor() }, 201, origin);
    } catch {
      if (sessionLocked && !paymentCaptured) {
        if (submitted?.ok) {
          await cancelSubmittedStoreOrder({
            database: env.DB,
            orderId: submitted.orderId,
            lines,
            adminNote: "Cancelled automatically: PayPal capture failed.",
          });
        }
        await shopDb.releaseStorePaymentSessionCapture(env.DB, orderId);
      }
      return json({ error: "paypal_error" }, 502, origin);
    }
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

  if (method === "POST" && seg[1] === "orders") {
    const body = (await readJson(request)) ?? {};
    const items = cartItems(body);
    if (!items) return json({ error: "invalid_order" }, 400, origin);
    // A client-supplied idempotency key makes the WHOLE checkout idempotent: a retried or double-submitted
    // request with the same key never creates a second order or debits twice. Optional (older clients omit
    // it and fall back to per-order keying, which still can't overdraw but doesn't dedup duplicates).
    const idemKey = asStr(body.idempotency_key, 160);
    if (idemKey) {
      const prior = await findWalletTransactionByIdempotencyKey(env.DB, "store_order:" + claims.sub + ":" + idemKey);
      if (prior) {
        const priorOrderId = asInt((prior as Record<string, unknown>).order_id) ?? 0;
        const priorOrder = priorOrderId ? await shopDb.getStoreOrderById(env.DB, priorOrderId) : null;
        return json({ order: priorOrder, transaction: prior, balance_cents: await shopDb.walletBalance(env.DB, claims.sub) }, 200, origin);
      }
    }
    const priced = await priceCart(env.DB, items);
    if (!priced.ok) return json(priced.body, priced.status, origin);
    // Early, friendly balance check so the common "too short" case returns 402 without creating and then
    // cancelling an order. It is NOT the safety guarantee — that is the atomic debit below.
    const balance = await shopDb.walletBalance(env.DB, claims.sub);
    if (balance < priced.total) return json({ error: "insufficient_store_credit", balance_cents: balance, total_cents: priced.total }, 402, origin);
    // Reserve stock / create the order first, but defer the club new-order email until the debit succeeds
    // (mirrors the PayPal path) so a rolled-back order never emails a phantom sale.
    const submitted = await submitStoreOrder({
      env,
      ctx,
      memberId: claims.sub,
      memberName: member.name,
      total: priced.total,
      lines: priced.lines,
      payment: { method: "store_credit" },
      notify: false,
    });
    if (!submitted.ok) return json(submitted.body, submitted.status, origin);
    // Debit keyed to the CLIENT key when present (dedups a double-submit across requests via the unique
    // idempotency_key index), else to this order (still atomic — prevents overdraw — but no cross-request
    // dedup). Atomically balance-checked. On failure, roll the order back so the member is never charged for
    // an unfulfilled order nor handed stock they didn't pay for.
    const debitKey = idemKey ? "store_order:" + claims.sub + ":" + idemKey : "store_order:" + submitted.orderId;
    let debit;
    try {
      debit = await createWalletDebitOnce(env.DB, {
        member_id: claims.sub,
        member_name: member.name,
        amount_cents: -priced.total,
        transaction_type: "debit",
        source: "store_purchase",
        order_id: submitted.orderId,
        note: "Pro shop order #" + submitted.orderId,
        idempotency_key: debitKey,
      }, { matchOrderId: false }); // key identifies the purchase; racing attempts have different order_ids
    } catch (e) {
      await cancelSubmittedStoreOrder({ database: env.DB, orderId: submitted.orderId, lines: priced.lines, adminNote: "Cancelled automatically: store-credit debit failed." });
      return json({ error: "order_failed" }, 500, origin);
    }
    if (!debit.ok) {
      await cancelSubmittedStoreOrder({ database: env.DB, orderId: submitted.orderId, lines: priced.lines, adminNote: "Cancelled automatically: store credit no longer covered this order at debit time." });
      const balanceNow = await shopDb.walletBalance(env.DB, claims.sub);
      if (debit.error === "insufficient_balance") return json({ error: "insufficient_store_credit", balance_cents: balanceNow, total_cents: priced.total }, 402, origin);
      return json({ error: "order_conflict" }, 409, origin);
    }
    // The debit deduped to an EARLIER order (a concurrent double-submit with the same key won the race): roll
    // back the duplicate order we just created and return the original settled order — one charge, one order.
    if (!debit.created) {
      await cancelSubmittedStoreOrder({ database: env.DB, orderId: submitted.orderId, lines: priced.lines, adminNote: "Cancelled automatically: duplicate of an already-settled checkout." });
      const originalId = asInt((debit.transaction as Record<string, unknown>).order_id) ?? 0;
      const original = originalId && originalId !== submitted.orderId ? await shopDb.getStoreOrderById(env.DB, originalId) : submitted.order;
      return json({ order: original, transaction: debit.transaction, balance_cents: await shopDb.walletBalance(env.DB, claims.sub) }, 200, origin);
    }
    ctx?.waitUntil(notifyNewOrder(env, submitted.order, priced.lines));
    return json({ order: submitted.order, transaction: debit.transaction, balance_cents: await shopDb.walletBalance(env.DB, claims.sub) }, 201, origin);
  }

  return json({ error: "not_found" }, 404, origin);
}
