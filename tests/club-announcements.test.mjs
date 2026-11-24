import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADMIN_DESTINATIONS } from "../src/shared/app-navigation.js";

const root = resolve(import.meta.dirname, "..");

test("Admin Announcements navigation and HTML pane are wired", () => {
  const nav = ADMIN_DESTINATIONS.find((item) => item.key === "announcements");
  assert.ok(nav, "ADMIN_DESTINATIONS must include announcements");
  assert.equal(nav.group, "members");
  assert.equal(nav.label, "Announcements");

  const adminHtml = readFileSync(resolve(root, "admin.html"), "utf8");
  assert.match(adminHtml, /data-admin-tab="announcements"/);
  assert.match(adminHtml, /id="apane-announcements"/);
  assert.match(adminHtml, /id="adminAnnouncementsReactApp"/);
});

test("Member Home renders AnnouncementsHomeCard and Message Board has admin-only push option", () => {
  const overviewSrc = readFileSync(resolve(root, "src/members-app/overview-dashboard.js"), "utf8");
  assert.match(overviewSrc, /AnnouncementsHomeCard/);

  const cardSrc = readFileSync(resolve(root, "src/members-app/announcements-home-card.js"), "utf8");
  assert.match(cardSrc, /"\/announcements"/);
  assert.match(cardSrc, /Club announcements/);

  const boardSrc = readFileSync(resolve(root, "src/members-app/board-panel.js"), "utf8");
  assert.match(boardSrc, /context\.isAdmin === true/);
  assert.match(boardSrc, /Send push notification to members/);
  assert.match(boardSrc, /payload\.announce = true/);
});
