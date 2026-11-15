import { describe, expect, it } from "vitest";
import { tagStandingsFromBoards, udiscLeaderboardFromLoader } from "../src/imports/udisc-leaderboard.js";
import { computeLeagueStandings } from "../src/scoring.js";

function board(results: Record<string, unknown>[], status: string, percentage?: number) {
  return {
    loaderData: {
      route: {
        rounds: [{ status }],
        publicRoundPreviewProps: percentage == null ? {} : { progress: { percentage } },
        roundEntryResults: results,
      },
    },
  };
}

describe("udisc leaderboard", () => {
  it("reads a finished round and ignores one still on the course", () => {
    const finished = udiscLeaderboardFromLoader(board([
      { name: "Sean Gough", ranking: 1, eventScore: 56, relativeEventScore: -9, eventEntryState: "active", isComplete: true },
      { name: "Jesus mares", ranking: 2, eventScore: 58, relativeEventScore: -7, eventEntryState: "active", isComplete: true },
    ], "finished", 100));
    expect(finished.finished).toBe(true);
    expect(finished.results.map((row) => row.name)).toEqual(["Sean Gough", "Jesus mares"]);
    const live = udiscLeaderboardFromLoader(board([
      { name: "Sean Gough", ranking: 1, eventScore: 30, relativeEventScore: -6, eventEntryState: "active", isComplete: false },
    ], "started", 34));
    expect(live.finished).toBe(false);
  });

  it("uses the latest finished round as the current tag order", () => {
    const standings = tagStandingsFromBoards("Sunday Baggers", [
      {
        name: "Warmup",
        date: "2026-11-01",
        externalUrl: "https://udisc.com/events/warmup",
        venue: null,
        finished: true,
        results: [{ name: "Ada", place: 1, total: 54, toPar: -2, points: null, division: "SB" }],
      },
      {
        name: "Nov 8",
        date: "2026-11-08",
        externalUrl: "https://udisc.com/events/nov8",
        venue: "West Meadowbrook Park",
        finished: true,
        results: [
          { name: "Sean Gough", place: 1, total: 56, toPar: -9, points: null, division: "SB" },
          { name: "Ada", place: 2, total: 60, toPar: -5, points: null, division: "SB" },
        ],
      },
    ]);
    expect(standings?.mode).toBe("tags");
    expect(standings?.standings.map((row) => row.name)).toEqual(["Sean Gough", "Ada"]);
    const rows = [
      { member_id: null, name: "Ada", place: 1, to_par: -2, breakdown: JSON.stringify({ udisc_bag_tag: true, udisc_current: false }) },
      { member_id: null, name: "Sean Gough", place: 1, to_par: -9, breakdown: JSON.stringify({ udisc_bag_tag: true, udisc_current: true }) },
      { member_id: null, name: "Ada", place: 2, to_par: -5, breakdown: JSON.stringify({ udisc_bag_tag: true, udisc_current: true }) },
    ];
    const table = computeLeagueStandings(rows);
    expect(table.map((row) => row.name)).toEqual(["Sean Gough", "Ada"]);
    expect(table[0]?.current_place).toBe(1);
    expect(table[0]?.points).toBe(0);
    expect(table[1]?.events).toBe(2);
  });
});
