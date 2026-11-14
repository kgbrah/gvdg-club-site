import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DISMISS_KEY,
  androidChromeIntent,
  inAppHost,
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
  assert.equal(inAppHost(ua), "");
});

test("Facebook's Android browser opens this page in Chrome instead of a dead install", () => {
  const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/490.0.0.0.0;]";
  assert.equal(installCoachMode(ua, false), "chrome");
  assert.equal(inAppHost(ua), "Facebook");
  const copy = installCoachCopy("chrome", "https://gvdgclub.com/score.html?round=AB12&watch=1#hole", "Facebook");
  assert.equal(copy.action, "Open in Chrome");
  assert.match(copy.body, /Chrome/);
  assert.match(copy.body, /Open in browser/);
  assert.equal(
    copy.href,
    "intent://gvdgclub.com/score.html?round=AB12&watch=1#hole#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fgvdgclub.com%2Fscore.html%3Fround%3DAB12%26watch%3D1%23hole;end",
  );
  assert.equal(androidChromeIntent("javascript:alert(1)"), "");
  const ui = readFileSync("src/shared/install-coach-ui.js", "utf8");
  assert.match(ui, /mode === "chrome" && copy\.href/);
  assert.match(ui, /href: copy\.href/);
});

test("Facebook's iPhone browser sends people to Safari, not Chrome", () => {
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/490.0.0.0.0;]";
  assert.equal(installCoachMode(ua, false), "safari");
  const copy = installCoachCopy("safari", "https://gvdgclub.com/score.html", "Facebook");
  assert.match(copy.title, /Safari/);
  assert.match(copy.body, /Open in Safari/);
  assert.match(copy.body, /Add to Home Screen/);
  assert.equal(copy.action, "");
  assert.equal(copy.href, "");
  assert.equal(installCoachMode("Mozilla/5.0 (Linux; Android 14) AppleWebKit Instagram 359.0 Android", false), "chrome");
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
