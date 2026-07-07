import React from "react";

import { statusLabel } from "../../events.js";

const h = React.createElement;
const LEAGUES_EVENT = "gvdg:events-leagues";
const LEAGUE_DETAIL_EVENT = "gvdg:events-league-detail";

function normalizeLeague(raw) {
  const league = raw && typeof raw === "object" ? raw : {};
  return {
    format: league.format == null ? "" : String(league.format),
    id: league.id == null ? "" : String(league.id),
    name: league.name == null ? "League" : String(league.name),
    season: league.season == null ? "" : String(league.season),
  };
}

function publishedLeagues() {
  return Array.isArray(window.__gvdgEventsLeagues)
    ? window.__gvdgEventsLeagues.map(normalizeLeague)
    : [];
}

function useEventsLeagues() {
  const [leagues, setLeagues] = React.useState(publishedLeagues);

  React.useEffect(() => {
    function update(event) {
      const next = event.detail && Array.isArray(event.detail.leagues)
        ? event.detail.leagues
        : publishedLeagues();
      setLeagues(next.map(normalizeLeague));
    }
    window.addEventListener(LEAGUES_EVENT, update);
    update({ detail: { leagues: publishedLeagues() } });
    return () => window.removeEventListener(LEAGUES_EVENT, update);
  }, []);

  return leagues;
}

function publishedLeagueDetail() {
  const data = window.__gvdgEventsLeagueDetail;
  return data && typeof data === "object" && data.league ? data : null;
}

function useEventsLeagueDetail() {
  const [data, setData] = React.useState(publishedLeagueDetail);

  React.useEffect(() => {
    function update(event) {
      const next = event.detail && event.detail.data ? event.detail.data : publishedLeagueDetail();
      setData(next && typeof next === "object" && next.league ? next : null);
    }
    window.addEventListener(LEAGUE_DETAIL_EVENT, update);
    update({ detail: { data: publishedLeagueDetail() } });
    return () => window.removeEventListener(LEAGUE_DETAIL_EVENT, update);
  }, []);

  return data;
}

function leagueKey(league, index) {
  return [league.id, league.name, league.season, league.format, String(index)].filter(Boolean).join("|");
}

function leagueMeta(league) {
  return [league.season, league.format].filter(Boolean).join(" · ");
}

function LeagueCard({ league }) {
  const meta = leagueMeta(league);
  const disabled = !league.id;

  function openLeague() {
    if (!disabled) window.location.hash = `#league/${encodeURIComponent(league.id)}`;
  }

  return h("button", {
    className: "league-card",
    disabled,
    onClick: openLeague,
    type: "button",
  }, [
    h("span", { className: "league-name", key: "name" }, league.name),
    meta ? h("span", { className: "league-meta", key: "meta" }, meta) : null,
  ]);
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
  const data = useEventsLeagueDetail();
  if (!data) return null;

  const league = normalizeLeague(data.league);
  const standings = Array.isArray(data.standings) ? data.standings : [];
  const rounds = Array.isArray(data.events) ? data.events : [];
  const teamStandings = Array.isArray(data.teamStandings) ? data.teamStandings : [];
  const roundWinners = data.roundWinners && typeof data.roundWinners === "object" ? data.roundWinners : {};
  const meta = leagueMeta(league);
  const isMatch = teamStandings.length > 0;

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
      h(TeamStandingsTable, { key: "teams", teams: teamStandings }),
      h(PlayerStandingsTable, { isMatch, key: "players", standings }),
      h(LeagueRounds, { key: "rounds", roundWinners, rounds }),
    ]),
  ]);
}

export function EventsLeaguesApp() {
  const leagues = useEventsLeagues();
  if (!leagues.length) return null;

  return h("section", { "data-react-events-leagues": "true" }, [
    h("h2", { className: "events-section-title", key: "title" }, "Leagues & Standings"),
    h("div", { className: "leagues-grid", key: "grid" }, leagues.map((league, index) =>
      h(LeagueCard, { key: leagueKey(league, index), league }))),
  ]);
}
