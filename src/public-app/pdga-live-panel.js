import React from "react";

import { PdgaCredit, PdgaLink } from "../shared/pdga-credit.js";
import { publicApiBase } from "./public-api.js";

const h = React.createElement;

const STAT_COLUMNS = [
  { key: "fwh", label: "FWH" },
  { key: "c1r", label: "C1R" },
  { key: "c2r", label: "C2R" },
  { key: "pkd", label: "PKD" },
  { key: "scr", label: "SCR" },
  { key: "c1x", label: "C1X" },
  { key: "c2p", label: "C2P" },
];

function fmtToPar(value) {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  const n = Number(value);
  return n === 0 ? "E" : n > 0 ? `+${n}` : String(n);
}

export function pdgaLivePositionText(row) {
  if (!row) return "-";
  if (row.dnf) return "DNF";
  if (row.runningPlace == null) return "-";
  return row.tied ? `T${row.runningPlace}` : String(row.runningPlace);
}

export function pdgaLiveStatPctText(stat) {
  if (!stat || !Number(stat.opp)) return "-";
  return `${Math.round(Number(stat.value) || 0)}%`;
}

export function pdgaLiveObText(stats) {
  if (!stats) return "-";
  if (stats.obCount && Number(stats.obCount.opp) > 0) {
    return String(stats.obCount.hit ?? Math.round(Number(stats.obCount.value) || 0));
  }
  if (stats.obRate && Number(stats.obRate.opp) > 0) {
    if (stats.obRate.hit != null) return String(stats.obRate.hit);
    return `${Math.round((Number(stats.obRate.value) || 0) * 10) / 10}%`;
  }
  return "-";
}

export function hasPdgaLiveDetailedStats(blocks) {
  return (Array.isArray(blocks) ? blocks : []).some((block) =>
    (Array.isArray(block?.scores) ? block.scores : []).some((row) => Boolean(row?.stats)),
  );
}

function roundLabel(event, roundNum) {
  const num = Number(roundNum);
  const meta = (Array.isArray(event?.roundsList) ? event.roundsList : []).find((r) => Number(r.number) === num);
  if (meta?.labelAbbreviated) return meta.labelAbbreviated;
  if (meta?.label) return meta.label;
  if (num === 11) return "Semis";
  if (num === 12) return "Finals";
  if (num === 13) return "Playoff";
  return `Rd ${roundNum}`;
}

export function PdgaLivePanel({ apiBase, pdgaEventId }) {
  const id = Number(pdgaEventId);
  const base = String(apiBase || publicApiBase() || "").replace(/\/+$/, "");
  const [selection, setSelection] = React.useState({ eventId: id, division: "", round: "" });
  const [showStats, setShowStats] = React.useState(false);
  const [payload, setPayload] = React.useState(null);

  React.useEffect(() => {
    setSelection({ eventId: id, division: "", round: "" });
    setShowStats(false);
    setPayload(null);
  }, [id]);

  const activeDivisionParam = selection.eventId === id ? selection.division : "";
  const activeRoundParam = selection.eventId === id ? selection.round : "";

  React.useEffect(() => {
    if (!Number.isInteger(id) || id <= 0 || !base) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (activeDivisionParam) params.set("division", activeDivisionParam);
    if (activeRoundParam) params.set("round", activeRoundParam);
    const qs = params.toString();
    const url = `${base}/pdga/live/event/${encodeURIComponent(String(id))}${qs ? `?${qs}` : ""}`;
    void fetch(url, { cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (controller.signal.aborted) return;
        const switched = Boolean(activeDivisionParam || activeRoundParam);
        const hasScores = Boolean(data && Array.isArray(data.blocks) && data.blocks.some((b) => Array.isArray(b.scores) && b.scores.length));
        if (hasScores || (switched && data && Array.isArray(data.blocks))) {
          setPayload(data);
        } else if (!switched) {
          setPayload(null);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [base, id, activeDivisionParam, activeRoundParam]);

  if (!payload) return null;

  const event = payload.event || {};
  const divisions = (Array.isArray(event.divisions) ? event.divisions : []).filter((d) => Number(d.players) > 0);
  const rounds = Array.isArray(event.roundsList) ? event.roundsList : [];
  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  const hasAnyScores = blocks.some((block) => Array.isArray(block.scores) && block.scores.length > 0);
  const hasStats = hasPdgaLiveDetailedStats(blocks);
  const activeDiv = payload.division || "";
  const activeRound = String(payload.round || "");
  const statsMode = showStats && hasStats;

  return h("section", { className: "pdga-live-panel", "data-pdga-live-panel": "ready" }, [
    h("h3", { className: "roster-title", key: "title" }, "PDGA Live results"),
    (divisions.length > 1 || rounds.length > 1 || hasStats)
      ? h("div", { className: "detail-actions pdga-live-controls", key: "controls" }, [
        ...divisions.map((div) => h("button", {
          type: "button",
          className: "event-action-btn",
          "aria-pressed": div.division === activeDiv ? "true" : "false",
          key: `div-${div.division}`,
          onClick: () => setSelection({ eventId: id, division: div.division, round: "" }),
        }, div.division)),
        ...rounds.map((r) => {
          const val = String(r.number);
          return h("button", {
            type: "button",
            className: "event-action-btn",
            "aria-pressed": val === activeRound ? "true" : "false",
            key: `rd-${val}`,
            onClick: () => setSelection({ eventId: id, division: activeDivisionParam || activeDiv, round: val }),
          }, roundLabel(event, val));
        }),
        hasStats ? h("button", {
          type: "button",
          className: "event-action-btn",
          "aria-pressed": statsMode ? "true" : "false",
          key: "stats-toggle",
          onClick: () => setShowStats((current) => !current),
        }, statsMode ? "Scores" : "Live stats") : null,
      ])
      : null,
    !hasAnyScores ? h("p", { className: "lb-empty", key: "empty" }, "No scores posted for this round yet.") : null,
    ...blocks.map((block, blockIndex) => {
      const scores = Array.isArray(block.scores) ? block.scores : [];
      if (!scores.length) return null;
      const columns = statsMode
        ? ["Pos", "Player", ...STAT_COLUMNS.map((c) => c.label), "OB"]
        : ["Pos", "Player", "Thru", "Round", "To Par", "Rating"];
      return h("div", { key: `${block.division || "div"}-${block.pool || blockIndex}` }, [
        blocks.length > 1 && block.pool ? h("h4", { className: "division-name", key: "pool" }, `Pool ${block.pool}`) : null,
        h("div", { className: "lb-wrap", key: "wrap" }, h("table", { className: "lb-table" }, [
          h("thead", { key: "head" }, h("tr", null, columns.map((label) => h("th", { key: label }, label)))),
          h("tbody", { key: "body" }, scores.map((row, index) => {
            const toPar = Number(row.toPar);
            const thru = row.dnf ? "DNF" : row.completed ? "F" : row.played ? String(row.played) : "-";
            const baseCells = [
              h("td", { className: "lb-pos", key: "pos" }, pdgaLivePositionText(row)),
              h("td", { className: "lb-name", key: "name" }, h(PdgaLink, { href: row.profileUrl || "" }, row.name || row.shortName || "Player")),
            ];
            if (statsMode) {
              return h("tr", { key: row.resultId || index }, baseCells.concat([
                ...STAT_COLUMNS.map((col) => h("td", { key: col.key }, pdgaLiveStatPctText(row.stats?.[col.key]))),
                h("td", { key: "ob" }, pdgaLiveObText(row.stats)),
              ]));
            }
            return h("tr", { key: row.resultId || index }, baseCells.concat([
              h("td", { key: "thru" }, thru),
              h("td", { key: "round" }, row.roundScore != null ? String(row.roundScore) : "-"),
              h("td", { className: `lb-topar${toPar < 0 ? " under" : toPar > 0 ? " over" : ""}`, key: "topar" }, fmtToPar(row.toPar)),
              h("td", { key: "rating" }, row.roundRating != null ? String(row.roundRating) : "-"),
            ]));
          })),
        ])),
      ]);
    }),
    h("div", { className: "pdga-live-foot", key: "foot" }, [
      payload.pdgaLiveUrl ? h("p", { className: "detail-notes", key: "live-link" },
        h(PdgaLink, { href: payload.pdgaLiveUrl }, "Full leaderboard & stats on PDGA Live")) : null,
      h(PdgaCredit, { key: "credit" }),
    ]),
  ]);
}
