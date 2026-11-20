import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Owner: "an apple user had a blank white screen when opening the app". An iPhone home-screen app has no reload
// button, so the members page carries a start-up safety net (boot-rescue.js): Reload instead of a blank page.

test("the members page loads the safety net before the app, and the service worker keeps it offline", () => {
  const html = readFileSync("gvdg-members.html", "utf8");
  const rescue = html.indexOf('<script src="boot-rescue.js"></script>');
  const app = html.indexOf('<script type="module" src="members-app/members-app.js');
  assert.ok(rescue > 0 && app > rescue, "boot-rescue.js runs before the app's module");
  assert.match(readFileSync("sw.js", "utf8"), /\n  "boot-rescue\.js",\n/);
});

test("the safety net is plain old JavaScript (it must run where the app itself can't)", () => {
  const code = readFileSync("boot-rescue.js", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  for (const [name, pattern] of [["arrow functions", /=>/], ["let/const", /\b(?:let|const)\s/], ["template strings", /`/], ["optional chaining", /\?\./], ["classes", /\bclass\s/], ["spread", /\.\.\./]]) {
    assert.doesNotMatch(code, pattern, "no " + name);
  }
  assert.match(code, /"membersReactAuthGate", "membersReactDashboardApp"/, "it watches where the app draws, not the section around it");
  assert.match(code, /GVDG didn't open properly/);
  assert.match(code, /"Reload fresh"/);
});
