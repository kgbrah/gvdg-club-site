import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";

afterEach(() => vi.unstubAllGlobals());

const SECRET = "x".repeat(40);
const MEMBER = JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false });
function kv(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
}
// reg owes entry 1000 + ctp 500 = 1500
const db = { prepare: (sql: string) => ({
  bind() { return this; },
  all: async () => ({ results: [], success: true }),
  first: async () => {
    if (/FROM registrations WHERE event_id/i.test(sql)) return { id: 1, addons: '{"ctp":true}', paid_entry: 0, payment_ref: null };
    if (/FROM event_config/i.test(sql)) return { entry_fee_cents: 1000, ctp_fee_cents: 500, ace_fee_cents: 300 };
    if (/UPDATE registrations SET paid_entry/i.test(sql)) return { id: 1, paid_entry: 1, payment_ref: "ORDER123", amount_paid_cents: 1500 };
    return null;
  },
  run: async () => ({ results: [], success: true }),
}) };
const envBase = { ROSTER: kv({ "member:m_jane": MEMBER }), RATELIMIT: kv(), DB: db, JWT_SECRET: SECRET, ALLOWED_ORIGINS: "http://localhost:8080", LIVE: undefined };
const env = (extra: Record<string, unknown> = {}) => ({ ...envBase, ...extra } as unknown as Parameters<typeof worker.fetch>[1]);
const tok = () => signSession({ sub: "m_jane", mustChangePin: false }, SECRET, 900);
async function call(path: string, method = "GET", token?: string, body?: unknown, e = env({ PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec" })) {
  const h: Record<string, string> = { Origin: "http://localhost:8080" };
  if (token) h.authorization = "Bearer " + token;
  if (body) h["content-type"] = "application/json";
  return worker.fetch(new Request("https://w" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), e);
}
// Stub the PayPal REST API by URL.
function stubPayPal(captureValue = "15.00", captureStatus = "COMPLETED") {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    if (u.includes("/capture")) return new Response(JSON.stringify({ status: captureStatus, purchase_units: [{ payments: { captures: [{ amount: { value: captureValue } }] } }] }), { status: 200 });
    if (u.includes("/v2/checkout/orders")) return new Response(JSON.stringify({ id: "ORDER123" }), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
}

describe("Track G G2 — PayPal Checkout", () => {
  it("GET /payments/config reflects whether credentials are configured", async () => {
    expect((await (await call("/payments/config", "GET", undefined, undefined, env())).json()).enabled).toBe(false);
    const on = await (await call("/payments/config", "GET")).json();
    expect(on.enabled).toBe(true);
    expect(on.clientId).toBe("cid");
  });
  it("pay routes are 503 when payments are not configured (manual mode)", async () => {
    expect((await call("/events/5/pay/create-order", "POST", await tok(), {}, env())).status).toBe(503);
  });
  it("create-order returns a PayPal order id", async () => {
    stubPayPal();
    const res = await call("/events/5/pay/create-order", "POST", await tok(), {});
    expect(res.status).toBe(200);
    expect((await res.json()).orderId).toBe("ORDER123");
  });
  it("capture verifies amount server-side and marks the registration paid", async () => {
    stubPayPal("15.00"); // owed is 1500 -> 15.00 USD ok
    const res = await call("/events/5/pay/capture", "POST", await tok(), { orderId: "ORDER123" });
    expect(res.status).toBe(200);
    expect((await res.json()).registration.paid_entry).toBe(1);
  });
  it("rejects an underpaid capture (402) — does not mark paid", async () => {
    stubPayPal("5.00"); // 500 cents < 1500 owed
    expect((await call("/events/5/pay/capture", "POST", await tok(), { orderId: "ORDER123" })).status).toBe(402);
  });
  it("requires auth", async () => {
    expect((await call("/events/5/pay/create-order", "POST")).status).toBe(401);
  });
});
