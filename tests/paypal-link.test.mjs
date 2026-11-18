import assert from "node:assert/strict";
import test from "node:test";

import { isInAppBrowser, paypalHandoff, paypalUrl, platformOf } from "../src/shared/paypal-link.js";

const FB_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.0;]";
const FB_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0;FBBV/1;FBDV/iPhone15,2]";
const IG_IOS16 = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const DUES = "https://paypal.me/greenvillediscgolf/15";

test("knows an app's own browser from a real one", () => {
  assert.equal(isInAppBrowser(FB_ANDROID), true);
  assert.equal(isInAppBrowser(FB_IOS), true);
  assert.equal(isInAppBrowser(IG_IOS16), true);
  assert.equal(isInAppBrowser(SAFARI), false);
  assert.equal(isInAppBrowser(CHROME_ANDROID), false);
  assert.deepEqual(platformOf(FB_IOS), { os: "ios", version: 17 });
  assert.deepEqual(platformOf(FB_ANDROID), { os: "android", version: 0 });
});

test("only PayPal links, only inside an in-app browser", () => {
  assert.equal(paypalUrl("https://paypal.me/greenvillediscgolf")?.hostname, "paypal.me");
  assert.equal(paypalUrl("https://www.paypal.com/donate?x=1")?.hostname, "www.paypal.com");
  assert.equal(paypalUrl("http://paypal.me/x"), null);
  assert.equal(paypalUrl("https://paypal.me.evil.example/x"), null);
  assert.equal(paypalHandoff(DUES, SAFARI), null, "Safari already opens the PayPal app");
  assert.equal(paypalHandoff(DUES, CHROME_ANDROID), null);
  assert.equal(paypalHandoff("https://gvdgclub.com/", FB_ANDROID), null);
});

test("Facebook on Android hands the link to Android (PayPal app or the real browser)", () => {
  assert.deepEqual(paypalHandoff(DUES, FB_ANDROID), {
    target: "intent://paypal.me/greenvillediscgolf/15#Intent;scheme=https;action=android.intent.action.VIEW;S.browser_fallback_url=https%3A%2F%2Fpaypal.me%2Fgreenvillediscgolf%2F15;end",
    fallback: DUES,
  });
});

test("Facebook on iPhone opens Safari (iOS 17+); older iPhones keep the plain link", () => {
  assert.deepEqual(paypalHandoff(DUES, FB_IOS), { target: "x-safari-" + DUES, fallback: DUES });
  assert.equal(paypalHandoff(DUES, IG_IOS16), null);
});
