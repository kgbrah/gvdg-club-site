import React from "react";

import { requestJson } from "./api.js";
import { formatToPar } from "./format.js";
import { applyOfficialRyderTally } from "../public-app/ryder-board-merge.js";
import { displayMatchStatus } from "../shared/match-status.js";
import { fetchMergedRyderData } from "../shared/ryder-cup-data.js";

const h = React.createElement;

function standingsHead(labels, nameIndex) {
  return h("tr", null, labels.map((label, index) => h("th", {
    className: index === nameIndex ? "player-name-cell" : "member-num",
    key: label,
  }, label)));
}

function nameCell(key, value) {
  return h("td", { className: "player-name-cell", key }, value);
}

function numCell(key, value) {
  return h("td", { className: "member-num", key }, value);
}

function LeagueCard({ item }) {
  const league = item.league || {};
  const official = item.officialSheet === true;
  const pending = item.officialPending === true;
  const failed = item.officialError === true;
  const teams = Array.isArray(item.teamStandings) ? item.teamStandings : [];
  const players = Array.isArray(item.standings) ? item.standings : [];
  const note = !official ? null
    : pending ? "Loading official tally…"
    : failed ? [
      "Couldn't load the official sheet tally. ",
      h("a", { className: "standings-link", href: "ryder-cup.html", key: "link" }, "Open scoreboard"),
    ]
    : [
      "Official points come from the club scoreboard sheet. ",
      h("a", { className: "standings-link", href: "ryder-cup.html", key: "link" }, "Open scoreboard"),
    ];
  return h("div", { className: "dash-standings-card" }, [
    h("h4", { className: "dash-subtitle", key: "title" }, `${league.name || "League"}${league.season ? ` - ${league.season}` : ""} - ${official ? "Official tally" : "Standings"}`),
    note ? h("p", { className: "dash-note", key: "note" }, note) : null,
    teams.length ? h("table", { className: "lb-table", key: "teams" }, [
      h("thead", { key: "head" }, standingsHead(["Team", "Pts", "W", "T", "L"], 0)),
      h("tbody", { key: "body" }, teams.map((team) => h("tr", { key: team.teamName || team.team }, [
        nameCell("name", team.teamName || team.team || "Team"),
        numCell("points", String(team.points)),
        numCell("wins", String(team.wins)),
        numCell("ties", String(team.ties)),
        numCell("losses", String(team.losses)),
      ]))),
    ]) : null,
    players.length ? h("details", { key: "players" }, [
      h("summary", { className: "standings-summary", key: "summary" }, players.some((player) => player.current_place != null) ? `Tag order (${players.length})` : `Player records (${players.length})`),
      h("table", { className: "lb-table", key: "table" }, [
        h("thead", { key: "head" }, standingsHead(players.some((player) => player.current_place != null) ? ["Tag", "Player", "Played", "Wins"] : ["Pos", "Player", "Pts", "Played", "Wins"], 1)),
        h("tbody", { key: "body" }, players.map((player, index) => h("tr", { key: `${player.name || "player"}-${index}` }, [
          numCell("pos", player.current_place != null ? String(player.current_place) : String(index + 1)),
          nameCell("name", player.name != null ? String(player.name) : "Player"),
          player.current_place != null ? null : numCell("points", String(player.points)),
          numCell("events", String(player.events)),
          numCell("wins", String(player.wins)),
        ]))),
      ]),
    ]) : null,
  ]);
}

function standingNameWithTeam(standing) {
  const name = standing && standing.name != null ? String(standing.name) : "Player";
  const team = standing && standing.scoringGroup && standing.scoringGroup.label
    ? String(standing.scoringGroup.label)
    : "";
  return team && team !== name ? `${name} · ${team}` : name;
}

function LiveEventStandings({ event }) {
  const [snapshot, setSnapshot] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await requestJson(`/events/${encodeURIComponent(event.id)}/live`);
        if (!cancelled) setSnapshot(data);
      } catch {
        if (!cancelled) setSnapshot(null);
      }
    }
    void poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [event.id]);

  const standings = Array.isArray(snapshot?.standings) ? snapshot.standings : [];
  const config = snapshot?.roundConfig || {};
  const matchplay = config.scoringStyle === "matchplay";
  const headings = matchplay
    ? ["Pos", config.groupFormat === "doubles" ? "Team" : "Player", "Thru", "Match"]
    : ["Pos", "Player", "Thru", "Total", "To Par"];
  return h("div", { className: "dash-standings-card" }, [
    h("h4", { className: "dash-subtitle", key: "title" }, [
      `Live - ${event.name || "Event"}`,
      h("a", { href: `events.html#event/${encodeURIComponent(event.id)}`, className: "standings-link", key: "link" }, "Open"),
    ]),
    standings.length ? h("table", { className: "lb-table", key: "table" }, [
      h("thead", { key: "head" }, standingsHead(headings, 1)),
      h("tbody", { key: "body" }, standings.map((standing, index) => h("tr", { key: `${standing.name || "player"}-${index}` }, [
        numCell("pos", String(index + 1)),
        nameCell("name", standingNameWithTeam(standing)),
        numCell("thru", standing.thru ? String(standing.thru) : "-"),
        matchplay
          ? numCell("match", displayMatchStatus(standing.match))
          : numCell("total", standing.total != null && standing.thru ? String(standing.total) : "-"),
        matchplay ? null : numCell("par", standing.thru ? formatToPar(standing.toPar) : "-"),
      ]))),
    ]) : h("div", { className: "dash-note", key: "empty" }, "Nothing here yet."),
  ]);
}

export function ActiveStandingsPanel({ standalone = false } = {}) {
  const [state, setState] = React.useState({ status: "idle", leagues: [], liveEvents: [], ryderTally: undefined });

  React.useEffect(() => {
    const controller = new AbortController();
    requestJson("/leagues/active", { signal: controller.signal })
      .then((data) => setState((current) => ({
        ...current,
        status: "ready",
        leagues: Array.isArray(data.leagues) ? data.leagues : [],
        liveEvents: Array.isArray(data.liveEvents) ? data.liveEvents : Array.isArray(data.events) ? data.events : [],
      })))
      .catch((error) => {
        if (error.name !== "AbortError") setState({ status: "error", leagues: [], liveEvents: [], ryderTally: null });
      });
    fetchMergedRyderData()
      .then((tally) => setState((current) => ({ ...current, ryderTally: tally })))
      .catch(() => setState((current) => ({ ...current, ryderTally: null })));
    return () => controller.abort();
  }, []);

  if (state.status !== "ready" || (!state.leagues.length && !state.liveEvents.length)) {
    // Embedded (Stats) the panel simply hides; as its own screen (Club → Club standings) it explains itself.
    if (!standalone) return null;
    const message = state.status === "error"
      ? "Standings are unavailable right now. Please try again in a minute."
      : state.status === "ready"
        ? "No league standings right now. They show here while a league round is live and for 60 days after one."
        : "Loading standings…";
    return h("div", { className: "player-card active-standings", "data-react-active-standings": state.status === "ready" ? "empty" : state.status },
      h("p", { className: "dash-note", role: state.status === "error" ? "alert" : "status" }, message));
  }
  const leagues = applyOfficialRyderTally(state.leagues, state.ryderTally);
  return h("div", { className: "active-standings react-active-standings", "data-react-active-standings": "ready" }, [
    ...state.liveEvents.map((event) => h(LiveEventStandings, { event, key: `event-${event.id}` })),
    ...leagues.map((league, index) => h(LeagueCard, { item: league, key: `league-${league.league?.id || index}` })),
  ]);
}
