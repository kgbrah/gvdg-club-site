import React from "react";

import { groupPlayersByDivision } from "./events-model.js";

const h = React.createElement;

function sortGroup(players) {
  return players.slice().sort((left, right) => {
    const ratingA = left.rating == null ? -1 : Number(left.rating);
    const ratingB = right.rating == null ? -1 : Number(right.rating);
    if (ratingA !== ratingB) return ratingB - ratingA;
    return String(left.name || "").localeCompare(String(right.name || ""));
  });
}

export function EventFieldRoster({ players, compact = false, title }) {
  const list = Array.isArray(players) ? players : [];
  const grouped = groupPlayersByDivision(list).map((group) => ({
    ...group,
    players: sortGroup(group.players),
  }));
  if (!grouped.length) return null;
  const showDivisionHeads = !(grouped.length === 1 && grouped[0].division === "Open");
  const heading = title || `Field (${list.length})`;

  return h("div", { className: compact ? "event-field event-field-compact" : "event-field" }, [
    h(compact ? "h4" : "h3", { className: compact ? "event-field-title" : "roster-title", key: "title" }, heading),
    grouped.map((group) => h("div", { className: "division-group", key: group.division }, [
      showDivisionHeads ? h("div", { className: "division-name", key: "division" }, group.division) : null,
      h("div", { className: "player-list", key: "players" }, group.players.map((player, index) => {
        const name = player && player.name != null ? String(player.name) : "Unnamed";
        const rating = player && player.rating != null && player.rating !== "" ? String(player.rating) : null;
        return h("div", { className: "player-row", key: `${name}|${index}` }, [
          h("span", { className: "player-name", key: "name" }, name),
          rating ? h("span", { className: "player-rating", key: "rating" }, rating) : null,
          player && player.team ? h("span", { className: "player-team", key: "team" }, String(player.team)) : null,
        ]);
      })),
    ])),
  ]);
}
