import React from "react";

import { currentAdminOrdersBadgeCount } from "./admin-shell-state.js";
import { counterHandoff, deskSummary, handoffLabel, holdDeskOrder } from "./desk-model.js";
import { useSettledWhileLoading } from "../shared/settled-state.js";
import { repeatSavePayload } from "./event-form.js";
import {
  bucketAdminEvents,
  formatAdminEventPlace,
  formatAdminEventWhen,
  normalizeAdminEvent,
  pickTodayEvent,
} from "./admin-events-model.js";
import { nextWeekOffer } from "./repeat-draft.js";
import { clubToday } from "../shared/events-model.js";

const h = React.createElement;
const EMPTY_STATE = { status: "loading", events: [] };
const EMPTY_DESK = { eventId: "", players: [], status: "idle" };

function dispatchRequest(name, detail = {}) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function requestTab(tab, extra = {}) {
  dispatchRequest("gvdg:admin-tab-request", { tab, ...extra });
}

function statusChip(status) {
  const label = status === "live" ? "Live" : status === "scheduled" ? "Scheduled" : status;
  return h("span", { className: `admin-badge ${status}` }, label);
}

function DeskLine({ onTap, player }) {
  const settled = player.checkedIn && player.paid;
  const note = !player.paid ? "Owes" : player.checkedIn ? "Here" : "Not here";
  return h("button", {
    className: settled ? "admin-desk-line in" : "admin-desk-line",
    onClick: () => onTap(player, !settled),
    type: "button",
  }, [
    h("span", { key: "name" }, player.name),
    h("span", { key: "note" }, note),
  ]);
}

function MorningDesk({ event }) {
  const [desk, setDesk] = React.useState(EMPTY_DESK);
  const order = React.useRef([]);
  const eventId = event && event.id ? String(event.id) : "";

  React.useEffect(() => {
    if (!eventId) return undefined;
    function update(message) {
      const detail = message.detail && typeof message.detail === "object" ? message.detail : EMPTY_DESK;
      if (String(detail.eventId || "") !== eventId) return;
      setDesk({
        eventId,
        players: Array.isArray(detail.players) ? detail.players : [],
        status: detail.status === "loading" || detail.status === "error" ? detail.status : "ready",
      });
    }
    window.addEventListener("gvdg:admin-desk", update);
    setDesk({ ...EMPTY_DESK, eventId, status: "loading" });
    dispatchRequest("gvdg:admin-desk-request", { eventId });
    return () => window.removeEventListener("gvdg:admin-desk", update);
  }, [eventId]);

  if (!eventId || desk.status === "idle" || desk.status === "loading") {
    return h("p", { className: "dash-note", key: "desk" }, "Checking the line…");
  }
  if (desk.status === "error") {
    return h("button", { className: "admin-btn", key: "score", onClick: () => requestTab("scoring", { eventId }), type: "button" }, "Start scoring");
  }
  const nextOrder = holdDeskOrder(desk.players, order.current);
  if (nextOrder !== order.current) order.current = nextOrder;
  const byId = new Map(desk.players.map((player) => [String(player.id != null ? player.id : player.name), player]));
  const line = order.current.map((id) => byId.get(id)).filter(Boolean);
  const summary = deskSummary(desk.players);
  const canStart = summary.ready || !summary.line.length;
  function tap(player, settle) {
    setDesk((current) => ({
      ...current,
      players: current.players.map((row) => row.id === player.id ? { ...row, checkedIn: settle, paid: settle ? true : row.paid } : row),
    }));
    dispatchRequest("gvdg:admin-desk-tap-request", { eventId, registrationId: player.id, settle });
  }
  return h("div", { className: "admin-desk", key: "desk" }, [
    h("p", { className: "admin-pane-kicker", key: "count" }, !summary.line.length ? "No one on the list yet." : summary.ready ? "Everyone is here." : `${summary.here} here${summary.owe ? ` · ${summary.owe} still owe` : ""}`),
    ...line.map((player) => h(DeskLine, { key: player.id || player.name, onTap: tap, player })),
    canStart && event.status !== "live" ? h("button", {
      className: "admin-btn",
      key: "score",
      onClick: () => requestTab("scoring", { eventId }),
      type: "button",
    }, "Start scoring") : null,
  ]);
}

function HandoffCard({ order }) {
  if (!order) return null;
  const ready = order.status === "ready";
  return h("div", { className: "admin-today-card admin-handoff", key: "handoff" }, [
    h("div", { className: "ev-name", key: "who" }, handoffLabel(order)),
    h("p", { className: "admin-event-meta", key: "state" }, ready ? "Ready to hand off" : "Order waiting"),
    h("button", {
      className: "admin-btn",
      key: "act",
      onClick: () => dispatchRequest("gvdg:admin-order-save-request", {
        order: order.source,
        requestId: `handoff-${order.id}`,
        status: ready ? "completed" : "ready",
        trackingCarrier: "",
        trackingNumber: "",
      }),
      type: "button",
    }, ready ? "Handed off" : "Mark ready"),
  ]);
}

export function AdminTodayDashboard() {
  const [state, setState] = React.useState(EMPTY_STATE);
  const [orders, setOrders] = React.useState(() => currentAdminOrdersBadgeCount());
  const [orderRows, setOrderRows] = React.useState([]);
  const [shelf, setShelf] = React.useState(null);

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
    function updateOrderRows(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      if (detail.status === "loading") return;
      setOrderRows(Array.isArray(detail.orders) ? detail.orders : []);
    }
    function updateShelf(event) {
      const count = Number(event.detail && event.detail.count);
      setShelf({
        count: Number.isFinite(count) ? count : 0,
        name: event.detail && event.detail.name ? String(event.detail.name) : "",
      });
    }
    window.addEventListener("gvdg:admin-events-list", updateEvents);
    window.addEventListener("gvdg:admin-orders-badge", updateOrders);
    window.addEventListener("gvdg:admin-orders-list", updateOrderRows);
    window.addEventListener("gvdg:admin-shelf", updateShelf);
    return () => {
      window.removeEventListener("gvdg:admin-events-list", updateEvents);
      window.removeEventListener("gvdg:admin-orders-badge", updateOrders);
      window.removeEventListener("gvdg:admin-orders-list", updateOrderRows);
      window.removeEventListener("gvdg:admin-shelf", updateShelf);
    };
  }, []);

  const view = useSettledWhileLoading(state);

  if (view.status === "loading") {
    return h("p", { className: "dash-note", "data-react-admin-today": "loading", role: "status" }, "Loading…");
  }

  const next = pickTodayEvent(view.events);
  const { live, upcoming, past } = bucketAdminEvents(view.events);
  const rest = [...live, ...upcoming].filter((event) => event.id !== next?.id).slice(0, 4);
  const fieldNote = next ? `${live.length + upcoming.length} on the books` : "Nothing scheduled";
  const deskEvent = next && (next.status === "live" || next.status === "scheduled") ? next : null;
  const offer = next && next.status === "live" ? null : nextWeekOffer(view.events.map((event) => event.source), clubToday());
  const handoff = counterHandoff(orderRows);
  const when = next ? formatAdminEventWhen(next) : "";
  const place = next ? formatAdminEventPlace(next) : "";

  return h("div", { "data-react-admin-today": next ? "ready" : "empty" }, [
    h("h2", { className: "admin-pane-heading", key: "title" }, "Today"),
    next
      ? h("div", { className: "admin-today-card", "data-admin-event-id": next.id, key: "next" }, [
        statusChip(next.status === "live" ? "live" : "scheduled"),
        h("div", { className: "ev-name", key: "name" }, next.name),
        when ? h("div", { className: "admin-event-meta", key: "when" }, when) : null,
        place ? h("div", { className: "admin-event-meta", key: "place" }, place) : null,
        deskEvent ? h(MorningDesk, { event: next, key: "morning" }) : null,
        h("div", { className: "admin-today-actions", key: "actions" }, [
          next.status === "live" ? h("button", {
            className: "admin-btn",
            key: "score",
            onClick: () => requestTab("scoring", { eventId: next.id }),
            type: "button",
          }, "Open scoring") : null,
          h("button", {
            className: "admin-btn secondary",
            key: "roster",
            onClick: () => requestTab("registration", { eventId: next.id }),
            type: "button",
          }, "Roster"),
        ]),
      ].filter(Boolean))
      : h("p", { className: "dash-note", key: "empty" }, past.length ? "Nothing on the card right now." : "Nothing on the card right now."),
    offer ? h("button", {
      className: "admin-btn",
      key: "next-week",
      onClick: () => {
        const payload = repeatSavePayload(offer.source);
        dispatchRequest("gvdg:admin-event-save-request", { ...payload, eventId: null, requestId: `event-repeat-${offer.nextDate}` });
      },
      type: "button",
    }, offer.label) : null,
    h(HandoffCard, { key: "handoff", order: handoff }),
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
      }, [h("strong", { key: "v" }, orders ? `${orders} to hand off` : "None waiting"), h("span", { key: "k" }, "Shop orders")]),
      h("button", {
        className: "admin-today-tile",
        key: "shelf",
        onClick: () => requestTab("shop"),
        type: "button",
      }, [h("strong", { key: "v" }, shelf == null ? "…" : shelf.count ? `${shelf.count} low` : "Stocked"), h("span", { key: "k" }, shelf && shelf.count === 1 && shelf.name ? shelf.name : "Shelf")]),
    ]),
    rest.length ? h("h3", { className: "admin-pane-kicker", key: "week-title" }, "Up next") : null,
    ...rest.map((event) => h("button", {
      className: "admin-evrow admin-event-card",
      key: event.id,
      onClick: () => requestTab(event.status === "live" ? "scoring" : "registration", { eventId: event.id }),
      type: "button",
    }, [
      h("span", { className: "ev-name", key: "name" }, event.name),
      formatAdminEventWhen(event) ? h("span", { className: "admin-event-meta", key: "when" }, formatAdminEventWhen(event)) : null,
    ])),
  ].filter(Boolean));
}