import React from "react";
import { nextHoleScore, nextPuttingScore } from "./score-view-model.js";

const h = React.createElement;

function step(putting, current, par, direction) {
  return putting ? nextPuttingScore(current, par, direction) : nextHoleScore(current, par, direction);
}

function WristRow(props) {
  const row = props.row;
  const current = row.currentScore;
  const par = props.hole && props.hole.par;
  const nextMinus = step(props.putting, current, par, "minus");
  const nextPlus = step(props.putting, current, par, "plus");
  const rel = row.relative;
  return h("div", { className: "wrist-player", key: row.key }, [
    h("div", { className: "wrist-player-name", key: "name" }, row.label),
    h("div", { className: "wrist-step", key: "step" }, [
      h("button", {
        "aria-label": nextMinus == null ? "Clear " + row.label : "Lower " + row.label,
        className: "wrist-minus",
        disabled: Boolean(props.locked),
        key: "minus",
        type: "button",
        onClick: () => props.onScore(row.source, props.hole.hole, nextMinus),
      }, "−"),
      h("button", {
        "aria-label": "Enter score for " + row.label,
        className: "wrist-val",
        disabled: Boolean(props.locked),
        key: "val",
        type: "button",
        onClick: () => props.onOpenPad(row),
      }, [
        h("b", { key: "n" }, current == null ? "–" : String(current)),
        rel ? h("span", { className: "rel " + rel.className, key: "rel" }, rel.text) : null,
      ]),
      h("button", {
        "aria-label": "Raise " + row.label,
        className: "wrist-plus",
        disabled: Boolean(props.locked),
        key: "plus",
        type: "button",
        onClick: () => props.onScore(row.source, props.hole.hole, nextPlus),
      }, "+"),
    ]),
  ]);
}

export function WristScore(props) {
  const hud = props.hud;
  const live = Boolean(hud && hud.mode === "remaining" && Number.isFinite(hud.ft));
  const circle = live && hud.circle ? " " + (hud.circle === "C1" ? "in-c1" : hud.circle === "C2" ? "in-c2" : "") : "";
  const feet = live ? hud.ft : (props.hole && props.hole.distance_ft ? props.hole.distance_ft : null);
  const caption = live ? (hud.circle ? "in " + hud.circle : "to basket") : feet != null ? "ft hole" : "GPS off";
  const rows = Array.isArray(props.rows) ? props.rows : [];
  return h("div", { className: "wrist-score", "data-wrist-score": "ready" }, [
    h("div", { className: "wrist-top", key: "top" }, [
      h("div", { key: "hole" }, [
        h("p", { className: "wrist-kicker", key: "k" }, props.courseName || "Wrist score"),
        h("h2", { key: "h" }, "Hole " + (props.hole && props.hole.hole ? props.hole.hole : "")),
        h("p", { className: "wrist-meta", key: "m" }, props.holeMeta || ""),
      ]),
      h("button", { className: "wrist-exit", key: "exit", type: "button", onClick: props.onExit }, "Phone"),
    ]),
    h("button", {
      className: "wrist-range" + circle + (live ? "" : " wrist-range-hole"),
      key: "range",
      type: "button",
      onClick: live ? props.onToggleLock : props.onEnableGps,
    }, [
      h("strong", { key: "ft" }, feet == null ? "—" : String(feet)),
      h("span", { key: "cap" }, caption),
      h("em", { key: "lock" }, live ? (props.rangeLockOn ? "Distance alerts on" : "Send distance alerts") : "Tap for GPS"),
    ]),
    h("div", { className: "wrist-players players-" + Math.min(Math.max(rows.length, 1), 4), key: "players" },
      rows.map((row) => h(WristRow, {
        hole: props.hole,
        key: row.key,
        locked: props.locked,
        putting: props.putting,
        row,
        onOpenPad: props.onOpenPad,
        onScore: props.onScore,
      })),
    ),
    h("div", { className: "wrist-nav", key: "nav" }, [
      h("button", {
        className: "wrist-nav-btn",
        disabled: props.atStart,
        key: "prev",
        type: "button",
        onClick: props.onPrevious,
      }, "Prev"),
      h("button", {
        className: "wrist-nav-btn wrist-nav-next",
        disabled: props.atEnd,
        key: "next",
        type: "button",
        onClick: props.onNext,
      }, "Next"),
    ]),
  ]);
}
