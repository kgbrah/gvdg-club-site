import { describe, expect, it } from "vitest";
import { confirmFundraiserStatusPatch } from "../src/club-admin-content.js";
import { jsonObject } from "./json.js";

describe("admin fundraiser status confirmation", () => {
  it("requires confirmation before changing fundraiser status", async () => {
    const result = confirmFundraiserStatusPatch({
      status: "closed",
      body: { status: "closed" },
      origin: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(409);
      await expect(jsonObject(result.response)).resolves.toMatchObject({ error: "fundraiser_status_confirmation_required" });
    }
  });

  it("accepts a confirmed fundraiser status change", () => {
    const result = confirmFundraiserStatusPatch({
      status: "active",
      body: { status: "active", confirm_fundraiser_status_change: true },
      origin: null,
    });

    expect(result.ok).toBe(true);
  });

  it("allows patches without a status field", () => {
    const result = confirmFundraiserStatusPatch({
      status: null,
      body: { title: "Disc drive" },
      origin: null,
    });

    expect(result.ok).toBe(true);
  });
});
