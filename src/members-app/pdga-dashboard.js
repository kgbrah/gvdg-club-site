import React from "react";

import { requestJson } from "./api.js";

const h = React.createElement;
const PDGA_REFRESH_MS = 15 * 60 * 1000;

const HTML_ENTITY_MAP = {
  amp: "&",
  apos: "'",
  quot: '"',
  "#039": "'",
};

export function pdgaEventTitle(value) {
  return String(value || "").replace(/&(#\d+|#x[\da-fA-F]+|amp|apos|quot|#039);/g, (match, entity) => {
    if (HTML_ENTITY_MAP[entity]) return HTML_ENTITY_MAP[entity];
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return match;
  }).trim();
}

export function pdgaEventYear(event) {
  const match = String(event && event.date || "").match(/(\d{4})/);
  if (match) return match[1];
  const epoch = Number(event && event.epoch);
  if (Number.isFinite(epoch) && epoch > 0) {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric" }).format(new Date(epoch * 1000));
  }
  return "Unknown";
}

export function pdgaCurrentYear(now = new Date()) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(now);
}

export function groupPdgaEventsByYear(events) {
  const groups = [];
  const index = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const year = pdgaEventYear(event);
    let group = index.get(year);
    if (!group) {
      group = { year, events: [] };
      index.set(year, group);
      groups.push(group);
    }
    group.events.push(event);
  }
  return groups.sort((a, b) => String(b.year).localeCompare(String(a.year), undefined, { numeric: true }));
}

function ratingValue(value) {
  return value == null ? "-" : String(value);
}

function eventMeta(event) {
  return [event.date || "", event.division || ""].filter(Boolean).join(" - ");
}

function eventRatings(event) {
  const ratings = (event.rounds || []).map((round) => round.rating).filter((value) => value != null);
  return ratings.length ? ratings.join(" - ") : "-";
}

function EventRatingRow({ ratings }) {
  const label = ratings === "-" ? "Rating" : "Round ratings";
  return h("div", { className: "dash-event-rating-row", key: "rating-row" }, [
    h("span", { className: "dash-event-rating-label", key: "label" }, label),
    h("span", {
      "aria-label": ratings === "-" ? "Round ratings unavailable" : `Round ratings: ${ratings}`,
      className: "dash-event-ratings",
      key: "ratings",
    }, ratings),
  ]);
}

export function usePdgaStats(pdgaNo) {
  const [state, setState] = React.useState({ status: pdgaNo ? "loading" : "empty", stats: null });

  React.useEffect(() => {
    if (!pdgaNo) {
      setState({ status: "empty", stats: null });
      return undefined;
    }

    const controller = new AbortController();
    let lastRequestedAt = 0;
    const load = (showLoading = false) => {
      lastRequestedAt = Date.now();
      if (showLoading) setState({ status: "loading", stats: null });
      void requestJson(`/pdga-stats?pdga=${encodeURIComponent(pdgaNo)}`, { signal: controller.signal })
        .then((stats) => {
          if (!stats || (stats.official_rating == null && !(Array.isArray(stats.events) && stats.events.length))) {
            setState({ status: "missing", stats: null });
            return;
          }
          setState({ status: "ready", stats });
        })
        .catch((error) => {
          if (error.name !== "AbortError") {
            lastRequestedAt = 0;
            setState({ status: "error", stats: null });
          }
        });
    };
    const refreshIfStale = () => {
      if (Date.now() - lastRequestedAt >= PDGA_REFRESH_MS) load();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };

    load(true);
    const refreshTimer = window.setInterval(refreshIfStale, PDGA_REFRESH_MS);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      controller.abort();
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [pdgaNo]);

  return state;
}

function RatingTile({ label, value, delta, live = false }) {
  const props = {
    className: "dash-tile",
  };
  if (live) {
    props["data-react-live-rating"] = "true";
  }
  return h("div", props, [
    h("div", { className: "dash-tile-num", key: "value" }, ratingValue(value)),
    delta ? h("div", { className: "dash-tile-delta", key: "delta" }, delta) : null,
    h("div", { className: "dash-tile-label", key: "label" }, label),
  ]);
}

function RecentEvent({ event }) {
  const ratings = eventRatings(event);
  const title = pdgaEventTitle(event.tournament) || "Event";
  return h("article", { className: "dash-event" }, [
    h("div", { className: "dash-event-main", key: "main" }, [
      h("div", { className: "dash-event-copy", key: "copy" }, [
        h("div", { className: "dash-event-name", key: "name" }, title),
        h("div", { className: "dash-event-date", key: "date" }, eventMeta(event)),
      ]),
      h(EventRatingRow, { ratings, key: "rating-row" }),
    ]),
  ]);
}

function eventCard(event, index) {
  return h(RecentEvent, { event, key: `${event.tournament || "event"}-${event.epoch || index}` });
}

function TournamentList({ events }) {
  const groups = groupPdgaEventsByYear(events);
  const currentYear = pdgaCurrentYear();
  const list = groups.length <= 1
    ? groups.flatMap((group) => group.events.map(eventCard))
    : groups.map((group) => h("details", {
      className: "dash-event-year",
      key: group.year,
      open: group.year === currentYear || undefined,
    }, [
      h("summary", { className: "dash-event-year-summary", key: "summary" }, `${group.year} (${group.events.length})`),
      h("div", { className: "dash-event-year-list", key: "list" }, group.events.map(eventCard)),
    ]));

  return h("details", { className: "dash-collapse", key: "events" }, [
    h("summary", { className: "dash-subtitle dash-collapse-summary", key: "title" }, `Tournaments (${events.length})`),
    h("div", { key: "list" }, list),
  ]);
}

export function PdgaDashboard({ pdgaNo, state, children, compact = false }) {
  const status = state.status;
  const stats = state.stats;
  const extras = children ? [children] : [];

  if (!pdgaNo) {
    return dashboardShell("empty", [
      h("div", { className: "react-pdga-status", key: "status" }, "No PDGA # is linked to your account yet. PDGA ratings and tournament history will appear here once it is."),
      ...extras,
    ]);
  }

  if (status === "loading") {
    return dashboardShell("loading", [
      h("div", { className: "react-pdga-status", key: "status" }, "Loading your stats..."),
      ...extras,
    ]);
  }

  if (status === "missing") {
    return dashboardShell("missing", [
      h("div", { className: "react-pdga-status", key: "status" }, `We couldn't find live data for PDGA #${pdgaNo} yet. Check back after the next sync.`),
      ...extras,
    ]);
  }

  if (status === "error") {
    return dashboardShell("error", [
      h("div", { className: "react-pdga-status error", key: "status" }, "Could not load PDGA stats. Please refresh and try again."),
      ...extras,
    ]);
  }

  const events = Array.isArray(stats?.events) ? stats.events : [];
  const live = stats?.live_rating;
  const official = stats?.official_rating;
  const delta = live != null && official != null
    ? `${live - official >= 0 ? "+" : ""}${live - official} vs official`
    : "";

  const history = events.length ? h(TournamentList, { events, key: "events" }) : null;

  if (compact) {
    return dashboardShell("ready", [
      ...extras,
      history,
    ]);
  }

  return dashboardShell("ready", [
    h("div", { className: "react-pdga-meta", key: "meta" }, `PDGA #${pdgaNo}`),
    h("div", { className: "dash-rating-row", key: "ratings" }, [
      h(RatingTile, { label: "Live Rating", value: live, delta, live: true, key: "live" }),
      h(RatingTile, { label: "Official", value: official, key: "official" }),
      h(RatingTile, { label: "Peak", value: stats?.peak_rating, key: "peak" }),
      h(RatingTile, { label: "Events", value: stats?.events_count != null ? stats.events_count : events.length, key: "events" }),
    ]),
    ...extras,
    history,
  ]);
}

function dashboardShell(status, children) {
  return h("div", {
    className: "react-pdga-dashboard",
    id: "membersReactRatingPanel",
    "data-react-pdga-dashboard": status,
  }, children);
}
