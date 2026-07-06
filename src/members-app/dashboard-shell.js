import React from "react";

const h = React.createElement;

export const TABS = [
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

function initialState() {
  const tab = DEFAULT_TAB.key;
  const title = document.getElementById("memberSectionTitle")?.textContent?.trim() || tabTitle(tab);
  return { tab, title };
}

export function selectDashboardTab(tab) {
  window.dispatchEvent(new CustomEvent("gvdg:select-dashboard-tab", { detail: { tab } }));
}

export function MemberDashboardShell() {
  const [state, setState] = React.useState(initialState);

  React.useEffect(() => {
    function update(event) {
      const nextTab = safeTab(event.detail?.tab || DEFAULT_TAB.key);
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
            onClick: () => selectDashboardTab(tab.key),
          },
          tab.label,
        );
      }),
    ),
  ]);
}
