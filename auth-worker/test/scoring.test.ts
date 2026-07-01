import { describe, it, expect } from "vitest";
import { assignCards, countScores, computeLeaderboard, finalizeStandings, computeLeagueStandings, type PlayerState } from "../src/scoring.js";

describe("assignCards", () => {
  const mk = (over: Partial<PlayerState>): PlayerState => ({ memberId: null, name: "P", scores: {}, ...over });
  it("buckets players into cards of 4 when no starting holes are assigned", () => {
    const players = Array.from({ length: 9 }, (_, i) => mk({ memberId: "m" + i }));
    assignCards(players);
    expect(players.map((p) => p.cardId)).toEqual(["c0", "c0", "c0", "c0", "c1", "c1", "c1", "c1", "c2"]);
  });
  it("groups players by shotgun starting hole when assigned", () => {
    const players = [mk({ startingHole: 5 }), mk({ startingHole: 5 }), mk({ startingHole: 9 })];
    assignCards(players);
    expect(players.map((p) => p.cardId)).toEqual(["h5", "h5", "h9"]);
  });
  it("never overwrites an explicit cardId", () => {
    const players = [mk({ cardId: "x" }), mk({})];
    assignCards(players);
    expect(players[0]!.cardId).toBe("x");
  });
});

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

describe("finalizeStandings (placements + breakdown for results)", () => {
  const holes = [
    { hole: 1, par: 3 },
    { hole: 2, par: 4 },
    { hole: 3, par: 3 },
  ];
  it("sorts, assigns competition ranks (ties share a place), and includes each player's breakdown", () => {
    const players: PlayerState[] = [
      { memberId: "a", name: "Ann", scores: { 1: 3, 2: 4, 3: 3 } }, // E, 10
      { memberId: "b", name: "Bo", scores: { 1: 2, 2: 4, 3: 3 } }, //  -1, 9
      { memberId: "c", name: "Cy", scores: { 1: 3, 2: 4, 3: 3 } }, //  E, 10 (ties Ann)
    ];
    const fs = finalizeStandings(holes, players);
    expect(fs.map((s) => s.name)).toEqual(["Bo", "Ann", "Cy"]);
    expect(fs[0]).toMatchObject({ name: "Bo", place: 1, total: 9, toPar: -1 });
    expect(fs[1]!.place).toBe(2);
    expect(fs[2]!.place).toBe(2); // tie shares place 2 (next would be 4)
    expect(fs[0]!.breakdown).toMatchObject({ birdies: 1, pars: 2, bogeys: 0 });
  });

  it("marks an incomplete card DNF (place null) but still tallies its played holes", () => {
    const fs = finalizeStandings(holes, [{ memberId: "x", name: "X", scores: { 1: 4 } }]); // thru 1 of 3
    expect(fs[0]).toMatchObject({ place: null, thru: 1, total: 4, toPar: 1 });
    expect(fs[0]!.breakdown).toMatchObject({ bogeys: 1 });
  });

  it("emits each player's played holes in layout order for the UDisc scorecard (skips unplayed)", () => {
    const fs = finalizeStandings(holes, [
      { memberId: "a", name: "Ann", scores: { 1: 3, 2: 4, 3: 3 } }, // complete
      { memberId: "p", name: "Partial", scores: { 1: 4, 3: 2 } }, //  skipped hole 2
    ]);
    expect(fs.find((s) => s.name === "Ann")!.holes).toEqual([
      { hole: 1, par: 3, strokes: 3 },
      { hole: 2, par: 4, strokes: 4 },
      { hole: 3, par: 3, strokes: 3 },
    ]);
    expect(fs.find((s) => s.name === "Partial")!.holes).toEqual([
      { hole: 1, par: 3, strokes: 4 },
      { hole: 3, par: 3, strokes: 2 },
    ]); // unplayed hole 2 omitted, order preserved
  });

  it("ranks only finishers; no-shows/partials are DNF (null) and never outrank a real finisher", () => {
    const players: PlayerState[] = [
      { memberId: "f", name: "Finisher", scores: { 1: 4, 2: 5, 3: 4 } }, // +3, complete
      { memberId: "n", name: "NoShow", scores: {} }, //                     thru 0
      { memberId: "p", name: "Partial", scores: { 1: 3 } }, //             thru 1 of 3
    ];
    const fs = finalizeStandings(holes, players);
    expect(fs[0]).toMatchObject({ name: "Finisher", place: 1 }); // ranked despite being +3
    expect(fs.find((s) => s.name === "NoShow")!.place).toBeNull();
    expect(fs.find((s) => s.name === "Partial")!.place).toBeNull();
    expect(new Set([fs[1]!.name, fs[2]!.name])).toEqual(new Set(["Partial", "NoShow"])); // DNFs sort last
  });
});

describe("computeLeagueStandings (season table across a league's events)", () => {
  it("aggregates per member into points/wins, sorts with tiebreaks", () => {
    const rows = [
      { member_id: "a", name: "Ann", place: 1, to_par: -3 }, // round 1
      { member_id: "b", name: "Bo", place: 2, to_par: -1 },
      { member_id: "a", name: "Ann", place: 2, to_par: -1 }, // round 2
      { member_id: "b", name: "Bo", place: 1, to_par: -4 },
      { member_id: "c", name: "Cy", place: 3, to_par: 1 },
    ];
    const st = computeLeagueStandings(rows);
    // Ann & Bo both 17 pts / 1 win → tiebreak total_to_par asc → Bo (-5) ahead of Ann (-4)
    expect(st.map((s) => s.name)).toEqual(["Bo", "Ann", "Cy"]);
    expect(st[0]).toMatchObject({ name: "Bo", events: 2, wins: 1, points: 17, total_to_par: -5, best_place: 1 });
    expect(st.find((s) => s.name === "Cy")).toMatchObject({ events: 1, wins: 0, points: 5, best_place: 3 });
  });

  it("groups guests (null member_id) by name", () => {
    const st = computeLeagueStandings([
      { member_id: null, name: "Guest", place: 1, to_par: -2 },
      { member_id: null, name: "Guest", place: 1, to_par: -1 },
    ]);
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ name: "Guest", events: 2, wins: 2 });
  });
});
