import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  bucketAdminEvents,
  calendarEntries,
  displayEventTitle,
  formatAdminEventWhen,
  normalizeAdminEvent,
  pickTodayEvent,
} from "../src/admin-app/admin-events-model.js";
import { clubToday } from "../src/shared/events-model.js";

test("admin event buckets put live first and keep scheduled upcoming", () => {
  const today = clubToday();
  const yesterday = clubToday(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const lastMonth = clubToday(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const nextWeek = clubToday(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  const live = normalizeAdminEvent({ id: 1, name: "Live dubs", status: "live", date: yesterday, starts_at: `${yesterday}T12:15:00.000Z` });
  const later = normalizeAdminEvent({ id: 2, name: "Next week", status: "scheduled", date: nextWeek });
  const done = normalizeAdminEvent({ id: 3, name: "Done", status: "final", date: lastMonth });
  const buckets = bucketAdminEvents([later, done, live]);
  assert.equal(buckets.live[0].id, "1");
  assert.equal(buckets.upcoming[0].id, "2");
  assert.equal(buckets.past[0].id, "3");
  assert.equal(pickTodayEvent([later, live]).id, "1");
  const laterSameStatus = normalizeAdminEvent({ id: 4, name: "Later", status: "scheduled", date: "2026-12-01" });
  const todaysRound = normalizeAdminEvent({ id: 5, name: "Today's round", status: "scheduled", date: today });
  assert.equal(pickTodayEvent([laterSameStatus, todaysRound]).id, "5");
  assert.match(formatAdminEventWhen(live), /[A-Z][a-z]{2}/);
});

test("a repeated league prefix is shown once", () => {
  assert.equal(displayEventTitle("Sunday Baggers - Sunday Baggers Nov 8th"), "Sunday Baggers Nov 8th");
  assert.equal(displayEventTitle("Sunday Baggers – Sunday Baggers"), "Sunday Baggers");
  assert.equal(displayEventTitle("Farm Open"), "Farm Open");
  assert.equal(displayEventTitle("Red - Blue"), "Red - Blue");
});

test("the calendar keeps campaigns and minutes beside rounds", () => {
  const round = normalizeAdminEvent({ id: 9, name: "Saturday league", status: "scheduled", type: "league_round", date: "2026-11-07" });
  const rows = calendarEntries([round], {
    fundraisers: [{ id: 3, title: "Baskets", status: "active", starts_at: "2026-11-01" }],
    meetings: [{ id: 4, title: "Board", date: "2026-11-10" }],
  }, "2026-11-02");
  assert.deepEqual(rows.map((row) => [row.kind, row.bucket, row.name]), [
    ["event", "rounds", "Saturday league"],
    ["campaign", "fundraiser", "Baskets"],
    ["minutes", "meeting", "Board"],
  ]);
});

test("admin today, more, and player theme are wired into the admin shell", () => {
  const html = readFileSync("admin.html", "utf8");
  const main = readFileSync("src/admin-app/main.js", "utf8");
  const chrome = readFileSync("src/admin-app/page-chrome.js", "utf8");
  const today = readFileSync("src/admin-app/today-dashboard.js", "utf8");
  const more = readFileSync("src/admin-app/more-page.js", "utf8");
  const nav = readFileSync("src/admin-app/navigation.js", "utf8");
  const list = readFileSync("src/admin-app/events-list.js", "utf8");

  assert.match(html, /body\.player-theme-page/);
  assert.match(html, /body\.player-theme-active/);
  assert.match(html, /--player-theme-image/);
  assert.match(html, /id="adminTodayReactApp"/);
  assert.match(html, /id="adminMoreReactApp"/);
  assert.match(html, /\.admin-dock \{/);
  assert.match(more, /from "\.\.\/shared\/player-theme-session\.js"/);
  assert.match(more, /PlayerThemeToggle/);
  assert.match(more, /paintPlayerTheme\(null, themeRoot\(\)\)/);
  assert.match(main, /import \{ AdminTodayDashboard \} from "\.\/today-dashboard\.js"/);
  assert.match(main, /import \{ AdminMorePage \} from "\.\/more-page\.js"/);
  assert.match(today, /export function AdminTodayDashboard/);
  assert.match(today, /Start scoring/);
  assert.match(today, /Live scoring/);
  assert.match(today, /eventId: event\.id/);
  assert.match(today, /eventId: next\.id/);
  assert.match(more, /export function AdminMorePage/);
  assert.match(nav, /ADMIN_PRIMARY/);
  assert.match(list, /Upcoming/);
  assert.match(list, /gvdg:admin-event-form-reset/);
  assert.match(list, /requestTab\("scoring", \{ eventId: event\.id \}\)/);

  const controller = readFileSync("src/admin-app/admin-controller.js", "utf8");
  assert.match(controller, /async function adminSwitch\(tab, detail = \{\}, options = \{\}\)/);
  assert.match(controller, /await scSelectEventFromReact\(\{ eventId: selected \}\)/);
  assert.match(controller, /await rgSelectEventFromReact\(\{ eventId: route.eventId \}\)/);
  assert.match(controller, /adminSwitch\(tab, event\.detail \|\| \{\}\)\.catch/);
});
