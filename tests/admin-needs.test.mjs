import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { adminNeedsBadgeCount, adminNeedsItems } from "../src/admin-app/admin-needs.js";

test("admin needs lists every waiting queue and lights the matching button", () => {
  const items = adminNeedsItems({
    bagRequests: 2,
    bagChallenges: 1,
    applications: 1,
    teeSigns: 3,
    orders: 4,
    shelf: 1,
    shelfName: "The Best Popcorn Ever Produced",
  });

  assert.deepEqual(items.map((item) => [item.id, item.tab, item.count]), [
    ["bag-requests", "bag-tags", 2],
    ["bag-challenges", "bag-tags", 1],
    ["applications", "members", 1],
    ["tee-signs", "tee-signs", 3],
    ["orders", "orders", 4],
    ["shelf", "shop", 1],
  ]);
  assert.equal(items[0].label, "Bag tag requests");
  assert.equal(items[0].detail, "Hand out the next number");
  assert.equal(items[5].label, "The Best Popcorn Ever Produced");
  assert.equal(adminNeedsBadgeCount(items, "today"), 12);
  assert.equal(adminNeedsBadgeCount(items, "more"), 7);
  assert.equal(adminNeedsBadgeCount(items, "shop"), 1);
  assert.equal(adminNeedsBadgeCount(items, "orders"), 4);
  assert.equal(adminNeedsBadgeCount(items, "bag-tags"), 3);
  assert.equal(adminNeedsBadgeCount(items, "members"), 1);
  assert.equal(adminNeedsBadgeCount(items, "tee-signs"), 3);
  assert.deepEqual(adminNeedsItems({ bagRequests: 0, orders: "nope", shelf: -1 }), []);
});

test("unusual round karma (more than 3 rounds in a day) waits in Lost & Found with its own count", () => {
  const items = adminNeedsItems({ lostFoundReports: 1, karmaFlags: 2 });
  assert.deepEqual(items.map((item) => [item.id, item.tab, item.count, item.label, item.detail]), [
    ["lost-found-reports", "lost-found", 1, "Lost & Found report", "Review and act"],
    ["karma-flags", "lost-found", 2, "Unusual karma flags", "More than 3 rounds in a day"],
  ]);
  assert.equal(adminNeedsBadgeCount(items, "lost-found"), 3);
  assert.equal(adminNeedsItems({ karmaFlags: 1 })[0].label, "Unusual karma");
});

test("today command center links each queue and keeps the scoring card", () => {
  const today = readFileSync("src/admin-app/today-dashboard.js", "utf8");
  const nav = readFileSync("src/admin-app/navigation.js", "utf8");
  const more = readFileSync("src/admin-app/more-page.js", "utf8");
  const controller = readFileSync("src/admin-app/admin-controller.js", "utf8");

  assert.match(today, /Needs you/);
  assert.match(today, /All clear/);
  assert.doesNotMatch(today, /Nothing on the card right now/);
  assert.doesNotMatch(today, /admin-today-tiles/);
  assert.match(today, /Start scoring/);
  assert.match(today, /Live scoring/);
  assert.match(nav, /AdminNeedsBadge/);
  assert.match(readFileSync("src/admin-app/today-dashboard.js", "utf8"), /requestTab\("applications"\)/);
  assert.match(more, /NEEDS_TABS\.has\(item.key\)/);
  assert.match(readFileSync("src/admin-app/today-dashboard.js", "utf8"), /requestTab\("orders", \{ filter: "new" \}\)/);
  assert.match(more, /AdminNeedsBadge/);
  assert.match(controller, /async function refreshAdminNeeds\(\)/);
  assert.match(controller, /\/admin\/bag-tags/);
  assert.match(controller, /\/admin\/members\/applications/);
  assert.match(controller, /\/admin\/tee-signs\?status=candidate/);
  assert.match(controller, /gvdg:admin-needs-refresh/);
  assert.match(controller, /setOrdersBadge\(0\);/);
  assert.match(controller, /navigationFromUrl\(true\)/);
});
