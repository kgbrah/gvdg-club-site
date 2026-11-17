import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { visibleKeyboardInset } from "../src/shared/crotts-widget.js";

test("keyboard inset is the strip the on-screen keyboard covers", () => {
  assert.deepEqual(visibleKeyboardInset(800, 0, 800), { top: 0, bottom: 0 });
  assert.deepEqual(visibleKeyboardInset(800, 0, 420), { top: 0, bottom: 380 });
  assert.deepEqual(visibleKeyboardInset(800, 40, 400), { top: 40, bottom: 360 });
  assert.deepEqual(visibleKeyboardInset("nope", 0, 400), { top: 0, bottom: 0 });
});

test("Crotts keeps its composer in the visual viewport on every surface", () => {
  const source = readFileSync("src/shared/crotts-widget.js", "utf8");
  assert.match(source, /visualViewport/);
  assert.match(source, /--crotts-keyboard/);
  assert.match(source, /crotts-keyboard/);
  assert.match(source, /id: "crotts-input"/);
});
