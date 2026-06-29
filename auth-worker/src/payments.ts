// PayPal Checkout (Orders v2) integration for event entry + add-ons. Credential-gated: the Worker only
// activates payments when PAYPAL_CLIENT_ID + PAYPAL_SECRET are configured; otherwise the club uses the
// manual "paid" flag (no payment downtime while waiting for credentials). The secret never leaves the
// Worker; the client-id is public (it goes in the frontend SDK URL). All amounts are computed and the
// capture is verified SERVER-SIDE — the client is never trusted for the amount.

export interface OwedConfig {
  entry_fee_cents?: number | null;
  ctp_fee_cents?: number | null;
  ace_fee_cents?: number | null;
}

/** Total a member owes for a registration, in cents: entry + each opted-in add-on the event offers. */
export function computeOwed(cfg: OwedConfig, addons: { ctp?: boolean; ace?: boolean }): number {
  let total = cfg.entry_fee_cents || 0;
  if (addons && addons.ctp && cfg.ctp_fee_cents) total += cfg.ctp_fee_cents;
  if (addons && addons.ace && cfg.ace_fee_cents) total += cfg.ace_fee_cents;
  return total;
}

/** PayPal REST API base. `override` (PAYPAL_API_BASE) is for local testing against a mock. */
export function paypalBase(env?: string, override?: string): string {
  if (override) return override.replace(/\/+$/, "");
  return env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

export interface PayPalCreds {
  clientId: string;
  secret: string;
  base: string;
}

async function accessToken(c: PayPalCreds): Promise<string> {
  const res = await fetch(c.base + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(c.clientId + ":" + c.secret), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("paypal_auth_" + res.status);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Create an order for `amountCents` (USD). Returns the PayPal order id for the frontend to approve. */
export async function createOrder(c: PayPalCreds, amountCents: number, description: string): Promise<string> {
  const token = await accessToken(c);
  const res = await fetch(c.base + "/v2/checkout/orders", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: (amountCents / 100).toFixed(2) }, description }] }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("paypal_create_" + res.status);
  return ((await res.json()) as { id: string }).id;
}

/** Capture an approved order. Returns the status + captured amount (cents) for server-side verification. */
export async function captureOrder(c: PayPalCreds, orderId: string): Promise<{ status: string; amountCents: number }> {
  const token = await accessToken(c);
  const res = await fetch(c.base + "/v2/checkout/orders/" + encodeURIComponent(orderId) + "/capture", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("paypal_capture_" + res.status);
  const d = (await res.json()) as { status?: string; purchase_units?: { payments?: { captures?: { amount?: { value?: string } }[] } }[] };
  const value = d.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;
  return { status: d.status ?? "", amountCents: Math.round(parseFloat(value || "0") * 100) };
}
