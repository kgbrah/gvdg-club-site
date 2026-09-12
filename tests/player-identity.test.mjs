import assert from "node:assert/strict";
import test from "node:test";

import {
  clusterPlayerNames,
  playersMatch,
  preferredPlayerName,
  resolvePlayerName,
} from "../src/shared/player-identity.js";

const ROSTER = [
  'Juan "Him" Martinez',
  "Jarrett Wallace",
  "Mike Fazzini",
  "Tj Braley",
  "Joshua Willoughby",
  'Travis "Trap" Sherrod',
  "Jason Shirley",
  "Kevin Gray",
  "Jonathan Benitez",
  "Jeff Stelly",
  "David Doughtie",
  "Eric Davis",
  "Jesus",
  'Jon " Vee if your nasty"',
  'Daniel " Flex King" Castro',
  "Blake Sargent",
  "Alex Schwarga",
  'P.J. " Where\'s my fuse" Corbett',
  "Alex Donadio",
  "Eder Hernandez",
  "Michael Ellis",
  "Caleb Leggett",
  "Eric LaRoque",
  "Leo Hernandez",
];

test("compact aliases and nicknames match the same player", () => {
  assert.equal(playersMatch("Tj Braley", "TJ Braley"), true);
  assert.equal(playersMatch("T.J. Braley", "TJ Braley"), true);
  assert.equal(playersMatch("Schwarga", "Alex Schwarga"), true);
  assert.equal(playersMatch("Eder H", "Eder Hernandez"), true);
  assert.equal(playersMatch("David D.", "David Doughtie"), true);
  assert.equal(playersMatch("Blake S", "Blake Sargent"), true);
  assert.equal(playersMatch("Willoughby", "Joshua Willoughby"), true);
  assert.equal(playersMatch("Stelly", "Jeff Stelly"), true);
  assert.equal(playersMatch("Jeff Stelly", "Jeffrey Stelly"), true);
  assert.equal(playersMatch("Mike Ellis", "Michael Ellis"), true);
  assert.equal(playersMatch("Leo H.", "Leo Hernandez"), true);
  assert.equal(playersMatch("Benitez", "Jonathan Benitez"), true);
  assert.equal(playersMatch("Castro", 'Daniel " Flex King" Castro'), true);
  assert.equal(playersMatch("Trap", 'Travis "Trap" Sherrod'), true);
  assert.equal(playersMatch("Vee", 'Jon " Vee if your nasty"'), true);
  assert.equal(playersMatch("PJ Corbett", "P.J. Corbett"), true);
  assert.equal(playersMatch("PJ Corbett", 'P.J. " Where\'s my fuse" Corbett'), true);
  assert.equal(playersMatch("Juan Martinez", 'Juan "Him" Martinez'), true);
});

test("distinct players stay distinct", () => {
  assert.equal(playersMatch("Eric Davis", "Eric LaRoque"), false);
  assert.equal(playersMatch("Leo H.", "Eder Hernandez"), false);
  assert.equal(playersMatch("Jesus", "Jackie"), false);
  assert.equal(playersMatch("Alex Donadio", "Alex Schwarga"), false);
  assert.equal(playersMatch("T.J. Braley", "T.J. Williams"), false);
  assert.equal(playersMatch("David D.", "David Doughtie"), true);
  assert.equal(playersMatch("David D.", "David Davenport"), true);
});

test("cluster prefers the fuller name and leaves ambiguous Davids split", () => {
  const clustered = clusterPlayerNames([
    "Tj Braley",
    "TJ Braley",
    "Schwarga",
    "Alex Schwarga",
    "Eder H",
    "Eder Hernandez",
    "Alex Donadio",
    "Jason Shirley",
    "David D.",
    "David Doughtie",
    "David Davenport",
  ]);
  assert.equal(clustered.get("Tj Braley"), clustered.get("TJ Braley"));
  assert.equal(clustered.get("Schwarga"), "Alex Schwarga");
  assert.equal(clustered.get("Eder H"), "Eder Hernandez");
  assert.equal(clustered.get("David Doughtie"), "David Doughtie");
  assert.equal(clustered.get("David Davenport"), "David Davenport");
  assert.equal(clustered.get("David D."), "David D.");

  const oneDavid = clusterPlayerNames(["David D.", "David Doughtie"]);
  assert.equal(oneDavid.get("David D."), "David Doughtie");
});

test("resolvePlayerName maps sheet nicknames onto the Ryder roster", () => {
  assert.equal(resolvePlayerName("Schwarga", ROSTER), "Alex Schwarga");
  assert.equal(resolvePlayerName("TJ Braley", ROSTER), "Tj Braley");
  assert.equal(resolvePlayerName("Eder H", ROSTER), "Eder Hernandez");
  assert.equal(resolvePlayerName("Leo H.", ROSTER), "Leo Hernandez");
  assert.equal(resolvePlayerName("David D.", ROSTER), "David Doughtie");
  assert.equal(resolvePlayerName("Trap", ROSTER), 'Travis "Trap" Sherrod');
  assert.equal(resolvePlayerName("Vee", ROSTER), 'Jon " Vee if your nasty"');
  assert.equal(resolvePlayerName("Benitez", ROSTER), "Jonathan Benitez");
  assert.equal(resolvePlayerName("Blake S", ROSTER), "Blake Sargent");
  assert.equal(resolvePlayerName("PJ Corbett", ROSTER), 'P.J. " Where\'s my fuse" Corbett');
  assert.equal(resolvePlayerName("Juan Martinez", ROSTER), 'Juan "Him" Martinez');
  assert.equal(preferredPlayerName(["Schwarga", "Alex Schwarga"]), "Alex Schwarga");
});
