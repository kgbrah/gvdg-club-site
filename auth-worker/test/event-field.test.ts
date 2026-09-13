import { describe, expect, it } from "vitest";
import { ratingFromPdgaCache, sortPublicField, unionFieldSeeds } from "../src/event-field.js";

describe("public event field", () => {
  it("merges guest and club-member rows onto one person", () => {
    const seeds = unionFieldSeeds(
      [{ event_id: 5, member_id: "g_abc", name: "T.J. Braley", division: "MA1", team: "KG/TJ" }],
      [{ event_id: 5, member_id: "m_tj", name: "TJ Braley", pdga_no: "12345", division: "MA1", team: "KG/TJ" }],
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ memberId: "m_tj", pdgaNo: "12345", team: "KG/TJ" });
  });

  it("reads official PDGA rating and falls back to live", () => {
    expect(ratingFromPdgaCache(JSON.stringify({ official_rating: 890, live_rating: 910 }))).toBe(890);
    expect(ratingFromPdgaCache(JSON.stringify({ live_rating: 910 }))).toBe(910);
    expect(ratingFromPdgaCache("nope")).toBeNull();
  });

  it("sorts a division by rating then name", () => {
    const sorted = sortPublicField([
      { name: "Pat", division: "MA1", team: null, pdga_no: null, rating: 800 },
      { name: "Abe", division: "MA1", team: null, pdga_no: null, rating: 800 },
      { name: "Zoe", division: "MA1", team: null, pdga_no: null, rating: 950 },
    ]);
    expect(sorted.map((row) => row.name)).toEqual(["Zoe", "Abe", "Pat"]);
  });
});
