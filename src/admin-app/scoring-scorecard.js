import React from "react";

import { conflictForRow, conflictTitle, isDoubles, isMatchplay, rowTotal, scoreForRow, scoreRows, toPar } from "./scoring-model.js";
import { displayMatchStatus } from "../shared/match-status.js";

const h = React.createElement;

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function ScoreInput({ hole, row, score }) {
  const [value, setValue] = React.useState(score == null ? "" : String(score));
  const focused = React.useRef(false);

  React.useEffect(() => {
    if (!focused.current) setValue(score == null ? "" : String(score));
  }, [score]);

  function commit() {
    if (!value.trim()) return;
    dispatchRequest("gvdg:admin-scoring-score-request", { hole, row, value });
  }

  return h("input", {
    className: "sc-score-input",
    max: "30",
    min: "1",
    onBlur: () => {
      focused.current = false;
      commit();
    },
    onChange: (event) => setValue(event.target.value),
    onFocus: () => { focused.current = true; },
    onKeyDown: (event) => {
      if (event.key === "Enter") {
        event.currentTarget.blur();
      }
    },
    type: "number",
    value,
  });
}

export function AdminScoringScorecard({ snapshot }) {
  const snap = snapshot || {};
  const holes = Array.isArray(snap.holes) ? snap.holes : [];
  const rows = scoreRows(snap);
  const rowHead = [isDoubles(snap) ? "Pair" : "Player", isDoubles(snap) ? "Members" : "Div", "Start"];
  const [holeIndex, setHoleIndex] = React.useState(0);

  React.useEffect(() => {
    setHoleIndex((current) => {
      if (!holes.length) return 0;
      return Math.min(current, holes.length - 1);
    });
  }, [holes.length]);

  const table = h("div", { className: "sc-scorecard-desktop", key: "desktop", style: { overflowX: "auto" } }, h("table", {
    className: "al-holes",
    "data-react-admin-scoring-grid": "ready",
    id: "scGrid",
  }, [
    h("thead", { key: "head" }, h("tr", null, [
      ...rowHead.map((label) => h("th", { key: label }, label)),
      ...holes.map((hole) => h("th", { className: hole.overridden ? "th-temp" : undefined, key: hole.hole }, `H${hole.hole} (${hole.par})${hole.overridden ? " temp" : ""}`)),
      h("th", { key: "total" }, "Tot"),
    ])),
    h("tbody", { key: "body" }, rows.map((row) => {
      const key = row.targetId || `player:${row.index}`;
      return h("tr", { "data-row-key": key, key }, [
        h("td", { className: "lb-name", key: "name" }, row.label),
        h("td", { key: "meta" }, row.meta || "N/A"),
        h("td", { key: "start" }, row.start || "N/A"),
        ...holes.map((hole) => {
          const conflict = conflictForRow(snap, row, hole.hole);
          return h("td", { className: conflict ? "sc-conflict" : undefined, key: hole.hole }, [
            h(ScoreInput, { hole: hole.hole, key: "score", row, score: scoreForRow(snap, row, hole.hole) }),
            conflict ? h("span", {
              "aria-label": conflictTitle(conflict),
              className: "sc-conflict-flag",
              key: "conflict",
              title: conflictTitle(conflict),
            }, "!") : null,
          ]);
        }),
        h("td", { key: "total" }, rowTotal(snap, row) || "N/A"),
      ]);
    })),
  ]));

  const hole = holes[holeIndex];
  const pager = hole ? h("div", {
    className: "sc-hole-pager",
    "data-admin-hole-pager": "ready",
    key: "pager",
  }, [
    h("div", { className: "sc-hole-pager-nav", key: "nav" }, [
      h("button", {
        "aria-label": "Previous hole",
        className: "admin-btn secondary sc-hole-pager-btn",
        disabled: holeIndex === 0,
        key: "prev",
        onClick: () => setHoleIndex((current) => Math.max(0, current - 1)),
        type: "button",
      }, "Prev"),
      h("div", { "aria-live": "polite", className: "sc-hole-pager-label", key: "label" }, [
        h("strong", { key: "hole" }, `Hole ${hole.hole}`),
        h("span", { key: "meta" }, `Par ${hole.par}${hole.overridden ? " · temp" : ""} · ${holeIndex + 1} of ${holes.length}`),
      ]),
      h("button", {
        "aria-label": "Next hole",
        className: "admin-btn secondary sc-hole-pager-btn",
        disabled: holeIndex >= holes.length - 1,
        key: "next",
        onClick: () => setHoleIndex((current) => Math.min(holes.length - 1, current + 1)),
        type: "button",
      }, "Next"),
    ]),
    h("div", { className: "sc-hole-pager-list", key: "list" }, rows.map((row) => {
      const key = row.targetId || `player:${row.index}`;
      const conflict = conflictForRow(snap, row, hole.hole);
      const total = rowTotal(snap, row);
      const meta = [row.meta, total ? `Tot ${total}` : null].filter(Boolean).join(" · ");
      return h("div", {
        className: conflict ? "sc-hole-pager-row sc-conflict" : "sc-hole-pager-row",
        "data-row-key": key,
        key,
      }, [
        h("div", { className: "sc-hole-pager-who", key: "who" }, [
          h("span", { className: "lb-name", key: "name" }, row.label),
          meta ? h("span", { className: "sc-hole-pager-meta", key: "meta" }, meta) : null,
        ]),
        h(ScoreInput, { hole: hole.hole, key: "score", row, score: scoreForRow(snap, row, hole.hole) }),
        conflict ? h("span", {
          "aria-label": conflictTitle(conflict),
          className: "sc-conflict-flag",
          key: "flag",
          title: conflictTitle(conflict),
        }, "!") : null,
      ]);
    })),
  ]) : null;

  return h(React.Fragment, null, [table, pager]);
}

export function AdminScoringLeaderboard({ snapshot }) {
  const snap = snapshot || {};
  const standings = Array.isArray(snap.standings) ? snap.standings : [];
  const errors = Array.isArray(snap.scoreTargetErrors) ? snap.scoreTargetErrors : [];
  const finalHead = isMatchplay(snap) ? "Match" : "To Par";

  return h("div", { className: "al-note", "data-react-admin-scoring-board": standings.length ? "ready" : "empty", id: "scBoard" }, [
    errors.length ? h("div", {
      className: "al-note",
      key: "errors",
      style: { color: "var(--over)", fontWeight: "600", marginBottom: ".5rem" },
    }, `Attention: ${errors.map((error) => error?.message || "A card has an invalid pair").join(" - ")} - the pair can rejoin or the team can withdraw; otherwise admin-force finalize to close the round.`) : null,
    standings.length ? h("div", { key: "table", style: { overflowX: "auto" } }, h("table", { className: "al-holes" }, [
      h("thead", { key: "head" }, h("tr", null, ["Pos", isDoubles(snap) ? "Pair" : "Player", "Thru", "Total", finalHead].map((label) => h("th", { key: label }, label)))),
      h("tbody", { key: "body" }, standings.map((standing, index) => h("tr", { key: standing.name || index }, [
        h("td", { key: "pos" }, String(index + 1)),
        h("td", { className: "lb-name", key: "name" }, `${standing.name || "Player"}${standing.scoringGroup && standing.scoringGroup.label && standing.scoringGroup.label !== standing.name ? ` · ${standing.scoringGroup.label}` : ""}${Array.isArray(standing.members) && standing.members.length && standing.targetType === "pair" ? ` - ${standing.members.join(" / ")}` : ""}`),
        h("td", { key: "thru" }, standing.thru ? String(standing.thru) : "N/A"),
        h("td", { key: "total" }, standing.thru ? String(standing.total) : "N/A"),
        h("td", { key: "final" }, isMatchplay(snap) ? displayMatchStatus(standing.match) : standing.thru ? toPar(standing.toPar) : "N/A"),
      ]))),
    ])) : h("div", { key: "empty", role: "status" }, "No scores yet."),
  ]);
}

export function AdminScoringOverride({ canOverride, snapshot }) {
  const holes = Array.isArray(snapshot?.holes) ? snapshot.holes : [];
  const [hole, setHole] = React.useState("");
  const [par, setPar] = React.useState("");
  const [distance, setDistance] = React.useState("");

  React.useEffect(() => {
    if (!holes.some((candidate) => String(candidate.hole) === String(hole))) {
      setHole(holes[0]?.hole == null ? "" : String(holes[0].hole));
    }
  }, [holes, hole]);

  function request(clear) {
    dispatchRequest("gvdg:admin-scoring-override-request", {
      clear,
      distance,
      hole,
      par,
    });
    if (clear) {
      setPar("");
      setDistance("");
    }
  }

  if (!canOverride) return null;

  return h(React.Fragment, null, [
    h("div", { className: "al-row", id: "scOverride", key: "controls", style: { alignItems: "flex-end", flexWrap: "wrap", marginTop: "0.75rem" } }, [
      h("div", { key: "hole" }, [
        h("label", { htmlFor: "scOvHole", key: "label" }, "Temporary hole override"),
        h("select", { id: "scOvHole", key: "select", onChange: (event) => setHole(event.target.value), value: hole }, holes.map((candidate) => (
          h("option", { key: candidate.hole, value: String(candidate.hole) }, `Hole ${candidate.hole}${candidate.overridden ? " temp" : ""}`)
        ))),
      ]),
      h("div", { key: "par" }, [
        h("label", { htmlFor: "scOvPar", key: "label" }, "Par"),
        h("input", { id: "scOvPar", key: "input", max: "15", min: "1", onChange: (event) => setPar(event.target.value), placeholder: "-", style: { width: "4rem" }, type: "number", value: par }),
      ]),
      h("div", { key: "dist" }, [
        h("label", { htmlFor: "scOvDist", key: "label" }, "Distance ft"),
        h("input", { id: "scOvDist", key: "input", max: "2000", min: "20", onChange: (event) => setDistance(event.target.value), placeholder: "-", style: { width: "6rem" }, type: "number", value: distance }),
      ]),
      h("button", { className: "admin-btn", id: "scOvApply", key: "apply", onClick: () => request(false), type: "button" }, "Apply"),
      h("button", { className: "admin-btn secondary", id: "scOvClear", key: "clear", onClick: () => request(true), type: "button" }, "Clear"),
    ]),
    h("p", { className: "al-note", key: "note" }, "A temporary override changes par/distance for this live round only. The course layout stays verified and the hole reverts after the round."),
  ]);
}
