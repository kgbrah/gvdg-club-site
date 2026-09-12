import React from "react";
import { Copy, Trophy } from "lucide-react";

import { HoleMap } from "../shared/hole-map.js";
import { PotsStrip } from "./pots-strip.js";
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

function WatchTeeSign(props) {
  if (!props.teeSign) return null;
  const style = props.teeSign.highlightColor ? { boxShadow: `0 0 0 3px ${props.teeSign.highlightColor}` } : undefined;
  return h("div", { className: "card tee-sign-card", key: "tee-sign", style }, [
    h("img", {
      alt: props.teeSign.alt,
      height: 400,
      key: "image",
      loading: "lazy",
      src: props.teeSign.src,
      width: 640,
    }),
    h("div", { className: "tee-sign-caption", key: "caption" }, [
      h("span", { key: "label" }, "Tee sign"),
      h("span", { key: "hole" }, `Hole ${props.teeSign.hole}`),
    ]),
  ]);
}

function WatchHoles(props) {
  const holes = Array.isArray(props.holes) ? props.holes : [];
  const [index, setIndex] = React.useState(0);
  const safeIndex = holes.length ? Math.min(index, holes.length - 1) : 0;
  const selected = holes[safeIndex] || null;
  if (!selected) return null;

  const bits = [`Hole ${selected.hole}`];
  if (selected.par != null) bits.push(`Par ${selected.par}`);
  if (selected.distance_ft != null) bits.push(`${selected.distance_ft} ft`);

  return h("div", { className: "watch-holes", key: "holes" }, [
    h("div", { className: "card", key: "picker" }, [
      h("h2", { className: "section", key: "title" }, "Hole maps"),
      h("p", { className: "watch-hole-meta", key: "meta" }, bits.join(" · ")),
      h("div", { className: "holegrid", key: "grid" }, holes.map((hole, holeIndex) =>
        h("button", {
          "aria-label": `Hole ${hole.hole}`,
          "aria-pressed": holeIndex === safeIndex,
          className: holeIndex === safeIndex ? "cur" : "",
          key: hole.hole,
          type: "button",
          onClick: () => setIndex(holeIndex),
        }, String(hole.hole)),
      )),
    ]),
    h(HoleMap, {
      hole: selected,
      key: "map",
      players: props.players,
      udiscCourseId: props.udiscCourseId,
      windFromDeg: props.windFromDeg,
    }),
    h(WatchTeeSign, { key: "sign", teeSign: selected.teeSign }),
  ]);
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
    props.showPots ? h(PotsStrip, { key: "pots", pots: props.pots }) : null,
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
    h(WatchHoles, {
      holes: props.holes,
      key: "holes",
      players: props.playerLocations,
      udiscCourseId: props.udiscCourseId,
      windFromDeg: props.windFromDeg,
    }),
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
