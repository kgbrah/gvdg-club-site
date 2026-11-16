import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("bag tags show on the events hub, member home, and admin club tools", () => {
  const events = readFileSync("events.html", "utf8");
  const publicMain = readFileSync("src/public-app/main.js", "utf8");
  const board = readFileSync("src/public-app/events-bag-tags-app.js", "utf8");
  const members = readFileSync("src/members-app/overview-dashboard.js", "utf8");
  const panel = readFileSync("src/members-app/bag-tag-panel.js", "utf8");
  const admin = readFileSync("admin.html", "utf8");
  const nav = readFileSync("src/shared/app-navigation.js", "utf8");
  const adminPanel = readFileSync("src/admin-app/bag-tags-panel.js", "utf8");

  assert.match(events, /body\[data-events-view="hub"\] #bagTagsSection/);
  assert.match(events, /id="bagTagsSection"/);
  assert.match(publicMain, /EventsBagTagsApp/);
  assert.match(board, /[Ll]ower number is better/);
  assert.match(members, /BagTagPanel/);
  assert.match(panel, /\/bag-tags\/challenges/);
  assert.match(panel, /\/bag-tags\/request/);
  assert.match(panel, /bag-tag-home/);
  assert.match(panel, /player-job-link/);
  assert.match(panel, /"aria-label": "Request a tag"/);
  assert.doesNotMatch(panel, /className: "player-btn primary"[\s\S]{0,160}Request a tag/);
  assert.match(panel, /Request sent\. An admin will hand you the next number\./);
  assert.doesNotMatch(panel, /Ask an admin for a tag/);
  assert.match(panel, /BagTagLeagueOrder/);
  assert.match(readFileSync("src/members-app/club-leagues.js", "utf8"), /data-react-league-schedule/);
  assert.match(readFileSync("src/members-app/club-leagues.js", "utf8"), /Sign up/);
  assert.match(readFileSync("src/members-app/dashboard-app.js", "utf8"), /LeagueSchedule/);
  assert.match(admin, /body\[data-admin-tab="bag-tags"\] #apane-bag-tags/);
  assert.match(admin, /id="adminBagTagsReactApp"/);
  assert.match(nav, /entry\("bag-tags", "Bag tags", "more"/);
  assert.match(adminPanel, /Settle this card/);
  assert.match(adminPanel, /Next new player is #/);
  assert.match(adminPanel, /Give #\$\{nextTag\}/);
});

test("league bag-tag ladders get their own challenges, the UDisc note, the no-tag hint, and an admin cancel", () => {
  const panel = readFileSync("src/members-app/bag-tag-panel.js", "utf8");
  const adminPanel = readFileSync("src/admin-app/bag-tags-panel.js", "utf8");
  assert.match(panel, /Imported from UDisc\. The ladder resets to UDisc's order at each import \(Sundays 3pm\)\. Record challenge results in UDisc to keep them\./);
  assert.match(panel, /Challenges unlock once you hold a tag\. Request a club tag, or join a bag-tag league\./);
  assert.match(panel, /leagueId/);
  assert.match(panel, /App challenge \(not in UDisc\)/);
  assert.match(adminPanel, /\/admin\/bag-tags\/challenges\/\$\{challenge\.id\}\/cancel/);
  assert.match(adminPanel, /Filter by series/);
});
