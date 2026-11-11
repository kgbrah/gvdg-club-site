import React from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { displayMatchStatus } from "../shared/match-status.js";
import { UDiscExportDetails } from "../shared/udisc-export.js";
import { useAccessibleDialog } from "../shared/a11y.js";
import { relText as formatStart, puttingScorecardMakes, strokeLabel } from "./score-view-model.js";
import { clipsForStanding, HighlightClipList } from "./throw-film.js";

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

function handicapOn(standings) {
  return standings.some((standing) => standing && standing.handicapStart != null);
}

function startLine(standing) {
  if (standing.handicapStart == null) return null;
  return h("span", { className: "lb-start", key: "start" },
    "Start " + formatStart(standing.handicapStart) + (standing.provisional ? " · provisional" : ""));
}

function resultCell(standing, isMatchplay, isPutting, handicapped, relClass, relText) {
  if (isMatchplay) return h("td", { key: "match" }, displayMatchStatus(standing.match));
  if (isPutting) {
    const makes = puttingScorecardMakes(standing.scorecard);
    return [
      h("td", { key: "makes" }, standing.thru && makes != null ? String(makes) : "-"),
      h("td", { key: "points" }, standing.thru ? String(standing.total) : "-"),
    ];
  }
  if (!handicapped) {
    return h("td", { className: "tp " + relClass(standing.toPar || 0), key: "toPar" }, standing.thru ? relText(standing.toPar || 0) : "E");
  }
  if (standing.handicapStart == null) {
    return h("td", { className: "tp " + relClass(standing.toPar || 0), key: "toPar" }, [
      h("b", { key: "gross" }, standing.thru ? relText(standing.toPar || 0) : "E"),
      h("span", { className: "lb-rnd", key: "note" }, "No start"),
    ]);
  }
  const net = Number(standing.net) || 0;
  return h("td", { className: "tp " + relClass(net), key: "toPar" }, [
    h("b", { key: "net" }, relText(net)),
    h("span", { className: "lb-rnd", key: "rnd" }, "Rnd " + (standing.thru ? relText(standing.toPar || 0) : "E")),
  ]);
}

function StandingScorecard({ holes, isPutting, onHole, scorecard, standing }) {
  const card = Array.isArray(scorecard) ? scorecard : [];
  const layout = Array.isArray(holes) ? holes : [];
  if (!card.length) return h("p", { className: "muted lb-card-empty" }, "No holes on this card yet.");
  return h("div", { className: "lb-scorecard" }, card.map((hole) => {
    const scored = typeof hole.strokes === "number";
    const rel = !isPutting && scored ? strokeLabel(hole.strokes, hole.par) : null;
    const tone = rel ? rel.className : "";
    const layoutHole = layout.find((row) => row && Number(row.hole) === Number(hole.hole));
    const distance = Number(hole.distance_ft != null ? hole.distance_ft : layoutHole && (layoutHole.distance_ft != null ? layoutHole.distance_ft : layoutHole.distanceFt));
    const station = Number.isFinite(distance) && distance > 0 ? String(distance) : String(hole.hole);
    const attempts = Number(hole.par);
    const scoreText = !scored
      ? "·"
      : (isPutting && Number.isFinite(attempts) && attempts > 0 ? hole.strokes + "/" + attempts : String(hole.strokes));
    const body = [
      h("span", { className: "lb-hole-num", key: "n" }, isPutting ? station : String(hole.hole)),
      h("b", { className: "lb-hole-score", key: "s" }, scoreText),
      rel ? h("span", { className: "lb-hole-rel", key: "r" }, rel.text) : null,
    ];
    if (typeof onHole !== "function") {
      return h("div", { className: "lb-hole" + (tone ? " " + tone : ""), key: hole.hole }, body);
    }
    return h("button", {
      "aria-label": isPutting ? (station === String(hole.hole) ? "Station " + hole.hole : station + " ft") : "Hole " + hole.hole,
      className: "lb-hole" + (tone ? " " + tone : ""),
      key: hole.hole,
      type: "button",
      onClick: () => onHole(hole.hole, standing),
    }, body);
  }));
}

export function LeaderboardTable({ clipApi, clipHoles, clips, isDoubles, isMatchplay, isPutting, onHole, relClass, relText, standings, startExpanded }) {
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
  const handicapped = !isMatchplay && handicapOn(standings);
  const resultHead = isMatchplay ? "Match" : isPutting ? "Points" : handicapped ? "Net" : "To par";
  const columns = [
    h("th", { key: "rank" }, ""),
    h("th", { key: "name" }, isDoubles ? "Pair" : "Player"),
    h("th", { key: "thru" }, "Thru"),
  ];
  if (isPutting) {
    columns.push(h("th", { key: "makes" }, "Makes"));
    columns.push(h("th", { key: "points" }, "Points"));
  } else {
    columns.push(h("th", { key: "result" }, resultHead));
  }
  return h("div", { className: "lb-wrap" }, [
    handicapped
      ? h("p", { className: "muted lb-handicap-note", key: "note" }, "Club handicap. Net is your start plus this round.")
      : null,
    h("table", { className: "lb", key: "table" }, [
    h("thead", { key: "head" }, h("tr", null, columns)),
    h("tbody", { key: "body" }, standings.map((standing, index) => {
      const id = standingKey(standing, index);
      const hasCard = Array.isArray(standing.scorecard) && standing.scorecard.length > 0;
      const playerClips = clipsForStanding(clips, standing);
      const open = isOpen(id, hasCard || playerClips.length > 0);
      const label = hasCard || playerClips.length
        ? h("button", {
          "aria-expanded": open ? "true" : "false",
          "aria-controls": "lb-card-" + id,
          className: "lb-name-btn",
          key: "label",
          type: "button",
          onClick: () => toggle(id),
        }, [
          standingName(standing),
          playerClips.length
            ? h("span", { className: "lb-clip-count", key: "clips" }, playerClips.length === 1 ? "1 clip" : playerClips.length + " clips")
            : null,
        ])
        : h("span", { className: "lb-name-text", key: "label" }, standingName(standing));
      return h(React.Fragment, { key: id }, [
        h("tr", { key: "row" }, [
          h("td", { className: "pos", key: "pos" }, String(index + 1)),
          h("td", { className: "name", key: "name" }, [label, startLine(standing)]),
          h("td", { key: "thru" }, String(standing.thru || 0)),
          resultCell(standing, isMatchplay, isPutting, handicapped, relClass, relText),
        ]),
        open ? h("tr", { className: "lb-card-row", key: "card" }, h("td", { colSpan: isPutting ? 5 : 4, id: "lb-card-" + id }, [
          hasCard ? h(StandingScorecard, { holes: clipHoles, isPutting, key: "card", onHole, scorecard: standing.scorecard, standing }) : null,
          h(HighlightClipList, { api: clipApi, clips: playerClips, holes: clipHoles, key: "clips", putting: isPutting }),
        ])) : null,
      ]);
    })),
    ]),
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
          isPutting: props.isPutting,
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
