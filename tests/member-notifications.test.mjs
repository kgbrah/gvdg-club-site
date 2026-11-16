import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("members can opt in to push from Account and the service worker opens the member app", () => {
  const panel = readFileSync("src/members-app/notifications-panel.js", "utf8");
  const more = readFileSync("src/members-app/more-page.js", "utf8");
  const sw = readFileSync("sw.js", "utf8");
  assert.match(panel, /\/me\/push-subscription/);
  assert.match(panel, /applicationServerKey/);
  assert.match(panel, /Bag tag challenges/);
  assert.match(panel, /Notification\.requestPermission/);
  assert.match(more, /MemberNotificationsPanel/);
  // Member pushes use kind "member"; the click handler opens /gvdg-members.html (with the #tags hash).
  assert.match(sw, /data\.kind === "member"/);
  assert.match(sw, /memberNotificationUrl/);
});
