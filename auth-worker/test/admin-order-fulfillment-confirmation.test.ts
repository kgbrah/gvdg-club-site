import { describe, expect, it } from "vitest";
import { call, makeDb, token } from "./pro-shop-fixture.js";

function addSubmittedOrder(dbState: ReturnType<typeof makeDb>) {
  dbState.state.orders.push({
    id: 10,
    member_id: "m_jane",
    member_name: "Jane",
    total_cents: 1800,
    payment_method: "store_credit",
    status: "submitted",
  });
}

describe("admin order fulfillment confirmation", () => {
  it("requires confirmation before changing order tracking or admin notes", async () => {
    const dbState = makeDb();
    addSubmittedOrder(dbState);
    const res = await call(
      "/admin/orders/10",
      "PATCH",
      await token("m_admin"),
      { tracking_carrier: "USPS", tracking_number: "9400", admin_note: "Packed" },
      dbState,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "order_fulfillment_confirmation_required" });
    expect(dbState.state.orders[0]?.tracking_carrier).toBeUndefined();
    expect(dbState.state.orders[0]?.tracking_number).toBeUndefined();
    expect(dbState.state.orders[0]?.admin_note).toBeUndefined();
  });

  it("updates order tracking and admin notes after confirmation", async () => {
    const dbState = makeDb();
    addSubmittedOrder(dbState);
    const res = await call(
      "/admin/orders/10",
      "PATCH",
      await token("m_admin"),
      { tracking_carrier: "USPS", tracking_number: "9400", admin_note: "Packed", confirm_order_fulfillment_update: true },
      dbState,
    );

    expect(res.status).toBe(200);
    expect(dbState.state.orders[0]?.tracking_carrier).toBe("USPS");
    expect(dbState.state.orders[0]?.tracking_number).toBe("9400");
    expect(dbState.state.orders[0]?.admin_note).toBe("Packed");
    expect(dbState.state.orders[0]?.status).toBe("submitted");
  });
});
