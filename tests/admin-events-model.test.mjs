import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  bucketAdminEvents,
  formatAdminEventWhen,
  normalizeAdminEvent,
  pickTodayEvent,
} from "../src/admin-app/admin-events-model.js";
import { clubToday } from "../src/shared/events-model.js";

test("admin event buckets put live first and keep scheduled upcoming", () => {
  const live = normalizeAdminEvent({ id: 1, name: "Live dubs", status: "live", date: "2026-09-13", starts_at: "2026-09-13T12:15:00.000Z" });
  const later = normalizeAdminEvent({ id: 2, name: "Next week", status: "scheduled", date: "2026-09-19" });
  const done = normalizeAdminEvent({ id: 3, name: "Done", status: "final", date: "2026-09-01" });
  const buckets = bucketAdminEvents([later, done, live]);
  assert.equal(buckets.live[0].id, "1");
  assert.equal(buckets.upcoming[0].id, "2");
  assert.equal(buckets.past[0].id, "3");
  assert.equal(pickTodayEvent([later, live]).id, "1");
  const today = clubToday();
  const laterSameStatus = normalizeAdminEvent({ id: 4, name: "Later", status: "scheduled", date: "2026-12-01" });
  const todaysRound = normalizeAdminEvent({ id: 5, name: "Today's round", status: "scheduled", date: today });
  assert.equal(pickTodayEvent([laterSameStatus, todaysRound]).id, "5");
  assert.match(formatAdminEventWhen(live), /Sep/);
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
  assert.match(chrome, /from "\.\.\/shared\/player-theme-session\.js"/);
  assert.match(chrome, /syncPlayerTheme/);
  assert.match(chrome, /togglePlayerThemeMode/);
  assert.match(chrome, /paintPlayerTheme\(null, themeRoot\(\)\)/);
  assert.match(main, /import \{ AdminTodayDashboard \} from "\.\/today-dashboard\.js"/);
  assert.match(main, /import \{ AdminMorePage \} from "\.\/more-page\.js"/);
  assert.match(today, /export function AdminTodayDashboard/);
  assert.match(today, /Start scoring/);
  assert.match(today, /Open scoring/);
  assert.match(today, /eventId: event\.id/);
  assert.match(today, /eventId: next\.id/);
  assert.match(more, /export function AdminMorePage/);
  assert.match(nav, /ADMIN_DOCK/);
  assert.match(list, /Upcoming/);
  assert.match(list, /gvdg:admin-event-form-reset/);
  assert.match(list, /requestTab\("scoring", \{ eventId: event\.id \}\)/);

  const controller = readFileSync("src/admin-app/admin-controller.js", "utf8");
  assert.match(controller, /async function adminSwitch\(tab, detail\)/);
  assert.match(controller, /if \(eventId\) await scSelectEventFromReact\(\{ eventId \}\)/);
  assert.match(controller, /if \(eventId\) await rgSelectEventFromReact\(\{ eventId \}\)/);
  assert.match(controller, /adminSwitch\(tab, event\.detail \|\| \{\}\)\.catch/);
});
