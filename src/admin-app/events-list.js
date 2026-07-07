import React from "react";

const h = React.createElement;

const EVENT_STATUSES = ["scheduled", "live", "final", "cancelled"];
const EMPTY_STATE = { status: "loading", events: [] };

function currentState() {
  const state = window.__gvdgAdminEventsListState;
  return state && typeof state === "object" ? state : EMPTY_STATE;
}

function normalizeEvent(event) {
  const source = event && typeof event === "object" ? event : {};
  const status = typeof source.status === "string" && source.status ? source.status : "scheduled";
  return {
    source,
    id: source.id == null ? "" : String(source.id),
    name: typeof source.name === "string" && source.name ? source.name : "Untitled event",
    status,
    date: typeof source.date === "string" ? source.date : "",
  };
}

function normalizeState(state) {
  const events = Array.isArray(state.events) ? state.events.map(normalizeEvent) : [];
  return {
    status: state.status === "loading" ? "loading" : "ready",
    events,
  };
}

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function AdminEventRow({ event }) {
  const safeStatus = EVENT_STATUSES.includes(event.status) ? event.status : "scheduled";
  const [selectValue, setSelectValue] = React.useState(safeStatus);

  React.useEffect(() => {
    setSelectValue(safeStatus);
  }, [safeStatus]);

  function requestStatusChange(changeEvent) {
    const status = changeEvent.target.value;
    if (!window.confirm(`Change "${event.name}" status to ${status}?`)) {
      setSelectValue(safeStatus);
      return;
    }
    setSelectValue(status);
    dispatchRequest("gvdg:admin-event-status-request", { event: event.source, status });
  }

  function requestDelete() {
    if (!window.confirm(`Delete event "${event.name}"?`)) return;
    dispatchRequest("gvdg:admin-event-delete-request", { event: event.source });
  }

  return h("div", { className: "admin-evrow", "data-admin-event-id": event.id }, [
    h("span", { className: "ev-name", key: "name" }, event.name),
    h("span", { className: `admin-badge ${event.status}`, key: "status" }, event.status),
    event.date ? h("span", { className: "dash-event-date", key: "date" }, event.date) : null,
    h("select", {
      "aria-label": `Status for ${event.name}`,
      key: "select",
      onChange: requestStatusChange,
      value: selectValue,
    }, EVENT_STATUSES.map((status) => h("option", { key: status, value: status }, status))),
    h("button", {
      className: "admin-btn secondary",
      key: "edit",
      onClick: () => dispatchRequest("gvdg:admin-event-edit-request", { event: event.source }),
      type: "button",
    }, "Edit"),
    h("button", {
      className: "admin-btn danger",
      key: "delete",
      onClick: requestDelete,
      type: "button",
    }, "Delete"),
  ]);
}

export function AdminEventsList() {
  const [state, setState] = React.useState(() => normalizeState(currentState()));

  React.useEffect(() => {
    function update(event) {
      setState(normalizeState(event.detail && typeof event.detail === "object" ? event.detail : currentState()));
    }
    window.addEventListener("gvdg:admin-events-list", update);
    setState(normalizeState(currentState()));
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
    return h("p", {
      className: "dash-note",
      "data-react-admin-events-list": "empty",
      role: "status",
    }, "No events yet — create or import one.");
  }

  return h("div", { "data-react-admin-events-list": "ready" }, state.events.map((event, index) => (
    h(AdminEventRow, { event, key: event.id || `${event.name}-${index}` })
  )));
}
