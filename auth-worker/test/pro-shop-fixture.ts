import { vi } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";
import type { Env } from "../src/index.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";

const memberRows = {
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }),
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
};

export type Row = Record<string, unknown>;

type MockState = {
  balanceCents: number;
  eventExists: boolean;
  nextProductId: number;
  nextOrderId: number;
  nextOrderItemId: number;
  nextTransactionId: number;
  products: Row[];
  orders: Row[];
  orderItems: Row[];
  transactions: Row[];
  paymentSessions: Row[];
};

function kv(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}

function baseProduct(overrides: Row = {}): Row {
  return {
    id: 1,
    category: "disc",
    name: "Roc",
    brand: "Innova",
    product_type: "Midrange",
    color: "Orange",
    weight_g: 177,
    price_cents: 1800,
    stock_qty: 2,
    image_url: "https://example.com/roc.jpg",
    description: "Stable midrange",
    active: 1,
    created_by: "m_admin",
    ...overrides,
  };
}

function stringArg(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberArg(value: unknown): number {
  return typeof value === "number" ? value : Number(value || 0);
}

function allRows(sql: string, args: unknown[], state: MockState): Row[] {
  if (/FROM store_products WHERE id IN/i.test(sql)) {
    const ids = new Set(args.map((v) => Number(v)));
    return state.products.filter((p) => ids.has(numberArg(p.id)));
  }
  if (/FROM store_products/i.test(sql)) return state.products;
  if (/FROM wallet_transactions WHERE event_id/i.test(sql)) {
    return state.transactions.filter((t) => numberArg(t.event_id) === numberArg(args[0]) && t.source === "event_payout");
  }
  if (/FROM wallet_transactions WHERE member_id/i.test(sql)) return state.transactions.filter((t) => t.member_id === args[0]);
  if (/FROM wallet_transactions ORDER BY/i.test(sql)) return state.transactions;
  if (/FROM store_orders WHERE member_id/i.test(sql)) return state.orders.filter((o) => o.member_id === args[0]);
  if (/FROM event_players WHERE event_id/i.test(sql)) return [];
  return [];
}

function firstRow(sql: string, args: unknown[], state: MockState): Row | null {
  if (/SELECT COALESCE\(SUM\(amount_cents\)/i.test(sql)) return { balance_cents: state.balanceCents };
  if (/SELECT \* FROM store_orders WHERE payment_ref/i.test(sql)) return state.orders.find((o) => o.payment_ref === args[0]) ?? null;
  if (/SELECT \* FROM store_payment_sessions WHERE paypal_order_id/i.test(sql)) return state.paymentSessions.find((session) => session.paypal_order_id === args[0]) ?? null;
  if (/SELECT \* FROM events WHERE id = \?/i.test(sql)) {
    return state.eventExists ? { id: numberArg(args[0]), name: "League Night", date: "2026-06-01", status: "scheduled" } : null;
  }
  if (/INSERT INTO store_products/i.test(sql)) return insertProduct(args, state);
  if (/INSERT INTO wallet_transactions/i.test(sql)) return insertTransaction(args, state);
  if (/INSERT INTO store_orders/i.test(sql)) return insertOrder(args, state);
  if (/INSERT INTO store_order_items/i.test(sql)) return insertOrderItem(args, state);
  if (/INSERT INTO store_payment_sessions/i.test(sql)) return insertPaymentSession(args, state);
  if (/UPDATE store_payment_sessions SET status = 'captured'/i.test(sql)) return capturePaymentSession(args, state);
  if (/SELECT \* FROM store_products WHERE id = \?/i.test(sql)) return state.products.find((p) => numberArg(p.id) === numberArg(args[0])) ?? null;
  if (/UPDATE store_products SET active = 0/i.test(sql)) {
    const row = state.products.find((p) => numberArg(p.id) === numberArg(args[0]));
    if (row) row.active = 0;
    return row ?? null;
  }
  return null;
}

function insertProduct(args: unknown[], state: MockState): Row {
  const row = baseProduct({
    id: state.nextProductId++,
    category: stringArg(args[0]) ?? "disc",
    name: stringArg(args[1]) ?? "Product",
    brand: stringArg(args[2]),
    product_type: stringArg(args[3]),
    color: stringArg(args[4]),
    weight_g: args[5] == null ? null : numberArg(args[5]),
    price_cents: numberArg(args[6]),
    stock_qty: numberArg(args[7]),
    image_url: stringArg(args[8]),
    description: stringArg(args[9]),
    active: numberArg(args[10]) || 1,
    created_by: stringArg(args[11]),
  });
  state.products.push(row);
  return row;
}

function insertTransaction(args: unknown[], state: MockState): Row {
  const amount = numberArg(args[2]);
  const row: Row = {
    id: state.nextTransactionId++,
    member_id: stringArg(args[0]),
    member_name: stringArg(args[1]),
    amount_cents: amount,
    transaction_type: stringArg(args[3]),
    source: stringArg(args[4]),
    event_id: args[5] == null ? null : numberArg(args[5]),
    order_id: args[6] == null ? null : numberArg(args[6]),
    note: stringArg(args[7]),
    created_by: stringArg(args[8]),
    created_at: "2026-06-01T12:00:00Z",
  };
  state.transactions.unshift(row);
  state.balanceCents += amount;
  return row;
}

function insertOrder(args: unknown[], state: MockState): Row {
  const row: Row = {
    id: state.nextOrderId++,
    member_id: stringArg(args[0]),
    member_name: stringArg(args[1]),
    total_cents: numberArg(args[2]),
    payment_method: stringArg(args[3]) ?? "store_credit",
    payment_ref: stringArg(args[4]),
    status: "submitted",
    created_at: "2026-06-01T12:00:00Z",
  };
  state.orders.unshift(row);
  return row;
}

function insertOrderItem(args: unknown[], state: MockState): Row {
  const row: Row = {
    id: state.nextOrderItemId++,
    order_id: numberArg(args[0]),
    product_id: numberArg(args[1]),
    name_snapshot: stringArg(args[2]),
    price_cents: numberArg(args[3]),
    quantity: numberArg(args[4]),
  };
  state.orderItems.push(row);
  return row;
}

function insertPaymentSession(args: unknown[], state: MockState): Row {
  const row: Row = {
    paypal_order_id: stringArg(args[0]),
    member_id: stringArg(args[1]),
    member_name: stringArg(args[2]),
    items_json: stringArg(args[3]) ?? "[]",
    total_cents: numberArg(args[4]),
    status: "pending",
    created_at: "2026-06-01T12:00:00Z",
    captured_at: null,
  };
  state.paymentSessions.unshift(row);
  return row;
}

function capturePaymentSession(args: unknown[], state: MockState): Row | null {
  const row = state.paymentSessions.find((session) => session.paypal_order_id === args[0]);
  if (row) {
    row.status = "captured";
    row.captured_at = "2026-06-01T12:05:00Z";
  }
  return row ?? null;
}

function runSql(sql: string, args: unknown[], state: MockState) {
  if (/UPDATE store_products SET stock_qty = stock_qty - \?/i.test(sql)) {
    const row = state.products.find((p) => numberArg(p.id) === numberArg(args[1]));
    if (row) row.stock_qty = numberArg(row.stock_qty) - numberArg(args[0]);
  }
  return { results: [], success: true };
}

export function makeDb(overrides: Partial<Pick<MockState, "balanceCents" | "eventExists" | "products">> = {}) {
  const state: MockState = {
    balanceCents: overrides.balanceCents ?? 0,
    eventExists: overrides.eventExists ?? true,
    nextProductId: 2,
    nextOrderId: 10,
    nextOrderItemId: 20,
    nextTransactionId: 30,
    products: overrides.products ?? [baseProduct()],
    orders: [],
    orderItems: [],
    transactions: [],
    paymentSessions: [],
  };
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        all: async () => ({ results: allRows(sql, bound, state), success: true }),
        first: async () => firstRow(sql, bound, state),
        run: async () => runSql(sql, bound, state),
      };
      return stmt;
    },
  };
  return { db: db as unknown as Env["DB"], state };
}

function env(state: ReturnType<typeof makeDb>, extra: Record<string, unknown> = {}) {
  return {
    ROSTER: kv(memberRows),
    RATELIMIT: kv(),
    DB: state.db,
    JWT_SECRET: SECRET,
    SESSION_TTL_SEC: "900",
    ALLOWED_ORIGINS: ORIGIN,
    LIVE: undefined,
    PHOTOS: undefined,
    ...extra,
  } as unknown as Env;
}

export async function token(sub: "m_jane" | "m_admin") {
  return signSession({ sub, mustChangePin: false }, SECRET, 900);
}

export async function call(path: string, method = "GET", bearerToken?: string, body?: unknown, dbState = makeDb(), extra: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (bearerToken) headers.Authorization = "Bearer " + bearerToken;
  if (body) headers["Content-Type"] = "application/json";
  return worker.fetch(
    new Request("https://worker.example" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env(dbState, extra),
  );
}

export function stubPayPal(captureValue = "18.00", captureStatus = "COMPLETED") {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    if (u.includes("/capture")) return new Response(JSON.stringify({ status: captureStatus, purchase_units: [{ payments: { captures: [{ amount: { value: captureValue } }] } }] }), { status: 200 });
    if (u.includes("/v2/checkout/orders")) return new Response(JSON.stringify({ id: "ORDER123" }), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
}
