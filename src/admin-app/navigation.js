import React from "react";
import { createPortal } from "react-dom";
import { CalendarDays, House, Settings, Users, Wallet } from "lucide-react";

import { ADMIN_DESTINATIONS, ADMIN_PRIMARY, destination } from "../shared/app-navigation.js";
import { ToolFinder } from "../shared/tool-finder.js";
import { currentAdminRoute } from "./admin-shell-state.js";
import { AdminNeedsBadge } from "./admin-needs.js";
import { AdminOrdersBadge } from "./orders-badge.js";
import { MorningDesk } from "./today-dashboard.js";

const h = React.createElement;
const ICONS = { today: House, events: CalendarDays, members: Users, shop: Wallet, more: Settings };

export function requestAdminTab(tab, context = {}) {
  window.dispatchEvent(new CustomEvent("gvdg:admin-tab-request", { detail: { tab, ...context } }));
}

function itemBadge(key) {
  if (key === "orders") return h(AdminOrdersBadge, { key: "badge" });
  if (key === "applications" || key === "bag-tags" || key === "tee-signs" || key === "marketplace" || key === "lost-found" || key === "donations" || key === "workdays") {
    return h(AdminNeedsBadge, { key: "badge", tab: key === "applications" ? "members" : key });
  }
  return null;
}

function PrimaryNav({ group, dock = false }) {
  return h("nav", {
    "aria-label": "Admin navigation",
    className: dock ? "admin-dock" : "admin-sidebar",
    "data-admin-dock": dock ? "portal" : undefined,
  }, ADMIN_PRIMARY.map((item) => {
    const selected = group === (item.key === "shop" ? "money" : item.key);
    return h("button", {
      "aria-current": selected ? "page" : undefined,
      className: (dock ? "admin-dock-item" : "admin-tab") + (selected ? (dock ? " on" : " active") : ""),
      "data-atab": item.key,
      key: item.key, type: "button", onClick: () => requestAdminTab(item.key),
    }, [
      h(ICONS[item.key], { "aria-hidden": true, key: "icon", size: dock ? 20 : 18, strokeWidth: 2.2 }),
      item.label,
    ]);
  }));
}

function SectionLinks({ items, route, label, layout }) {
  return h("nav", { className: "admin-section-links" + (layout ? " " + layout : ""), "aria-label": label }, items.map((item) => {
    const selected = route.tab === item.key;
    return h("button", {
      "aria-current": selected ? "page" : undefined,
      className: "admin-chip" + (selected ? " on" : ""),
      type: "button", key: item.key, "data-atab": item.key,
      onClick: () => requestAdminTab(item.key, item.key === "orders" ? { filter: "new" }
        : item.key === "tee-signs" ? { filter: "candidate" } : {}),
    }, [item.label, itemBadge(item.key)]);
  }));
}

function Workspace({ route, title, group, events, courses }) {
  const workspace = ADMIN_DESTINATIONS.filter((item) => item.context === "event");
  const courseTools = ADMIN_DESTINATIONS.filter((item) => item.context === "course");
  const showEvent = workspace.some((item) => item.key === route.tab);
  const showCourse = courseTools.some((item) => item.key === route.tab);
  const event = events.find((item) => String(item.id) === route.eventId);
  const selectedCourse = courses.find((item) => String(item.id) === route.courseId);
  const groupLinks = ADMIN_DESTINATIONS.filter((item) => item.group === group && !item.context && (group !== "more" || item.key === "more"));
  const heading = React.useRef(null);

  React.useEffect(() => {
    document.title = title + (showEvent && event?.name ? " · " + event.name : "") + " | GVDG Admin";
  }, [title, showEvent, event?.name]);

  React.useEffect(() => {
    if (!route.focusHeading) return;
    const target = route.tab === "applications" ? document.getElementById("admin-applications-heading")
      : route.filter === "alerts" ? document.querySelector("[data-admin-push]")
      : route.filter === "requests" || route.filter === "challenges" ? document.getElementById("admin-bag-" + route.filter)
      : heading.current;
    const frame = requestAnimationFrame(() => {
      (target || heading.current)?.scrollIntoView({ block: "start" });
      (target || heading.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [route]);

  return h("div", { className: "admin-workspace-context" }, [
    h("div", { className: "admin-workspace-heading", key: "heading" }, [
      h("h1", { className: "admin-pane-heading admin-context-title", ref: heading, tabIndex: -1, key: "title" }, title),
      showEvent ? h("button", { className: "admin-chip", key: "event-list", onClick: () => requestAdminTab("events"), type: "button" }, "Event list") : null,
    ]),
    !showEvent && route.tab !== "events" && groupLinks.length > 1 ? h(SectionLinks, { key: "group", items: groupLinks, route, label: "Sections in " + group }) : null,
    route.tab === "events" ? h(SectionLinks, { key: "event-entry", items: groupLinks.concat(workspace), route, label: "Event tools", layout: "admin-tool-grid" }) : null,
    showEvent ? h("section", { className: "admin-context", "aria-label": "Selected event", key: "event" }, [
      h("p", { className: "admin-context-caption", key: "event" },
        event?.name || (route.eventId ? "Event #" + route.eventId : "Select an event"),
        event?.status === "live" ? h("span", { className: "admin-badge live" }, "Live") : null),
      h(SectionLinks, { items: workspace, route, label: "Event workspace", layout: "admin-tool-grid", key: "event-links" }),
      h("div", { key: "event-payments", className: "admin-context-links" }, [
        h("button", {
          className: "admin-chip", key: "wallets", type: "button", onClick: () => requestAdminTab("wallets", { eventId: route.eventId }),
        }, "Event payments and wallets"),
      ]),
      route.tab === "check-in" && event ? h(MorningDesk, { event, key: event.id }) : null,
    ]) : null,
    showCourse ? h("section", { className: "admin-context", "aria-label": "Selected course", key: "course" }, [
      route.tab === "course-health" ? null : route.tab === "layouts" ? h("p", { className: "admin-context-caption", key: "course-label" }, selectedCourse?.name || "Select a course below")
        : h("label", { className: "admin-context-caption", key: "course-label" }, [
        "Course",
        h("select", {
          value: selectedCourse ? route.courseId : "", key: "select",
          onChange: (event) => requestAdminTab(route.tab, { courseId: event.target.value || null }),
        }, [
          h("option", { value: "", key: "all" }, "All courses"),
          ...courses.map((course) => h("option", { value: String(course.id), key: course.id }, course.name)),
        ]),
      ]),
      h(SectionLinks, { items: courseTools, route, label: "Course workspace", layout: "admin-tool-grid", key: "course-links" }),
    ]) : null,
    route.tab === "wallets" && route.eventId ? h("button", {
      className: "admin-chip", type: "button", key: "event-back", onClick: () => requestAdminTab("registration", { eventId: route.eventId }),
    }, "Back to event registration and payouts") : null,
  ]);
}

export function AdminNavigation() {
  const [route, setRoute] = React.useState(currentAdminRoute);
  const [events, setEvents] = React.useState([]);
  const [courses, setCourses] = React.useState([]);
  React.useEffect(() => {
    const update = (event) => setRoute(event.detail || currentAdminRoute());
    const eventList = (event) => { if (event.detail?.status === "ready") setEvents(event.detail.events || []); };
    const courseList = (event) => { if (event.detail?.status === "ready") setCourses(event.detail.courses || []); };
    window.addEventListener("gvdg:admin-active-tab", update);
    window.addEventListener("gvdg:admin-events-list", eventList);
    window.addEventListener("gvdg:admin-courses-list", courseList);
    setRoute(currentAdminRoute());
    return () => {
      window.removeEventListener("gvdg:admin-active-tab", update);
      window.removeEventListener("gvdg:admin-events-list", eventList);
      window.removeEventListener("gvdg:admin-courses-list", courseList);
    };
  }, []);

  const active = destination("admin", route.tab);
  const contextMount = document.getElementById("adminContextReactApp");
  return h(React.Fragment, null, [
    h(ToolFinder, { role: "admin", isAdmin: true, onNavigate: requestAdminTab, key: "search" }),
    h(PrimaryNav, { group: active.group, key: "sidebar" }),
    createPortal(h(PrimaryNav, { group: active.group, dock: true }), document.body, "dock"),
    contextMount ? createPortal(h(Workspace, { title: active.label, group: active.group, route, events, courses }), contextMount, "context") : null,
  ]);
}
