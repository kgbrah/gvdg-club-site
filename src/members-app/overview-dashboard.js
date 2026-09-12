import React from "react";

import { TOKEN_KEY, requestJson, storageGet } from "./api.js";
import { LiveScoringPanel, WalletPanel } from "./activity-panels.js";
import { selectDashboardTab } from "./dashboard-shell.js";
import { dollars, formatEventDay, formatToPar } from "./format.js";
import { useMemberContext } from "./member-context.js";
import { usePdgaStats } from "./pdga-dashboard.js";
import { useRegistrationData } from "./registration-panel.js";
import { eventMeta } from "./registration-utils.js";

const h = React.createElement;

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "G";
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function latestResult(results) {
  return (Array.isArray(results) ? results : []).slice().sort((left, right) =>
    String(right.event_date || "").localeCompare(String(left.event_date || "")),
  )[0] || null;
}

function HomeHero({ context, pdgaState }) {
  const stats = pdgaState.stats;
  const live = stats?.live_rating;
  const division = Array.isArray(stats?.events) ? stats.events[0]?.division : null;
  const photo = context.photo || stats?.photo || null;
  const meta = [
    context.pdgaNo ? `PDGA #${context.pdgaNo}` : null,
    division || null,
  ].filter(Boolean).join(" · ");

  return h("div", {
    className: "player-home-hero",
    "data-react-home-hero": "ready",
    "data-react-member-banner": "ready",
  }, [
    photo
      ? h("img", { className: "player-avatar", src: photo, alt: "", key: "avatar" })
      : h("div", { className: "player-avatar player-avatar-fallback", key: "avatar" }, initials(context.name)),
    h("div", { className: "player-who", key: "who" }, [
      h("h1", { key: "name" }, context.name || "Member"),
      meta ? h("p", { key: "meta" }, meta) : null,
    ]),
    h("div", {
      className: "player-rating-pill",
      "data-react-live-rating": live != null ? "true" : "empty",
      key: "rating",
    }, [
      h("b", { className: "dash-tile-num", "data-rating-value": "true", key: "value" }, live != null ? String(live) : "—"),
      h("span", { key: "label" }, "Live rating"),
    ]),
  ]);
}

function UpNextCard({ events }) {
  const event = Array.isArray(events) ? events[0] : null;
  if (!event) {
    return h("section", { className: "player-card", "data-react-home-next": "empty" }, [
      h("h3", { key: "title" }, "Up next"),
      h("p", { className: "player-card-meta", key: "empty" }, "Nothing open to register for right now."),
      h("button", {
        type: "button",
        className: "player-btn primary",
        onClick: () => selectDashboardTab("events"),
        key: "events",
      }, "See events"),
    ]);
  }

  const when = formatEventDay(event.date);
  const fee = event.entry_fee_cents ? dollars(event.entry_fee_cents) : null;
  const meta = [when, eventMeta(event), fee].filter(Boolean).join(" · ");
  const live = event.status === "live";

  return h("section", { className: "player-card", "data-react-home-next": "ready" }, [
    h("h3", { key: "title" }, "Up next"),
    h("div", { className: "player-event-name", key: "name" }, event.name || "Club event"),
    meta ? h("div", { className: "player-card-meta", key: "meta" }, meta) : null,
    h("div", { className: "player-chip-row", key: "chips" }, [
      h("span", { className: `player-chip${live ? " live" : ""}`, key: "status" }, live ? "Live" : "Open"),
      event.play_format === "doubles" ? h("span", { className: "player-chip", key: "format" }, "Doubles") : null,
    ].filter(Boolean)),
    h("button", {
      type: "button",
      className: "player-btn primary",
      onClick: () => selectDashboardTab("events"),
      key: "register",
    }, "Register"),
  ]);
}

function LastRoundCard({ token }) {
  const [state, setState] = React.useState({ status: "idle", row: null });

  React.useEffect(() => {
    if (!token) {
      setState({ status: "idle", row: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: "loading", row: null });
    requestJson("/my-results?all=1", { token, signal: controller.signal })
      .then((payload) => setState({ status: "ready", row: latestResult(payload?.results) }))
      .catch((error) => {
        if (error.name !== "AbortError") setState({ status: "ready", row: null });
      });
    return () => controller.abort();
  }, [token]);

  const row = state.row;
  return h("section", { className: "player-card", "data-react-home-last-round": state.status }, [
    h("h3", { key: "title" }, "Last club round"),
    row
      ? h("div", { className: "player-list-row", key: "row" }, [
        h("div", { key: "copy" }, [
          h("div", { className: "player-event-name", key: "name" }, row.event_name || "Club event"),
          h("div", { className: "player-card-meta", key: "meta" }, [formatEventDay(row.event_date), row.place != null ? "Competitive" : null].filter(Boolean).join(" · ")),
        ]),
        h("div", { className: "player-score", key: "score" }, [
          h("b", { key: "par" }, row.to_par != null ? formatToPar(row.to_par) : row.total != null ? String(row.total) : "—"),
          h("span", { key: "place" }, row.place != null ? `#${row.place}` : "Finish"),
        ]),
      ])
      : h("p", { className: "player-card-meta", key: "empty" }, state.status === "loading" ? "Loading last round..." : "No finalized club round yet."),
  ]);
}

export function MemberOverviewDashboard() {
  const context = useMemberContext();
  const token = storageGet(TOKEN_KEY);
  const pdgaState = usePdgaStats(context.pdgaNo);
  const registration = useRegistrationData();
  const official = pdgaState.stats?.official_rating;
  const peak = pdgaState.stats?.peak_rating;

  if (!token) return null;

  return h("div", { className: "react-overview-dashboard player-home", "data-react-overview-dashboard": "ready" }, [
    h(HomeHero, { context, pdgaState, key: "hero" }),
    h(LiveScoringPanel, { token, compact: true, key: "live-scoring" }),
    h("div", { className: "player-row-cards", key: "stats" }, [
      h(WalletPanel, { token, compact: true, key: "wallet" }),
      h("div", { className: "player-stat", key: "official" }, [
        h("div", { className: "player-stat-k", key: "k" }, "Official"),
        h("div", { className: "player-stat-v", key: "v" }, official != null ? String(official) : "—"),
        h("div", { className: "player-stat-s", key: "s" }, peak != null ? `Peak ${peak}` : "PDGA official"),
      ]),
    ]),
    h(UpNextCard, { events: registration.state.events, key: "next" }),
    h(LastRoundCard, { token, key: "last" }),
  ]);
}
