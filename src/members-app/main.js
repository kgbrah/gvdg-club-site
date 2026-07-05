import React from "react";
import { createRoot } from "react-dom/client";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const h = React.createElement;

const TABS = [
  { key: "overview", label: "Overview", title: "Player Dashboard" },
  { key: "events", label: "Events", title: "Event Registration" },
  { key: "board", label: "Board", title: "Member Board" },
  { key: "tee", label: "Tee Signs", title: "Tee Sign Capture" },
  { key: "club", label: "Club", title: "GVDG Member Directory" },
];

const DEFAULT_TAB = TABS[0];
const tabKeys = new Set(TABS.map((tab) => tab.key));

function safeTab(value) {
  return tabKeys.has(value) ? value : DEFAULT_TAB.key;
}

function tabTitle(key) {
  return TABS.find((tab) => tab.key === key)?.title || DEFAULT_TAB.title;
}

function tabFromLegacyDom() {
  const active = document.querySelector("#dashTabs .dash-tab.active");
  return safeTab(active?.getAttribute("data-dtab") || DEFAULT_TAB.key);
}

function initialState() {
  const tab = tabFromLegacyDom();
  const title = document.getElementById("memberSectionTitle")?.textContent?.trim() || tabTitle(tab);
  return { tab, title };
}

function selectTab(tab) {
  window.dispatchEvent(new CustomEvent("gvdg:select-dashboard-tab", { detail: { tab } }));
}

function MemberDashboardShell() {
  const [state, setState] = React.useState(initialState);

  React.useEffect(() => {
    function update(event) {
      const nextTab = safeTab(event.detail?.tab || tabFromLegacyDom());
      setState({
        tab: nextTab,
        title: event.detail?.title || tabTitle(nextTab),
      });
    }

    window.addEventListener("gvdg:dashboard-tab-selected", update);
    window.addEventListener("gvdg:member-dashboard-ready", update);
    return () => {
      window.removeEventListener("gvdg:dashboard-tab-selected", update);
      window.removeEventListener("gvdg:member-dashboard-ready", update);
    };
  }, []);

  return h(React.Fragment, null, [
    h("h2", { className: "section-title", id: "membersReactDashboardTitle", key: "title" }, state.title),
    h(
      "div",
      {
        className: "dash-tabs members-react-tabs",
        role: "tablist",
        "aria-label": "Member dashboard sections",
        key: "tabs",
      },
      TABS.map((tab) => {
        const active = state.tab === tab.key;
        return h(
          "button",
          {
            className: `dash-tab${active ? " active" : ""}`,
            type: "button",
            role: "tab",
            "aria-selected": active ? "true" : "false",
            "data-dtab": tab.key,
            key: tab.key,
            onClick: () => selectTab(tab.key),
          },
          tab.label,
        );
      }),
    ),
  ]);
}

const mount = document.getElementById("membersReactDashboardShell");
if (mount) {
  createRoot(mount).render(h(MemberDashboardShell));
  document.getElementById("members")?.classList.add("members-react-shell-ready");
}
