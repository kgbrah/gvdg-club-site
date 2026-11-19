import React from "react";
import { KarmaChip } from "../shared/karma.js";
import { ChevronRight } from "lucide-react";

import { requestJson } from "./api.js";
import { selectDashboardTab } from "./dashboard-shell.js";
import { formatEventDay } from "./format.js";
import { displayEventTitle } from "../shared/events-model.js";
import { SIGNUP_LINK } from "../shared/outside-link.js";

const h = React.createElement;
const DAY = 24 * 60 * 60 * 1000;

function clubDay(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(date);
}

function isCurrentLeague(detail) {
  const cutoff = clubDay(new Date(Date.now() - 120 * DAY));
  const events = Array.isArray(detail && detail.events) ? detail.events : [];
  return events.some((event) => event && event.status !== "cancelled" && String(event.date || "") >= cutoff);
}

let loaded = null;

export function loadCurrentLeagues() {
  if (!loaded) {
    loaded = requestJson("/leagues").then(async (data) => {
      const rows = Array.isArray(data && data.leagues) ? data.leagues : [];
      const details = await Promise.all(rows.slice(0, 12).map((league) => requestJson(`/leagues/${encodeURIComponent(league.id)}`).catch(() => null)));
      return details.filter((detail) => detail && detail.league && isCurrentLeague(detail));
    }).catch(() => []);
  }
  return loaded;
}

function tagStandings(detail) {
  const standings = Array.isArray(detail && detail.standings) ? detail.standings : [];
  return standings.some((row) => row && row.current_place != null) ? standings : [];
}

export function BagTagLeagueOrder({ compact = false, skipIds = [] }) {
  const [leagues, setLeagues] = React.useState([]);
  React.useEffect(() => {
    let active = true;
    loadCurrentLeagues().then((rows) => {
      if (active) setLeagues(rows.filter((detail) => tagStandings(detail).length));
    });
    return () => {
      active = false;
    };
  }, []);
  const shown = leagues.filter((detail) => !skipIds.includes(String(detail.league && detail.league.id)));
  if (!shown.length) return null;
  return h(React.Fragment, null, shown.map((detail) => {
    const league = detail.league || {};
    const tags = tagStandings(detail);
    const id = league.id == null ? "" : String(league.id);
    const leader = tags[0];
    if (compact) {
      return h("a", {
        "aria-label": `${league.name || "Bag tags"} tag order`,
        className: "member-account-row",
        href: `events.html#league/${encodeURIComponent(id)}`,
        key: id || league.name,
      }, [
        h("span", { "aria-hidden": "true", className: "member-account-spacer", key: "spacer" }),
        h("span", { className: "member-account-copy", key: "copy" }, [
          h("strong", { key: "name" }, league.name || "Bag tags"),
          h("small", { key: "leader" }, leader ? [`#${leader.current_place} ${leader.name}`, h(KarmaChip, { key: "karma", memberId: leader.member_id })] : "Current tag order"),
        ]),
        h(ChevronRight, { "aria-hidden": "true", className: "member-account-chevron", key: "open", size: 18 }),
      ]);
    }
    return h("section", { className: "member-list", key: id || league.name }, [
      h("div", { className: "member-list-rows", key: "rows" }, [
        h("div", { className: "member-list-row", key: "head" }, [
          h("div", { className: "member-list-copy", key: "copy" }, [
            h("h3", { className: "member-list-name", key: "name" }, league.name || "Bag tags"),
            h("p", { className: "member-list-meta", key: "note" }, "Current order"),
          ]),
          h("a", { className: "member-list-action", href: `events.html#league/${encodeURIComponent(id)}`, key: "link" }, "Open league"),
        ]),
        ...tags.slice(0, 20).map((row) => h("div", { className: "member-list-row", key: `${row.current_place}-${row.name}` }, [
          h("span", { className: "member-list-date", key: "tag" }, `#${row.current_place}`),
          h("h3", { className: "member-list-name", key: "name" }, row.name || "Player"),
        ])),
      ]),
    ]);
  }));
}

function scheduleLeagues(rows) {
  const leagues = [];
  const byId = new Map();
  for (const row of rows) {
    const id = row && row.league_id != null ? String(row.league_id) : "";
    if (!id) continue;
    let league = byId.get(id);
    if (!league) {
      league = {
        id,
        name: row.league_name || "League",
        season: row.season || "",
        events: [],
      };
      byId.set(id, league);
      leagues.push(league);
    }
    league.events.push(row);
  }
  return leagues;
}

function safeUrl(value) {
  const url = String(value || "");
  return /^https?:\/\//i.test(url) ? url : "";
}

function canSignUp(event) {
  return event.status === "scheduled" || event.status === "live";
}

function ScheduleEvent({ event }) {
  const openHere = Number(event.registration_open) === 1 && canSignUp(event);
  const external = safeUrl(event.external_url);
  let action = null;
  if (openHere) {
    action = h("button", {
      className: "member-list-action passkey-btn",
      key: "signup",
      onClick: () => selectDashboardTab("events", { eventId: event.id }),
      type: "button",
    }, "Sign up");
  } else if (external && canSignUp(event)) {
    action = h("a", {
      className: "member-list-action passkey-btn",
      href: external,
      key: "signup",
      ...SIGNUP_LINK,
    }, "Sign up");
  } else if (event.status === "final") {
    action = h("a", {
      className: "member-list-action passkey-btn",
      href: `events.html#event/${encodeURIComponent(event.id)}`,
      key: "results",
    }, "Results");
  }
  const status = event.status === "live" ? "Live" : event.status === "final" ? "Final" : "";
  return h("article", { className: "member-list-row" }, [
    h("time", { className: "member-list-date", dateTime: event.date || undefined, key: "date" }, event.date ? formatEventDay(event.date) : "Date to be set"),
    h("div", { className: "member-list-copy", key: "copy" }, [
      h("h3", { className: "member-list-name register-name", key: "name" }, displayEventTitle(event.name || "Round")),
      status ? h("p", { className: "member-list-meta", key: "status" }, status) : null,
    ]),
    action,
  ]);
}

function useLeagueScheduleRows() {
  const [rows, setRows] = React.useState(null);
  React.useEffect(() => {
    let active = true;
    requestJson("/leagues/schedule")
      .then((data) => {
        if (active) setRows(Array.isArray(data && data.events) ? data.events : []);
      })
      .catch(() => {
        if (active) setRows([]);
      });
    return () => {
      active = false;
    };
  }, []);
  return rows;
}

const isFinal = (event) => event && event.status === "final";
const leagueTitle = (league) => [league.name, league.season].filter(Boolean).join(" · ");

/** League schedule tab: upcoming and live rounds only; finished rounds live on the Event results tab. */
export function LeagueSchedule() {
  const rows = useLeagueScheduleRows();
  if (rows == null) return h("p", { className: "dash-note" }, "Loading league schedule…");
  const leagues = scheduleLeagues(rows);
  if (!leagues.length) {
    return h("p", { className: "dash-note", "data-react-league-schedule": "empty" }, "No current leagues.");
  }
  return h("section", { className: "member-events-sections", "data-react-league-schedule": "ready" }, leagues.map((league) => {
    const upcoming = league.events.filter((event) => !isFinal(event));
    return h("section", { className: "member-list", key: league.id, "aria-label": league.name }, [
      h("h2", { className: "register-subhead", key: "title" }, leagueTitle(league)),
      upcoming.length
        ? h("div", { className: "member-list-rows", key: "events" }, upcoming.map((event) => h(ScheduleEvent, { event, key: event.id })))
        : h("p", { className: "dash-note", key: "done" }, [
          "No upcoming rounds. Finished rounds are in ",
          h("button", { type: "button", className: "board-link", key: "link", onClick: () => selectDashboardTab("results") }, "Event results"),
          ".",
        ]),
    ]);
  }));
}

const COMPLETED_PREVIEW = 5;

function CompletedLeague({ league }) {
  const [showAll, setShowAll] = React.useState(false);
  const done = league.events.filter(isFinal).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  if (!done.length) return null;
  const shown = showAll ? done : done.slice(0, COMPLETED_PREVIEW);
  return h("section", { className: "member-list", "aria-label": `${league.name} completed rounds` }, [
    h("h3", { className: "register-subhead", key: "title" }, leagueTitle(league)),
    h("div", { className: "member-list-rows", key: "events" }, shown.map((event) => h(ScheduleEvent, { event, key: event.id }))),
    done.length > COMPLETED_PREVIEW ? h("button", {
      type: "button", className: "dashboard-action", key: "more", "aria-expanded": showAll,
      onClick: () => setShowAll((value) => !value),
    }, showAll ? "Show fewer" : `Show all ${done.length}`) : null,
  ]);
}

/** Event results tab: each current league's finished rounds, newest first. */
export function CompletedLeagueRounds() {
  const rows = useLeagueScheduleRows();
  if (!rows) return null;
  const leagues = scheduleLeagues(rows).filter((league) => league.events.some(isFinal));
  if (!leagues.length) return null;
  return h("section", { className: "member-event-section member-completed-league-rounds", "aria-label": "Completed league rounds" }, [
    h("h2", { className: "register-subhead", key: "title" }, "Completed league rounds"),
    ...leagues.map((league) => h(CompletedLeague, { league, key: league.id })),
  ]);
}
