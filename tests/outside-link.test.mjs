import assert from "node:assert/strict";
import test from "node:test";

import { isInAppBrowser, outsideHandoff, paypalHandoff, paypalUrl, platformOf, signupUrl, SIGNUP_LINK } from "../src/shared/outside-link.js";

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

// The installed club app (home screen) and sign-up links beyond PayPal: owner, "open the renew with PDGA and all outside
// registration links in the user's default browser".
const IPHONE_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPHONE16_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_APP = CHROME_ANDROID;
const RENEW = "https://www.pdga.com/membership/renew";
const DGS = "https://www.discgolfscene.com/tournaments/Greenville_Fall_Classic_2026";

test("sign-up links: PayPal and Disc Golf Scene always; anything else only when marked", () => {
  assert.ok(signupUrl(DUES));
  assert.ok(signupUrl(DGS));
  assert.equal(signupUrl(RENEW), null, "a PDGA link is a sign-up only when the page marks it (profiles aren't)");
  assert.ok(signupUrl(RENEW, true));
  assert.equal(signupUrl("javascript:alert(1)", true), null);
  assert.equal(signupUrl("/events#event/7", true), null, "the club's own pages stay in place");
  assert.deepEqual({ ...SIGNUP_LINK }, { "data-signup-link": "true", rel: "noopener noreferrer", target: "_blank" });
});

test("from the installed app, PDGA renew and registration links go to the phone's own browser", () => {
  assert.deepEqual(outsideHandoff(RENEW, { ua: IPHONE_APP, standalone: true, marked: true }), { target: "x-safari-" + RENEW, fallback: RENEW });
  assert.deepEqual(outsideHandoff(DGS, { ua: ANDROID_APP, standalone: true }), {
    target: `intent://www.discgolfscene.com/tournaments/Greenville_Fall_Classic_2026#Intent;scheme=https;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(DGS)};end`,
    fallback: DGS,
  });
  assert.equal(outsideHandoff(DUES, { ua: IPHONE_APP, standalone: true }).target, "x-safari-" + DUES, "dues and donations too");
  assert.equal(outsideHandoff(RENEW, { ua: IPHONE16_APP, standalone: true, marked: true }), null, "iOS 16 can't: the plain link opens");
  assert.equal(outsideHandoff(RENEW, { ua: IPHONE_APP, standalone: true }), null, "unmarked PDGA links (profiles) stay as they are");
});

test("a normal browser tab is left alone (its new tab already has the person's sign-ins)", () => {
  assert.equal(outsideHandoff(RENEW, { ua: SAFARI, marked: true }), null);
  assert.equal(outsideHandoff(DGS, { ua: CHROME_ANDROID }), null);
  assert.equal(outsideHandoff(RENEW, { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0", standalone: true, marked: true }), null, "a desktop app window opens links in the browser already");
  assert.equal(outsideHandoff(DGS, { ua: FB_IOS }).target, "x-safari-" + DGS, "Facebook's browser hands registration off too");
});

test("Home's PDGA card credits PDGA once (the membership card inside it doesn't repeat the line)", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync("src/members-app/overview-dashboard.js", "utf8"), /h\(PdgaMembershipCard, \{ data: pdgaMembership, compact: true, credit: false \}\)/);
  assert.match(readFileSync("src/shared/pdga-membership.js", "utf8"), /player && credit \? h\(PdgaCredit/);
  for (const file of ["src/public-app/tournament-registration.js", "src/shared/pdga-membership.js", "src/members-app/pdga-events-panel.js", "src/members-app/overview-dashboard.js", "src/members-app/club-leagues.js"]) {
    assert.match(readFileSync(file, "utf8"), /\.\.\.SIGNUP_LINK|: SIGNUP_LINK\)/, file + " marks its sign-up link");
  }
});
