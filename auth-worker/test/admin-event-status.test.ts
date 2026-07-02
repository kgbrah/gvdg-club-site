import { describe, expect, it } from "vitest";
import { confirmEventStatusPatch } from "../src/admin-event-status.js";

describe("admin event status confirmation", () => {
  it("requires confirmation before changing a scheduled event status", () => {
    const result = confirmEventStatusPatch({
      currentStatus: "scheduled",
      body: { status: "cancelled" },
      origin: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(409);
  });

  it("accepts a confirmed scheduled-to-cancelled status change", () => {
    const result = confirmEventStatusPatch({
      currentStatus: "scheduled",
      body: { status: "cancelled", confirm_event_status_change: true },
      origin: null,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("cancelled");
  });

  it("still blocks direct lifecycle status writes", () => {
    const result = confirmEventStatusPatch({
      currentStatus: "scheduled",
      body: { status: "live", confirm_event_status_change: true },
      origin: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(409);
  });
});
