import React from "react";

import { requestJson } from "./api.js";
import { currentDashboardTab } from "./dashboard-router.js";

const h = React.createElement;
const CLUB_ORIGIN = { lat: 35.6127, lng: -77.3664 };

function eventsTabActive(event) {
  const tab = event?.detail?.tab || currentDashboardTab();
  if (tab === "events") return true;
  return document.body?.dataset?.memberDashboardTab === "events";
}

function readPlayerOrigin() {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        source: "player",
      }),
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 300000, timeout: 8000 },
    );
  });
}

function EventCard({ event }) {
  const miles = typeof event.miles === "number" ? `${event.miles.toFixed(1)} mi` : "";
  const where = [event.course, event.place].filter(Boolean).join(" · ");
  return h("article", { className: "register-card pdga-event-card", "data-event-state": "register" }, [
    h("div", { className: "register-head", key: "head" }, [
      h("span", { className: "register-name", key: "name" }, event.name),
      miles ? h("span", { className: "pdga-event-miles", key: "miles" }, miles) : null,
    ]),
    h("p", { className: "register-date", key: "date" }, [event.date, event.tier].filter(Boolean).join(" · ")),
    where ? h("p", { className: "pdga-event-where", key: "where" }, where) : null,
    h("div", { className: "register-actions", key: "actions" },
      h("a", {
        className: "passkey-btn",
        href: event.url,
        rel: "noopener noreferrer",
        target: "_blank",
      }, "Register")),
  ]);
}

export function PdgaEventsSection() {
  const [active, setActive] = React.useState(eventsTabActive);
  const [state, setState] = React.useState({ status: "idle", events: [], source: "club" });

  React.useEffect(() => {
    function sync(event) {
      setActive(eventsTabActive(event));
    }
    window.addEventListener("gvdg:dashboard-tab-selected", sync);
    window.addEventListener("gvdg:member-dashboard-ready", sync);
    return () => {
      window.removeEventListener("gvdg:dashboard-tab-selected", sync);
      window.removeEventListener("gvdg:member-dashboard-ready", sync);
    };
  }, []);

  React.useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setState((current) => ({ ...current, status: current.events.length ? current.status : "loading" }));
    const apply = (data, source) => {
      if (cancelled) return;
      const events = Array.isArray(data?.events) ? data.events : [];
      setState({ status: events.length ? "ready" : "empty", events, source });
    };
    const load = (point, source) => requestJson(
      `/pdga-events?lat=${encodeURIComponent(point.lat)}&lng=${encodeURIComponent(point.lng)}`,
      { signal: controller.signal },
    ).then((data) => ({ data, source }));
    let sawPlayer = false;
    load(CLUB_ORIGIN, "club").then(({ data, source }) => {
      if (!sawPlayer) apply(data, source);
    }).catch((error) => {
      if (!cancelled && !sawPlayer && error?.name !== "AbortError") {
        setState({ status: "error", events: [], source: "club" });
      }
    });
    readPlayerOrigin().then((origin) => {
      if (cancelled || !origin) return null;
      return load(origin, "player").then(({ data, source }) => {
        sawPlayer = true;
        apply(data, source);
      });
    }).catch((error) => {
      if (!cancelled && !sawPlayer && error?.name !== "AbortError") {
        setState((current) => current.events.length ? current : { status: "error", events: [], source: "club" });
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [active]);

  if (!active && state.status === "idle") return null;

  const note = state.source === "player"
    ? "PDGA events within 100 miles, soonest first."
    : "PDGA events within 100 miles of Greenville, soonest first. Allow location to use where you are.";

  return h("section", { className: "pdga-events", "data-pdga-events": state.status }, [
    h("h3", { className: "my-dashboard-title", key: "title" }, "Nearby PDGA"),
    h("p", { className: "dash-note", key: "note" }, note),
    state.status === "loading" ? h("p", { className: "dash-note", key: "loading" }, "Finding nearby PDGA events...") : null,
    state.status === "error" ? h("p", { className: "dash-note", key: "error" }, "PDGA events are temporarily unavailable.") : null,
    state.status === "empty" ? h("p", { className: "dash-note", key: "empty" }, "No upcoming PDGA events within 100 miles.") : null,
    state.status === "ready"
      ? h("div", { key: "list" }, state.events.map((event) => h(EventCard, { event, key: event.url })))
      : null,
  ]);
}
