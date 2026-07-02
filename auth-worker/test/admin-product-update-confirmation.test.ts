import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";
import { jsonObject } from "./json.js";
import { d1Database, d1Statement, memoryKv, workerEnv } from "./worker-test-env.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const MEMBERS = {
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
};

type ProductRow = {
  readonly id: number;
  readonly name: string;
  price_cents: number;
  stock_qty: number;
  active: number;
};

type DbState = {
  readonly product: ProductRow;
  updateCount: number;
};

function numberArg(value: unknown): number {
  return typeof value === "number" ? value : Number(value || 0);
}

function updateProduct(args: readonly unknown[], state: DbState): ProductRow | null {
  if (numberArg(args[11]) !== state.product.id) return null;
  if (args[6] != null) state.product.price_cents = numberArg(args[6]);
  if (args[7] != null) state.product.stock_qty = numberArg(args[7]);
  if (args[10] != null) state.product.active = numberArg(args[10]);
  state.updateCount += 1;
  return state.product;
}

function db(state: DbState): D1Database {
  return d1Database((sql) => {
    let binds: readonly unknown[] = [];
    return d1Statement({
      bind: (values) => {
        binds = values;
      },
      first: () => (/UPDATE store_products SET/i.test(sql) ? updateProduct(binds, state) : null),
    });
  });
}

function env(state: DbState) {
  return workerEnv({ roster: memoryKv(MEMBERS), db: db(state), secret: SECRET, origin: ORIGIN });
}

async function token() {
  return signSession({ sub: "m_admin", mustChangePin: false }, SECRET, 900);
}

async function patchProduct(state: DbState, body: Record<string, unknown>) {
  return worker.fetch(
    new Request("https://w/admin/shop/products/1", {
      method: "PATCH",
      headers: { Origin: ORIGIN, authorization: "Bearer " + await token(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env(state),
  );
}

function productState(): DbState {
  return { product: { id: 1, name: "Roc", price_cents: 1800, stock_qty: 2, active: 1 }, updateCount: 0 };
}

describe("admin product update confirmation", () => {
  it("requires confirmation before changing product price, stock, or active state", async () => {
    const state = productState();
    const res = await patchProduct(state, { price_cents: 2100, stock_qty: 5, active: false });

    expect(res.status).toBe(409);
    await expect(jsonObject(res)).resolves.toMatchObject({ error: "product_update_confirmation_required" });
    expect(state.updateCount).toBe(0);
    expect(state.product).toMatchObject({ price_cents: 1800, stock_qty: 2, active: 1 });
  });

  it("updates product price, stock, and active state after confirmation", async () => {
    const state = productState();
    const res = await patchProduct(state, { price_cents: 2100, stock_qty: 5, active: false, confirm_product_update: true });

    expect(res.status).toBe(200);
    expect(state.updateCount).toBe(1);
    expect(state.product).toMatchObject({ price_cents: 2100, stock_qty: 5, active: 0 });
  });
});
