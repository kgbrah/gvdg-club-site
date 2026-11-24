import React from "react";

import { requestJson } from "./api.js";
import {
  PdgaLink,
  pdgaEventHref,
  pdgaLiveEventHref,
  pdgaPlayerHistoryHref,
  pdgaPlayerHref,
  pdgaPlayerStatsHref,
} from "../shared/pdga-credit.js";

const h = React.createElement;
const PDGA_REFRESH_MS = 15 * 60 * 1000;

const HTML_ENTITY_MAP = {
  amp: "&",
  apos: "'",
  quot: '"',
  "#039": "'",
};

const ROUND_STAT_CHIP_LABELS = [
  ["fwh", "FWH"],
  ["c1r", "C1R"],
  ["c2r", "C2R"],
  ["parked", "Parked"],
  ["scramble", "Scramble"],
  ["c1p", "C1P"],
  ["c1x", "C1X"],
  ["c2p", "C2P"],
];

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

export function formatPdgaPlace(place, dnf = false) {
  if (dnf) return "DNF";
  const n = Number(place);
  if (!Number.isInteger(n) || n <= 0) return "";
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  return `${n}${rem10 === 1 ? "st" : rem10 === 2 ? "nd" : rem10 === 3 ? "rd" : "th"}`;
}

export function formatPdgaToPar(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "E";
  return n > 0 ? `+${Math.round(n)}` : String(Math.round(n));
}

export function pdgaRoundStatChips(stats) {
  if (!stats || typeof stats !== "object") return [];
  const chips = [];
  for (const [key, label] of ROUND_STAT_CHIP_LABELS) {
    const entry = stats[key];
    const opp = Number(entry?.opp);
    const hit = Number(entry?.hit);
    if (!Number.isFinite(opp) || opp <= 0 || !Number.isFinite(hit) || hit < 0) continue;
    chips.push({ id: key, label, text: `${label} ${Math.round((hit / opp) * 100)}%` });
  }
  const obHoles = Number(stats.ob?.holes);
  const obCount = Number(stats.ob?.count);
  if (Number.isFinite(obHoles) && obHoles > 0 && Number.isFinite(obCount) && obCount >= 0) {
    chips.push({ id: "ob", label: "OB", text: `OB ${obCount}` });
  }
  return chips;
}

export function formatPdgaAnnualSummary(row) {
  if (!row || typeof row !== "object") return [];
  const parts = [];
  if (row.events != null) parts.push(`${row.events} ${row.events === 1 ? "event" : "events"}`);
  if (row.points != null) parts.push(`${row.points} pts`);
  if (row.prize != null && row.prize > 0) {
    parts.push(`$${Number(row.prize).toLocaleString(undefined, { maximumFractionDigits: 2 })} cash`);
  }
  if (row.wins != null && row.wins > 0) parts.push(`${row.wins} ${row.wins === 1 ? "win" : "wins"}`);
  return parts;
}

function ratingValue(value) {
  return value == null ? "-" : String(value);
}

function eventMeta(event) {
  const place = formatPdgaPlace(event.place, event.dnf);
  const toPar = formatPdgaToPar(event.to_par);
  const totalText = event.total != null ? `${event.total}${toPar ? ` (${toPar})` : ""}` : toPar;
  return [event.date || "", event.division || "", place, totalText].filter(Boolean).join(" · ");
}

function eventRatings(event) {
  const ratings = (event.rounds || []).map((round) => round.rating).filter((value) => value != null);
  return ratings.length ? ratings.join(" - ") : "-";
}

function roundMixText(round) {
  const parts = [];
  if (round.aces > 0) parts.push(`${round.aces} ace${round.aces === 1 ? "" : "s"}`);
  if (round.eagles > 0) parts.push(`${round.eagles} eagle${round.eagles === 1 ? "" : "s"}`);
  if (round.birdies > 0) parts.push(`${round.birdies} birdie${round.birdies === 1 ? "" : "s"}`);
  if (round.pars > 0) parts.push(`${round.pars} par${round.pars === 1 ? "" : "s"}`);
  if (round.bogeys > 0) parts.push(`${round.bogeys} bogey${round.bogeys === 1 ? "" : "s"}`);
  if (round.doubles_plus > 0) parts.push(`${round.doubles_plus} dbl+`);
  return parts.join(" · ");
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
          const hasData = Boolean(
            stats
            && (stats.official_rating != null
              || (Array.isArray(stats.annual_stats) && stats.annual_stats.length)
              || (Array.isArray(stats.events) && stats.events.length)
              || (Array.isArray(stats.play_rounds) && stats.play_rounds.length)),
          );
          if (!hasData) {
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
  const rounds = Array.isArray(event.rounds) ? event.rounds : [];
  const hasRoundDetails = rounds.some((r) => r.score != null || r.holes > 0 || pdgaRoundStatChips(r.stats).length > 0);
  const eventHref = pdgaEventHref(event.eventId);
  const liveHref = event.live_url || pdgaLiveEventHref(event.eventId, event.division);

  return h("article", { className: "dash-event" }, [
    h("div", { className: "dash-event-main", key: "main" }, [
      h("div", { className: "dash-event-copy", key: "copy" }, [
        h(PdgaLink, { as: "div", className: "dash-event-name", href: eventHref, key: "name" }, title),
        h("div", { className: "dash-event-date", key: "date" }, eventMeta(event)),
      ]),
      h(EventRatingRow, { ratings, key: "rating-row" }),
    ]),
    (hasRoundDetails || eventHref || liveHref) ? h("details", { className: "dash-event-details", key: "details" }, [
      h("summary", { key: "summary" }, "Round details & stats"),
      hasRoundDetails ? h("div", { className: "dash-round-list", key: "rounds" }, rounds.map((round, index) => {
        const toPar = formatPdgaToPar(round.to_par);
        const scoreText = round.score != null
          ? `${round.score}${toPar ? ` (${toPar})` : ""}`
          : toPar || "—";
        const mixText = roundMixText(round);
        const statChips = pdgaRoundStatChips(round.stats);
        return h("div", { className: "dash-round-item", key: round.round || String(index) }, [
          h("div", { className: "dash-round-head", key: "head" }, [
            h("span", { className: "dash-round-label", key: "label" }, [
              `Rd ${round.round || index + 1}`,
              round.date ? ` · ${round.date}` : "",
            ].join("")),
            h("span", { className: "dash-round-score-wrap", key: "score" }, [
              h("strong", { className: "dash-round-score", key: "total" }, scoreText),
              round.rating != null ? h("span", { className: "round-rating", key: "rating" }, String(round.rating)) : null,
            ]),
          ]),
          mixText ? h("p", { className: "dash-round-mix", key: "mix" }, mixText) : null,
          statChips.length ? h("div", { className: "dash-round-chips", key: "chips" }, statChips.map((chip) =>
            h("span", { className: "dash-round-chip", key: chip.id }, chip.text),
          )) : null,
        ].filter(Boolean));
      })) : null,
      (eventHref || liveHref) ? h("div", { className: "dash-event-links", key: "links" }, [
        eventHref ? h("a", {
          className: "pdga-link pdga-profile-link",
          href: eventHref,
          key: "event",
          rel: "noopener noreferrer",
          target: "_blank",
        }, "PDGA event page") : null,
        liveHref ? h("a", {
          className: "pdga-link pdga-profile-link",
          href: liveHref,
          key: "live",
          rel: "noopener noreferrer",
          target: "_blank",
        }, "PDGA Live scorecard") : null,
      ].filter(Boolean)) : null,
    ].filter(Boolean)) : null,
  ]);
}

function eventCard(event, index) {
  return h(RecentEvent, { event, key: event.eventId || `${event.tournament || "event"}-${event.epoch || index}` });
}

function PdgaAnnualStats({ pdgaNo, rows }) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  return h("section", {
    className: "pdga-annual-section",
    "data-pdga-annual-stats": "ready",
    "aria-label": "PDGA season totals",
  }, [
    h("h4", { className: "dash-subtitle", key: "title" }, "PDGA season totals"),
    h("div", { className: "pdga-annual-list", key: "list" }, list.map((row) => {
      const key = `${row.year}-${row.divisionCode}`;
      const summary = formatPdgaAnnualSummary(row).join(" · ");
      const yearHref = row.url || pdgaPlayerStatsHref(pdgaNo, row.year);
      return h("article", { className: "pdga-annual-row", "data-pdga-annual-row": key, key }, [
        h("div", { className: "pdga-annual-head", key: "head" }, [
          h("strong", { key: "title" }, `${row.year} · ${row.divisionCode}`),
          row.rating != null ? h("span", { className: "round-rating", key: "rating" }, String(row.rating)) : null,
        ]),
        summary ? h("p", { className: "pdga-annual-meta", key: "summary" }, summary) : null,
        yearHref ? h("a", {
          className: "pdga-link pdga-profile-link",
          href: yearHref,
          key: "link",
          rel: "noopener noreferrer",
          target: "_blank",
        }, `View ${row.year} on PDGA.com`) : null,
      ].filter(Boolean));
    })),
  ]);
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
      h("div", { className: "react-pdga-status", key: "status" }, "Loading your stats…"),
      ...extras,
    ]);
  }

  if (status === "missing") {
    return dashboardShell("missing", [
      h("div", { className: "react-pdga-status", key: "status" }, `PDGA did not return a rating for #${pdgaNo}. Refresh in a few minutes.`),
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
  const annualStats = Array.isArray(stats?.annual_stats) ? stats.annual_stats : [];
  const live = stats?.live_rating;
  const official = stats?.official_rating;
  const delta = live != null && official != null
    ? `${live - official >= 0 ? "+" : ""}${live - official} vs official`
    : "";

  const history = events.length
    ? h(TournamentList, { events, key: "events" })
    : official != null && !compact
      ? h("p", { className: "pdga-source-note", key: "empty-history" }, [
        "No recent regional PDGA Live rounds matched automatically yet. View all sanctioned finishes on ",
        h("a", {
          className: "pdga-link",
          href: pdgaPlayerHistoryHref(pdgaNo),
          key: "history-link",
          rel: "noopener noreferrer",
          target: "_blank",
        }, "PDGA.com"),
        ".",
      ])
      : null;

  if (compact) {
    return dashboardShell("ready", [
      ...extras,
      history,
    ]);
  }

  const currentYear = pdgaCurrentYear();
  const profileHref = pdgaPlayerHref(pdgaNo);
  const historyHref = pdgaPlayerHistoryHref(pdgaNo);
  const statsYearHref = pdgaPlayerStatsHref(pdgaNo, currentYear);

  return dashboardShell("ready", [
    h("div", { className: "react-pdga-meta pdga-profile-links", key: "meta" }, [
      h(PdgaLink, { href: profileHref, key: "num" }, `PDGA #${pdgaNo}`),
      profileHref ? h("a", {
        className: "pdga-link pdga-profile-link",
        href: profileHref,
        key: "profile",
        rel: "noopener noreferrer",
        target: "_blank",
      }, "Official PDGA profile") : null,
      historyHref ? h("a", {
        className: "pdga-link pdga-profile-link",
        href: historyHref,
        key: "history",
        rel: "noopener noreferrer",
        target: "_blank",
      }, "Full ratings history") : null,
      statsYearHref ? h("a", {
        className: "pdga-link pdga-profile-link",
        href: statsYearHref,
        key: "year-stats",
        rel: "noopener noreferrer",
        target: "_blank",
      }, `${currentYear} stats on PDGA.com`) : null,
    ].filter(Boolean)),
    h("p", { className: "pdga-source-note", key: "source" },
      "Official ratings and season totals come from PDGA's API; recent round breakdowns come from PDGA Live. Club rounds and UDisc imports stay separate above."),
    h("div", { className: "dash-rating-row", key: "ratings" }, [
      h(RatingTile, { label: "Live rating estimate", value: live, delta, live: true, key: "live" }),
      h(RatingTile, { label: "PDGA official rating", value: official, delta: stats?.rating_date ? `As of ${stats.rating_date}` : "", key: "official" }),
      // The highest single round rating among recent PDGA Live rounds (not a peak official rating).
      h(RatingTile, { label: "Best round rating", value: stats?.peak_rating, key: "peak" }),
      h(RatingTile, { label: "Events", value: stats?.events_count != null ? stats.events_count : events.length, key: "events" }),
    ]),
    h(PdgaAnnualStats, { pdgaNo, rows: annualStats, key: "annual" }),
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
