const DISMISS_KEY = "gvdg_install_coach_dismissed";

function userAgent(value) {
  return String(value || (typeof navigator !== "undefined" ? navigator.userAgent : "") || "");
}

function iosDevice(text) {
  return /iPad|iPhone|iPod/.test(text) || (/Macintosh/.test(text) && /Mobile/.test(text));
}

export function isStandaloneDisplay(mediaMatches, navStandalone) {
  if (navStandalone === true) return true;
  if (typeof mediaMatches === "function") {
    try {
      return mediaMatches("(display-mode: standalone)") === true;
    } catch {
      return false;
    }
  }
  return false;
}

export function inAppHost(ua) {
  const text = userAgent(ua);
  if (/Instagram/i.test(text)) return "Instagram";
  if (/Messenger/i.test(text)) return "Messenger";
  if (/FB_IAB|FBAN|FBAV/i.test(text)) return "Facebook";
  return "";
}

export function androidChromeIntent(pageUrl) {
  let url;
  try {
    url = new URL(String(pageUrl || ""));
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  const scheme = url.protocol.replace(":", "");
  const fallback = encodeURIComponent(url.toString());
  return `intent://${url.host}${url.pathname}${url.search}${url.hash}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${fallback};end`;
}

export function installCoachMode(ua, standalone) {
  if (standalone) return "hidden";
  const text = userAgent(ua);
  if (inAppHost(text)) return iosDevice(text) ? "safari" : "chrome";
  const iosSafari = iosDevice(text) && /Safari/.test(text) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(text);
  if (iosSafari) return "ios";
  return "prompt";
}

export function readInstallCoachDismissed(storage) {
  try {
    return Boolean(storage && storage.getItem(DISMISS_KEY));
  } catch {
    return false;
  }
}

export function writeInstallCoachDismissed(storage) {
  try {
    storage.setItem(DISMISS_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function installCoachCopy(mode, pageUrl, host) {
  const whose = host ? host + "'s browser" : "This browser";
  if (mode === "ios") {
    return {
      title: "Add GVDG to your Home Screen",
      body: "On iPhone, tap Share, then Add to Home Screen. Scoring stays one tap away in the parking lot.",
      action: "",
      href: "",
    };
  }
  if (mode === "safari") {
    return {
      title: "Open in Safari to install",
      body: whose + " can't install the app. Tap the ••• menu, then Open in Safari. In Safari, tap Share, then Add to Home Screen.",
      action: "",
      href: "",
    };
  }
  if (mode === "chrome") {
    return {
      title: "Open in Chrome to install",
      body: whose + " can't install the app. Open this page in Chrome, then tap Install. If Chrome doesn't open, tap the ⋮ menu and choose Open in browser.",
      action: "Open in Chrome",
      href: androidChromeIntent(pageUrl),
    };
  }
  return {
    title: "Install GVDG Club",
    body: "Install the app for a full-screen scorecard, offline members page, and a Home Screen icon.",
    action: "Install",
    href: "",
  };
}

export { DISMISS_KEY };
