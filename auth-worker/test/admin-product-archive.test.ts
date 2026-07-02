import { describe, expect, it } from "vitest";
import { call, makeDb, token } from "./pro-shop-fixture.js";

describe("admin product archive confirmation", () => {
  it("requires confirmation before archiving a product", async () => {
    const dbState = makeDb();
    const auth = await token("m_admin");

    const unconfirmed = await call("/admin/shop/products/1", "DELETE", auth, undefined, dbState);
    expect(unconfirmed.status).toBe(409);
    expect(dbState.state.products[0]?.active).toBe(1);

    const confirmed = await call("/admin/shop/products/1", "DELETE", auth, { confirm_product_archive: true }, dbState);
    expect(confirmed.status).toBe(200);
    expect(dbState.state.products[0]?.active).toBe(0);
  });
});
