import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("nearby PDGA follows the selected tab and does not wait on GPS", () => {
  const panel = readFileSync("src/members-app/pdga-events-panel.js", "utf8");
  const router = readFileSync("src/members-app/dashboard-router.js", "utf8");
  assert.match(router, /export function currentDashboardTab\(\)/);
  assert.match(panel, /currentDashboardTab\(\)/);
  assert.match(panel, /event\?\.detail\?\.tab \|\| currentDashboardTab\(\)/);
  assert.match(panel, /load\(CLUB_ORIGIN, "club"\)/);
  assert.doesNotMatch(panel, /readPlayerOrigin\(\)\.then\(\(origin\) => \{\s*const point = origin/);
});
