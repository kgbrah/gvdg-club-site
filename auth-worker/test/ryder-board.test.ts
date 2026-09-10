import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
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
      num: 1,
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
      num: 1,
      red: ["Jackie"],
      blue: ["Jesus"],
      score: "",
      winner: null,
      official: false,
      livePath: "score.html?event=88",
    });
  });
});

function kv() {
  const rows = new Map<string, string>();
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
  };
}

function leagueDb(state: { league: Record<string, unknown> | null; events: Record<string, unknown>[]; rows: Record<string, unknown>[] }) {
  return {
    prepare: (sql: string) => {
      let binds: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          binds = values;
          return this;
        },
        first: async () => {
          if (/FROM leagues WHERE id = \?/i.test(sql)) {
            return binds[0] === 4 ? state.league : null;
          }
          return null;
        },
        all: async () => {
          if (/FROM results r JOIN events e/i.test(sql)) return { results: state.rows, success: true };
          if (/FROM events WHERE league_id = \?/i.test(sql)) return { results: state.events, success: true };
          return { results: [], success: true };
        },
        run: async () => ({ results: [], success: true }),
      };
    },
  };
}

describe("GET /leagues/4 includes the official board", () => {
  it("attaches board for Ryder Cup", async () => {
    const events = [
      { id: 1001, name: "Ryder Cup Week 1 #1 — Juan Martinez vs Jesus", date: "2026-06-17", status: "final", format: "matchplay" },
    ];
    const rows = [
      { event_id: 1001, member_id: null, name: "Jesus", place: 1, to_par: null, match_result: mr("won"), scoring_group: sg("Blue", "Jesus Team", ["Jesus"]) },
      { event_id: 1001, member_id: null, name: "Juan Martinez", place: 2, to_par: null, match_result: mr("lost"), scoring_group: sg("Red", "Juan Team", ["Juan Martinez"]) },
    ];
    const env = {
      ROSTER: kv(),
      RATELIMIT: kv(),
      DB: leagueDb({ league: { id: 4, name: "Ryder Cup", format: "matchplay" }, events, rows }),
      JWT_SECRET: "x".repeat(40),
      ALLOWED_ORIGINS: "http://localhost:8080",
      LIVE: undefined,
    } as unknown as Parameters<typeof worker.fetch>[1];

    const res = await worker.fetch(new Request("https://w/leagues/4", { headers: { Origin: "http://localhost:8080" } }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { board?: { teamPoints?: { red: number; blue: number }; weeks?: { label: string }[] } };
    expect(body.board?.teamPoints).toEqual({ red: 0, blue: 2 });
    expect(body.board?.weeks?.map((week) => week.label)).toEqual(["Week 1"]);
  });
});
