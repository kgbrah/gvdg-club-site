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
    const res = await call("/admin/events/7/store-credit", "POST", await token("m_admin"), { member_id: "m_jane", amount_cents: 1500, note: "League payout" }, dbState);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { balance_cents: number; payouts: Row[] };
    expect(body.balance_cents).toBe(1700);
    expect(body.payouts[0]?.source).toBe("event_payout");
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
});
