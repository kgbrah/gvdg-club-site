import { describe, expect, it } from "vitest";
import { computeLeagueStandings } from "../src/scoring.js";

const win = JSON.stringify({ status: "won 3&2", outcome: "won" });
const loss = JSON.stringify({ status: "lost 3&2", outcome: "lost" });

function row(name: string, memberId: string | null, outcome: string) {
  return {
    member_id: memberId,
    name,
    place: outcome === win ? 1 : 2,
    to_par: 0,
    match_result: outcome,
  };
}

describe("computeLeagueStandings unifies nickname and member/guest splits", () => {
  it("merges the fractured Ryder Cup player-record spellings", () => {
    const standings = computeLeagueStandings([
      row("Tj Braley", "tj", win),
      row("Tj Braley", "tj", win),
      row("TJ Braley", null, win),
      row("Alex Donadio", "ad", win),
      row("Alex Donadio", "ad", win),
      row("Alex Donadio", null, loss),
      row("Schwarga", null, win),
      row("Alex Schwarga", "as", loss),
      row("Eder H", null, win),
      row("Eder Hernandez", "eh", loss),
      row("Jason Shirley", "js", win),
      row("Jason Shirley", null, loss),
      row("David D.", null, loss),
      row("David Doughtie", "dd", loss),
      row("Benitez", null, win),
      row("Trap", null, win),
      row("Jackie", null, win),
      row("Jarrett Wallace", "jw", loss),
    ]);

    const byName = Object.fromEntries(standings.map((row) => [row.name, row]));
    expect(standings.filter((row) => /braley/i.test(row.name))).toHaveLength(1);
    expect(standings.filter((row) => /donadio/i.test(row.name))).toHaveLength(1);
    expect(standings.filter((row) => /schwarga/i.test(row.name))).toHaveLength(1);
    expect(standings.filter((row) => /eder/i.test(row.name))).toHaveLength(1);
    expect(standings.filter((row) => /shirley/i.test(row.name))).toHaveLength(1);
    expect(standings.filter((row) => /doughtie|david d/i.test(row.name))).toHaveLength(1);

    expect(byName["Tj Braley"] || byName["TJ Braley"]).toMatchObject({ events: 3, wins: 3, points: 6, member_id: "tj" });
    expect(byName["Alex Donadio"]).toMatchObject({ events: 3, wins: 2, points: 4, member_id: "ad" });
    expect(byName["Alex Schwarga"]).toMatchObject({ events: 2, wins: 1, points: 2, member_id: "as" });
    expect(byName["Eder Hernandez"]).toMatchObject({ events: 2, wins: 1, points: 2, member_id: "eh" });
    expect(byName["Jason Shirley"]).toMatchObject({ events: 2, wins: 1, points: 2, member_id: "js" });
    expect(byName["David Doughtie"]).toMatchObject({ events: 2, wins: 0, points: 0, member_id: "dd" });
    expect(byName["Benitez"] || byName["Jonathan Benitez"]).toMatchObject({ events: 1, wins: 1, points: 2 });
    expect(byName["Trap"]).toMatchObject({ events: 1, wins: 1, points: 2 });
    expect(byName["Jarrett Wallace"]).toMatchObject({ events: 2, wins: 1, points: 2, member_id: "jw" });
    expect(standings.filter((row) => /jackie|jarrett/i.test(row.name))).toHaveLength(1);
  });

  it("does not merge two different member ids even with matching names", () => {
    const standings = computeLeagueStandings([
      { member_id: "a", name: "Alex Donadio", place: 1, to_par: 0, match_result: win },
      { member_id: "b", name: "Alex Donadio", place: 2, to_par: 0, match_result: loss },
    ]);
    expect(standings).toHaveLength(2);
    expect(standings.map((row) => row.member_id).sort()).toEqual(["a", "b"]);
  });

  it("leaves David D. split when two Davids are in the field", () => {
    const standings = computeLeagueStandings([
      { member_id: "dd", name: "David Doughtie", place: 2, to_par: 0, match_result: loss },
      { member_id: "dv", name: "David Davenport", place: 2, to_par: 0, match_result: loss },
      { member_id: null, name: "David D.", place: 2, to_par: 0, match_result: loss },
    ]);
    expect(standings).toHaveLength(3);
    expect(standings.find((row) => row.name === "David D.")?.member_id ?? null).toBeNull();
  });
});
