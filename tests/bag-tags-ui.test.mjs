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
  const nav = readFileSync("src/admin-app/navigation.js", "utf8");
  const adminPanel = readFileSync("src/admin-app/bag-tags-panel.js", "utf8");

  assert.match(events, /body\[data-events-view="hub"\] #bagTagsSection/);
  assert.match(events, /id="bagTagsSection"/);
  assert.match(publicMain, /EventsBagTagsApp/);
  assert.match(board, /Lower number is better/);
  assert.match(members, /BagTagPanel/);
  assert.match(panel, /\/bag-tags\/challenges/);
  assert.match(panel, /must_challenge_better_tag/);
  assert.match(admin, /body\[data-admin-tab="bag-tags"\] #apane-bag-tags/);
  assert.match(admin, /id="adminBagTagsReactApp"/);
  assert.match(nav, /tab: "bag-tags", label: "Bag tags"/);
  assert.match(adminPanel, /Settle this card/);
  assert.match(adminPanel, /Next new player is #/);
});
