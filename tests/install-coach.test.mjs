import assert from "node:assert/strict";
import test from "node:test";

import {
  DISMISS_KEY,
  installCoachCopy,
  installCoachMode,
  isStandaloneDisplay,
  readInstallCoachDismissed,
  writeInstallCoachDismissed,
} from "../src/shared/install-coach.js";

test("install coach hides in standalone display", () => {
  assert.equal(isStandaloneDisplay(() => true, false), true);
  assert.equal(isStandaloneDisplay(() => false, true), true);
  assert.equal(installCoachMode("Mozilla/5.0", true), "hidden");
});

test("install coach uses iOS share copy on iPhone Safari", () => {
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  assert.equal(installCoachMode(ua, false), "ios");
  assert.match(installCoachCopy("ios").body, /Add to Home Screen/);
});

test("install coach uses the install prompt on Android Chrome", () => {
  const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
  assert.equal(installCoachMode(ua, false), "prompt");
  assert.equal(installCoachCopy("prompt").action, "Install");
});

test("install coach remembers a dismissal in storage", () => {
  const store = new Map();
  const storage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
  };
  assert.equal(readInstallCoachDismissed(storage), false);
  assert.equal(writeInstallCoachDismissed(storage), true);
  assert.equal(store.get(DISMISS_KEY), "1");
  assert.equal(readInstallCoachDismissed(storage), true);
});
