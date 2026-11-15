import React from "react";
import { Check, ChevronDown, ChevronRight, Circle, X } from "lucide-react";
import { useMemberContext } from "./member-context.js";
import { selectDashboardTab } from "./dashboard-shell.js";

const h = React.createElement;
const PREFIX = "gvdg:first-use:";
const dismissed = new Set();

function stored(key) {
  try { return localStorage.getItem(key) === "1"; }
  catch { return false; }
}

function remember(key) {
  try { localStorage.setItem(key, "1"); }
  catch { /* Current session still reflects the action. */ }
}

function standalone() {
  return navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

export function FirstUseGuide({ playedCasual, onDismiss }) {
  const { sub, pdgaNo, photo } = useMemberContext();
  const [hidden, setHidden] = React.useState(null);
  const [installed, setInstalled] = React.useState(false);
  const key = PREFIX + sub;
  const installedKey = key + ":installed";

  React.useEffect(() => {
    const display = window.matchMedia("(display-mode: standalone)");
    const update = () => setInstalled(standalone() || stored(installedKey));
    const complete = () => {
      remember(installedKey);
      setInstalled(true);
    };
    update();
    display.addEventListener("change", update);
    window.addEventListener("appinstalled", complete);
    return () => {
      display.removeEventListener("change", update);
      window.removeEventListener("appinstalled", complete);
    };
  }, [installedKey]);

  if (!sub || hidden === key || dismissed.has(key) || stored(key)) return null;

  const tasks = [
    { id: "profile", label: "Set up your profile", completedLabel: "Profile set up", nextLabel: "Edit", done: Boolean(pdgaNo || photo),
      action: () => window.dispatchEvent(new CustomEvent("gvdg:member-edit-profile-requested")) },
    { id: "round", label: "Start a casual round", completedLabel: "First round started", nextLabel: "Start another",
      done: playedCasual, href: "score.html?start=1" },
    { id: "install", label: "Install app", completedLabel: "App installed", nextLabel: "View", done: installed, action: () => selectDashboardTab("install") },
  ];
  const completed = tasks.filter(({ done }) => done).length;

  return h("details", { className: "member-first-use", "aria-label": "Getting started" }, [
    h("summary", { key: "summary" }, [
      h("span", { key: "label" }, "Getting started"),
      h("span", { className: "member-first-progress", key: "progress" }, completed === tasks.length ? "Complete" : completed + " of " + tasks.length + " complete"),
      h(ChevronDown, { className: "member-first-chevron", size: 18, "aria-hidden": true, key: "arrow" }),
    ]),
    h("ul", { className: "member-first-tasks", key: "tasks" }, tasks.map(({ id, label, completedLabel, nextLabel, done, href, action }) => {
      const Status = done ? Check : Circle;
      return h("li", { key: id }, h(href ? "a" : "button", {
        ...(href ? { href } : { type: "button", onClick: action }),
        className: "member-first-task",
      }, [
        h(Status, { className: done ? "is-complete" : undefined, size: 16, "aria-hidden": true, key: "status" }),
        h("span", { key: "label" }, done ? completedLabel : label),
        done ? h("small", { key: "next" }, nextLabel) : null,
        h(ChevronRight, { size: 16, "aria-hidden": true, key: "arrow" }),
      ]));
    })),
    h("button", {
      className: "member-first-dismiss", key: "dismiss", type: "button", "aria-label": "Dismiss getting started",
      onClick: () => {
        dismissed.add(key);
        remember(key);
        setHidden(key);
        onDismiss?.();
      },
    }, [h(X, { size: 14, "aria-hidden": true, key: "icon" }), "Dismiss"]),
  ]);
}
