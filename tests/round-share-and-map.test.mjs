import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("a live round can be shared by code and an unmapped hole can be pinned", () => {
  const view = readFileSync("src/score-app/scorecard-view.js", "utf8");
  const controller = readFileSync("src/score-app/score-controller.js", "utf8");
  const home = readFileSync("src/members-app/overview-dashboard.js", "utf8");
  assert.match(view, /Invite to score/);
  assert.match(view, /Tee is here/);
  assert.match(view, /Basket is here/);
  assert.match(view, /Sign in to drop the tee and basket/);
  assert.match(controller, /function shareJoinCode\(\)/);
  assert.match(controller, /Join my card — code /);
  assert.match(controller, /onShareCode: ROUND_CODE && S.status === 'live' \? shareJoinCode : null/);
  assert.match(view, /Use \" \+ value/);
  assert.match(readFileSync("src/score-app/setup-flow.js", "utf8"), /Jump back in/);
  assert.match(controller, /function forgetRecentRound/);
  assert.match(controller, /forgetRecentRound\(ROUND_CODE\)/);
  assert.match(controller, /function pruneLeftRounds/);
  assert.doesNotMatch(view, /pointReady\(props\.gpsFix\)/);
  assert.doesNotMatch(readFileSync("src/shared/hole-map.js", "utf8"), /here: props\.here/);
  assert.match(readFileSync("src/shared/hole-map-model.js", "utf8"), /export function projectLooseHoleMap/);
  assert.match(home, /data-react-home-pdga/);
  assert.match(readFileSync("src/members-app/pdga-events-panel.js", "utf8"), /AddToCalendarButton/);
  assert.match(readFileSync("src/members-app/registration-events.js", "utf8"), /calendarEventFromClub/);
});
