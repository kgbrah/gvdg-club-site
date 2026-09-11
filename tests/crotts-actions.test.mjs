import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeCrottsActions, sanitizeCrottsHref } from "../src/shared/crotts-actions.js";

test("Crotts widget only follows allowlisted club hrefs", () => {
  assert.equal(sanitizeCrottsHref("score.html?event=2&watch=1"), "score.html?event=2&watch=1");
  assert.equal(sanitizeCrottsHref("gvdg-members.html#apply"), "gvdg-members.html#apply");
  assert.equal(sanitizeCrottsHref("javascript:alert(1)"), "");
  assert.equal(sanitizeCrottsHref("https://evil.example/"), "");
  assert.deepEqual(
    sanitizeCrottsActions([
      { href: "score.html?event=2", id: "score-2", label: "Keep score" },
      { href: "javascript:alert(1)", id: "x", label: "Nope" },
    ]),
    [{ href: "score.html?event=2", id: "score-2", label: "Keep score" }],
  );
});
