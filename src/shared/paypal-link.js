// PayPal links opened from an app's own browser (the owner's report: a Facebook-opened link to the club's PayPal
// opened a signed-out page instead of the PayPal app, an extra login that puts people off joining or donating).
// Facebook, Messenger, Instagram and other in-app browsers keep links inside themselves, where no one is signed in to
// PayPal and the PayPal app can't pick them up. Normal browsers already hand paypal.me to the PayPal app, so nothing
// changes there. Inside an in-app browser:
//   - Android: an intent:// link, so Android opens the PayPal app (or the phone's own browser) instead of the in-app one;
//   - iPhone (iOS 17+): x-safari-https://, which opens the link in Safari, where the person is usually signed in and
//     PayPal can switch to its app; if nothing happens (older iOS) the normal link opens after a moment.
// One delegated click listener (installPayPalHandoff) covers every PayPal link on the page: the dues and Donate links,
// fundraisers, and marketplace pay links.

const IN_APP = /FBAN|FBAV|FB_IAB|FBIOS|FB4A|Messenger|Instagram|musical_ly|BytedanceWebview|TikTok|Snapchat|Line\/|Twitter|Pinterest/i;
const PAYPAL_HOSTS = /^(?:www\.)?(?:paypal\.me|paypal\.com)$/i;

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

/** A paypal.me / paypal.com https link, or null. */
export function paypalUrl(href) {
  let url;
  try { url = new URL(String(href || "")); } catch { return null; }
  return url.protocol === "https:" && PAYPAL_HOSTS.test(url.hostname) ? url : null;
}

/**
 * Where a PayPal link should go from this browser: null to leave it alone (a normal browser, or not PayPal), else
 * { target, fallback } (the fallback is the plain link, used if the target does nothing).
 */
export function paypalHandoff(href, ua) {
  const url = paypalUrl(href);
  if (!url || !isInAppBrowser(ua)) return null;
  const plain = url.toString();
  const { os, version } = platformOf(ua);
  if (os === "android") {
    const rest = plain.slice("https://".length);
    return { target: `intent://${rest}#Intent;scheme=https;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(plain)};end`, fallback: plain };
  }
  if (os === "ios" && version >= 17) return { target: "x-safari-" + plain, fallback: plain };
  return null;
}

/** Follow one PayPal link out of the in-app browser. Returns true when it took over the click. */
export function handOffPayPal(href, { ua = navigator.userAgent, win = window } = {}) {
  const handoff = paypalHandoff(href, ua);
  if (!handoff) return false;
  // Seen by the QA (an intent:// or x-safari- navigation is invisible to a desktop browser).
  try { win.document.documentElement.dataset.paypalHandoff = handoff.target; } catch { /* harmless */ }
  win.location.href = handoff.target;
  // Still here (an older phone ignored it): open the plain link instead.
  win.setTimeout(() => {
    if (win.document.visibilityState === "visible") win.location.href = handoff.fallback;
  }, 1500);
  return true;
}

let installed = false;

/** One listener for the whole page: every PayPal link, wherever it's rendered. Safe to call more than once. */
export function installPayPalHandoff(doc = document) {
  if (installed || !doc || !isInAppBrowser(navigator.userAgent)) return;
  installed = true;
  doc.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || !paypalUrl(link.href)) return;
    if (handOffPayPal(link.href)) event.preventDefault();
  });
}
