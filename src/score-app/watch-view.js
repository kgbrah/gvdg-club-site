import React from "react";
import { Copy, Trophy } from "lucide-react";

import { HoleMap } from "../shared/hole-map.js";
import { PotsStrip } from "./pots-strip.js";
import { WeatherStrip } from "./weather-strip.js";
import { LeaderboardTable } from "./leaderboard-sheet.js";
import {
  watchFollowOptions,
  watchFollowPlayer,
  watchHoleScoreChips,
  watchHoleThrows,
  watchMatchCards,
  watchScoreSignature,
  watchStrokeHoleChips,
} from "./score-view-model.js";

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

function WatchHoleChips({ chips }) {
  if (!chips || !chips.length) return null;
  return h("div", { className: "watch-hole-chips", key: "chips" }, chips.map((chip) =>
    h("span", {
      className: "watch-hole-chip " + (chip.result || "") + " " + (chip.className || ""),
      key: chip.key,
    }, [
      h("span", { key: "name" }, chip.name),
      h("span", { className: "rel " + chip.className, key: "score" }, chip.strokes + " " + chip.label),
    ]),
  ));
}

function WatchStrokeStrip({ chips }) {
  if (!chips || !chips.length) return null;
  return h("div", { className: "card watch-stroke-strip", key: "stroke" }, [
    h("span", { className: "muted", key: "label" }, "Thru this hole"),
    h(WatchHoleChips, { chips, key: "chips" }),
  ]);
}

function WatchMatchCards({ cards }) {
  if (!cards || !cards.length) return null;
  return h("div", { className: "watch-match-list", key: "matches" }, cards.map((card) =>
    h("div", { className: "card watch-match-card", key: card.key }, [
      h("div", { className: "watch-match-head", key: "head" }, [
        h("strong", { key: "title" }, card.title),
        h("span", { className: "watch-match-status", key: "status" }, card.status),
      ]),
      h("p", { className: "muted watch-match-thru", key: "thru" }, "Thru " + card.thru),
      card.chips.length
        ? h(WatchHoleChips, { chips: card.chips, key: "chips" })
        : h("p", { className: "muted", key: "empty" }, "No score this hole yet"),
    ]),
  ));
}

function WatchFollowBar({ options, follow, pinned, onPin }) {
  if (!follow && !(options && options.length)) return null;
  return h("div", { className: "watch-follow", key: "follow" }, [
    h("p", { className: "watch-follow-label", key: "label" }, follow ? follow.name + "'s lies" : "Marked lies"),
    options && options.length > 1
      ? h("div", { className: "watch-follow-chips", key: "chips", role: "group", "aria-label": "Follow player lies" },
        options.map((row) => h("button", {
          "aria-pressed": follow && follow.index === row.index ? "true" : "false",
          className: "watch-follow-chip" + (follow && follow.index === row.index ? " is-active" : ""),
          key: row.index,
          type: "button",
          onClick: () => onPin(pinned === row.index ? null : row.index),
        }, row.name)))
      : null,
  ]);
}

function WatchHoles(props) {
  const holes = Array.isArray(props.holes) ? props.holes : [];
  const liveIndex = holes.length
    ? Math.min(Math.max(0, Number(props.activeHoleIndex) || 0), holes.length - 1)
    : 0;
  const [index, setIndex] = React.useState(liveIndex);
  const [followLive, setFollowLive] = React.useState(true);
  React.useEffect(() => {
    if (followLive) setIndex(liveIndex);
  }, [followLive, liveIndex]);
  const safeIndex = holes.length ? Math.min(index, holes.length - 1) : 0;
  const selected = holes[safeIndex] || null;
  const [pinned, setPinned] = React.useState(null);
  const [scoreFlight, setScoreFlight] = React.useState(0);
  const scoreSigRef = React.useRef("");
  const follow = selected
    ? watchFollowPlayer({
      followIndex: pinned,
      hole: selected.hole,
      players: props.scorePlayers,
    })
    : null;
  const followOptions = selected ? watchFollowOptions({ hole: selected.hole, players: props.scorePlayers }) : [];
  const followThrows = follow && selected ? watchHoleThrows(follow, selected.hole) : [];
  const scoreSig = selected ? watchScoreSignature(follow, selected.hole) : "";
  React.useEffect(() => {
    scoreSigRef.current = "";
    setScoreFlight(0);
  }, [follow && follow.index, selected && selected.hole]);
  React.useEffect(() => {
    const prev = scoreSigRef.current;
    scoreSigRef.current = scoreSig;
    if (!prev) return;
    const prevStrokes = prev.slice(prev.indexOf(":") + 1);
    const nextStrokes = scoreSig.slice(scoreSig.indexOf(":") + 1);
    if (nextStrokes && nextStrokes !== prevStrokes) setScoreFlight((value) => value + 1);
  }, [scoreSig]);
  if (!selected) return null;
  const mapPlayers = props.isMatchplay
    ? props.players
    : watchHoleScoreChips({
      hole: selected.hole,
      locations: props.players,
      par: selected.par,
      players: props.scorePlayers,
      scoreTargets: props.scoreTargets,
    });
  const strokeChips = props.isMatchplay
    ? []
    : watchStrokeHoleChips({
      hole: selected.hole,
      par: selected.par,
      players: props.scorePlayers,
      scoreTargets: props.scoreTargets,
    });
  const matchCards = props.isMatchplay
    ? watchMatchCards({
      hole: selected.hole,
      par: selected.par,
      players: props.scorePlayers,
      scoreTargets: props.scoreTargets,
      standings: props.standings,
    })
    : [];

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
          onClick: () => {
            setFollowLive(holeIndex === liveIndex);
            setIndex(holeIndex);
          },
        }, String(hole.hole)),
      )),
    ]),
    h(HoleMap, {
      discColor: follow && follow.discColor,
      hole: selected,
      key: "map",
      players: mapPlayers,
      scoreFlight,
      throwGroups: followOptions.map((row) => ({
        active: Boolean(follow && follow.index === row.index),
        key: row.index,
        throws: row.throws,
      })),
      throws: followThrows,
      throwsKey: follow ? follow.index : "none",
      udiscCourseId: props.udiscCourseId,
      windFromDeg: props.windFromDeg,
    }),
    h(WatchFollowBar, {
      follow,
      key: "follow",
      options: followOptions,
      pinned,
      onPin: setPinned,
    }),
    props.isMatchplay ? h(WatchMatchCards, { cards: matchCards, key: "matches" }) : h(WatchStrokeStrip, { chips: strokeChips, key: "stroke" }),
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
      activeHoleIndex: props.activeHoleIndex,
      holes: props.holes,
      isMatchplay: props.isMatchplay,
      key: "holes",
      players: props.playerLocations,
      scorePlayers: props.players,
      scoreTargets: props.scoreTargets,
      standings,
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
