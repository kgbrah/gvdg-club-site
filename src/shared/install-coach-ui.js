import React from "react";

import {
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
    return { mode, promptReady: false };
  });

  React.useEffect(() => {
    function onAvailable() {
      setState((current) => current.mode === "hidden" ? current : { ...current, promptReady: true });
    }
    window.addEventListener("gvdg:pwa-install-available", onAvailable);
    if (window.__gvdgPwaInstallAvailable) onAvailable();
    return () => window.removeEventListener("gvdg:pwa-install-available", onAvailable);
  }, []);

  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    document.body.dataset.installCoach = state.mode === "hidden" ? "off" : "on";
    return () => {
      if (document.body.dataset.installCoach) delete document.body.dataset.installCoach;
    };
  }, [state.mode]);

  if (state.mode === "hidden") return null;
  const copy = installCoachCopy(state.mode);
  const canInstall = state.mode === "prompt" && state.promptReady;

  function dismiss() {
    writeInstallCoachDismissed(localStorage);
    setState({ mode: "hidden", promptReady: false });
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
      canInstall
        ? h("button", { className: "install-coach-btn", key: "install", type: "button", onClick: install }, copy.action)
        : null,
      h("button", { className: "install-coach-dismiss", key: "dismiss", type: "button", onClick: dismiss }, "Not now"),
    ].filter(Boolean)),
  ]);
}
