import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADMIN_DESTINATIONS } from "../src/shared/app-navigation.js";
import { adminNeedsItems } from "../src/admin-app/admin-needs.js";
import { calendarEventFromWorkday } from "../src/shared/event-calendar.js";

const root = resolve(import.meta.dirname, "..");

test("Admin Workdays navigation, needs badge, and HTML pane are wired", () => {
  const workdayNav = ADMIN_DESTINATIONS.find((item) => item.key === "workdays");
  assert.ok(workdayNav, "ADMIN_DESTINATIONS must include workdays");
  assert.equal(workdayNav.group, "events");
  assert.equal(workdayNav.label, "Workdays");

  const adminHtml = readFileSync(resolve(root, "admin.html"), "utf8");
  assert.match(adminHtml, /id="apane-workdays"/);
  assert.match(adminHtml, /id="adminWorkdaysReactApp"/);
  assert.match(adminHtml, /data-admin-tab="workdays"/);

  const singleNeed = adminNeedsItems({ workdayCheckins: 1 });
  assert.deepEqual(singleNeed, [
    {
      id: "workday-checkins",
      tab: "workdays",
      count: 1,
      label: "Workday check-in to verify",
      detail: "GPS checked in, confirm karma",
    },
  ]);

  const multiNeeds = adminNeedsItems({ workdayCheckins: 2 });
  assert.deepEqual(multiNeeds, [
    {
      id: "workday-checkins",
      tab: "workdays",
      count: 2,
      label: "Workday check-ins to verify",
      detail: "GPS checked in, confirm karma",
    },
  ]);
});

test("calendarEventFromWorkday builds valid calendar item metadata", () => {
  const cal = calendarEventFromWorkday({
    id: 17,
    title: "Tee Pad Cleanup",
    workdayDate: "2026-06-14",
    startTime: "08:30",
    locationName: "Meadowbrook Park",
    karmaReward: 40,
    description: "Bring gloves and rakes.",
  });
  assert.ok(cal, "calendarEventFromWorkday should return a calendar item");
  assert.ok(String(cal.title || cal.summary || "").includes("Tee Pad Cleanup"));
  assert.equal(cal.location, "Meadowbrook Park");
  assert.ok(cal.start, "calendar event should include a start value");
  assert.ok(cal.end, "calendar event should include an end value");
});

test("Member Home renders WorkdaysHomeCard showing signup roster and GPS check-in", () => {
  const overviewSrc = readFileSync(resolve(root, "src/members-app/overview-dashboard.js"), "utf8");
  assert.match(overviewSrc, /WorkdaysHomeCard/);

  const cardSrc = readFileSync(resolve(root, "src/members-app/workdays-home-card.js"), "utf8");
  assert.match(cardSrc, /workday\.signups/);
  assert.match(cardSrc, /Signed up/);
  assert.match(cardSrc, /\/workdays\/\$\{[^}]+\}\/check-in/);
});
