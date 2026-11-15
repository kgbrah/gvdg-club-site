import React from "react";

import { requestJson } from "./api.js";

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

function nextRound(detail) {
  const today = clubDay(new Date());
  const events = Array.isArray(detail && detail.events) ? detail.events : [];
  return events
    .filter((event) => event && event.status !== "cancelled" && event.status !== "final" && String(event.date || "") >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null;
}

export function ClubLeagueCards() {
  const [leagues, setLeagues] = React.useState([]);
  React.useEffect(() => {
    let active = true;
    loadCurrentLeagues().then((rows) => {
      if (active) setLeagues(rows);
    });
    return () => {
      active = false;
    };
  }, []);
  if (!leagues.length) return null;
  return h("section", { className: "member-events-sections", "data-react-club-leagues": "ready" }, [
    h("h3", { className: "dash-subtitle", key: "title" }, "This season"),
    ...leagues.map((detail) => {
      const league = detail.league || {};
      const tags = tagStandings(detail);
      const upcoming = nextRound(detail);
      const id = league.id == null ? "" : String(league.id);
      return h("a", {
        className: "dash-standings-card",
        href: `events.html#league/${encodeURIComponent(id)}`,
        key: id || league.name,
      }, [
        h("h4", { className: "dash-subtitle", key: "name" }, league.name || "League"),
        h("p", { className: "dash-note", key: "when" }, upcoming
          ? `Next round ${upcoming.date}${upcoming.name ? ` · ${upcoming.name}` : ""}`
          : tags.length
            ? `Current tag order · #${tags[0].current_place} ${tags[0].name}`
            : "Open the league"),
        tags.length
          ? h("ol", { className: "extras-list", key: "tags" }, tags.slice(0, 5).map((row) =>
            h("li", { key: `${row.current_place}-${row.name}` }, `#${row.current_place} ${row.name}`)))
          : null,
      ]);
    }),
  ]);
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
