import React from "react";
import { ChevronRight, ShieldCheck } from "lucide-react";

import { TOKEN_KEY, requestJson, storageGet } from "./api.js";
import { LiveScoringPanel, WalletPanel } from "./activity-panels.js";
import { FirstUseGuide } from "./first-use-guide.js";
import { selectDashboardTab } from "./dashboard-shell.js";
import { dollars, formatEventDay, formatToPar } from "./format.js";
import { HomeJobs } from "./home-jobs.js";
import { useMemberContext } from "./member-context.js";
import { usePdgaStats, pdgaEventTitle } from "./pdga-dashboard.js";
import { PlayStatsPanel } from "./play-stats-panel.js";
import { useRegistrationData } from "./registration-panel.js";
import { eventMeta, pickUpNext } from "./registration-utils.js";
import { latestHomeRound } from "./play-page-model.js";
import { EventScheduleFacts } from "../shared/event-schedule.js";
import { EventFieldRoster } from "../shared/event-field-roster.js";
import { AddToCalendarButton } from "../shared/add-to-calendar.js";
import { BagTagPanel } from "./bag-tag-panel.js";
import { calendarEventFromClub, calendarEventFromPdga } from "../shared/event-calendar.js";

const h = React.createElement;

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "G";
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function HomeHero({ context, pdgaState }) {
  const stats = pdgaState.stats;
  const live = stats?.live_rating;
  const division = Array.isArray(stats?.events) ? stats.events[0]?.division : null;
  const photo = context.photo || stats?.photo || null;
  const meta = [
    context.pdgaNo ? `PDGA #${context.pdgaNo}` : null,
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
      h("h2", { key: "name" }, context.name || "Member"),
      meta ? h("p", { key: "meta" }, meta) : null,
      pdgaState.status === "empty" ? h("p", { key: "pdga-empty" }, "No PDGA # is linked yet.") : null,
      pdgaState.status === "missing" ? h("p", { key: "pdga-missing" }, "PDGA ratings are unavailable right now.") : null,
      pdgaState.status === "error" ? h("p", { key: "pdga-error" }, "Could not load PDGA stats.") : null,
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

function UpNextCard({ events, registrations }) {
  const { event, registration } = pickUpNext(events, registrations);
  if (!event) {
    return h("section", { className: "player-story-block", "data-react-home-next": "empty" }, [
      h("h3", { key: "title" }, "Up next"),
      h("p", { className: "player-card-meta", key: "empty" }, "Nothing on your schedule right now."),
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
  const chip = live ? "Live" : registration ? "You're in" : "Open";
  const actionLabel = live && registration ? "Open scorecard" : registration ? "You're in" : "Register";

  return h("div", { className: "player-story-block", "data-react-home-next": registration ? "registered" : "ready" }, [
    h("h3", { key: "title" }, "Up next"),
    h("div", { className: "player-event-name", key: "name" }, event.name || "Club event"),
    meta ? h("div", { className: "player-card-meta", key: "meta" }, meta) : null,
    h(EventScheduleFacts, { event, key: "schedule" }),
    h(EventFieldRoster, { compact: true, key: "field", players: event.field }),
    h("div", { className: "player-chip-row", key: "chips" }, [
      h("span", { className: `player-chip${live ? " live" : ""}`, key: "status" }, chip),
      event.play_format === "doubles" ? h("span", { className: "player-chip", key: "format" }, "Doubles") : null,
    ].filter(Boolean)),
    h("button", {
      type: "button",
      className: "player-btn primary",
      onClick: () => {
        if (live && registration) {
          window.location.href = `score.html?event=${encodeURIComponent(event.id)}`;
          return;
        }
        selectDashboardTab("events", { eventId: event.id });
      },
      key: "register",
    }, actionLabel),
    h(AddToCalendarButton, { className: "player-btn", item: calendarEventFromClub(event), key: "cal" }),
  ]);
}

const CLUB_ORIGIN = { lat: 35.6127, lng: -77.3664 };

function NextPdgaCard() {
  const [event, setEvent] = React.useState(null);

  React.useEffect(() => {
    const controller = new AbortController();
    const query = `/pdga-events?lat=${encodeURIComponent(CLUB_ORIGIN.lat)}&lng=${encodeURIComponent(CLUB_ORIGIN.lng)}`;
    requestJson(query, { signal: controller.signal })
      .then((data) => {
        const events = Array.isArray(data?.events) ? data.events : [];
        setEvent(events[0] || null);
      })
      .catch((error) => {
        if (error?.name !== "AbortError") setEvent(null);
      });
    return () => controller.abort();
  }, []);

  if (!event) return null;
  const miles = typeof event.miles === "number" ? `${event.miles.toFixed(1)} mi` : "";
  const meta = [event.date, event.course, miles].filter(Boolean).join(" · ");
  return h("div", { className: "player-story-block", "data-react-home-pdga": "ready", key: "pdga" }, [
    h("h3", { key: "title" }, "Next PDGA"),
    h("div", { className: "player-event-name", key: "name" }, event.name),
    meta ? h("div", { className: "player-card-meta", key: "meta" }, meta) : null,
    h("div", { className: "player-actions", key: "actions" }, [
      h("a", {
        className: "player-btn primary",
        href: event.url,
        key: "register",
        rel: "noopener noreferrer",
        target: "_blank",
      }, "Register"),
      h(AddToCalendarButton, { className: "player-btn", item: calendarEventFromPdga(event), key: "cal" }),
      h("button", {
        className: "player-btn",
        key: "all",
        type: "button",
        onClick: () => selectDashboardTab("events"),
      }, "All events"),
    ]),
  ]);
}

function LastRoundCard({ token, onCasualHistory }) {
  const [state, setState] = React.useState({ status: "idle", row: null });

  React.useEffect(() => {
    if (!token) {
      setState({ status: "idle", row: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: "loading", row: null });
    requestJson("/my-results?all=1", { token, signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        onCasualHistory(Array.isArray(payload?.casual) && payload.casual.length > 0);
        setState({ status: "ready", row: latestHomeRound(payload?.results, payload?.casual) });
      })
      .catch((error) => {
        if (error.name !== "AbortError") setState({ status: "ready", row: null });
      });
    return () => controller.abort();
  }, [token, onCasualHistory]);

  const row = state.row;
  const meta = row
    ? [
      formatEventDay(row.when),
      row.kind === "casual" ? "Casual" : (row.place != null ? "Competitive" : null),
      row.layout || null,
    ].filter(Boolean).join(" · ")
    : "";
  return h("div", { className: "player-story-block", "data-react-home-last-round": state.status }, [
    h("h3", { key: "title" }, "Last round"),
    row
      ? h("a", {
        className: "player-list-row",
        href: row.href,
        key: "row",
      }, [
        h("div", { key: "copy" }, [
          h("div", { className: "player-event-name", key: "name" }, row.title || "Round"),
          meta ? h("div", { className: "player-card-meta", key: "meta" }, meta) : null,
          row.mix ? h("div", { className: "player-card-meta", key: "mix" }, row.mix) : null,
        ]),
        h("div", { className: "player-score", key: "score" }, [
          h("b", { key: "par" }, row.toPar != null ? formatToPar(row.toPar) : row.total != null ? String(row.total) : "—"),
          h("span", { key: "place" }, row.place != null ? `#${row.place}` : "Card"),
          row.rating != null ? h("span", { className: "round-rating", key: "rating", "aria-label": `Round rating ${row.rating}` }, String(row.rating)) : null,
        ]),
      ])
      : h("p", { className: "player-card-meta", key: "empty" }, state.status === "loading" ? "Loading last round..." : "No finished round yet."),
  ]);
}

function RatingMove({ stats, status }) {
  if (status !== "ready" || stats?.official_rating == null) return null;
  const official = stats.official_rating;
  const previous = stats.previous_rating;
  let move = stats.rating_date ? `As of ${stats.rating_date}` : "Official rating";
  let tone = "";
  if (previous != null && previous !== official) {
    const delta = official - previous;
    tone = delta > 0 ? "up" : "down";
    move = `${delta > 0 ? "Up" : "Down"} ${Math.abs(delta)} from ${previous}`;
  }
  return h("div", { className: "player-story-block", key: "rating" }, [
    h("h3", { key: "title" }, "Rating"),
    h("div", { className: "player-story-rating", key: "row" }, [
      h("b", { key: "n" }, String(official)),
      h("span", { className: `player-story-move ${tone}`.trim(), key: "move" }, move),
    ]),
  ]);
}

function PdgaHistory({ stats }) {
  const events = Array.isArray(stats?.events) ? stats.events : [];
  if (!events.length) return null;
  return h("details", { className: "dash-collapse player-story-history", key: "history" }, [
    h("summary", { className: "dash-collapse-summary", key: "summary" }, `PDGA events (${events.length})`),
    h("div", { className: "player-story-events", key: "list" }, events.slice(0, 6).map((event, index) =>
      h("div", { className: "player-list-row", key: `${event.tournament || "event"}-${event.epoch || index}` }, [
        h("div", { key: "copy" }, [
          h("div", { className: "player-event-name", key: "name" }, pdgaEventTitle(event.tournament) || "Event"),
          h("div", { className: "player-card-meta", key: "meta" }, [event.date, event.division].filter(Boolean).join(" · ")),
        ]),
        h("div", { className: "player-score", key: "score" }, [
          h("b", { key: "r" }, event.rounds?.[0]?.rating != null ? String(event.rounds[0].rating) : "—"),
          h("span", { key: "l" }, "Rating"),
        ]),
      ]),
    )),
  ]);
}

export function MemberOverviewDashboard() {
  const context = useMemberContext();
  const token = storageGet(TOKEN_KEY);
  const pdgaState = usePdgaStats(context.pdgaNo);
  const registration = useRegistrationData();

  const [activeRound, setActiveRound] = React.useState(false);
  const [playedCasual, setPlayedCasual] = React.useState(false);
  const accountHeading = React.useRef(null);
  if (!token) return null;

  return h("div", { className: "react-overview-dashboard player-home", "data-react-overview-dashboard": "ready" }, [
    h(HomeHero, { context, pdgaState, key: "hero" }),
    h("div", { className: "member-home-feature", key: "feature" }, [
      h("div", { className: "member-home-play", key: "play" }, [
        h(LiveScoringPanel, { token, compact: true, onCasualActive: setActiveRound, key: "live-scoring" }),
        h(FirstUseGuide, { playedCasual: playedCasual || activeRound, key: "first-use",
          onDismiss: () => accountHeading.current?.focus({ preventScroll: true }),
        }),
      ]),
      h("section", { className: "member-home-services", "aria-label": "Your club account", key: "account" }, [
        h("h2", { key: "heading", ref: accountHeading, tabIndex: -1 }, "Your club account"),
        h(WalletPanel, { token, compact: true, key: "wallet" }),
        h("button", {
          className: "member-account-row member-account-link", type: "button", key: "membership",
          onClick: () => selectDashboardTab("account"),
        }, [
          h(ShieldCheck, { className: "member-account-icon", size: 20, "aria-hidden": true, key: "icon" }),
          h("span", { className: "member-account-copy", key: "copy" }, [
            h("strong", { key: "label" }, "Membership and profile"),
            h("small", { key: "hint" }, "Profile, sign-in and settings"),
          ]),
          h(ChevronRight, { className: "member-account-chevron", size: 18, "aria-hidden": true, key: "arrow" }),
        ]),
        h(BagTagPanel, { key: "bag-tags", token, compact: true }),
      ]),
    ]),
    h(HomeJobs, {
      events: registration.state.events,
      registrations: registration.state.registrations,
      token,
      onReload: registration.reload,
      key: "jobs",
    }),
    h("section", { className: "player-card player-story", "data-react-home-story": "ready", key: "story" }, [
      h(RatingMove, { stats: pdgaState.stats, status: pdgaState.status, key: "rating" }),
      h(LastRoundCard, { token, onCasualHistory: setPlayedCasual, key: "recent" }),
      h(UpNextCard, { events: registration.state.events, registrations: registration.state.registrations, key: "up-next" }),
      h(NextPdgaCard, { key: "next-pdga" }),
      h(PdgaHistory, { stats: pdgaState.stats, key: "history" }),
    ]),
    h(PlayStatsPanel, { compact: true, key: "play-stats", pdgaStats: pdgaState.stats }),
  ]);
}
