import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  clusterPlayerNames,
  compactPlayerName,
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
  assert.equal(playersMatch("Jackie", "Jarrett Wallace"), true);
  assert.equal(playersMatch("Juan", 'Juan "Him" Martinez'), true);
  assert.equal(playersMatch("Jeff", "Jeff Stelly"), true);
  assert.equal(playersMatch("TJ", "Tj Braley"), true);
});

test("distinct players stay distinct", () => {
  assert.equal(playersMatch("Eric Davis", "Eric LaRoque"), false);
  assert.equal(playersMatch("Leo H.", "Eder Hernandez"), false);
  assert.equal(playersMatch("Jesus", "Jackie"), false);
  assert.equal(playersMatch("Jackie", "Jesus"), false);
  assert.equal(playersMatch("Jackie", "Jarrett Gaskins"), false);
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
  assert.equal(resolvePlayerName("Jackie", ROSTER), "Jarrett Wallace");
  assert.equal(resolvePlayerName("Juan", ROSTER), 'Juan "Him" Martinez');
  assert.equal(preferredPlayerName(["Jackie", "Jarrett Wallace"]), "Jarrett Wallace");
  assert.equal(preferredPlayerName(["Schwarga", "Alex Schwarga"]), "Alex Schwarga");
});

test("Jackie folds into Jarrett Wallace on the 24-player Ryder roster", () => {
  const names = [
    ...ROSTER,
    "Jackie",
    "TJ Braley",
    "Schwarga",
    "Eder H",
    "Trap",
    "Vee",
    "Juan",
  ];
  const clustered = clusterPlayerNames(names);
  const unified = [...new Set(ROSTER.map((name) => clustered.get(name)))];
  assert.equal(unified.length, 24);
  assert.equal(clustered.get("Jackie"), "Jarrett Wallace");
  assert.equal(clustered.get("TJ Braley"), clustered.get("Tj Braley"));
  assert.equal(resolvePlayerName("TJ Braley", ROSTER), "Tj Braley");
  assert.equal(clustered.get("Juan"), 'Juan "Him" Martinez');
});

test("empty compact names and CJK names stay distinct", () => {
  assert.equal(compactPlayerName("李"), "李");
  assert.equal(compactPlayerName("王伟"), "王伟");
  assert.equal(compactPlayerName("???"), "");
  assert.equal(compactPlayerName("José García"), "josegarcia");
  assert.equal(compactPlayerName("Jose Garcia"), "josegarcia");

  assert.equal(playersMatch("李", "王伟"), false);
  assert.equal(playersMatch("李", "李"), true);
  assert.equal(playersMatch("王伟", "王 伟"), true);
  assert.equal(playersMatch("???", "***"), false);
  assert.equal(playersMatch("???", "???"), false);
  assert.equal(playersMatch("José García", "Jose Garcia"), true);

  const clustered = clusterPlayerNames(["李", "王伟", "???", "***"]);
  assert.equal(clustered.get("李"), "李");
  assert.equal(clustered.get("王伟"), "王伟");
  assert.notEqual(clustered.get("李"), clustered.get("王伟"));
});

test("JS and worker player-identity keep Unicode compact folding in sync", () => {
  const js = readFileSync(new URL("../src/shared/player-identity.js", import.meta.url), "utf8");
  const ts = readFileSync(new URL("../auth-worker/src/player-identity.ts", import.meta.url), "utf8");
  for (const source of [js, ts]) {
    assert.match(source, /function foldLetters/);
    assert.match(source, /normalize\("NFKD"\)/);
    assert.match(source, /\\p\{L\}\\p\{N\}/);
    assert.match(source, /compactA && compactB && compactA === compactB/);
    assert.match(source, /if \(!compact\) continue/);
  }
});
