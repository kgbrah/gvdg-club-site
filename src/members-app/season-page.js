import React from "react";

import { TOKEN_KEY, requestJson, storageGet } from "./api.js";
import { applyOfficialRyderTally } from "../public-app/ryder-board-merge.js";
import { fetchMergedRyderData } from "../shared/ryder-cup-data.js";
import { ActiveStandingsPanel } from "./activity-panels.js";
import { ClubRatings } from "./club-ratings.js";
import { selectDashboardTab } from "./dashboard-shell.js";
import { formatEventDay, formatToPar } from "./format.js";
import { useMemberContext } from "./member-context.js";
import { PdgaDashboard, usePdgaStats } from "./pdga-dashboard.js";
import { PlayStatsPanel } from "./play-stats-panel.js";
import { buildSeasonPage } from "./season-page-model.js";
import { liveWatchHref } from "../shared/live-watch.js";
import { relClass } from "./play-page-model.js";

const h = React.createElement;

function emptyPayload() {
  return { results: [], casual: [], ratings: null, registrations: [], leagues: [], ryderTally: undefined };
}

function fallbackUnlessAborted(error, fallback) {
  if (error?.name === "AbortError") throw error;
  return fallback;
}

async function loadSeasonPayload(token, signal) {
  const [resultsData, ratings, registrationData, leagueData, ryderTally] = await Promise.all([
    requestJson("/my-results?all=1", { token, signal }).catch((error) => fallbackUnlessAborted(error, { results: [] })),
    requestJson("/my-ratings?competitiveLimit=250&casualLimit=250", { token, signal }).catch((error) => fallbackUnlessAborted(error, null)),
    requestJson("/my-registrations", { token, signal }).catch((error) => fallbackUnlessAborted(error, { registrations: [] })),
    requestJson("/leagues/active", { signal }).catch((error) => fallbackUnlessAborted(error, { leagues: [] })),
    fetchMergedRyderData().catch(() => null),
  ]);
  return {
    results: Array.isArray(resultsData?.results) ? resultsData.results : [],
    casual: Array.isArray(resultsData?.casual) ? resultsData.casual : [],
    ratings,
    registrations: Array.isArray(registrationData?.registrations) ? registrationData.registrations : [],
    leagues: applyOfficialRyderTally(
      Array.isArray(leagueData?.leagues) ? leagueData.leagues : [],
      ryderTally,
    ),
    ryderTally,
  };
}

function StatTile({ label, value }) {
  return h("div", { className: "doubles-quick-stat" }, [
    h("div", { className: "doubles-quick-stat-val", key: "value" }, value),
    h("div", { className: "doubles-quick-stat-label", key: "label" }, label),
  ]);
}

function placeLabel(place) {
  if (place == null) return "-";
  const value = Number(place);
  const remainder = value % 10;
  const suffix = value % 100 >= 11 && value % 100 <= 13
    ? "th"
    : remainder === 1 ? "st" : remainder === 2 ? "nd" : remainder === 3 ? "rd" : "th";
  return `${value}${suffix}`;
}

function ResultRow({ row }) {
  const casual = row.kind === "casual" || row.round_code;
  const title = casual
    ? (row.course_name || row.event_name || "Casual round")
    : (row.event_name || "Club event");
  const when = formatEventDay(row.event_date || row.finalized_at);
  const score = row.to_par != null ? formatToPar(row.to_par) : row.total != null ? String(row.total) : "-";
  const href = casual
    ? liveWatchHref({ roundCode: row.round_code })
    : (row.event_id != null ? liveWatchHref({ eventId: row.event_id }) : "events.html");
  return h("a", {
    className: "dash-event season-result",
    href,
  }, [
    h("div", { className: "dash-event-copy", key: "copy" }, [
      h("div", { className: "dash-event-name", key: "name" }, title),
      when ? h("div", { className: "dash-event-date", key: "date" }, [when, casual ? "Casual" : "", row.layout_name].filter(Boolean).join(" · ")) : null,
    ]),
    h("div", { className: "season-result-score", key: "score" }, [
      h("div", { className: "season-result-place", key: "place" }, row.place != null ? `#${row.place}` : "—"),
      h("div", { className: "season-result-par " + relClass(row.to_par), key: "par" }, score),
    ]),
  ]);
}

function UpcomingRow({ row }) {
  const title = row.event_name || "Registered event";
  const when = formatEventDay(row.event_date);
  const href = row.event_id != null ? `events.html#event/${encodeURIComponent(row.event_id)}` : "events.html";
  return h("a", { className: "dash-event", href }, [
    h("div", { className: "dash-event-copy", key: "copy" }, [
      h("div", { className: "dash-event-name", key: "name" }, title),
      h("div", { className: "dash-event-date", key: "date" }, [when, row.course_name, row.division].filter(Boolean).join(" · ")),
    ]),
  ]);
}

function StandingCard({ item }) {
  const label = [item.leagueName, item.season].filter(Boolean).join(" · ");
  return h("div", { className: "dash-standings-card season-standing" }, [
    h("h4", { className: "dash-subtitle", key: "title" }, label),
    h("p", { className: "season-standing-place", key: "place" }, [
      placeLabel(item.place),
      ` of ${item.field}`,
      item.points != null ? ` · ${item.points} pts` : "",
      item.officialSheet ? " · official sheet" : "",
    ].join("")),
  ]);
}

export function MemberSeasonPage() {
  const context = useMemberContext();
  const token = storageGet(TOKEN_KEY);
  const pdgaState = usePdgaStats(context.pdgaNo);
  const [state, setState] = React.useState({ status: token ? "loading" : "idle", page: null });

  React.useEffect(() => {
    if (!token) {
      setState({ status: "idle", page: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: "loading", page: null });
    loadSeasonPayload(token, controller.signal)
      .then((payload) => {
        setState({
          status: "ready",
          page: buildSeasonPage({
            ...payload,
            memberName: context.name,
          }),
        });
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setState({
            status: "error",
            page: buildSeasonPage({ ...emptyPayload(), memberName: context.name }),
          });
        }
      });
    return () => controller.abort();
  }, [token, context.name]);

  if (!token) return null;

  const page = state.page;
  return h("div", { className: "react-season-page", "data-react-season-page": state.status }, [
    h("h3", { className: "my-dashboard-title", key: "title" }, page ? `${page.year} Season` : "Your Season"),
    state.status === "loading" ? h("p", { className: "dash-note", key: "loading" }, "Loading your season...") : null,
    state.status === "error" ? h("p", { className: "dash-note", key: "error" }, "Could not load every season number. Showing what we have.") : null,
    page ? h("div", { className: "doubles-quick-stats", key: "stats" }, [
      h(StatTile, { label: "Event rounds", value: String(page.rounds), key: "rounds" }),
      h(StatTile, { label: "Event avg", value: page.avgToPar == null ? "-" : formatToPar(page.avgToPar), key: "avg" }),
      h(StatTile, { label: "Best finish", value: page.bestFinish == null ? "-" : placeLabel(page.bestFinish), key: "best" }),
      h(StatTile, { label: "Club rating", value: page.clubRating == null ? "-" : String(page.clubRating), key: "rating" }),
    ]) : null,
    h(PlayStatsPanel, { key: "play-stats", pdgaStats: pdgaState.stats }),
    h(ActiveStandingsPanel, { key: "active-standings" }),
    page?.standings.length
      ? h("div", { key: "standings" }, [
        h("h4", { className: "dash-subtitle", key: "title" }, "Your leagues"),
        page.standings.map((item, index) => h(StandingCard, { item, key: `${item.leagueId || item.leagueName}-${index}` })),
      ])
      : null,
    page ? h("div", { key: "upcoming" }, [
      h("h4", { className: "dash-subtitle", key: "title" }, "Coming up"),
      page.upcoming.length
        ? page.upcoming.map((row, index) => h(UpcomingRow, { row, key: row.id || `${row.event_id}-${index}` }))
        : h("p", { className: "dash-note", key: "empty" }, "No upcoming registrations."),
      h("button", {
        type: "button",
        className: "dashboard-action",
        onClick: () => selectDashboardTab("events"),
        key: "register",
      }, "Register for an event"),
    ]) : null,
    page ? h("div", { key: "results" }, [
      h("h4", { className: "dash-subtitle", key: "title" }, "Club results"),
      page.results.length
        ? page.results.map((row, index) => h(ResultRow, { row, key: row.id || `${row.event_id}-${index}` }))
        : h("p", { className: "dash-note", key: "empty" }, "No finalized club or casual rounds this season yet."),
    ]) : null,
    h(PdgaDashboard, { pdgaNo: context.pdgaNo, state: pdgaState, key: "pdga" }),
    h(ClubRatings, { token, key: "ratings" }),
  ]);
}
