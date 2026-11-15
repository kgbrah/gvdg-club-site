import React from "react";

import { bagTagHolderGroups, collapseBagTagMoves } from "../shared/bag-tag-model.js";
import { fetchPublicJson, publicApiBase } from "./public-api.js";

const h = React.createElement;

function heldLabel(value) {
  const text = String(value || "");
  const day = text.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return `since ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

function Holder({ holder, lead = false }) {
  return h("li", { className: `bagtag-holder${lead ? " lead" : ""}` }, [
    h("span", { className: "bagtag-number num", key: "tag" }, [h("span", { "aria-hidden": "true", key: "hash" }, "#"), String(holder.tagNumber)]),
    h("span", { className: "bagtag-name", key: "name" }, holder.name || "Player"),
    h("span", { className: "bagtag-since", key: "since" }, heldLabel(holder.heldSince)),
  ]);
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
  const changes = collapseBagTagMoves(board.moves, 6);
  const { podium, rest } = bagTagHolderGroups(holders);
  const title = [board.series.name, board.series.season].filter(Boolean).join(" · ");

  return h("section", { className: "events-section bagtags", "data-react-events-bag-tags": "true" }, [
    h("div", { className: "events-section-head", key: "head" }, [
      h("h2", { className: "events-section-title", key: "title" }, title || "Bag tags"),
      holders.length
        ? h("span", { className: "events-section-count", key: "count" }, `${holders.length} holder${holders.length === 1 ? "" : "s"}`)
        : null,
    ]),
    holders.length
      ? h(React.Fragment, { key: "ladder" }, [
        h("p", { className: "events-group-sub", key: "note" }, "Win a round against a higher tag and the numbers swap. A lower number is better."),
        h("ol", { className: "bagtag-ladder bagtag-podium", key: "podium" }, podium.map((holder) =>
          h(Holder, { holder, key: holder.tagNumber, lead: true }))),
        rest.length
          ? h("ol", { className: "bagtag-ladder", key: "rest" }, rest.map((holder) => h(Holder, { holder, key: holder.tagNumber })))
          : null,
      ])
      : h("div", { className: "bagtag-empty", key: "empty" }, [
        h("p", { className: "bagtag-empty-title", key: "t" }, "Tags are not assigned yet."),
        h("p", { className: "events-group-sub", key: "s" }, "Once the season opens, the ladder from #1 down lands here."),
      ]),
    changes.length
      ? h("details", { className: "bagtag-changes", key: "moves" }, [
        h("summary", { key: "summary" }, [
          h("span", { key: "label" }, "Recent changes"),
          h("span", { className: "bagtag-changes-total num", key: "count" }, String(changes.length)),
        ]),
        h("ul", { className: "bagtag-changes-list", key: "list" }, changes.map((move) =>
          h("li", { key: move.id }, [
            h("span", { key: "s" }, move.summary),
            move.count > 1 ? h("span", { className: "bagtag-changes-count", key: "c" }, `${move.count} updates`) : null,
          ]))),
      ])
      : null,
  ]);
}
