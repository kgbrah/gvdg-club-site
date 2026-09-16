import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(path, "utf8");
}

test("shared a11y module provides announce and a React dialog hook without raw hex", () => {
  const a11y = source("src/shared/a11y.js");
  const tokens = source("tokens.css");
  assert.match(a11y, /export function announce\(/);
  assert.match(a11y, /export function useAccessibleDialog\(/);
  assert.match(a11y, /aria-live/);
  assert.match(a11y, /assertive/);
  assert.match(a11y, /ANNOUNCE_DELAY_MS = 140/);
  assert.match(a11y, /setAttribute\("inert"/);
  assert.match(a11y, /keydown/);
  assert.match(a11y, /Escape/);
  assert.match(a11y, /pagehide/);
  assert.match(a11y, /gvdg-a11y-announcer/);
  assert.doesNotMatch(a11y, /#[0-9A-Fa-f]{3,8}\b/);
  assert.doesNotMatch(a11y, /Date\.now\(|Math\.random\(/);
  assert.match(tokens, /#gvdg-a11y-announcer \{/);
  assert.match(tokens, /clip-path: inset\(50%\)/);
});

test("course, player, leaderboard, and manage-player dialogs use the shared a11y hook", () => {
  const course = source("src/home-app/course-modal.js");
  const doubles = source("src/members-app/doubles-league-panel.js");
  const leaderboard = source("src/score-app/leaderboard-sheet.js");
  const manage = source("src/score-app/manage-players-sheet.js");
  const notifications = source("src/score-app/notifications.js");

  for (const [name, src] of [
    ["course", course],
    ["player", doubles],
    ["leaderboard", leaderboard],
    ["manage", manage],
  ]) {
    assert.match(src, /useAccessibleDialog/, name);
    assert.match(src, /createPortal/, name);
    assert.match(src, /role: "dialog"/, name);
    assert.match(src, /dialog\.overlayRef/, name);
    assert.match(src, /dialog\.panelRef/, name);
    assert.match(src, /dialog\.isolated/, name);
  }

  assert.match(course, /labelledBy: "course-modal-title"/);
  assert.match(course, /label: "Course details"/);
  assert.match(doubles, /labelledBy: "doublesPlayerModalTitle"/);
  assert.match(leaderboard, /labelledBy: "score-leaderboard-title"/);
  assert.match(leaderboard, /label: "Live leaderboard"/);
  assert.match(manage, /labelledBy: "score-manage-players-title"/);
  assert.match(notifications, /from "\.\.\/shared\/a11y\.js"/);
  assert.match(notifications, /announce\(message, \{ assertive: options\.variant === "conflict" \}\)/);
});
