import assert from "node:assert/strict";
import test from "node:test";

import { applyOfficialRyderTally, mergeRyderCupData, officialRyderPlayerStandings, officialRyderTeamStandings, sidesOverlap, uiMatch } from "../src/public-app/ryder-board-merge.js";

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

test("sidesOverlap matches shortened sheet names to live card names", () => {
  assert.equal(sidesOverlap(["Kevin Gray", "David D"], ["David Doughtie", "Kevin Gray"]), true);
  assert.equal(sidesOverlap(["Mike Ellis", "Caleb Leggett"], ["Caleb Leggett", "Michael Ellis"]), true);
  assert.equal(sidesOverlap(["Jackie"], ["Jesus"]), false);
  assert.equal(sidesOverlap(["Jason Shirley", "Kevin Gray"], ["Jason Shirley", "Benitez"]), false);
});

test("mergeRyderCupData uses the sheet as the official tally and overlays live card links", () => {
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
        red: { name: "Juan Team", players: ["Sheet R"] },
        blue: { name: "Jesus Team", players: ["Sheet B"] },
      },
      teamPoints: { red: 80, blue: 76 },
      weeks: [
        { label: "Week 1", dates: "6/17", format: "singles", matches: [{ num: 1, red: "Sheet Juan", blue: "Sheet Jesus", score: "5&4", winner: "red" }, { num: 2, red: "Trap", blue: "PJ", score: "6&5" }] },
        { label: "Week 7", dates: "8/5", format: "singles", matches: [{ num: 1, red: "Jackie", blue: "Jesus", score: "" }] },
      ],
    },
  );

  assert.deepEqual(merged.teamPoints, { red: 80, blue: 76 });
  assert.equal(merged.scoreboard.red.name, "Juan Team");
  assert.deepEqual(merged.scoreboard.red.players, ["Sheet R"]);
  assert.equal(merged.officialPoints, true);
  assert.deepEqual(merged.weeks.map((week) => week.label), ["Week 1", "Week 7"]);
  assert.equal(merged.weeks[0].official, true);
  assert.equal(merged.weeks[0].source, "sheet");
  assert.equal(merged.weeks[0].matches[0].red, "Sheet Juan");
  assert.equal(merged.weeks[0].matches[0].score, "5&4");
  assert.equal(merged.weeks[0].matches[0].winner, "red");
  assert.equal(merged.weeks[0].matches[0].official, true);
  assert.equal(merged.weeks[0].matches[0].livePath, "score.html?event=1001");
  assert.equal(merged.weeks[0].matches[1].red, "Trap");
  assert.equal(merged.weeks[1].official, true);
  assert.equal(merged.weeks[1].source, "sheet");
  assert.equal(merged.weeks[1].matches[0].red, "Jackie");
});

test("mergeRyderCupData attaches unlabeled app cards onto the matching sheet match instead of duplicating", () => {
  const merged = mergeRyderCupData(
    {
      board: {
        scoreboard: { red: { name: "Juan Team", players: [] }, blue: { name: "Jesus Team", players: [] } },
        teamPoints: { red: 2, blue: 0 },
        weeks: [{
          label: "2026-07-04",
          dates: "2026-07-04",
          format: "doubles",
          official: true,
          matches: [{
            num: 1,
            red: ["Kevin Gray", "David Doughtie"],
            blue: ["Michael Ellis", "Caleb Leggett"],
            winner: "blue",
            official: true,
            livePath: "score.html?event=6",
          }],
        }],
      },
    },
    {
      weeks: [{
        label: "Week 3",
        format: "doubles",
        matches: [{ num: 5, red: "Kevin Gray / David D", blue: "Mike Ellis / Caleb Leggett", score: "3&2", redPlayers: ["Kevin Gray", "David D"], bluePlayers: ["Mike Ellis", "Caleb Leggett"] }],
      }],
      teamPoints: { red: 80, blue: 76 },
      scoreboard: { red: { name: "Juan Team", players: [] }, blue: { name: "Jesus Team", players: [] } },
    },
  );
  assert.deepEqual(merged.teamPoints, { red: 80, blue: 76 });
  assert.deepEqual(merged.weeks.map((week) => week.label), ["Week 3"]);
  assert.equal(merged.weeks[0].matches[0].livePath, "score.html?event=6");
  assert.equal(merged.weeks[0].matches[0].score, "3&2");
});

test("mergeRyderCupData does not attach a live card onto a different pairing or score", () => {
  const merged = mergeRyderCupData(
    {
      board: {
        scoreboard: { red: { name: "Juan Team", players: [] }, blue: { name: "Jesus Team", players: [] } },
        teamPoints: { red: 2, blue: 0 },
        weeks: [{
          label: "2026-07-26",
          format: "doubles",
          official: true,
          matches: [{
            num: 1,
            red: ["Jason Shirley", "Kevin Gray"],
            blue: ["Alex Donadio", "Eder Hernandez"],
            score: "1&0",
            winner: "red",
            official: true,
            livePath: "score.html?event=1020",
          }],
        }],
      },
    },
    {
      weeks: [{
        label: "Week 3",
        format: "doubles",
        matches: [{
          num: 4,
          red: "Jason Shirley / Benitez",
          blue: "Alex Donadio / Eder H",
          score: "3&2",
          redPlayers: ["Jason Shirley", "Benitez"],
          bluePlayers: ["Alex Donadio", "Eder H"],
        }],
      }],
      teamPoints: { red: 80, blue: 76 },
      scoreboard: { red: { name: "Juan Team", players: [] }, blue: { name: "Jesus Team", players: [] } },
    },
  );
  assert.equal(merged.weeks[0].matches[0].livePath, "");
  assert.equal(merged.weeks[1].label, "2026-07-26");
  assert.equal(merged.weeks[1].matches[0].livePath, "score.html?event=1020");
});

test("official Ryder standings use sheet points and skip leftover fill-only winners", () => {
  const tally = {
    scoreboard: { red: { name: "Juan Team" }, blue: { name: "Jesus Team" } },
    teamPoints: { red: 80, blue: 76 },
    weeks: [
      {
        source: "sheet",
        matches: [
          { num: 1, red: "Juan", blue: "Jesus", score: "1&0", winner: "blue", redPlayers: ["Juan"], bluePlayers: ["Jesus"] },
          { num: 2, red: "Trap", blue: "PJ", score: "", winner: "red", redPlayers: ["Trap"], bluePlayers: ["PJ"] },
        ],
      },
    ],
  };
  const teams = officialRyderTeamStandings(tally);
  assert.equal(teams[0].teamName, "Juan Team");
  assert.deepEqual(teams.map((team) => [team.team, team.points, team.wins, team.losses]), [
    ["Red", 80, 0, 1],
    ["Blue", 76, 1, 0],
  ]);
  const players = officialRyderPlayerStandings(tally.weeks);
  assert.deepEqual(players.map((player) => [player.name, player.points, player.wins, player.events]), [
    ["Jesus", 2, 1, 1],
    ["Juan", 0, 0, 1],
  ]);
});

test("applyOfficialRyderTally overlays sheet points and hides D1 numbers until the sheet loads", () => {
  const leagues = [{
    league: { id: 4, name: "Ryder Cup", season: "2026" },
    teamStandings: [{ team: "Blue", teamName: "Jesus Team", points: 21, wins: 10, ties: 1, losses: 9 }],
    standings: [{ name: "Caleb Leggett", points: 5, events: 3, wins: 2 }],
  }, {
    league: { id: 9, name: "Other League" },
    teamStandings: [{ team: "A", points: 12 }],
    standings: [],
  }];

  const pending = applyOfficialRyderTally(leagues, undefined);
  assert.equal(pending[0].officialSheet, true);
  assert.equal(pending[0].officialPending, true);
  assert.deepEqual(pending[0].teamStandings, []);
  assert.deepEqual(pending[0].standings, []);
  assert.deepEqual(pending[1].teamStandings, [{ team: "A", points: 12 }]);

  const failed = applyOfficialRyderTally(leagues, null);
  assert.equal(failed[0].officialError, true);
  assert.deepEqual(failed[0].teamStandings, []);

  const ready = applyOfficialRyderTally(leagues, {
    scoreboard: { red: { name: "Juan Team" }, blue: { name: "Jesus Team" } },
    teamPoints: { red: 80, blue: 76 },
    weeks: [],
  });
  assert.equal(ready[0].officialPending, false);
  assert.equal(ready[0].officialError, false);
  assert.deepEqual(ready[0].teamStandings.map((team) => [team.team, team.points]), [
    ["Red", 80],
    ["Blue", 76],
  ]);
  assert.deepEqual(ready[0].standings, []);
});

test("mergeRyderCupData keeps leftover live weeks that do not match the sheet", () => {
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
          matches: [{ num: 1, red: ["Nobody", "Else"], blue: ["Unlisted", "Pair"], winner: "red", official: true, livePath: "score.html?event=1020" }],
        }],
      },
    },
    { weeks: [{ label: "Week 1", format: "singles", matches: [{ num: 1, red: "Juan", blue: "Jesus", score: "1&0" }] }], teamPoints: { red: 80, blue: 76 }, scoreboard: { red: { name: "Red", players: [] }, blue: { name: "Blue", players: [] } } },
  );
  assert.deepEqual(merged.weeks.map((week) => week.label), ["Week 1", "2026-07-26"]);
  assert.equal(merged.weeks[1].official, false);
  assert.equal(merged.teamPoints.red, 80);
});
