import { describe, expect, it } from "vitest";
import { buildRyderCupBoard } from "../src/ryder-board.js";

const sg = (label: string, teamName: string, members: string[]) =>
  JSON.stringify({ label, teamName, members });
const mr = (outcome: "won" | "lost" | "draw", status = "won 1&0") =>
  JSON.stringify({ status: outcome === "draw" ? "AS" : status, outcome });

describe("buildRyderCupBoard from live league results", () => {
  it("maps week 1 singles, week 2 doubles, and unnamed July dubs onto official weeks", () => {
    const events = [
      { id: 1001, name: "Ryder Cup Week 1 #1 — Juan Martinez vs Jesus", date: "2026-06-17", status: "final", format: "matchplay" },
      { id: 1013, name: "Ryder Cup Week 2 #1 — Juan Martinez & Jarrett Wallace vs Jesus & Castro", date: "2026-06-24", status: "final", format: "matchplay" },
      { id: 1020, name: "Eder/Alex vs kg/Jason Ryder Cup MATCHPLAY DUBS", date: "2026-07-26", status: "final", format: "matchplay" },
    ];
    const rows = [
      { event_id: 1001, name: "Jesus", match_result: mr("won"), scoring_group: sg("Blue", "Jesus Team", ["Jesus"]) },
      { event_id: 1001, name: "Juan Martinez", match_result: mr("lost"), scoring_group: sg("Red", "Juan Team", ["Juan Martinez"]) },
      { event_id: 1013, name: "Jesus", match_result: mr("won"), scoring_group: sg("Blue", "Jesus Team", ["Jesus", "Castro"]) },
      { event_id: 1013, name: "Castro", match_result: mr("won"), scoring_group: sg("Blue", "Jesus Team", ["Jesus", "Castro"]) },
      { event_id: 1013, name: "Juan Martinez", match_result: mr("lost"), scoring_group: sg("Red", "Juan Team", ["Juan Martinez", "Jarrett Wallace"]) },
      { event_id: 1013, name: "Jarrett Wallace", match_result: mr("lost"), scoring_group: sg("Red", "Juan Team", ["Juan Martinez", "Jarrett Wallace"]) },
      { event_id: 1020, name: "Jason Shirley", match_result: mr("won"), scoring_group: JSON.stringify({ targetId: "pair:red", targetType: "pair", label: "Red", members: ["Jason Shirley", "Kevin Gray"] }) },
      { event_id: 1020, name: "Kevin Gray", match_result: mr("won"), scoring_group: JSON.stringify({ targetId: "pair:red", targetType: "pair", label: "Red", members: ["Jason Shirley", "Kevin Gray"] }) },
      { event_id: 1020, name: "Alex Donadio", match_result: mr("lost"), scoring_group: JSON.stringify({ targetId: "pair:blue", targetType: "pair", label: "Blue", members: ["Alex Donadio", "Eder Hernandez"] }) },
      { event_id: 1020, name: "Eder Hernandez", match_result: mr("lost"), scoring_group: JSON.stringify({ targetId: "pair:blue", targetType: "pair", label: "Blue", members: ["Alex Donadio", "Eder Hernandez"] }) },
    ];

    const board = buildRyderCupBoard(events, rows);
    expect(board.teamPoints).toEqual({ red: 2, blue: 4 });
    expect(board.scoreboard.red.name).toBe("Juan Team");
    expect(board.scoreboard.blue.name).toBe("Jesus Team");
    expect(board.weeks.map((week) => week.label)).toEqual(["Week 1", "Week 2", "2026-07-26"]);

    const week1 = board.weeks[0]!;
    expect(week1.official).toBe(true);
    expect(week1.format).toBe("singles");
    expect(week1.matches[0]).toMatchObject({
      eventId: 1001,
      num: 1,
      red: ["Juan Martinez"],
      blue: ["Jesus"],
      score: "1&0",
      winner: "blue",
      official: true,
      livePath: "score.html?event=1001",
    });

    const week2 = board.weeks[1]!;
    expect(week2.format).toBe("doubles");
    expect(week2.matches[0]).toMatchObject({
      eventId: 1013,
      num: 1,
      red: ["Juan Martinez", "Jarrett Wallace"],
      blue: ["Jesus", "Castro"],
      winner: "blue",
      official: true,
    });

    const july = board.weeks[2]!;
    expect(july.format).toBe("doubles");
    expect(july.matches[0]).toMatchObject({
      eventId: 1020,
      red: ["Jason Shirley", "Kevin Gray"],
      blue: ["Alex Donadio", "Eder Hernandez"],
      winner: "red",
      official: true,
    });
  });

  it("keeps unfinished live cards unofficial and score-empty", () => {
    const board = buildRyderCupBoard(
      [{ id: 88, name: "Ryder Cup Week 7 #1 — Jackie vs Jesus", date: "2026-09-10", status: "live", format: "matchplay" }],
      [],
    );
    expect(board.teamPoints).toEqual({ red: 0, blue: 0 });
    expect(board.weeks[0]).toMatchObject({ label: "Week 7", official: false });
    expect(board.weeks[0]!.matches[0]).toMatchObject({
      eventId: 88,
      red: ["Jackie"],
      blue: ["Jesus"],
      score: "",
      winner: null,
      official: false,
      livePath: "score.html?event=88",
    });
  });
});
