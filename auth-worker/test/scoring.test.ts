import { describe, it, expect } from "vitest";
import { countScores, computeLeaderboard, type PlayerState } from "../src/scoring.js";

describe("countScores (UDisc-style breakdown)", () => {
  it("buckets holes by score-to-par and tallies aces separately", () => {
    // pars:  3  4  3  5     strokes: 1  4  2  7
    // hole1: ace (1) + eagle (d=-2); hole2: par; hole3: birdie (d=-1); hole4: double+ (d=+2)
    const b = countScores([3, 4, 3, 5], [1, 4, 2, 7]);
    expect(b).toEqual({ aces: 1, eagles: 1, birdies: 1, pars: 1, bogeys: 0, doubles_plus: 1 });
  });
  it("counts bogeys and ignores missing/null holes", () => {
    const b = countScores([3, 3, 4], [4, null as unknown as number, 4]);
    expect(b).toEqual({ aces: 0, eagles: 0, birdies: 0, pars: 1, bogeys: 1, doubles_plus: 0 });
  });
});

describe("computeLeaderboard", () => {
  const holes = [
    { hole: 1, par: 3 },
    { hole: 2, par: 4 },
    { hole: 3, par: 3 },
  ];
  it("computes thru/total/toPar and sorts by to-par then total then name", () => {
    const players: PlayerState[] = [
      { memberId: "a", name: "Ann", scores: { 1: 4, 2: 4, 3: 3 } }, // +1, thru3, 11
      { memberId: "b", name: "Bo", scores: { 1: 2, 2: 4 } }, //          -1, thru2, 6
      { memberId: "c", name: "Cy", scores: {} }, //                       E, thru0, 0
    ];
    const lb = computeLeaderboard(holes, players);
    expect(lb.map((s) => s.name)).toEqual(["Bo", "Cy", "Ann"]); // -1, E, +1
    const bo = lb[0]!;
    expect(bo).toMatchObject({ name: "Bo", thru: 2, total: 6, toPar: -1 });
    expect(lb.find((s) => s.name === "Ann")).toMatchObject({ thru: 3, total: 11, toPar: 1 });
  });
});
