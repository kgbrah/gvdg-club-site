import React from "react";

import { adminConfirm } from "./admin-dialogs.js";
import {
  bucketAdminEvents,
  formatAdminEventPlace,
  formatAdminEventWhen,
  normalizeAdminEvent,
} from "./admin-events-model.js";

const h = React.createElement;

const EVENT_STATUSES = ["scheduled", "live", "final", "cancelled"];
const MANUAL_STATUSES = ["scheduled", "final", "cancelled"];
const EMPTY_STATE = { status: "loading", events: [] };
const FILTERS = [
  { id: "upcoming", label: "Upcoming" },
  { id: "live", label: "Live" },
  { id: "past", label: "Past" },
];

function normalizeState(state) {
  const events = Array.isArray(state.events) ? state.events.map(normalizeAdminEvent) : [];
  return {
    status: state.status === "loading" ? "loading" : "ready",
    events,
  };
}

function statusOptions(current) {
  const options = MANUAL_STATUSES.map((status) => h("option", { key: status, value: status }, status));
  if (current === "live") {
    options.unshift(h("option", { key: "live", value: "live", disabled: true, hidden: true }, "live"));
  }
  return options;
}

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function requestTab(tab, extra = {}) {
  dispatchRequest("gvdg:admin-tab-request", { tab, ...extra });
}

function AdminEventRow({ event }) {
  const safeStatus = EVENT_STATUSES.includes(event.status) ? event.status : "scheduled";
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [selectValue, setSelectValue] = React.useState(safeStatus);
  const when = formatAdminEventWhen(event);
  const place = formatAdminEventPlace(event);

  React.useEffect(() => {
    setSelectValue(safeStatus);
  }, [safeStatus]);

  async function requestStatusChange(changeEvent) {
    const status = changeEvent.target.value;
    const confirmed = await adminConfirm({
      title: "Change event status",
      message: `Change "${event.name}" status to ${status}?`,
      confirmText: "Change status",
    });
    if (!confirmed) {
      setSelectValue(safeStatus);
      return;
    }
    setSelectValue(status);
    dispatchRequest("gvdg:admin-event-status-request", { event: event.source, status });
  }

  async function requestDelete() {
    const confirmed = await adminConfirm({
      title: "Delete event",
      message: `Delete event "${event.name}"?`,
      confirmText: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    dispatchRequest("gvdg:admin-event-delete-request", { event: event.source });
  }

  return h("div", { className: "admin-evrow admin-event-card", "data-admin-event-id": event.id }, [
    h("button", {
      className: "admin-event-card-main",
      key: "main",
      onClick: () => {
        if (event.status === "live") requestTab("scoring", { eventId: event.id });
        else if (event.status === "scheduled") requestTab("registration", { eventId: event.id });
        else dispatchRequest("gvdg:admin-event-edit-request", { event: event.source });
      },
      type: "button",
    }, [
      h("span", { className: "ev-name", key: "name" }, event.name),
      when ? h("span", { className: "admin-event-meta", key: "when" }, when) : null,
      place ? h("span", { className: "admin-event-meta", key: "place" }, place) : null,
    ]),
    h("span", { className: `admin-badge ${event.status}`, key: "status" }, event.status),
    h("button", {
      "aria-expanded": menuOpen ? "true" : "false",
      "aria-label": `More actions for ${event.name}`,
      className: "admin-event-more",
      key: "more",
      onClick: () => setMenuOpen((open) => !open),
      type: "button",
    }, "···"),
    menuOpen ? h("div", { className: "admin-event-menu", key: "menu" }, [
      h("label", { className: "admin-event-menu-status", key: "status" }, [
        "Status",
        h("select", {
          "aria-label": `Status for ${event.name}`,
          key: "select",
          onChange: requestStatusChange,
          value: selectValue,
        }, statusOptions(event.status)),
      ]),
      h("button", {
        className: "admin-btn secondary",
        key: "edit",
        onClick: () => dispatchRequest("gvdg:admin-event-edit-request", { event: event.source }),
        type: "button",
      }, "Edit"),
      h("button", {
        className: "admin-btn secondary",
        key: "roster",
        onClick: () => requestTab("registration", { eventId: event.id }),
        type: "button",
      }, "Roster"),
      h("button", {
        className: "admin-btn danger",
        key: "delete",
        onClick: requestDelete,
        type: "button",
      }, "Delete"),
    ]) : null,
  ]);
}

export function AdminEventsList() {
  const [state, setState] = React.useState(() => normalizeState(EMPTY_STATE));
  const [filter, setFilter] = React.useState("upcoming");

  React.useEffect(() => {
    function update(event) {
      setState(normalizeState(event.detail && typeof event.detail === "object" ? event.detail : EMPTY_STATE));
    }
    window.addEventListener("gvdg:admin-events-list", update);
    return () => window.removeEventListener("gvdg:admin-events-list", update);
  }, []);

  if (state.status === "loading") {
    return h("p", {
      className: "dash-note",
      "data-react-admin-events-list": "loading",
      role: "status",
    }, "Loading…");
  }

  if (!state.events.length) {
    return h("div", { "data-react-admin-events-list": "empty" }, [
      h("p", { className: "dash-note", key: "empty", role: "status" }, "No events yet — create or import one."),
      h("button", {
        className: "admin-btn",
        key: "create",
        onClick: () => {
          dispatchRequest("gvdg:admin-event-form-reset", {});
          requestTab("create");
        },
        type: "button",
      }, "New event"),
    ]);
  }

  const buckets = bucketAdminEvents(state.events);
  const rows = filter === "live"
    ? buckets.live
    : filter === "past"
      ? buckets.past
      : [...buckets.live, ...buckets.upcoming];

  return h("div", { "data-react-admin-events-list": "ready" }, [
    h("div", { className: "admin-events-toolbar", key: "toolbar" }, [
      h("h2", { className: "admin-pane-heading", key: "title" }, "Events"),
      h("button", {
        className: "admin-btn",
        key: "create",
        onClick: () => {
          dispatchRequest("gvdg:admin-event-form-reset", {});
          requestTab("create");
        },
        type: "button",
      }, "New event"),
    ]),
    h("div", { className: "admin-seg", key: "filters", role: "tablist", "aria-label": "Event filters" }, FILTERS.map((item) => h("button", {
      "aria-selected": filter === item.id ? "true" : "false",
      className: filter === item.id ? "on" : "",
      key: item.id,
      onClick: () => setFilter(item.id),
      type: "button",
    }, item.label))),
    rows.length
      ? rows.map((event, index) => h(AdminEventRow, { event, key: event.id || `${event.name}-${index}` }))
      : h("p", { className: "dash-note", key: "none", role: "status" }, `No ${filter} events.`),
  ]);
}
