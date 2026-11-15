import { describe, expect, it } from "vitest";
import { computeLeagueStandings } from "../src/scoring.js";
import { udiscStandingsFromLoader } from "../src/imports.js";

const LOADER = {
  loaderData: {
    "routes/leagues/$slug/standings": {
      league: { name: "Dolly Dubs", shortId: "5JJBOv" },
      season: { startDate: "2026-03-01", endDate: "2026-11-01" },
      standings: { roundsKept: 2, minimumPoints: 5, type: "standard" },
      usersById: {
        u1: { fullName: "Ada Player" },
        u2: { fullName: "Bea Player" },
      },
      eventColumns: [
        { _id: "e1", name: "Week 1", shortId: "aaa111", startDate: "2026-03-04", location: { courseName: "Dolly Cooper Park" } },
        { _id: "e2", name: "Week 2", shortId: "bbb222", startDate: "2026-03-11", location: { courseName: "Dolly Cooper Park" } },
        { _id: "e3", name: "Week 3", shortId: "ccc333", startDate: "2026-03-18", location: { courseName: "Dolly Cooper Park" } },
      ],
      eventRoundEntryResultsById: {
        r1: { eventScore: 54, relativeEventScore: -2 },
        r2: { eventScore: 58, relativeEventScore: 2 },
        r3: { eventScore: 60, relativeEventScore: 4 },
      },
      points: [
        { eventListingId: "e1", userId: "u1", eventRoundEntryId: "r1", eventRanking: 1, points: 10, division: "GEN" },
        { eventListingId: "e2", userId: "u1", eventRoundEntryId: "r2", eventRanking: 2, points: 1, division: "GEN" },
        { eventListingId: "e3", userId: "u1", eventRoundEntryId: "r3", eventRanking: 1, points: 8, division: "GEN" },
        { eventListingId: "e1", userId: "u2", eventRoundEntryId: "r2", eventRanking: 4, points: 3, division: "GEN" },
      ],
    },
  },
};

describe("udisc standings", () => {
  it("reads past rounds, scores, and keeps UDisc's best rounds", () => {
    const parsed = udiscStandingsFromLoader(LOADER);
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events[0]).toMatchObject({
      name: "Week 1",
      date: "2026-03-04",
      venue: "Dolly Cooper Park",
      externalUrl: "https://udisc.com/events/week-1-aaa111",
    });
    expect(parsed.events[0]?.results[0]).toMatchObject({ name: "Ada Player", place: 1, total: 54, toPar: -2, points: 10 });
    expect(parsed.standings[0]).toMatchObject({ name: "Ada Player", points: 18, events: 3, wins: 2 });
    expect(parsed.standings.map((row) => row.name)).toEqual(["Ada Player"]);
  });

  it("uses imported UDisc points instead of club place points", () => {
    const breakdown = (points: number) => JSON.stringify({ udisc_points: points, udisc_rounds_kept: 2, udisc_minimum_points: 5 });
    const standings = computeLeagueStandings([
      { member_id: null, name: "Ada Player", place: 1, to_par: -2, breakdown: breakdown(10) },
      { member_id: null, name: "Ada Player", place: 2, to_par: 2, breakdown: breakdown(1) },
      { member_id: null, name: "Ada Player", place: 1, to_par: 4, breakdown: breakdown(8) },
    ]);
    expect(standings).toEqual([expect.objectContaining({ name: "Ada Player", points: 18, events: 3, wins: 2 })]);
  });
});
