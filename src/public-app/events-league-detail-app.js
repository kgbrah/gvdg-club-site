import React from "react";

import { statusLabel } from "../shared/events-model.js";
import {
  currentEventsRoute,
  EVENTS_ROUTE_REQUEST_EVENT,
  publishEventsLastUpdated,
  publishEventsStatus,
  publishEventsView,
} from "./events-state.js";
import { fetchPublicJson, publicApiBase } from "./public-api.js";
import { fetchMergedRyderData } from "../shared/ryder-cup-data.js";
import { officialRyderPlayerStandings } from "./ryder-board-merge.js";

const h = React.createElement;

function normalizeLeague(raw) {
  const league = raw && typeof raw === "object" ? raw : {};
  return {
    format: league.format == null ? "" : String(league.format),
    id: league.id == null ? "" : String(league.id),
    name: league.name == null ? "League" : String(league.name),
    season: league.season == null ? "" : String(league.season),
  };
}

function leagueRouteId(route) {
  return route && route.view === "league" && route.id != null ? String(route.id) : "";
}

function currentLeagueRouteId() {
  return leagueRouteId(currentEventsRoute());
}

function useEventsLeagueDetail() {
  const api = React.useMemo(publicApiBase, []);
  const [routeId, setRouteId] = React.useState(currentLeagueRouteId);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [data, setData] = React.useState(null);

  React.useEffect(() => {
    function update(event) {
      const nextRoute = event.detail && event.detail.route ? event.detail.route : currentEventsRoute();
      setRouteId(leagueRouteId(nextRoute));
    }

    window.addEventListener(EVENTS_ROUTE_REQUEST_EVENT, update);
    update({ detail: { route: currentEventsRoute() } });
    return () => window.removeEventListener(EVENTS_ROUTE_REQUEST_EVENT, update);
  }, []);

  React.useEffect(() => {
    if (!routeId) {
      setData(null);
      return undefined;
    }

    let active = true;

    async function loadLeagueDetail() {
      publishEventsView("status");
      publishEventsLastUpdated(null);
      publishEventsStatus({
        message: "Loading league...",
        retry: null,
        tone: "loading",
      });

      try {
        const next = await fetchPublicJson(api, `/leagues/${encodeURIComponent(routeId)}`);
        if (!active) return;
        if (!next || !next.league) {
          setData(null);
          publishEventsStatus({
            message: "That league could not be found.",
            retry: () => {
              window.location.hash = "";
            },
            tone: "error",
          });
          return;
        }

        setData(next);
        publishEventsView("league-detail");
        publishEventsLastUpdated(null);
        window.scrollTo(0, 0);
      } catch {
        if (!active) return;
        setData(null);
        publishEventsStatus({
          message: "We couldn't load that league right now.",
          retry: () => setReloadKey((value) => value + 1),
          tone: "error",
        });
      }
    }

    loadLeagueDetail();
    return () => {
      active = false;
    };
  }, [api, reloadKey, routeId]);

  return { data, routeId };
}

function useOfficialRyderTally(routeId) {
  const [tally, setTally] = React.useState(null);
  React.useEffect(() => {
    if (routeId !== "4") {
      setTally(null);
      return undefined;
    }
    let active = true;
    fetchMergedRyderData()
      .then((next) => {
        if (active) setTally(next);
      })
      .catch(() => {
        if (active) setTally(null);
      });
    return () => {
      active = false;
    };
  }, [routeId]);
  return tally;
}

function leagueMeta(league) {
  return [league.season, league.format].filter(Boolean).join(" · ");
}

function fmtToPar(value) {
  const n = Number(value) || 0;
  return n === 0 ? "E" : n > 0 ? `+${n}` : String(n);
}

function cellText(value, fallback = "0") {
  return value == null || value === "" ? fallback : String(value);
}

function safeWinnerClass(value) {
  const key = String(value || "").toLowerCase();
  return key === "red" || key === "blue" || key === "tie" ? key : "";
}

function TeamDot({ team }) {
  return h("span", {
    "aria-hidden": "true",
    className: `team-dot ${safeWinnerClass(team)}`.trim(),
  });
}

function ScrollTable({ children }) {
  return h("div", { className: "lb-wrap" }, children);
}

function OfficialRyderTally({ tally }) {
  if (!tally || !tally.teamPoints) return null;
  const teams = [
    { team: "Red", teamName: tally.scoreboard && tally.scoreboard.red ? tally.scoreboard.red.name : "Red Team", points: tally.teamPoints.red },
    { team: "Blue", teamName: tally.scoreboard && tally.scoreboard.blue ? tally.scoreboard.blue.name : "Blue Team", points: tally.teamPoints.blue },
  ];
  return h(React.Fragment, null, [
    h("h3", { className: "roster-title", key: "title" }, "Official tally"),
    h("p", { className: "detail-notes", key: "note" }, "Official points come from the club scoreboard sheet. This Ryder Cup was kept there, not in the app."),
    h(ScrollTable, { key: "table" }, h("table", { className: "lb-table" }, [
      h("thead", { key: "head" }, h("tr", null, ["Team", "Pts"].map((label) => h("th", { key: label }, label)))),
      h("tbody", { key: "body" }, teams.map((team) => h("tr", { key: team.team }, [
        h("td", { className: "lb-name", key: "team" }, [
          h(TeamDot, { key: "dot", team: team.team }),
          team.teamName,
        ]),
        h("td", { key: "points" }, cellText(team.points)),
      ]))),
    ])),
    h("p", { key: "scoreboard-link" },
      h("a", { className: "back-link", href: "ryder-cup.html" }, "Full Ryder Cup scoreboard")),
  ]);
}

function TeamStandingsTable({ teams }) {
  if (!teams.length) return null;
  return h(React.Fragment, null, [
    h("h3", { className: "roster-title", key: "title" }, "Team standings"),
    h(ScrollTable, { key: "table" }, h("table", { className: "lb-table" }, [
      h("thead", { key: "head" }, h("tr", null, ["Team", "Pts", "W", "T", "L", "Matches"].map((label) =>
        h("th", { key: label }, label)))),
      h("tbody", { key: "body" }, teams.map((team, index) => {
        const teamName = cellText(team.teamName || team.team, "Team");
        return h("tr", { key: [team.team, teamName, String(index)].filter(Boolean).join("|") }, [
          h("td", { className: "lb-name", key: "team" }, [
            h(TeamDot, { key: "dot", team: team.team || teamName }),
            teamName,
          ]),
          h("td", { key: "points" }, cellText(team.points)),
          h("td", { key: "wins" }, cellText(team.wins)),
          h("td", { key: "ties" }, cellText(team.ties)),
          h("td", { key: "losses" }, cellText(team.losses)),
          h("td", { key: "matches" }, cellText(team.matches)),
        ]);
      })),
    ])),
  ]);
}

function PlayerStandingsTable({ isMatch, standings }) {
  return h(React.Fragment, null, [
    h("h3", { className: "roster-title", key: "title" }, isMatch ? "Player records" : "Standings"),
    standings.length
      ? h(ScrollTable, { key: "table" }, h("table", { className: "lb-table" }, [
        h("thead", { key: "head" }, h("tr", null, (isMatch
          ? ["Pos", "Player", "Pts", "Played", "Wins"]
          : ["Pos", "Player", "Pts", "Played", "Wins", "To Par"]).map((label) =>
          h("th", { key: label }, label)))),
        h("tbody", { key: "body" }, standings.map((standing, index) => {
          const totalToPar = Number(standing.total_to_par) || 0;
          return h("tr", { key: [standing.name, String(index)].filter(Boolean).join("|") }, [
            h("td", { className: "lb-pos", key: "pos" }, String(index + 1)),
            h("td", { className: "lb-name", key: "name" }, cellText(standing.name, "Player")),
            h("td", { key: "points" }, cellText(standing.points)),
            h("td", { key: "events" }, cellText(standing.events)),
            h("td", { key: "wins" }, cellText(standing.wins)),
            isMatch ? null : h("td", {
              className: `lb-topar${totalToPar < 0 ? " under" : totalToPar > 0 ? " over" : ""}`,
              key: "to-par",
            }, fmtToPar(standing.total_to_par)),
          ]);
        })),
      ]))
      : h("p", { className: "lb-empty", key: "empty" }, "No finalized rounds yet - standings appear once rounds are scored."),
  ]);
}

function roundKey(event, index) {
  return [event && event.id, event && event.name, event && event.date, String(index)].filter(Boolean).join("|");
}

function LeagueRounds({ roundWinners, rounds }) {
  if (!rounds.length) return null;
  return h(React.Fragment, null, [
    h("h3", { className: "roster-title", key: "title" }, `Rounds (${rounds.length})`),
    h("div", { className: "player-list", key: "list" }, rounds.map((event, index) => {
      const id = event && event.id != null ? String(event.id) : "";
      const winner = safeWinnerClass(roundWinners[id]);
      function openEvent() {
        if (id) window.location.hash = `#event/${encodeURIComponent(id)}`;
      }
      return h("button", {
        className: `player-row league-round-card${winner ? ` winner-${winner}` : ""}`,
        disabled: !id,
        key: roundKey(event, index),
        onClick: openEvent,
        type: "button",
      }, [
        h("span", { className: "player-name", key: "name" }, cellText(event && event.name, "Event")),
        event && event.date ? h("span", { className: "player-pdga", key: "date" }, String(event.date)) : null,
        h("span", { className: "player-team", key: "status" }, statusLabel(event && event.status)),
      ]);
    })),
  ]);
}

export function EventsLeagueDetailApp() {
  const { data, routeId } = useEventsLeagueDetail();
  const ryderTally = useOfficialRyderTally(routeId);
  if (!data) return null;

  const league = normalizeLeague(data.league);
  const rounds = Array.isArray(data.events) ? data.events : [];
  const teamStandings = Array.isArray(data.teamStandings) ? data.teamStandings : [];
  const roundWinners = data.roundWinners && typeof data.roundWinners === "object" ? data.roundWinners : {};
  const meta = leagueMeta(league);
  const isMatch = teamStandings.length > 0;
  const isRyder = routeId === "4";
  const standings = isRyder && ryderTally
    ? officialRyderPlayerStandings(ryderTally.weeks, [
      ...((ryderTally.scoreboard && ryderTally.scoreboard.red && ryderTally.scoreboard.red.players) || []),
      ...((ryderTally.scoreboard && ryderTally.scoreboard.blue && ryderTally.scoreboard.blue.players) || []),
    ])
    : (Array.isArray(data.standings) ? data.standings : []);

  function backToHub() {
    window.location.hash = "";
  }

  return h(React.Fragment, null, [
    h("button", { className: "back-link", key: "back", onClick: backToHub, type: "button" }, "\u2190 All events"),
    h("article", { className: "detail-card", key: "card", "data-react-events-league-detail": "true" }, [
      h("div", { className: "detail-head", key: "head" }, [
        h("h2", { className: "detail-title", key: "title" }, league.name),
        meta ? h("span", { className: "badge type-badge", key: "meta" }, meta) : null,
      ]),
      data.league && data.league.description
        ? h("div", { className: "detail-notes", key: "description" }, String(data.league.description))
        : null,
      isRyder ? h(OfficialRyderTally, { key: "official", tally: ryderTally }) : h(TeamStandingsTable, { key: "teams", teams: teamStandings }),
      h(PlayerStandingsTable, { isMatch, key: "players", standings }),
      h(LeagueRounds, { key: "rounds", roundWinners, rounds }),
    ]),
  ]);
}
