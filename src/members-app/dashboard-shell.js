import React from "react";
import { CalendarDays, Home, PlayCircle, TrendingUp, Users } from "lucide-react";

import { destination, MEMBER_PRIMARY } from "../shared/app-navigation.js";
import { currentDashboardTab } from "./dashboard-router.js";

const h = React.createElement;
const ICONS = { overview: Home, play: PlayCircle, events: CalendarDays, season: TrendingUp, more: Users };

export function selectDashboardTab(tab, context = {}) {
  window.dispatchEvent(new CustomEvent("gvdg:select-dashboard-tab", { detail: { tab, ...context } }));
}

export function requestLogout() {
  window.dispatchEvent(new CustomEvent("gvdg:member-logout-requested"));
}

export function MemberDashboardShell() {
  const [tab, setTab] = React.useState(currentDashboardTab);
  const heading = React.useRef(null);
  const current = destination("member", tab);
  const parent = destination("member", current.group);

  React.useEffect(() => {
    function update(event) {
      if (!event.detail?.tab) return;
      setTab(event.detail.tab);
      if (event.detail.scroll) {
        requestAnimationFrame(() => {
          window.scrollTo(0, 0);
          heading.current?.focus({ preventScroll: true });
        });
      }
    }
    window.addEventListener("gvdg:dashboard-tab-selected", update);
    window.addEventListener("gvdg:member-dashboard-ready", update);
    setTab(currentDashboardTab());
    return () => {
      window.removeEventListener("gvdg:dashboard-tab-selected", update);
      window.removeEventListener("gvdg:member-dashboard-ready", update);
    };
  }, []);

  React.useEffect(() => {
    document.body.dataset.memberDashboardTab = tab;
    document.title = current.label + " | GVDG Members";
    return () => {
      if (document.body.dataset.memberDashboardTab === tab) delete document.body.dataset.memberDashboardTab;
    };
  }, [tab, current.label]);

  return h("div", { className: "member-dashboard-shell-chrome", "data-member-dashboard-shell": tab }, [
    h("nav", { className: "player-app-nav", "aria-label": "Member app", key: "nav" }, MEMBER_PRIMARY.map((key) => {
      const item = destination("member", key);
      const active = current.group === key;
      return h("button", {
        "aria-current": active ? "page" : undefined,
        className: "player-app-nav-btn" + (active ? " active" : ""),
        type: "button", "data-dtab": key, key, onClick: () => selectDashboardTab(key),
      }, [h(ICONS[key], { size: 22, strokeWidth: 2.2, "aria-hidden": true, key: "icon" }), item.label]);
    })),
    h("div", { className: "member-page-heading" + (current.key === "overview" ? " member-home-heading" : ""), key: "heading" }, [
      current.key !== current.group
        ? h("button", { type: "button", className: "member-parent-link", onClick: () => selectDashboardTab(parent.key), key: "parent" }, "‹ " + parent.label)
        : null,
      h("h1", { className: "section-title player-app-title", id: "membersReactDashboardTitle", tabIndex: -1, ref: heading, key: "title" }, current.label),
    ]),
  ]);
}
