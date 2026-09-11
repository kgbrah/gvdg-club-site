import React from "react";
import { Copy, Trophy } from "lucide-react";

import { WeatherStrip } from "./weather-strip.js";
import { LeaderboardTable } from "./leaderboard-sheet.js";

const h = React.createElement;

function icon(Icon) {
  return h(Icon, {
    key: "icon",
    size: 16,
    strokeWidth: 2.4,
    "aria-hidden": "true",
    focusable: "false",
  });
}

export function WatchView(props) {
  const standings = Array.isArray(props.standings) ? props.standings : [];
  return h("div", { className: "watch-view", "data-react-live-watch": props.status || "live" }, [
    h("div", { className: "watch-banner", key: "banner" }, [
      h("span", { className: "live-dot", key: "dot" }),
      h("span", { key: "label" }, props.status === "final" ? "Round finished" : "Watching live"),
      h("span", { className: "lb-conn", key: "connection" }, props.connection || "Live"),
    ]),
    props.courseName || props.layoutName
      ? h("p", { className: "muted watch-meta", key: "meta" }, [props.courseName, props.layoutName].filter(Boolean).join(" · "))
      : null,
    props.showWeather ? h(WeatherStrip, { key: "weather", title: "Round weather", weather: props.weather }) : null,
    h("div", { className: "card", key: "board" }, [
      h("h2", { className: "section", key: "title" }, [icon(Trophy), " Live leaderboard"]),
      h(LeaderboardTable, {
        isDoubles: props.isDoubles,
        isMatchplay: props.isMatchplay,
        key: "table",
        relClass: props.relClass,
        relText: props.relText,
        standings,
      }),
    ]),
    h("div", { className: "watch-actions", key: "actions" }, [
      props.onCopyLink
        ? h("button", { className: "btn secondary", key: "copy", type: "button", onClick: props.onCopyLink }, [
          icon(Copy),
          "Copy watch link",
        ])
        : null,
      props.keepScoreHref
        ? h("a", { className: "btn", href: props.keepScoreHref, key: "score" }, "Keep score")
        : null,
    ].filter(Boolean)),
  ]);
}
