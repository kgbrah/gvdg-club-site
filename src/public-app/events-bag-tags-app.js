import React from "react";

import { fetchPublicJson, publicApiBase } from "./public-api.js";

const h = React.createElement;

function heldLabel(value) {
  const text = String(value || "");
  const day = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `since ${day}` : "";
}

export function EventsBagTagsApp() {
  const api = React.useMemo(publicApiBase, []);
  const [board, setBoard] = React.useState(null);

  React.useEffect(() => {
    let active = true;
    fetchPublicJson(api, "/bag-tags")
      .then((data) => {
        if (active) setBoard(data && data.series ? data : null);
      })
      .catch(() => {
        if (active) setBoard(null);
      });
    return () => {
      active = false;
    };
  }, [api]);

  if (!board) return null;
  const holders = Array.isArray(board.holders) ? board.holders : [];
  const moves = Array.isArray(board.moves) ? board.moves : [];
  const title = [board.series.name, board.series.season].filter(Boolean).join(" · ");

  return h("section", { className: "events-section", "data-react-events-bag-tags": "true" }, [
    h("div", { className: "events-section-head", key: "head" }, [
      h("h2", { className: "events-section-title", key: "title" }, "Bag tags"),
      h("span", { className: "events-section-count", key: "count" }, String(holders.length)),
    ]),
    h("p", { className: "events-group-sub", key: "note" }, `${title}. Lower number is better. #1 is the ace.`),
    holders.length
      ? h("div", { className: "lb-wrap", key: "table" }, h("table", { className: "lb-table" }, [
        h("thead", { key: "head" }, h("tr", null, ["Tag", "Player", "Held"].map((label) => h("th", { key: label }, label)))),
        h("tbody", { key: "body" }, holders.map((holder) => h("tr", { key: holder.tagNumber }, [
          h("td", { className: "lb-pos", key: "tag" }, `#${holder.tagNumber}`),
          h("td", { className: "lb-name", key: "name" }, holder.name || "Player"),
          h("td", { key: "since" }, heldLabel(holder.heldSince)),
        ]))),
      ]))
      : h("p", { className: "events-empty", key: "empty" }, "Tags are not assigned yet."),
    moves.length
      ? h("ul", { className: "extras-list", key: "moves" }, moves.slice(0, 8).map((move) =>
        h("li", { key: move.id }, move.summary)))
      : null,
  ]);
}
