import React from "react";

import {
  inAppHost,
  installCoachCopy,
  installCoachMode,
  isStandaloneDisplay,
  readInstallCoachDismissed,
  writeInstallCoachDismissed,
} from "./install-coach.js";

const h = React.createElement;

function matchesMedia(query) {
  return typeof window !== "undefined" && window.matchMedia && window.matchMedia(query).matches;
}

export function InstallCoachBanner() {
  const [state, setState] = React.useState(() => {
    const standalone = isStandaloneDisplay(matchesMedia, typeof navigator !== "undefined" ? navigator.standalone : false);
    const dismissed = readInstallCoachDismissed(typeof localStorage !== "undefined" ? localStorage : null);
    const mode = dismissed || standalone ? "hidden" : installCoachMode(undefined, standalone);
    return { hint: false, mode };
  });

  React.useEffect(() => {
    function onManual() {
      setState((current) => current.mode === "hidden" ? current : { ...current, hint: true });
    }
    function onInstalled() {
      setState({ hint: false, mode: "hidden" });
    }
    window.addEventListener("gvdg:pwa-install-manual", onManual);
    window.addEventListener("gvdg:pwa-installed", onInstalled);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("gvdg:pwa-install-manual", onManual);
      window.removeEventListener("gvdg:pwa-installed", onInstalled);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    document.body.dataset.installCoach = state.mode === "hidden" ? "off" : "on";
    return () => {
      if (document.body.dataset.installCoach) delete document.body.dataset.installCoach;
    };
  }, [state.mode]);

  if (state.mode === "hidden") return null;
  const copy = installCoachCopy(
    state.mode,
    typeof location !== "undefined" ? location.href : "",
    inAppHost(),
  );

  function dismiss() {
    writeInstallCoachDismissed(localStorage);
    setState({ hint: false, mode: "hidden" });
  }

  function install() {
    window.dispatchEvent(new CustomEvent("gvdg:pwa-install-prompt"));
  }

  return h("aside", { className: "install-coach", "data-react-install-coach": state.mode }, [
    h("div", { className: "install-coach-copy", key: "copy" }, [
      h("strong", { key: "title" }, copy.title),
      h("p", { key: "body" }, copy.body),
    ]),
    h("div", { className: "install-coach-actions", key: "actions" }, [
      state.mode === "chrome" && copy.href
        ? h("a", { className: "install-coach-btn", href: copy.href, key: "open" }, copy.action)
        : null,
      state.mode === "prompt"
        ? h("button", { className: "install-coach-btn", key: "install", type: "button", onClick: install }, copy.action)
        : null,
      h("button", { className: "install-coach-dismiss", key: "dismiss", type: "button", onClick: dismiss }, "Not now"),
    ].filter(Boolean)),
    state.hint
      ? h("p", { className: "install-coach-hint", key: "hint" }, "If the install window doesn't open, use the browser menu and choose Install app.")
      : null,
  ]);
}
