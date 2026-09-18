import React from "react";
import { CalendarDays, Home, MoreHorizontal, PlayCircle, TrendingUp } from "lucide-react";

import { readMemberContext } from "./member-context.js";

const h = React.createElement;

export const TABS = [
  { key: "overview", label: "Home", title: "Home", nav: true, icon: Home },
  { key: "play", label: "Play", title: "Play", nav: true, icon: PlayCircle },
  { key: "events", label: "Events", title: "Events", nav: true, icon: CalendarDays },
  { key: "season", label: "Season", title: "Season", nav: true, icon: TrendingUp },
  { key: "more", label: "More", title: "More", nav: true, icon: MoreHorizontal },
  { key: "board", label: "Board", title: "Member Board", nav: false },
  { key: "tee", label: "Tee Signs", title: "Tee Sign Capture", nav: false },
  { key: "club", label: "Club", title: "GVDG Member Directory", nav: false },
];

const DEFAULT_TAB = TABS[0];
const tabKeys = new Set(TABS.map((tab) => tab.key));
const NAV_TABS = TABS.filter((tab) => tab.nav);
const MORE_KEYS = new Set(["more", "board", "tee", "club"]);

function safeTab(value) {
  return tabKeys.has(value) ? value : DEFAULT_TAB.key;
}

function tabTitle(key) {
  return TABS.find((tab) => tab.key === key)?.title || DEFAULT_TAB.title;
}

function navIsActive(tab, current) {
  if (tab.key === "more") return MORE_KEYS.has(current);
  return tab.key === current;
}

function initialState() {
  const tab = DEFAULT_TAB.key;
  const context = readMemberContext();
  return { ...context, scrollVersion: 0, tab, title: tabTitle(tab) };
}

function nextState(previous, detail = null) {
  const nextTab = safeTab(detail?.tab || previous.tab || DEFAULT_TAB.key);
  const context = readMemberContext(detail);
  return {
    ...context,
    scrollVersion: detail?.scroll === true ? previous.scrollVersion + 1 : previous.scrollVersion,
    tab: nextTab,
    title: detail?.title || tabTitle(nextTab),
  };
}

export function selectDashboardTab(tab) {
  window.dispatchEvent(new CustomEvent("gvdg:select-dashboard-tab", { detail: { tab } }));
}

export function requestLogout() {
  window.dispatchEvent(new CustomEvent("gvdg:member-logout-requested"));
}

function navIcon(Icon) {
  return h(Icon, {
    size: 22,
    strokeWidth: 2.2,
    "aria-hidden": "true",
    focusable: "false",
  });
}

export function MemberDashboardShell() {
  const [state, setState] = React.useState(initialState);
  const shellRef = React.useRef(null);

  React.useEffect(() => {
    document.body.dataset.memberDashboardTab = state.tab;
    return () => {
      if (document.body.dataset.memberDashboardTab === state.tab) delete document.body.dataset.memberDashboardTab;
    };
  }, [state.tab]);

  React.useEffect(() => {
    if (!state.scrollVersion) return;
    shellRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [state.scrollVersion]);

  React.useEffect(() => {
    function update(event) {
      setState((previous) => nextState(previous, event.detail || null));
    }

    window.addEventListener("gvdg:dashboard-tab-selected", update);
    window.addEventListener("gvdg:member-dashboard-ready", update);
    window.addEventListener("gvdg:member-profile-updated", update);
    return () => {
      window.removeEventListener("gvdg:dashboard-tab-selected", update);
      window.removeEventListener("gvdg:member-dashboard-ready", update);
      window.removeEventListener("gvdg:member-profile-updated", update);
    };
  }, []);

  const adminPortal = state.tab === "overview" && state.isAdmin
    ? h(
      "a",
      {
        className: "admin-portal-link react-admin-portal-link",
        "data-react-admin-portal": "ready",
        href: "admin.html",
        id: "adminPortalLink",
        key: "adminPortal",
      },
      "Admin Portal - manage events & courses",
    )
    : null;

  return h("div", { className: "member-dashboard-shell-chrome", "data-member-dashboard-shell": state.tab, ref: shellRef }, [
    h("h2", { className: "section-title player-app-title", id: "membersReactDashboardTitle", key: "title" }, state.title),
    adminPortal,
    h(
      "nav",
      {
        className: "player-app-nav",
        role: "tablist",
        "aria-label": "Player app",
        key: "nav",
      },
      NAV_TABS.map((tab) => {
        const active = navIsActive(tab, state.tab);
        return h(
          "button",
          {
            className: `player-app-nav-btn${active ? " active" : ""}`,
            type: "button",
            role: "tab",
            "aria-selected": active ? "true" : "false",
            "data-dtab": tab.key,
            key: tab.key,
            onClick: () => selectDashboardTab(tab.key),
          },
          [navIcon(tab.icon), tab.label],
        );
      }),
    ),
  ]);
}
