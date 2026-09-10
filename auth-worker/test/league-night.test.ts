import { describe, expect, it } from "vitest";
import { matchEventName, parseLeagueNightPlan, parseMatchLines } from "../src/league-night.js";

describe("league night match parser", () => {
  it("parses singles lines", () => {
    const matches = parseMatchLines("Jackie vs Jesus\nJuan Martinez vs Castro", "singles");
    expect(matches).toEqual([
      { num: 1, red: ["Jackie"], blue: ["Jesus"] },
      { num: 2, red: ["Juan Martinez"], blue: ["Castro"] },
    ]);
  });

  it("parses doubles pairs split by slash or ampersand", () => {
    const matches = parseMatchLines("Juan / Jarrett vs Jesus & Castro", "doubles");
    expect(matches).toEqual([
      { num: 1, red: ["Juan", "Jarrett"], blue: ["Jesus", "Castro"] },
    ]);
  });

  it("rejects a singles line with two names on a side", () => {
    const parsed = parseMatchLines("Juan / Jarrett vs Jesus / Castro", "singles");
    expect(parsed).toMatchObject({ error: "invalid_matches" });
  });

  it("rejects a night with no matches", () => {
    expect(parseMatchLines("\n# comment\n", "singles")).toMatchObject({ error: "invalid_matches" });
  });
});

describe("parseLeagueNightPlan", () => {
  it("requires week, format, and matches before start", () => {
    expect(parseLeagueNightPlan({})).toMatchObject({ error: "invalid_night" });
    expect(parseLeagueNightPlan({ weekLabel: "Week 7", format: "singles" })).toMatchObject({ error: "invalid_matches" });
    expect(parseLeagueNightPlan({
      weekLabel: "Week 7",
      format: "singles",
      start: true,
      matchesText: "Jackie vs Jesus",
    })).toMatchObject({ error: "invalid_night", message: "Pick a layout before starting live cards." });
  });

  it("accepts a startable singles night", () => {
    const plan = parseLeagueNightPlan({
      weekLabel: "Week 7",
      format: "singles",
      date: "2026-09-10",
      course_id: 1,
      layout_id: 13,
      start: true,
      matchesText: "Jackie vs Jesus",
    });
    expect(plan).toMatchObject({
      weekLabel: "Week 7",
      format: "singles",
      layoutId: 13,
      start: true,
      matches: [{ num: 1, red: ["Jackie"], blue: ["Jesus"] }],
    });
    if ("error" in plan) throw new Error("expected a plan");
    expect(matchEventName("Ryder Cup", plan, plan.matches[0]!)).toBe("Ryder Cup Week 7 #1 - Jackie vs Jesus");
  });
});
