import React from "react";

import { currentAdminOrdersBadgeCount } from "./admin-shell-state.js";
import {
  bucketAdminEvents,
  formatAdminEventPlace,
  formatAdminEventWhen,
  normalizeAdminEvent,
  pickTodayEvent,
} from "./admin-events-model.js";

const h = React.createElement;
const EMPTY_STATE = { status: "loading", events: [] };

function dispatchRequest(name, detail = {}) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function requestTab(tab, extra = {}) {
  dispatchRequest("gvdg:admin-tab-request", { tab, ...extra });
}

function openEvent(event) {
  const eventId = event.id;
  if (!eventId) return;
  if (event.status === "live") requestTab("scoring", { eventId });
  else requestTab("registration", { eventId });
}

function statusChip(status) {
  const label = status === "live" ? "Live" : status === "scheduled" ? "Scheduled" : status;
  return h("span", { className: `admin-badge ${status}` }, label);
}

function EventCard({ event, featured }) {
  const when = formatAdminEventWhen(event);
  const place = formatAdminEventPlace(event);
  const scoreLabel = event.status === "live" ? "Open scoring" : "Start scoring";
  return h("div", {
    className: featured ? "admin-today-card" : "admin-evrow admin-event-card",
    "data-admin-event-id": event.id,
  }, [
    featured
      ? h("div", { className: "admin-event-card-main", key: "main" }, [
        statusChip(event.status === "live" ? "live" : "scheduled"),
        h("div", { className: "ev-name", key: "name" }, event.name),
        when ? h("div", { className: "admin-event-meta", key: "when" }, when) : null,
        place ? h("div", { className: "admin-event-meta", key: "place" }, place) : null,
      ].filter(Boolean))
      : h("button", {
        className: "admin-event-card-main",
        key: "main",
        onClick: () => openEvent(event),
        type: "button",
      }, [
        h("span", { className: "ev-name", key: "name" }, event.name),
        when ? h("span", { className: "admin-event-meta", key: "when" }, when) : null,
        place ? h("span", { className: "admin-event-meta", key: "place" }, place) : null,
      ]),
    featured ? h("div", { className: "admin-today-actions", key: "actions" }, [
      h("button", {
        className: "admin-btn",
        key: "score",
        onClick: () => requestTab("scoring", { eventId: event.id }),
        type: "button",
      }, scoreLabel),
      h("button", {
        className: "admin-btn secondary",
        key: "roster",
        onClick: () => requestTab("registration", { eventId: event.id }),
        type: "button",
      }, "Roster"),
    ]) : h("span", { className: `admin-badge ${event.status}`, key: "status" }, event.status),
  ]);
}

export function AdminTodayDashboard() {
  const [state, setState] = React.useState(EMPTY_STATE);
  const [orders, setOrders] = React.useState(() => currentAdminOrdersBadgeCount());

  React.useEffect(() => {
    function updateEvents(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : EMPTY_STATE;
      setState({
        status: detail.status === "loading" ? "loading" : "ready",
        events: Array.isArray(detail.events) ? detail.events.map(normalizeAdminEvent) : [],
      });
    }
    function updateOrders(event) {
      setOrders(Number(event.detail?.count) || currentAdminOrdersBadgeCount());
    }
    window.addEventListener("gvdg:admin-events-list", updateEvents);
    window.addEventListener("gvdg:admin-orders-badge", updateOrders);
    return () => {
      window.removeEventListener("gvdg:admin-events-list", updateEvents);
      window.removeEventListener("gvdg:admin-orders-badge", updateOrders);
    };
  }, []);

  if (state.status === "loading") {
    return h("p", { className: "dash-note", "data-react-admin-today": "loading", role: "status" }, "Loading…");
  }

  const next = pickTodayEvent(state.events);
  const { live, upcoming } = bucketAdminEvents(state.events);
  const rest = [...live, ...upcoming].filter((event) => event.id !== next?.id).slice(0, 4);
  const fieldNote = next ? `${live.length + upcoming.length} on the books` : "Nothing scheduled";

  return h("div", { "data-react-admin-today": next ? "ready" : "empty" }, [
    h("h2", { className: "admin-pane-heading", key: "title" }, "Today"),
    next
      ? h(EventCard, { event: next, featured: true, key: "next" })
      : h("p", { className: "dash-note", key: "empty" }, "Nothing on the card right now."),
    h("div", { className: "admin-today-tiles", key: "tiles" }, [
      h("button", {
        className: "admin-today-tile",
        key: "events",
        onClick: () => requestTab("events"),
        type: "button",
      }, [h("strong", { key: "v" }, fieldNote), h("span", { key: "k" }, "Events")]),
      h("button", {
        className: "admin-today-tile",
        key: "score",
        onClick: () => requestTab("scoring", next?.id ? { eventId: next.id } : {}),
        type: "button",
      }, [h("strong", { key: "v" }, next?.status === "live" ? "Live" : "Idle"), h("span", { key: "k" }, "Scoring")]),
      h("button", {
        className: "admin-today-tile",
        key: "orders",
        onClick: () => requestTab("orders"),
        type: "button",
      }, [h("strong", { key: "v" }, orders ? `${orders} new` : "None"), h("span", { key: "k" }, "Shop orders")]),
    ]),
    rest.length ? h("h3", { className: "admin-pane-kicker", key: "week-title" }, "Up next") : null,
    ...rest.map((event) => h(EventCard, { event, featured: false, key: event.id })),
  ].filter(Boolean));
}
