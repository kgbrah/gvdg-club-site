import { describe, expect, it } from "vitest";

import { holePlayStats, parseBreakdown, parseThrowsBody, playStatsByKind, playStatsView, roundPlayStats, withPlayBreakdown } from "../src/play-stats.js";

const TEE = { lat: 35.6, lng: -77.37 };
const BASKET = { lat: 35.6008, lng: -77.37 };
const HOLE = { hole: 1, par: 3, tee: TEE, target: BASKET };

function northOf(point: { lat: number; lng: number }, meters: number) {
  return { lat: point.lat + meters / 111320, lng: point.lng };
}

describe("play stats", () => {
  it("counts a C1 birdie from a marked lie", () => {
    const stats = holePlayStats(HOLE, [northOf(BASKET, 8)], 2);
    expect(stats.c1r?.hit).toBe(1);
    expect(stats.c1Putt?.hit).toBe(1);
  });

  it("merges throw stats onto a classic breakdown", () => {
    const next = withPlayBreakdown(
      { aces: 0, eagles: 0, birdies: 1, pars: 0, bogeys: 0, doubles_plus: 0 },
      { memberId: "m1", name: "Ann", scores: { 1: 2 }, throws: { 1: [{ ...northOf(BASKET, 8), n: 1 }] } },
      [HOLE],
    );
    expect(next.birdies).toBe(1);
    expect(next.c1r_hit).toBe(1);
    expect(next.holes).toBe(1);
  });

  it("parses throws posts and ranks birdie rate", () => {
    expect(parseThrowsBody({ hole: 1, throws: [{ lat: 35.6, lng: -77.37 }] })?.throws).toHaveLength(1);
    expect(parseThrowsBody({ hole: 0, throws: [] })).toBeNull();
    const view = playStatsView([
      { memberId: "a", name: "Ann", totals: parseBreakdown({ eagles: 1, birdies: 8, pars: 7, bogeys: 2, doubles_plus: 0 }) },
      { memberId: "b", name: "Ben", totals: parseBreakdown({ eagles: 0, birdies: 3, pars: 12, bogeys: 3, doubles_plus: 0 }) },
    ], "b");
    const birdie = view.find((row) => row.id === "birdie");
    expect(birdie?.mine?.rank).toBe(2);
    expect(roundPlayStats([HOLE], { 1: [northOf(BASKET, 8)] }, { 1: 2 }).c1_putt_hit).toBe(1);
    const split = playStatsByKind([
      { member_id: "b", name: "Ben", kind: "competitive", breakdown: { eagles: 1, birdies: 8, pars: 7, bogeys: 2, doubles_plus: 0 } },
      { member_id: "b", name: "Ben", kind: "casual", breakdown: { eagles: 0, birdies: 14, pars: 4, bogeys: 0, doubles_plus: 0 } },
    ], "b");
    expect(split.competitive.mine.totals.birdies).toBe(8);
    expect(split.casual.mine.totals.birdies).toBe(14);
    expect(split.competitive.mine.totals.holes).toBe(18);
    expect(split.casual.mine.totals.holes).toBe(18);
    const competitiveBirdie = split.competitive.categories.find((row) => row.id === "birdieMix");
    const casualBirdie = split.casual.categories.find((row) => row.id === "birdieMix");
    expect(competitiveBirdie?.mine?.hit).toBe(8);
    expect(casualBirdie?.mine?.hit).toBe(14);
  });
});
