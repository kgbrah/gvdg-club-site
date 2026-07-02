import { afterEach, describe, expect, it, vi } from "vitest";
import { call, makeDb, stubPayPal, token, type Row } from "./pro-shop-fixture.js";

afterEach(() => vi.unstubAllGlobals());

describe("pro shop and player wallets", () => {
  it("lists active shop products publicly", async () => {
    const res = await call("/shop/products?brand=innova&sort=weight");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: Row[] };
    expect(body.products[0]?.name).toBe("Roc");
  });

  it("allows only admins to create products", async () => {
    const dbState = makeDb();
    const body = { category: "disc", name: "Zone", brand: "Discraft", product_type: "Putter", color: "Blue", weight_g: 174, price_cents: 1900, stock_qty: 4, image_url: "https://example.com/zone.jpg" };
    expect((await call("/admin/shop/products", "POST", await token("m_jane"), body, dbState)).status).toBe(403);
    const res = await call("/admin/shop/products", "POST", await token("m_admin"), body, dbState);
    expect(res.status).toBe(201);
    expect(dbState.state.products.some((p) => p.name === "Zone")).toBe(true);
  });

  it("rejects products with negative price or stock", async () => {
    const dbState = makeDb();
    const auth = await token("m_admin");
    expect((await call("/admin/shop/products", "POST", auth, { name: "Bad Price", price_cents: -100, stock_qty: 1 }, dbState)).status).toBe(400);
    expect((await call("/admin/shop/products", "POST", auth, { name: "Bad Stock", price_cents: 100, stock_qty: -1 }, dbState)).status).toBe(400);
    expect((await call("/admin/shop/products", "POST", auth, { name: "Bad Image", price_cents: 100, image_url: "http://example.com/disc.jpg" }, dbState)).status).toBe(400);
  });

  it("credits store payout prizes from an admin event", async () => {
    const dbState = makeDb({ balanceCents: 200 });
    const res = await call("/admin/events/7/store-credit", "POST", await token("m_admin"), { member_id: "m_jane", amount_cents: 1500, note: "League payout", idempotency_key: "event:7:m_jane:abc" }, dbState);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { balance_cents: number; payouts: Row[] };
    expect(body.balance_cents).toBe(1700);
    expect(body.payouts[0]?.source).toBe("event_payout");
  });

  it("deduplicates event store credit awards with the same idempotency key", async () => {
    const dbState = makeDb({ balanceCents: 200 });
    const body = { member_id: "m_jane", amount_cents: 1500, note: "League payout", idempotency_key: "event:7:m_jane:retry" };

    const first = await call("/admin/events/7/store-credit", "POST", await token("m_admin"), body, dbState);
    const second = await call("/admin/events/7/store-credit", "POST", await token("m_admin"), body, dbState);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(dbState.state.transactions).toHaveLength(1);
    expect(dbState.state.balanceCents).toBe(1700);
  });

  it("requires an idempotency key for event store credit awards", async () => {
    const dbState = makeDb({ balanceCents: 200 });
    const res = await call("/admin/events/7/store-credit", "POST", await token("m_admin"), { member_id: "m_jane", amount_cents: 1500 }, dbState);

    expect(res.status).toBe(400);
    expect(dbState.state.transactions).toHaveLength(0);
    expect(dbState.state.balanceCents).toBe(200);
  });

  it("rejects idempotency key reuse for a different event store credit award", async () => {
    const dbState = makeDb({ balanceCents: 200 });
    const key = "event:7:m_jane:conflict";
    const first = await call("/admin/events/7/store-credit", "POST", await token("m_admin"), { member_id: "m_jane", amount_cents: 1500, idempotency_key: key }, dbState);
    const second = await call("/admin/events/7/store-credit", "POST", await token("m_admin"), { member_id: "m_jane", amount_cents: 1600, idempotency_key: key }, dbState);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(dbState.state.transactions).toHaveLength(1);
    expect(dbState.state.balanceCents).toBe(1700);
  });

  it("deduplicates manual wallet adjustments with the same idempotency key", async () => {
    const dbState = makeDb({ balanceCents: 200 });
    const body = { member_id: "m_jane", amount_cents: 500, note: "Volunteer credit", idempotency_key: "wallet:m_jane:retry" };

    const first = await call("/admin/wallets/credit", "POST", await token("m_admin"), body, dbState);
    const second = await call("/admin/wallets/credit", "POST", await token("m_admin"), body, dbState);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(dbState.state.transactions).toHaveLength(1);
    expect(dbState.state.transactions[0]?.source).toBe("manual_adjustment");
    expect(dbState.state.balanceCents).toBe(700);
  });

  it("requires an idempotency key for manual wallet adjustments", async () => {
    const dbState = makeDb({ balanceCents: 200 });
    const res = await call("/admin/wallets/credit", "POST", await token("m_admin"), { member_id: "m_jane", amount_cents: 500 }, dbState);

    expect(res.status).toBe(400);
    expect(dbState.state.transactions).toHaveLength(0);
    expect(dbState.state.balanceCents).toBe(200);
  });

  it("rejects manual wallet adjustments from non-admin members", async () => {
    const dbState = makeDb({ balanceCents: 200 });
    const res = await call("/admin/wallets/credit", "POST", await token("m_jane"), { member_id: "m_jane", amount_cents: 500, idempotency_key: "wallet:m_jane:forbidden" }, dbState);

    expect(res.status).toBe(403);
    expect(dbState.state.transactions).toHaveLength(0);
    expect(dbState.state.balanceCents).toBe(200);
  });

  it("rejects idempotency key reuse for a different manual wallet adjustment", async () => {
    const dbState = makeDb({ balanceCents: 200 });
    const key = "wallet:m_jane:conflict";
    const first = await call("/admin/wallets/credit", "POST", await token("m_admin"), { member_id: "m_jane", amount_cents: 500, idempotency_key: key }, dbState);
    const second = await call("/admin/wallets/credit", "POST", await token("m_admin"), { member_id: "m_jane", amount_cents: 600, idempotency_key: key }, dbState);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(dbState.state.transactions).toHaveLength(1);
    expect(dbState.state.balanceCents).toBe(700);
  });

  it("requires confirmation before changing an order status", async () => {
    const dbState = makeDb();
    dbState.state.orders.push({ id: 10, member_id: "m_jane", member_name: "Jane", total_cents: 1800, payment_method: "store_credit", status: "submitted" });
    const auth = await token("m_admin");

    const unconfirmed = await call("/admin/orders/10", "PATCH", auth, { status: "completed" }, dbState);
    expect(unconfirmed.status).toBe(409);
    expect(dbState.state.orders[0]?.status).toBe("submitted");

    const tracking = await call("/admin/orders/10", "PATCH", auth, { tracking_carrier: "USPS", tracking_number: "9400" }, dbState);
    expect(tracking.status).toBe(200);
    expect(dbState.state.orders[0]?.tracking_carrier).toBe("USPS");
    expect(dbState.state.orders[0]?.status).toBe("submitted");

    const confirmed = await call("/admin/orders/10", "PATCH", auth, { status: "completed", confirm_order_status_change: true }, dbState);
    expect(confirmed.status).toBe(200);
    expect(dbState.state.orders[0]?.status).toBe("completed");
  });

  it("shows the member wallet balance and ledger", async () => {
    const dbState = makeDb({ balanceCents: 2500 });
    dbState.state.transactions.push({ id: 1, member_id: "m_jane", amount_cents: 2500, source: "event_payout" });
    const res = await call("/shop/wallet", "GET", await token("m_jane"), undefined, dbState);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance_cents: number; transactions: Row[] };
    expect(body.balance_cents).toBe(2500);
    expect(body.transactions).toHaveLength(1);
  });

  it("rejects checkout when store credit is short", async () => {
    const dbState = makeDb({ balanceCents: 1000 });
    const res = await call("/shop/orders", "POST", await token("m_jane"), { items: [{ product_id: 1, quantity: 1 }] }, dbState);
    expect(res.status).toBe(402);
  });

  it("spends wallet credit on checkout and decrements stock", async () => {
    const dbState = makeDb({ balanceCents: 5000 });
    const res = await call("/shop/orders", "POST", await token("m_jane"), { items: [{ product_id: 1, quantity: 2 }] }, dbState);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { balance_cents: number };
    expect(body.balance_cents).toBe(1400);
    expect(dbState.state.orders[0]?.total_cents).toBe(3600);
    expect(dbState.state.orderItems[0]?.quantity).toBe(2);
    expect(dbState.state.products[0]?.stock_qty).toBe(0);
    expect(dbState.state.transactions[0]?.source).toBe("store_purchase");
  });

  it("rejects checkout when stock reservation loses a race", async () => {
    const dbState = makeDb({ balanceCents: 5000, stockReservationFailures: 1 });
    const res = await call("/shop/orders", "POST", await token("m_jane"), { items: [{ product_id: 1, quantity: 2 }] }, dbState);

    expect(res.status).toBe(409);
    expect(dbState.state.products[0]?.stock_qty).toBe(2);
    expect(dbState.state.transactions).toHaveLength(0);
    expect(dbState.state.orders[0]?.status).toBe("cancelled");
  });

  it("creates a PayPal order from a server-priced cart", async () => {
    stubPayPal();
    const dbState = makeDb({ balanceCents: 0 });
    const res = await call("/shop/pay/create-order", "POST", await token("m_jane"), { items: [{ product_id: 1, quantity: 1 }] }, dbState, { PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { orderId: string }).orderId).toBe("ORDER123");
    expect(dbState.state.paymentSessions[0]?.total_cents).toBe(1800);
  });

  it("captures PayPal and submits a shop order without spending wallet credit", async () => {
    stubPayPal();
    const dbState = makeDb({ balanceCents: 0 });
    const extra = { PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec" };
    expect((await call("/shop/pay/create-order", "POST", await token("m_jane"), { items: [{ product_id: 1, quantity: 1 }] }, dbState, extra)).status).toBe(200);
    const res = await call("/shop/pay/capture", "POST", await token("m_jane"), { orderId: "ORDER123" }, dbState, extra);
    expect(res.status).toBe(201);
    expect(dbState.state.orders[0]?.payment_method).toBe("paypal");
    expect(dbState.state.orders[0]?.payment_ref).toBe("ORDER123");
    expect(dbState.state.transactions).toHaveLength(0);
    expect(dbState.state.products[0]?.stock_qty).toBe(1);
    expect(dbState.state.paymentSessions[0]?.status).toBe("captured");
  });

  it("lets a GUEST (no login) pay via PayPal with a name, and records a guest order", async () => {
    stubPayPal();
    const dbState = makeDb({ balanceCents: 0 });
    const extra = { PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec" };
    // a guest must supply a name
    expect((await call("/shop/pay/create-order", "POST", undefined, { items: [{ product_id: 1, quantity: 1 }] }, dbState, extra)).status).toBe(400);
    const created = await call("/shop/pay/create-order", "POST", undefined, { items: [{ product_id: 1, quantity: 1 }], name: "Guest Buyer" }, dbState, extra);
    expect(created.status).toBe(200);
    expect(dbState.state.paymentSessions[0]?.member_id).toBe("guest");
    expect(dbState.state.paymentSessions[0]?.member_name).toBe("Guest Buyer");
    const cap = await call("/shop/pay/capture", "POST", undefined, { orderId: "ORDER123" }, dbState, extra);
    expect(cap.status).toBe(201);
    expect(dbState.state.orders[0]?.member_id).toBe("guest");
    expect(dbState.state.orders[0]?.payment_method).toBe("paypal");
  });

  it("rejects an underpaid PayPal capture (amount < order total)", async () => {
    stubPayPal("0.01"); // PayPal reports a far smaller captured amount than the cart total
    const dbState = makeDb({ balanceCents: 0 });
    const extra = { PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec" };
    expect((await call("/shop/pay/create-order", "POST", await token("m_jane"), { items: [{ product_id: 1, quantity: 1 }] }, dbState, extra)).status).toBe(200);
    const cap = await call("/shop/pay/capture", "POST", await token("m_jane"), { orderId: "ORDER123" }, dbState, extra);
    expect(cap.status).toBe(402);
    expect(dbState.state.orders[0]?.status).toBe("cancelled");
    expect(dbState.state.paymentSessions[0]?.status).toBe("captured");
    expect(dbState.state.products[0]?.stock_qty).toBe(2);
  });

  it("rejects a COMPLETED order whose capture is still PENDING (unsettled eCheck)", async () => {
    stubPayPal("18.00", "PENDING", "COMPLETED"); // order COMPLETED but the capture itself is PENDING
    const dbState = makeDb({ balanceCents: 0 });
    const extra = { PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec" };
    expect((await call("/shop/pay/create-order", "POST", await token("m_jane"), { items: [{ product_id: 1, quantity: 1 }] }, dbState, extra)).status).toBe(200);
    const cap = await call("/shop/pay/capture", "POST", await token("m_jane"), { orderId: "ORDER123" }, dbState, extra);
    expect(cap.status).toBe(402);
    expect(dbState.state.orders[0]?.status).toBe("cancelled");
    expect(dbState.state.paymentSessions[0]?.status).toBe("captured");
    expect(dbState.state.products[0]?.stock_qty).toBe(2);
  });

  it("does not capture PayPal when checkout loses the stock reservation race", async () => {
    stubPayPal();
    const dbState = makeDb({ balanceCents: 0, stockReservationFailures: 1 });
    const extra = { PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec" };
    expect((await call("/shop/pay/create-order", "POST", await token("m_jane"), { items: [{ product_id: 1, quantity: 1 }] }, dbState, extra)).status).toBe(200);

    const cap = await call("/shop/pay/capture", "POST", await token("m_jane"), { orderId: "ORDER123" }, dbState, extra);

    expect(cap.status).toBe(409);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/capture"))).toBe(false);
    expect(dbState.state.paymentSessions[0]?.status).toBe("pending");
    expect(dbState.state.orders[0]?.status).toBe("cancelled");
    expect(dbState.state.products[0]?.stock_qty).toBe(2);
  });

  it("does not treat a reserved PayPal order as captured while capture is in progress", async () => {
    stubPayPal();
    const dbState = makeDb({ balanceCents: 0 });
    const extra = { PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec" };
    expect((await call("/shop/pay/create-order", "POST", await token("m_jane"), { items: [{ product_id: 1, quantity: 1 }] }, dbState, extra)).status).toBe(200);
    const session = dbState.state.paymentSessions[0];
    expect(session).toBeDefined();
    if (session) session.status = "capturing";
    dbState.state.orders.unshift({
      id: 99,
      member_id: "m_jane",
      member_name: "Jane",
      total_cents: 1800,
      payment_method: "paypal",
      payment_ref: "ORDER123",
      status: "submitted",
    });

    const cap = await call("/shop/pay/capture", "POST", await token("m_jane"), { orderId: "ORDER123" }, dbState, extra);

    expect(cap.status).toBe(409);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/capture"))).toBe(false);
  });
});
