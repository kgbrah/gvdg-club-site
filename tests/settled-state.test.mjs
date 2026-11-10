import assert from "node:assert/strict";
import test from "node:test";

import { settleWhileLoading } from "../src/shared/settled-state.js";

test("a loading refresh keeps the settled list", () => {
  const ready = { status: "ready", events: [{ id: 1 }] };
  const first = settleWhileLoading(null, { status: "loading", events: [] }, "");
  assert.equal(first.held, false);
  assert.equal(first.view.status, "loading");

  const settled = settleWhileLoading(null, ready, "");
  const refresh = settleWhileLoading(settled.snapshot, { status: "loading", events: [] }, "");
  assert.equal(refresh.held, true);
  assert.equal(refresh.view, ready);
});

test("a different scope does not keep the previous list", () => {
  const settled = settleWhileLoading(null, { status: "ready", products: [{ id: 1 }], inventoryStatus: "active" }, "active");
  const next = settleWhileLoading(settled.snapshot, { status: "loading", products: [], inventoryStatus: "inactive" }, "inactive");
  assert.equal(next.held, false);
  assert.equal(next.view.status, "loading");
});
