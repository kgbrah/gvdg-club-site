import React from "react";

import { requestJson } from "./api.js";
import { selectDashboardTab } from "./dashboard-shell.js";
import { formatEventDay } from "./format.js";

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

export function BagTagLeagueOrder({ compact = false }) {
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
  if (!leagues.length) return null;
  return h(React.Fragment, null, leagues.map((detail) => {
    const league = detail.league || {};
    const tags = tagStandings(detail);
    const id = league.id == null ? "" : String(league.id);
    const leader = tags[0];
    if (compact) {
      return h("a", {
        className: "member-account-row",
        href: `events.html#league/${encodeURIComponent(id)}`,
        key: id || league.name,
      }, [
        h("span", { className: "member-account-copy", key: "copy" }, [
          h("strong", { key: "name" }, league.name || "Bag tags"),
          h("small", { key: "leader" }, leader ? `#${leader.current_place} ${leader.name}` : "Current tag order"),
        ]),
        h("span", { className: "member-account-action", key: "open" }, "Tag order"),
      ]);
    }
    return h("div", { className: "dash-standings-card", key: id || league.name }, [
      h("h4", { className: "dash-subtitle", key: "name" }, league.name || "Bag tags"),
      h("p", { className: "dash-note", key: "note" }, "Current order from the last finished round."),
      h("table", { className: "lb-table", key: "table" }, [
        h("thead", { key: "head" }, h("tr", null, ["Tag", "Player"].map((label) => h("th", { key: label }, label)))),
        h("tbody", { key: "body" }, tags.slice(0, 20).map((row) => h("tr", { key: `${row.current_place}-${row.name}` }, [
          h("td", { key: "tag" }, `#${row.current_place}`),
          h("td", { key: "name" }, row.name || "Player"),
        ]))),
      ]),
      h("a", { className: "standings-link", href: `events.html#league/${encodeURIComponent(id)}`, key: "link" }, "Open league"),
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
      className: "passkey-btn",
      key: "signup",
      onClick: () => selectDashboardTab("events", { eventId: event.id }),
      type: "button",
    }, "Sign up");
  } else if (external && canSignUp(event)) {
    action = h("a", {
      className: "passkey-btn",
      href: external,
      key: "signup",
      rel: "noopener noreferrer",
      target: "_blank",
    }, "Sign up");
  } else if (event.status === "final") {
    action = h("a", {
      className: "passkey-btn",
      href: `events.html#event/${encodeURIComponent(event.id)}`,
      key: "results",
    }, "Results");
  }
  return h("article", { className: `register-card${event.status === "live" ? " live" : ""}` }, [
    h("div", { className: "register-head", key: "head" }, [
      h("div", { key: "heading" }, [
        event.date ? h("p", { className: "register-date", key: "date" }, formatEventDay(event.date)) : null,
        h("h3", { className: "register-name", key: "name" }, event.name || "Round"),
      ]),
      event.status === "live" ? h("span", { className: "register-live-badge", key: "badge" }, "LIVE NOW") : null,
      event.status === "final" ? h("span", { className: "register-final-badge", key: "badge" }, "Final") : null,
    ]),
    action ? h("div", { className: "register-actions", key: "actions" }, action) : null,
  ]);
}

export function LeagueSchedule() {
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
  if (rows == null) return h("p", { className: "dash-note" }, "Loading league schedule...");
  const leagues = scheduleLeagues(rows);
  if (!leagues.length) {
    return h("p", { className: "dash-note", "data-react-league-schedule": "empty" }, "No current leagues.");
  }
  return h("section", { className: "member-events-sections", "data-react-league-schedule": "ready" }, leagues.map((league) =>
    h("section", { className: "member-event-section", key: league.id, "aria-label": league.name }, [
      h("h2", { className: "register-subhead", key: "title" }, [league.name, league.season].filter(Boolean).join(" · ")),
      h("div", { className: "member-event-list", key: "events" }, league.events.map((event) =>
        h(ScheduleEvent, { event, key: event.id }))),
    ])));
}
