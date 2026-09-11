const DISMISS_KEY = "gvdg_install_coach_dismissed";

function userAgent(value) {
  return String(value || (typeof navigator !== "undefined" ? navigator.userAgent : "") || "");
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

export function installCoachMode(ua, standalone) {
  if (standalone) return "hidden";
  const text = userAgent(ua);
  const ios = /iPad|iPhone|iPod/.test(text) || (/Macintosh/.test(text) && /Mobile/.test(text));
  const iosSafari = ios && /Safari/.test(text) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(text);
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

export function installCoachCopy(mode) {
  if (mode === "ios") {
    return {
      title: "Add GVDG to your Home Screen",
      body: "On iPhone, tap Share, then Add to Home Screen. Scoring stays one tap away in the parking lot.",
      action: "",
    };
  }
  return {
    title: "Install GVDG Club",
    body: "Install the app for a full-screen scorecard, offline members page, and a Home Screen icon.",
    action: "Install",
  };
}

export { DISMISS_KEY };
