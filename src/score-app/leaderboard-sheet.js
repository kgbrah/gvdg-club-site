import React from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { displayMatchStatus } from "../shared/match-status.js";
import { UDiscExportDetails } from "../shared/udisc-export.js";
import { useAccessibleDialog } from "../shared/a11y.js";
import { strokeLabel } from "./score-view-model.js";

const h = React.createElement;

function standingName(standing) {
  const team = standing.scoringGroup && standing.scoringGroup.label && standing.scoringGroup.label !== standing.name
    ? String(standing.scoringGroup.label)
    : "";
  const extra = standing.members && standing.members.length && standing.targetType === "pair"
    ? standing.members.join(" / ")
    : (team || standing.division || "");
  return standing.name + (extra ? " · " + extra : "");
}

function standingKey(standing, index) {
  return String(standing.targetId || standing.name || index);
}

function StandingScorecard({ onHole, scorecard, standing }) {
  const holes = Array.isArray(scorecard) ? scorecard : [];
  if (!holes.length) return h("p", { className: "muted lb-card-empty" }, "No holes on this card yet.");
  return h("div", { className: "lb-scorecard" }, holes.map((hole) => {
    const scored = typeof hole.strokes === "number";
    const rel = scored ? strokeLabel(hole.strokes, hole.par) : null;
    const tone = rel ? rel.className : "";
    const body = [
      h("span", { className: "lb-hole-num", key: "n" }, String(hole.hole)),
      h("b", { className: "lb-hole-score", key: "s" }, scored ? String(hole.strokes) : "·"),
      rel ? h("span", { className: "lb-hole-rel", key: "r" }, rel.text) : null,
    ];
    if (typeof onHole !== "function") {
      return h("div", { className: "lb-hole" + (tone ? " " + tone : ""), key: hole.hole }, body);
    }
    return h("button", {
      "aria-label": "Hole " + hole.hole,
      className: "lb-hole" + (tone ? " " + tone : ""),
      key: hole.hole,
      type: "button",
      onClick: () => onHole(hole.hole, standing),
    }, body);
  }));
}

export function LeaderboardTable({ isDoubles, isMatchplay, onHole, relClass, relText, standings, startExpanded }) {
  const [toggled, setToggled] = React.useState(() => new Set());
  function isOpen(id, hasCard) {
    if (!hasCard) return false;
    const touched = toggled.has(id);
    return startExpanded ? !touched : touched;
  }
  function toggle(id) {
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  if (!standings.length) return h("p", { className: "muted" }, "No scores in yet.");
  const resultHead = isMatchplay ? "Match" : "To par";
  return h("table", { className: "lb" }, [
    h("thead", { key: "head" }, h("tr", null, [
      h("th", { key: "rank" }, ""),
      h("th", { key: "name" }, isDoubles ? "Pair" : "Player"),
      h("th", { key: "thru" }, "Thru"),
      h("th", { key: "result" }, resultHead),
    ])),
    h("tbody", { key: "body" }, standings.map((standing, index) => {
      const id = standingKey(standing, index);
      const hasCard = Array.isArray(standing.scorecard) && standing.scorecard.length > 0;
      const open = isOpen(id, hasCard);
      return h(React.Fragment, { key: id }, [
        h("tr", { key: "row" }, [
          h("td", { className: "pos", key: "pos" }, String(index + 1)),
          h("td", { className: "name", key: "name" }, hasCard
            ? h("button", {
              "aria-expanded": open ? "true" : "false",
              "aria-controls": "lb-card-" + id,
              className: "lb-name-btn",
              type: "button",
              onClick: () => toggle(id),
            }, standingName(standing))
            : standingName(standing)),
          h("td", { key: "thru" }, String(standing.thru || 0)),
          isMatchplay
            ? h("td", { key: "match" }, displayMatchStatus(standing.match))
            : h("td", { className: "tp " + relClass(standing.toPar || 0), key: "toPar" }, standing.thru ? relText(standing.toPar || 0) : "E"),
        ]),
        open ? h("tr", { className: "lb-card-row", key: "card" }, h("td", { colSpan: 4, id: "lb-card-" + id }, h(StandingScorecard, { onHole, scorecard: standing.scorecard, standing }))) : null,
      ]);
    })),
  ]);
}

function FinalizePanel({ blockers, cardLocked, mode, onFinalize, onShare, status }) {
  if (status === "final" || cardLocked) {
    return h("div", { className: "finalize-card ready" }, [
      h("p", { className: "finalize-head", key: "head" }, status === "final" ? "Round finished - scores are locked." : "Card submitted — scores locked"),
      typeof onShare === "function"
        ? h("button", { className: "btn finish-round-btn", key: "share", type: "button", onClick: onShare }, "Share card")
        : null,
    ]);
  }
  if (!blockers.ready || (mode !== "round" && mode !== "event")) return null;
  return h("div", { className: "finalize-card ready" }, [
    h("p", { className: "finalize-head", key: "head" }, "All holes scored — finish this card"),
    h("p", { className: "muted finish-round-hint", key: "hint" }, "Anyone on this card can confirm. Matching scores on each hole are enough."),
    h("button", { className: "btn finish-round-btn", key: "finish", type: "button", onClick: onFinalize }, "Finish card"),
  ]);
}

function LeaderboardSheet(props) {
  const dialog = useAccessibleDialog({
    open: true,
    onClose: props.onClose,
    labelledBy: "score-leaderboard-title",
    label: "Live leaderboard",
  });
  return createPortal(
    h(
      "div",
      {
        className: "overlay",
        "data-a11y-overlay": "true",
        role: "presentation",
        ref: dialog.overlayRef,
      },
      h("div", {
        className: "sheet",
        role: "dialog",
        "aria-modal": dialog.isolated ? "true" : undefined,
        "aria-labelledby": "score-leaderboard-title",
        "aria-label": "Live leaderboard",
        tabIndex: -1,
        ref: dialog.panelRef,
      }, [
        h("div", { className: "grab", key: "grab" }),
        h("h2", { className: "section", id: "score-leaderboard-title", key: "title" }, "Live Leaderboard"),
        h(LeaderboardTable, {
          isDoubles: props.isDoubles,
          isMatchplay: props.isMatchplay,
          key: "table",
          onHole: props.onHole,
          relClass: props.relClass,
          relText: props.relText,
          standings: props.standings,
        }),
        props.exportData ? h("div", { className: "udisc-export-section", key: "udisc" },
          h(UDiscExportDetails, { courseId: props.exportData.courseId, scorecard: props.exportData.scorecard }),
        ) : null,
        h(FinalizePanel, {
          blockers: props.blockers,
          cardLocked: props.cardLocked,
          key: "finalize",
          mode: props.mode,
          onFinalize: props.onFinalize,
          onShare: props.onShare,
          status: props.status,
        }),
        h("button", { className: "btn secondary sheet-close", key: "close", type: "button", onClick: props.onClose }, "Close"),
      ]),
    ),
    document.body,
  );
}

export function createLeaderboardSheetRenderer() {
  let host = null;
  let root = null;

  function close() {
    if (root) root.render(null);
  }

  function render(props) {
    if (!host) {
      host = document.getElementById("scoreReactLeaderboardSheetApp");
      if (!host) throw new Error("Missing scoreReactLeaderboardSheetApp mount element");
    }
    if (!root) root = createRoot(host);
    root.render(h(LeaderboardSheet, props));
  }

  return { close, render };
}
