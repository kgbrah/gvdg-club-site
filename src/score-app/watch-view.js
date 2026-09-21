import React from "react";
import { ChevronLeft, ChevronRight, Copy, Pause, Play, Trophy } from "lucide-react";

import { HoleMap } from "../shared/hole-map.js";
import { HOLE_MAP_WATCH_SIZE } from "../shared/hole-map-model.js";
import { preloadRoundMaps } from "../shared/satellite-preload.js";
import { PotsStrip } from "./pots-strip.js";
import { WeatherStrip } from "./weather-strip.js";
import { LeaderboardTable } from "./leaderboard-sheet.js";
import {
  watchFollowOptions,
  watchFollowPlayer,
  watchHoleScoreChips,
  watchHoleThrows,
  watchMatchCards,
  watchReplayCaption,
  watchReplayDelayMs,
  watchReplayHole,
  watchReplayIsScoreStep,
  watchReplayPlayers,
  watchReplayStepCount,
  watchReplayVisibleThrows,
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

function WatchReplayBar({ caption, playing, onPlay, onPrevHole, onPrevThrow, onNextThrow, onNextHole }) {
  return h("div", { className: "watch-replay", key: "replay" }, [
    h("p", { className: "watch-replay-caption", key: "caption" }, caption || "Replay"),
    h("div", { className: "watch-replay-controls", key: "controls", role: "group", "aria-label": "Replay throws" }, [
      h("button", { "aria-label": "Previous hole", className: "watch-replay-btn", key: "prev-hole", type: "button", onClick: onPrevHole }, icon(ChevronLeft)),
      h("button", { "aria-label": "Previous throw", className: "watch-replay-btn", key: "prev-throw", type: "button", onClick: onPrevThrow }, "Prev"),
      h("button", {
        "aria-label": playing ? "Pause replay" : "Play replay",
        "aria-pressed": playing ? "true" : "false",
        className: "watch-replay-btn watch-replay-play",
        key: "play",
        type: "button",
        onClick: onPlay,
      }, [icon(playing ? Pause : Play), playing ? " Pause" : " Play"]),
      h("button", { "aria-label": "Next throw", className: "watch-replay-btn", key: "next-throw", type: "button", onClick: onNextThrow }, "Next"),
      h("button", { "aria-label": "Next hole", className: "watch-replay-btn", key: "next-hole", type: "button", onClick: onNextHole }, icon(ChevronRight)),
    ]),
  ]);
}

function WatchHoles(props) {
  const replay = props.status === "final";
  const holes = Array.isArray(props.holes) ? props.holes : [];
  const liveIndex = holes.length
    ? Math.min(Math.max(0, Number(props.activeHoleIndex) || 0), holes.length - 1)
    : 0;
  const [index, setIndex] = React.useState(replay ? 0 : liveIndex);
  const [followLive, setFollowLive] = React.useState(!replay);
  React.useEffect(() => {
    if (followLive) setIndex(liveIndex);
  }, [followLive, liveIndex]);
  const safeIndex = holes.length ? Math.min(Math.max(0, index), holes.length - 1) : 0;
  const selected = holes[safeIndex] || null;
  const replayRoster = replay ? watchReplayPlayers(props.scorePlayers) : [];
  const [pinned, setPinned] = React.useState(replay && replayRoster[0] ? replayRoster[0].index : null);
  const [step, setStep] = React.useState(0);
  const [playing, setPlaying] = React.useState(replay);
  const [scoreFlight, setScoreFlight] = React.useState(0);
  const scoreSigRef = React.useRef("");
  const follow = selected
    ? watchFollowPlayer({
      followIndex: pinned,
      hole: selected.hole,
      players: props.scorePlayers,
    })
    : null;
  const followOptions = replay
    ? replayRoster
    : (selected ? watchFollowOptions({ hole: selected.hole, players: props.scorePlayers }) : []);
  const plan = replay ? watchReplayHole({ player: follow, hole: selected }) : null;
  const stepMax = watchReplayStepCount(plan);
  const safeStep = Math.max(0, Math.min(step, stepMax - 1));
  const followThrows = replay
    ? watchReplayVisibleThrows(plan, safeStep)
    : (follow && selected ? watchHoleThrows(follow, selected.hole) : []);
  const scoreSig = selected ? watchScoreSignature(follow, selected.hole) : "";
  React.useEffect(() => {
    scoreSigRef.current = "";
    setScoreFlight(0);
    setStep(0);
  }, [follow && follow.index, selected && selected.hole]);
  React.useEffect(() => {
    if (replay) return;
    const prev = scoreSigRef.current;
    scoreSigRef.current = scoreSig;
    if (!prev) return;
    const prevStrokes = prev.slice(prev.indexOf(":") + 1);
    const nextStrokes = scoreSig.slice(scoreSig.indexOf(":") + 1);
    if (nextStrokes && nextStrokes !== prevStrokes) setScoreFlight((value) => value + 1);
  }, [replay, scoreSig]);
  const scoreStep = replay && watchReplayIsScoreStep(plan, safeStep);
  React.useEffect(() => {
    if (!replay || !scoreStep) return;
    setScoreFlight((value) => value + 1);
  }, [replay, scoreStep, follow && follow.index, selected && selected.hole]);
  React.useEffect(() => {
    if (!replay || !playing || !plan) return;
    const id = setTimeout(() => {
      if (safeStep < stepMax - 1) {
        setStep(safeStep + 1);
        return;
      }
      if (safeIndex < holes.length - 1) {
        setFollowLive(false);
        setIndex(safeIndex + 1);
        setStep(0);
        return;
      }
      setPlaying(false);
    }, watchReplayDelayMs(plan, safeStep));
    return () => clearTimeout(id);
  }, [replay, playing, safeStep, stepMax, safeIndex, holes.length, plan && plan.hole, plan && plan.throwCount, plan && plan.strokes]);
  React.useEffect(() => {
    preloadRoundMaps(holes, {
      activeIndex: safeIndex,
      all: true,
      ahead: 2,
      size: HOLE_MAP_WATCH_SIZE,
    });
  }, [holes, safeIndex]);
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

  function goHole(nextIndex) {
    if (!holes.length) return;
    const bounded = Math.max(0, Math.min(nextIndex, holes.length - 1));
    setFollowLive(false);
    setIndex(bounded);
    setStep(0);
  }

  function goThrow(delta) {
    setPlaying(false);
    if (delta < 0 && safeStep <= 0) {
      if (safeIndex > 0) goHole(safeIndex - 1);
      return;
    }
    if (delta > 0 && safeStep >= stepMax - 1) {
      if (safeIndex < holes.length - 1) goHole(safeIndex + 1);
      return;
    }
    setStep(safeStep + delta);
  }

  return h("div", { className: "watch-holes", key: "holes" }, [
    replay
      ? h(WatchReplayBar, {
        caption: watchReplayCaption(plan, safeStep),
        key: "replay",
        playing,
        onPlay: () => setPlaying((value) => !value),
        onPrevHole: () => goHole(safeIndex - 1),
        onPrevThrow: () => goThrow(-1),
        onNextThrow: () => goThrow(1),
        onNextHole: () => goHole(safeIndex + 1),
      })
      : h("p", { className: "watch-hole-meta", key: "meta" }, bits.join(" · ")),
    h(HoleMap, {
      discColor: follow && follow.discColor,
      hole: selected,
      key: "map",
      large: true,
      layoutId: props.layoutId,
      players: mapPlayers,
      scoreFlight,
      throwGroups: replay
        ? [{ active: true, key: follow ? follow.index : "replay", throws: followThrows }]
        : followOptions.map((row) => ({
          active: Boolean(follow && follow.index === row.index),
          key: row.index,
          throws: row.throws,
        })),
      throws: followThrows,
      throwsKey: (follow ? follow.index : "none") + (replay ? ":replay" : ""),
      udiscCourseId: props.udiscCourseId,
      windFromDeg: props.windFromDeg,
    }),
    h(WatchFollowBar, {
      follow,
      key: "follow",
      options: followOptions,
      pinned,
      onPin: (value) => {
        setPinned(value);
        setStep(0);
      },
    }),
    h("div", { className: "card", key: "picker" }, [
      h("h2", { className: "section", key: "title" }, replay ? "Holes" : "Hole maps"),
      replay ? h("p", { className: "watch-hole-meta", key: "meta" }, bits.join(" · ")) : null,
      h("div", { className: "holegrid", key: "grid" }, holes.map((hole, holeIndex) =>
        h("button", {
          "aria-label": `Hole ${hole.hole}`,
          "aria-pressed": holeIndex === safeIndex,
          className: holeIndex === safeIndex ? "cur" : "",
          key: hole.hole,
          type: "button",
          onClick: () => {
            setFollowLive(!replay && holeIndex === liveIndex);
            setIndex(holeIndex);
            setStep(0);
            setPlaying(false);
          },
        }, String(hole.hole)),
      )),
    ]),
    props.isMatchplay ? h(WatchMatchCards, { cards: matchCards, key: "matches" }) : h(WatchStrokeStrip, { chips: strokeChips, key: "stroke" }),
    h(WatchTeeSign, { key: "sign", teeSign: selected.teeSign }),
  ]);
}

export function WatchView(props) {
  const standings = Array.isArray(props.standings) ? props.standings : [];
  return h("div", { className: "watch-view", "data-react-live-watch": props.status || "live" }, [
    h("div", { className: "watch-banner", key: "banner" }, [
      h("span", { className: "live-dot" + (props.status === "final" ? " is-final" : ""), key: "dot" }),
      h("span", { key: "label" }, props.status === "final" ? "Replay round" : "Watching live"),
      h("span", { className: "lb-conn", key: "connection" }, props.connection || "Live"),
    ]),
    props.courseName || props.layoutName
      ? h("p", { className: "muted watch-meta", key: "meta" }, [props.courseName, props.layoutName].filter(Boolean).join(" · "))
      : null,
    h(WatchHoles, {
      activeHoleIndex: props.activeHoleIndex,
      holes: props.holes,
      isMatchplay: props.isMatchplay,
      key: "holes",
      players: props.playerLocations,
      scorePlayers: props.players,
      scoreTargets: props.scoreTargets,
      standings,
      status: props.status,
      udiscCourseId: props.udiscCourseId,
      windFromDeg: props.windFromDeg,
    }),
    props.showPots ? h(PotsStrip, { key: "pots", pots: props.pots }) : null,
    h("div", { className: "card", key: "board" }, [
      h("h2", { className: "section", key: "title" }, [icon(Trophy), props.status === "final" ? " Final leaderboard" : " Live leaderboard"]),
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
      props.status === "final"
        ? null
        : (props.keepScoreHref
          ? h("a", { className: "btn", href: props.keepScoreHref, key: "score" }, "Keep score")
          : null),
    ].filter(Boolean)),
    props.showWeather ? h(WeatherStrip, { key: "weather", title: "Round weather", weather: props.weather }) : null,
  ]);
}
