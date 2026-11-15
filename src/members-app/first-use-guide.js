import React from "react";
import { useMemberContext } from "./member-context.js";
import { selectDashboardTab } from "./dashboard-shell.js";

const h = React.createElement;
const PREFIX = "gvdg:first-use:";
const dismissed = new Set();

function skipped(key) {
  try { return dismissed.has(key) || localStorage.getItem(key) === "1"; }
  catch { return dismissed.has(key); }
}

export function FirstUseGuide() {
  const { sub } = useMemberContext();
  const [hidden, setHidden] = React.useState(null);
  const key = PREFIX + sub;
  if (!sub || hidden === key || skipped(key)) return null;

  return h("details", { className: "member-first-use", "aria-label": "Getting started" }, [
    h("summary", { key: "summary" }, "Getting started"),
    h("div", { className: "dashboard-actions", key: "actions" }, [
      h("button", { className: "dashboard-action", key: "profile", type: "button", onClick: () => window.dispatchEvent(new CustomEvent("gvdg:member-edit-profile-requested")) }, "Set up your profile"),
      h("a", { className: "dashboard-action", href: "score.html?start=1", key: "round" }, "Start a casual round"),
      h("button", { className: "dashboard-action", key: "install", type: "button", onClick: () => selectDashboardTab("install") }, "Install app"),
      h("button", {
        className: "dashboard-action", key: "dismiss", type: "button",
        onClick: () => {
          dismissed.add(key);
          try { localStorage.setItem(key, "1"); } catch { /* dismissal lasts for this session */ }
          setHidden(key);
        },
      }, "Dismiss getting started"),
    ]),
  ]);
}
