import { describe, expect, it } from "vitest";
import { normalizeRoundCode } from "../src/club-rounds-routes.js";

describe("normalizeRoundCode", () => {
  it("leaves a blank code for the server to invent", () => {
    expect(normalizeRoundCode(null)).toBeNull();
    expect(normalizeRoundCode("  ")).toBeNull();
  });

  it("keeps a shareable code and rejects one that is too short", () => {
    expect(normalizeRoundCode("saturday")).toEqual({ code: "SATURDAY" });
    expect(normalizeRoundCode("kg card")).toEqual({ code: "KGCARD" });
    expect(normalizeRoundCode("ab")).toEqual({ error: "invalid_code" });
    expect(normalizeRoundCode("thiscodeiswaytoolong")).toEqual({ error: "invalid_code" });
  });
});
