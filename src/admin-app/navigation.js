import React from "react";
import { createPortal } from "react-dom";
import { CalendarDays, House, MoreHorizontal, ShoppingBag, Timer } from "lucide-react";

import { currentAdminActiveTab } from "./admin-shell-state.js";
import { AdminOrdersBadge } from "./orders-badge.js";

const h = React.createElement;

export const ADMIN_NAV_GROUPS = [
  {
    label: "Home",
    items: [
      { tab: "today", label: "Today" },
    ],
  },
  {
    label: "Events",
    items: [
      { tab: "events", label: "Events" },
      { tab: "create", label: "New Event" },
      { tab: "import", label: "Import" },
      { tab: "registration", label: "Registration" },
    ],
  },
  {
    label: "Scoring",
    items: [
      { tab: "scoring", label: "Live Scoring" },
    ],
  },
  {
    label: "Shop",
    items: [
      { tab: "shop", label: "Pro Shop" },
      { tab: "orders", label: "Orders", badge: "orders" },
      { tab: "wallets", label: "Wallets" },
    ],
  },
  {
    label: "Club",
    items: [
      { tab: "courses", label: "Courses" },
      { tab: "layouts", label: "Layouts" },
      { tab: "tee-signs", label: "Tee Signs" },
      { tab: "leagues-mgmt", label: "Leagues" },
      { tab: "fundraisers", label: "Fundraisers" },
      { tab: "meetings", label: "Meetings" },
      { tab: "members", label: "Members" },
      { tab: "data-archive", label: "Data archive" },
    ],
  },
];

export const ADMIN_DOCK = [
  { id: "today", label: "Home", tab: "today", Icon: House, tabs: ["today"] },
  {
    id: "events",
    label: "Events",
    tab: "events",
    Icon: CalendarDays,
    tabs: ["events", "create", "import", "registration"],
    chips: [
      { tab: "events", label: "Events" },
      { tab: "create", label: "New" },
      { tab: "import", label: "Import" },
      { tab: "registration", label: "Registration" },
    ],
  },
  { id: "scoring", label: "Scoring", tab: "scoring", Icon: Timer, tabs: ["scoring"] },
  {
    id: "shop",
    label: "Shop",
    tab: "shop",
    Icon: ShoppingBag,
    tabs: ["shop", "orders", "wallets"],
    chips: [
      { tab: "shop", label: "Inventory" },
      { tab: "orders", label: "Orders", badge: "orders" },
      { tab: "wallets", label: "Wallets" },
    ],
  },
  {
    id: "more",
    label: "More",
    tab: "more",
    Icon: MoreHorizontal,
    tabs: ["more", "courses", "layouts", "tee-signs", "leagues-mgmt", "fundraisers", "meetings", "members", "data-archive"],
  },
];

function initialTab() {
  return currentAdminActiveTab();
}

function tabLabel(item) {
  if (item.badge === "orders") {
    return [item.label, " ", h(AdminOrdersBadge, { key: "badge" })];
  }
  return item.label;
}

function requestTab(tab) {
  window.dispatchEvent(new CustomEvent("gvdg:admin-tab-request", { detail: { tab } }));
}

function dockForTab(tab) {
  return ADMIN_DOCK.find((item) => item.tabs.includes(tab)) || ADMIN_DOCK[0];
}

function AdminDock({ activeId }) {
  return h("nav", {
    "aria-label": "Admin tabs",
    className: "admin-dock",
    "data-admin-dock": "portal",
  }, ADMIN_DOCK.map((item) => {
    const on = activeId === item.id;
    return h("button", {
      "aria-current": on ? "page" : undefined,
      className: on ? "admin-dock-item on" : "admin-dock-item",
      key: item.id,
      onClick: () => requestTab(item.tab),
      type: "button",
    }, [
      h(item.Icon, { "aria-hidden": true, key: "icon", size: 20, strokeWidth: 2.3 }),
      item.label,
      item.id === "shop" ? h(AdminOrdersBadge, { key: "badge" }) : null,
    ]);
  }));
}

export function AdminNavigation() {
  const [activeTab, setActiveTab] = React.useState(initialTab);

  React.useEffect(() => {
    function update(event) {
      const tab = event.detail?.tab;
      if (typeof tab === "string" && tab) setActiveTab(tab);
    }
    window.addEventListener("gvdg:admin-active-tab", update);
    setActiveTab(initialTab());
    return () => window.removeEventListener("gvdg:admin-active-tab", update);
  }, []);

  const dock = dockForTab(activeTab);
  const chips = dock.chips || [];
  const dockNav = typeof document === "undefined"
    ? null
    : createPortal(h(AdminDock, { activeId: dock.id }), document.body, "dock");

  return h(React.Fragment, null, [
    chips.length ? h("div", {
      className: "admin-mobile-chips",
      key: "chips",
      role: "tablist",
      "aria-label": `${dock.label} sections`,
    }, chips.map((item) => {
      const selected = item.tab === activeTab;
      return h("button", {
        "aria-selected": selected ? "true" : "false",
        className: selected ? "admin-chip on" : "admin-chip",
        key: item.tab,
        onClick: () => requestTab(item.tab),
        role: "tab",
        type: "button",
      }, tabLabel(item));
    })) : null,
    dockNav,
    h("nav", { "aria-label": "Admin sections", className: "admin-sidebar", key: "sidebar" },
      ADMIN_NAV_GROUPS.flatMap((group) => [
        h("div", { className: "admin-navgroup", key: `${group.label}-group` }, group.label),
        ...group.items.map((item) => {
          const active = item.tab === activeTab;
          return h("button", {
            "aria-current": active ? "page" : undefined,
            className: active ? "admin-tab active" : "admin-tab",
            "data-atab": item.tab,
            key: item.tab,
            onClick: () => requestTab(item.tab),
            type: "button",
          }, tabLabel(item));
        }),
      ])),
  ]);
}
