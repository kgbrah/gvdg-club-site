import React from "react";

import { displayMatchStatus } from "../shared/match-status.js";

const h = React.createElement;

function cellText(value, fallback = "0") {
  return value == null || value === "" ? fallback : String(value);
}

function fmtToPar(value) {
  const n = Number(value) || 0;
  return n === 0 ? "E" : n > 0 ? `+${n}` : String(n);
}

function standingTeamLabel(standing) {
  const label = standing && standing.scoringGroup && standing.scoringGroup.label
    ? String(standing.scoringGroup.label)
    : "";
  return label && label !== cellText(standing && standing.name, "") ? label : "";
}

function safeWinnerClass(value) {
  const key = String(value || "").toLowerCase();
  return key === "red" || key === "blue" || key === "tie" ? key : "";
}

export function LiveStandings({ snapshot }) {
  if (!snapshot) {
    return h("div", { className: "lb-wrap" }, h("p", { className: "lb-empty" }, "Loading live scores..."));
  }

  const standings = Array.isArray(snapshot.standings) ? snapshot.standings : [];
  if (!standings.length) {
    return h("div", { className: "lb-wrap" }, h("p", { className: "lb-empty" }, "Waiting for the first scores..."));
  }

  const config = snapshot.roundConfig || {};
  const matchplay = config.scoringStyle === "matchplay";
  const doubles = config.groupFormat === "doubles";
  const hasDivision = !matchplay && standings.some((standing) => standing && standing.division);
  const columns = matchplay
    ? ["Pos", doubles ? "Team" : "Player", "Thru", "Match"]
    : hasDivision
      ? ["Pos", "Player", "Div", "Thru", "Total", "To Par"]
      : ["Pos", "Player", "Thru", "Total", "To Par"];

  return h("div", { className: "lb-wrap", "data-react-live-standings": "ready" }, h("table", { className: `lb-table${matchplay ? " live-matchplay" : ""}` }, [
    h("thead", { key: "head" }, h("tr", null, columns.map((label) => h("th", { key: label }, label)))),
    h("tbody", { key: "body" }, standings.map((standing, index) => {
      const toPar = Number(standing && standing.toPar) || 0;
      const name = cellText(standing && standing.name, "Player");
      const teamLabel = standingTeamLabel(standing);
      const team = safeWinnerClass(teamLabel || (standing && standing.scoringGroup && standing.scoringGroup.label));
      const members = doubles && standing && Array.isArray(standing.members) && standing.members.length
        ? ` (${standing.members.join(" & ")})`
        : "";
      const base = [
        h("td", { className: "lb-pos", key: "pos" }, String(index + 1)),
        h("td", { className: "lb-name", key: "name" }, [
          team ? h("span", { "aria-hidden": "true", className: `team-dot ${team}`, key: "dot" }) : null,
          name,
          teamLabel ? h("span", { className: "lb-members", key: "team" }, teamLabel) : null,
          members ? h("span", { className: "lb-members", key: "members" }, members) : null,
        ]),
      ];
      if (matchplay) {
        return h("tr", { key: `${name}|${index}` }, base.concat([
          h("td", { key: "thru" }, standing && standing.thru ? String(standing.thru) : "-"),
          h("td", { className: "lb-match", key: "match" }, displayMatchStatus(standing && standing.match)),
        ]));
      }
      return h("tr", { key: `${name}|${index}` }, base.concat([
        hasDivision ? h("td", { key: "division" }, (standing && standing.division) || "-") : null,
        h("td", { key: "thru" }, standing && standing.thru ? String(standing.thru) : "-"),
        h("td", { key: "total" }, standing && standing.total != null && standing.thru ? String(standing.total) : "-"),
        h("td", {
          className: `lb-topar${standing && standing.thru && toPar < 0 ? " under" : standing && standing.thru && toPar > 0 ? " over" : ""}`,
          key: "to-par",
        }, standing && standing.thru ? fmtToPar(standing.toPar) : "-"),
      ]));
    })),
  ]));
}
