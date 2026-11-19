// Sign-up links open in the phone's own browser, where the person is usually already signed in.
//
// Owner: "open the renew with PDGA and all outside registration links in the user's default browser (the one they are
// likely already logged into the external site on) to avoid unnecessary friction for sign ups and PDGA renewals."
// Earlier report: a Facebook-opened link to the club's PayPal opened a signed-out page instead of the PayPal app.
//
// Two places keep links away from the person's browser and its sign-ins:
//   - an app's own browser (Facebook, Messenger, Instagram, TikTok…);
//   - the club app installed on the home screen: on iPhone, an outside link opens in a sheet with none of Safari's
//     sign-ins.
// In those two places a sign-up link is handed to the phone:
//   - Android: an intent:// link, so Android opens it in the default browser, or in the site's own app if it has one
//     (PayPal);
//   - iPhone (iOS 17+): x-safari-https://, which opens it in Safari; if nothing happens (older iOS), the normal link
//     opens after a moment.
// A normal browser tab is left alone: its new tab already has the person's sign-ins.
//
// Sign-up links are PayPal (dues, donations, marketplace pay links), Disc Golf Scene, and any link marked
// data-signup-link (PDGA join/renew, event Register/Sign up links, outside event pages). One delegated click listener
// (installOutsideLinkHandoff) covers every one of them on the page.

const IN_APP = /FBAN|FBAV|FB_IAB|FBIOS|FB4A|Messenger|Instagram|musical_ly|BytedanceWebview|TikTok|Snapchat|Line\/|Twitter|Pinterest/i;
const PAYPAL_HOSTS = /^(?:www\.)?(?:paypal\.me|paypal\.com)$/i;
const SIGNUP_HOSTS = /(?:^|\.)discgolfscene\.com$/i;

/** Spread onto a sign-up link: it opens in a new tab, and in the phone's own browser from the app or an in-app browser. */
export const SIGNUP_LINK = Object.freeze({ "data-signup-link": "true", rel: "noopener noreferrer", target: "_blank" });

/** True inside an app's own browser (Facebook, Messenger, Instagram, TikTok…). */
export function isInAppBrowser(ua) {
  return IN_APP.test(String(ua || ""));
}

/** "android", "ios" (with its major version), or "other". */
export function platformOf(ua) {
  const text = String(ua || "");
  if (/Android/i.test(text)) return { os: "android", version: 0 };
  const ios = text.match(/(?:iPhone|iPad|iPod)[^)]*? OS (\d+)_/i);
  if (ios) return { os: "ios", version: Number(ios[1]) };
  return { os: "other", version: 0 };
}

function webUrl(href) {
  try {
    const url = new URL(String(href || ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** A paypal.me / paypal.com https link, or null. */
export function paypalUrl(href) {
  const url = webUrl(href);
  return url && url.protocol === "https:" && PAYPAL_HOSTS.test(url.hostname) ? url : null;
}

/** A sign-up link (PayPal, Disc Golf Scene, or one marked data-signup-link), or null. */
export function signupUrl(href, marked = false) {
  const url = webUrl(href);
  if (!url) return null;
  if (paypalUrl(href) || SIGNUP_HOSTS.test(url.hostname)) return url;
  return marked ? url : null;
}

/** The link handed to the phone (Android intent, or Safari on iOS 17+), or null where this phone can't. */
function phoneTarget(url, ua) {
  const plain = url.toString();
  const { os, version } = platformOf(ua);
  if (os === "android") {
    const scheme = url.protocol.replace(":", "");
    const rest = plain.slice(url.protocol.length + 2);
    return `intent://${rest}#Intent;scheme=${scheme};action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(plain)};end`;
  }
  if (os === "ios" && version >= 17) return "x-safari-" + plain;
  return null;
}

/**
 * Where a sign-up link should go: null to leave it alone (a normal browser tab, not a sign-up link, or a phone that
 * can't be handed the link), else { target, fallback } (the fallback is the plain link, used if the target does
 * nothing).
 */
export function outsideHandoff(href, { ua = "", standalone = false, marked = false } = {}) {
  const url = signupUrl(href, marked);
  if (!url || !(standalone || isInAppBrowser(ua))) return null;
  const target = phoneTarget(url, ua);
  return target ? { target, fallback: url.toString() } : null;
}

/** PayPal only, from an in-app browser (kept for the dues and donation links' tests). */
export function paypalHandoff(href, ua) {
  return paypalUrl(href) ? outsideHandoff(href, { ua }) : null;
}

/** True when the club site runs as the installed app (home screen). */
export function runningInstalled(win = typeof window !== "undefined" ? window : null) {
  if (!win) return false;
  if (win.navigator && win.navigator.standalone === true) return true;
  try {
    return typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches === true;
  } catch {
    return false;
  }
}

/** Follow one sign-up link out to the phone's browser. Returns true when it took over the click. */
export function handOffOutside(href, { ua = navigator.userAgent, win = window, standalone = runningInstalled(win), marked = false } = {}) {
  const handoff = outsideHandoff(href, { ua, standalone, marked });
  if (!handoff) return false;
  // Seen by the QA (an intent:// or x-safari- navigation is invisible to a desktop browser).
  try { win.document.documentElement.dataset.outsideHandoff = handoff.target; } catch { /* harmless */ }
  win.location.href = handoff.target;
  // Still here (an older phone ignored it): open the plain link instead.
  win.setTimeout(() => {
    if (win.document.visibilityState === "visible") win.location.href = handoff.fallback;
  }, 1500);
  return true;
}

let installed = false;

/** One listener for the whole page: every sign-up link, wherever it's rendered. Safe to call more than once. */
export function installOutsideLinkHandoff(doc = document) {
  if (installed || !doc) return;
  const standalone = runningInstalled(window);
  if (!standalone && !isInAppBrowser(navigator.userAgent)) return;
  installed = true;
  doc.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    const marked = link.hasAttribute("data-signup-link");
    if (!signupUrl(link.href, marked)) return;
    if (handOffOutside(link.href, { standalone, marked })) event.preventDefault();
  });
}
