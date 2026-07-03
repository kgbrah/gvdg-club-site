import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";
import { jsonObject, objectField } from "./json.js";
import { d1Database, d1Statement, memoryKv, workerEnv } from "./worker-test-env.js";

afterEach(() => vi.unstubAllGlobals());

const SECRET = "x".repeat(40);
const MEMBER = JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false });
type TestEnv = Parameters<typeof worker.fetch>[1];

function paymentDb(first: (sql: string) => Record<string, unknown> | null): D1Database {
  return d1Database((sql) =>
    d1Statement({
      first: () => first(sql),
    }),
  );
}
// reg owes entry 1000 + ctp 500 = 1500
const db = paymentDb((sql) => {
    if (/FROM registrations WHERE event_id/i.test(sql)) return { id: 1, addons: '{"ctp":true}', paid_entry: 0, payment_ref: null };
    if (/FROM event_config/i.test(sql)) return { entry_fee_cents: 1000, ctp_fee_cents: 500, ace_fee_cents: 300 };
    if (/UPDATE registrations SET payment_ref/i.test(sql)) return { id: 1 }; // reserveCapture wins the slot
    if (/UPDATE registrations SET paid_entry/i.test(sql)) return { id: 1, paid_entry: 1, payment_ref: "ORDER123", amount_paid_cents: 1500 };
    return null;
});
// variant where a concurrent capture already holds the reservation (reserveCapture loses)
const dbRaceLost = paymentDb((sql) => {
    if (/FROM registrations WHERE event_id/i.test(sql)) return { id: 1, addons: '{"ctp":true}', paid_entry: 0, payment_ref: null };
    if (/FROM event_config/i.test(sql)) return { entry_fee_cents: 1000, ctp_fee_cents: 500, ace_fee_cents: 300 };
    if (/UPDATE registrations SET payment_ref/i.test(sql)) return null; // another order id is mid-capture
    return null;
});
// variant where entry is already PAID (1000c) — used to test the paid-add-on lock on re-register
const dbPaidEntry = paymentDb((sql) => {
    if (/SELECT status(?:, starts_at, registration_deadline, checkin_deadline)? FROM events/i.test(sql)) return { status: "scheduled" };
    if (/FROM event_config/i.test(sql)) return { registration_open: 1, divisions: "[]", entry_fee_cents: 1000, ctp_fee_cents: 500, ace_fee_cents: 300 };
    if (/FROM registrations WHERE event_id/i.test(sql)) return { id: 1, paid_entry: 1, amount_paid_cents: 1000, addons: "{}" };
    if (/INSERT INTO registrations/i.test(sql)) return { id: 1, addons: '{"ace":true}', paid_entry: 1 };
    return null;
});
// variant where the registration is already paid (payment_ref ORDER123)
const dbPaid = paymentDb((sql) => {
    if (/FROM registrations WHERE event_id/i.test(sql)) return { id: 1, addons: '{"ctp":true}', paid_entry: 1, payment_ref: "ORDER123" };
    if (/FROM event_config/i.test(sql)) return { entry_fee_cents: 1000, ctp_fee_cents: 500, ace_fee_cents: 300 };
    return null;
});
const env = (extra: Partial<TestEnv> = {}): TestEnv => ({
  ...workerEnv({ roster: memoryKv({ "member:m_jane": MEMBER }), db, secret: SECRET, origin: "http://localhost:8080" }),
  ...extra,
});
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
    expect((await jsonObject(await call("/payments/config", "GET", undefined, undefined, env()))).enabled).toBe(false);
    const on = await jsonObject(await call("/payments/config", "GET"));
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
    expect((await jsonObject(res)).orderId).toBe("ORDER123");
  });
  it("capture verifies amount server-side and marks the registration paid", async () => {
    stubPayPal("15.00"); // owed is 1500 -> 15.00 USD ok
    const res = await call("/events/5/pay/capture", "POST", await tok(), { orderId: "ORDER123" });
    expect(res.status).toBe(200);
    expect(objectField(await jsonObject(res), "registration").paid_entry).toBe(1);
  });
  it("rejects an underpaid capture (402) — does not mark paid", async () => {
    stubPayPal("5.00"); // 500 cents < 1500 owed
    expect((await call("/events/5/pay/capture", "POST", await tok(), { orderId: "ORDER123" })).status).toBe(402);
  });
  it("requires auth", async () => {
    expect((await call("/events/5/pay/create-order", "POST")).status).toBe(401);
  });
  it("refuses to start a 2nd order once already paid (409) — prevents double-charge", async () => {
    stubPayPal();
    const e = env({ PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec", DB: dbPaid });
    expect((await call("/events/5/pay/create-order", "POST", await tok(), {}, e)).status).toBe(409);
  });
  it("capture is idempotent for the same order, refuses a different order when already paid", async () => {
    stubPayPal();
    const e = env({ PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec", DB: dbPaid });
    expect((await call("/events/5/pay/capture", "POST", await tok(), { orderId: "ORDER123" }, e)).status).toBe(200); // same order -> idempotent ok
    expect((await call("/events/5/pay/capture", "POST", await tok(), { orderId: "OTHER" }, e)).status).toBe(409); // different order -> refuse
  });
  it("refuses a concurrent 2nd capture without charging PayPal (reservation closes the double-charge race)", async () => {
    stubPayPal();
    const e = env({ PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec", DB: dbRaceLost });
    const res = await call("/events/5/pay/capture", "POST", await tok(), { orderId: "ORDER123" }, e);
    expect(res.status).toBe(409); // capture_in_progress
    const calls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/capture"))).toBe(false); // never charged the card
  });
});

describe("Track G — paid add-on lock (free ace-pot / CTP entry)", () => {
  it("blocks adding a paid add-on after entry is paid (409 paid_addons_locked)", async () => {
    const e = env({ DB: dbPaidEntry });
    const res = await call("/events/5/register", "POST", await tok(), { addons: { ace: true } }, e);
    expect(res.status).toBe(409);
    expect((await jsonObject(res)).error).toBe("paid_addons_locked");
  });
  it("still allows a no-cost re-registration after paying (e.g. division edit)", async () => {
    const e = env({ DB: dbPaidEntry });
    expect((await call("/events/5/register", "POST", await tok(), { division: "MA1" }, e)).status).toBe(201);
  });
});
