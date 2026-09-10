import assert from "node:assert/strict";
import test from "node:test";

import { mergeRyderCupData, uiMatch } from "../src/public-app/ryder-board-merge.js";

test("uiMatch flattens live name arrays onto the sheet card shape", () => {
  const match = uiMatch({
    num: 1,
    red: ["Juan Martinez", "Jarrett Wallace"],
    blue: ["Jesus", "Castro"],
    score: "1&0",
    winner: "blue",
    official: true,
    livePath: "score.html?event=1013",
    eventId: 1013,
  });
  assert.equal(match.red, "Juan Martinez");
  assert.equal(match.blue, "Jesus");
  assert.deepEqual(match.redPlayers, ["Juan Martinez", "Jarrett Wallace"]);
  assert.equal(match.livePath, "score.html?event=1013");
});

test("mergeRyderCupData uses live points and live weeks as official, sheet weeks as fill-in", () => {
  const merged = mergeRyderCupData(
    {
      board: {
        scoreboard: {
          red: { name: "Juan Team", players: ["Juan Martinez"] },
          blue: { name: "Jesus Team", players: ["Jesus"] },
        },
        teamPoints: { red: 19, blue: 21 },
        weeks: [
          {
            label: "Week 1",
            dates: "2026-06-17",
            format: "singles",
            official: true,
            matches: [{ num: 1, red: ["Juan Martinez"], blue: ["Jesus"], score: "1&0", winner: "blue", official: true, livePath: "score.html?event=1001", eventId: 1001 }],
          },
        ],
      },
    },
    {
      scoreboard: {
        red: { name: "Sheet Red", players: ["Sheet R"] },
        blue: { name: "Sheet Blue", players: ["Sheet B"] },
      },
      teamPoints: { red: 80, blue: 76 },
      weeks: [
        { label: "Week 1", dates: "6/17", format: "singles", matches: [{ num: 1, red: "Sheet Juan", blue: "Sheet Jesus", score: "5&4" }, { num: 2, red: "Trap", blue: "PJ", score: "" }] },
        { label: "Week 7", dates: "8/5", format: "singles", matches: [{ num: 1, red: "Jackie", blue: "Jesus", score: "" }] },
      ],
    },
  );

  assert.deepEqual(merged.teamPoints, { red: 19, blue: 21 });
  assert.equal(merged.scoreboard.red.name, "Juan Team");
  assert.equal(merged.officialPoints, true);
  assert.deepEqual(merged.weeks.map((week) => week.label), ["Week 1", "Week 7"]);
  assert.equal(merged.weeks[0].official, true);
  assert.equal(merged.weeks[0].source, "live");
  assert.equal(merged.weeks[0].matches[0].red, "Juan Martinez");
  assert.equal(merged.weeks[0].matches[0].official, true);
  assert.equal(merged.weeks[0].matches[1].red, "Trap");
  assert.equal(merged.weeks[0].matches[1].official, false);
  assert.equal(merged.weeks[1].official, false);
  assert.equal(merged.weeks[1].source, "sheet");
  assert.equal(merged.weeks[1].matches[0].red, "Jackie");
});

test("mergeRyderCupData keeps extra live weeks that the sheet does not have", () => {
  const merged = mergeRyderCupData(
    {
      board: {
        scoreboard: { red: { name: "Juan Team", players: [] }, blue: { name: "Jesus Team", players: [] } },
        teamPoints: { red: 2, blue: 0 },
        weeks: [{
          label: "2026-07-26",
          dates: "2026-07-26",
          format: "doubles",
          official: true,
          matches: [{ num: 1, red: ["Jason Shirley", "Kevin Gray"], blue: ["Alex Donadio", "Eder Hernandez"], winner: "red", official: true, livePath: "score.html?event=1020" }],
        }],
      },
    },
    { weeks: [{ label: "Week 1", format: "singles", matches: [] }], teamPoints: { red: 80, blue: 76 }, scoreboard: { red: { name: "Red", players: [] }, blue: { name: "Blue", players: [] } } },
  );
  assert.deepEqual(merged.weeks.map((week) => week.label), ["Week 1", "2026-07-26"]);
  assert.equal(merged.weeks[1].official, true);
  assert.equal(merged.teamPoints.red, 2);
});
