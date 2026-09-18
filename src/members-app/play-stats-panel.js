import React from "react";

import { TOKEN_KEY, requestJson, storageGet } from "./api.js";
import { COMPACT_STAT_IDS, PLAY_KINDS, formatPct, formatRankNeed, playKindLabel, scoreMixRows } from "../shared/play-stats.js";
import { selectDashboardTab } from "./dashboard-shell.js";

const h = React.createElement;

export function usePlayStats() {
  const token = storageGet(TOKEN_KEY);
  const [state, setState] = React.useState({ status: token ? "loading" : "idle", payload: null });

  React.useEffect(() => {
    if (!token) {
      setState({ status: "idle", payload: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: "loading", payload: null });
    requestJson("/play-stats", { token, signal: controller.signal })
      .then((payload) => setState({ status: "ready", payload }))
      .catch((error) => {
        if (error.name !== "AbortError") setState({ status: "error", payload: null });
      });
    return () => controller.abort();
  }, [token]);

  return state;
}

function rankText(row) {
  return formatRankNeed(row.mine, row.min, row.field);
}

function sampleText(mine) {
  if (!mine || !mine.att) return "";
  return mine.hit + "/" + mine.att;
}

function MixBar({ rows }) {
  const parts = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ ...row, pct: row.mine && row.mine.pct != null ? row.mine.pct : 0 }))
    .filter((row) => row.pct > 0);
  if (!parts.length) return null;
  const label = parts.map((row) => (row.short || row.label) + " " + formatPct(row.pct)).join(", ");
  return h("div", {
    "aria-label": label,
    className: "play-score-mix",
    role: "img",
  }, parts.map((row) => h("span", {
    className: "play-score-mix-seg tone-" + (row.tone || "par"),
    key: row.id,
    style: { flexGrow: Math.max(row.pct, 2) },
    title: (row.label || row.short) + " " + formatPct(row.pct),
  }, row.pct >= 12 ? formatPct(row.pct) : "\u00a0")));
}

function MixLegend({ compact, rows }) {
  return h("div", { className: "play-score-legend" }, (Array.isArray(rows) ? rows : []).map((row) => {
    const mine = row.mine;
    return h("div", {
      className: "play-score-legend-item tone-" + (row.tone || "par"),
      key: row.id,
    }, [
      h("span", { className: "play-score-legend-k", key: "k" }, row.short || row.label),
      h("b", { key: "v" }, mine ? formatPct(mine.pct) : "—"),
      h("small", { key: "s" }, rankText(row)),
      !compact && row.leaders && row.leaders.length
        ? h("ol", { className: "play-stat-leaders", key: "leaders" }, row.leaders.slice(0, 3).map((leader) =>
          h("li", { key: leader.memberId || leader.name }, [
            h("span", { key: "name" }, leader.name),
            h("b", { key: "pct" }, formatPct(leader.pct)),
          ]),
        ))
        : null,
    ]);
  }));
}

function StatCard({ compact, row }) {
  const mine = row.mine;
  const pct = mine ? formatPct(mine.pct) : "—";
  const sample = sampleText(mine);
  return h("div", { className: "play-stat-card" + (compact ? " compact" : "") + (row.tone ? " tone-" + row.tone : "") }, [
    h("div", { className: "play-stat-k", key: "k" }, row.label),
    h("div", { className: "play-stat-v", key: "v" }, pct),
    h("div", { className: "play-stat-s", key: "s" }, [rankText(row), sample].filter(Boolean).join(" · ")),
    !compact && row.leaders && row.leaders.length
      ? h("ol", { className: "play-stat-leaders", key: "leaders" }, row.leaders.slice(0, 3).map((leader) =>
        h("li", { key: leader.memberId || leader.name }, [
          h("span", { key: "name" }, leader.name),
          h("b", { key: "pct" }, formatPct(leader.pct)),
        ]),
      ))
      : null,
  ]);
}

function KindToggle({ kind, onKind }) {
  return h("div", { className: "play-stats-kind", role: "tablist", "aria-label": "Scoring kind" }, PLAY_KINDS.map((id) =>
    h("button", {
      "aria-pressed": kind === id ? "true" : "false",
      className: kind === id ? "active" : "",
      key: id,
      type: "button",
      onClick: () => onKind && onKind(id),
    }, playKindLabel(id)),
  ));
}

export function PlayStatsKindBlock({ compact = false, kind, onKind, showToggle = false, showStatus = true, state }) {
  const selected = kind === "casual" ? "casual" : "competitive";
  const bucket = state?.payload?.[selected] || null;
  const rows = Array.isArray(bucket?.categories) ? bucket.categories : [];
  const mix = scoreMixRows(rows);
  const cards = compact
    ? rows.filter((row) => COMPACT_STAT_IDS.includes(row.id))
    : rows.filter((row) => row.group !== "mix");
  const holes = Number(bucket?.mine?.totals?.holes) || 0;
  const kindLabel = playKindLabel(selected);
  const hasSample = holes > 0 || cards.some((row) => row.mine && row.mine.att);
  const status = state?.status || "idle";
  return h("section", {
    className: "player-card play-stats-panel",
    "data-play-stats-kind": selected,
    "data-react-play-stats": status,
  }, [
    h("div", { className: "player-job-head", key: "head" }, [
      h("h3", { key: "title" }, kindLabel + " scoring"),
      compact
        ? h("button", {
          className: "player-job-link",
          key: "season",
          type: "button",
          onClick: () => selectDashboardTab("season"),
        }, "Ranks")
        : h("p", { className: "player-card-meta", key: "meta" }, holes ? holes + " holes this season" : "Club ranks by percentage"),
    ]),
    showToggle ? h(KindToggle, { key: "kind", kind: selected, onKind }) : null,
    showStatus && status === "loading" ? h("p", { className: "player-card-meta", key: "loading" }, "Loading club stats...") : null,
    showStatus && status === "error" ? h("p", { className: "player-card-meta", key: "error" }, "Could not load club scoring stats.") : null,
    hasSample
      ? h("div", { className: "play-score-mix-wrap", key: "mix" }, [
        h("div", { className: "play-stat-k", key: "label" }, kindLabel + " scoring percentages"),
        h(MixBar, { key: "bar", rows: mix }),
        h(MixLegend, { compact, key: "legend", rows: mix }),
      ])
      : null,
    hasSample && cards.length
      ? h("div", { className: compact ? "play-stats-grid compact" : "play-stats-grid", key: "grid" },
        cards.map((row) => h(StatCard, { compact, key: row.id, row })))
      : status === "ready"
        ? h("p", { className: "player-card-meta", key: "empty" }, selected === "casual"
          ? "Finish a casual round to start those percentages. Mark lies for fairways, C1/C2, and putting."
          : "Finish a club event to start competitive percentages. Mark lies for fairways, C1/C2, and putting.")
        : null,
  ]);
}

export function PlayStatsGrid({ compact = false, kind, onKind, state }) {
  const selected = kind === "casual" ? "casual" : "competitive";
  const status = state?.status || "idle";
  if (compact) {
    return h(PlayStatsKindBlock, {
      compact: true,
      kind: selected,
      onKind,
      showToggle: true,
      state,
    });
  }
  return h("div", {
    className: "play-stats-split",
    "data-play-stats-split": "true",
    "data-react-play-stats": status,
  }, [
    status === "loading" ? h("p", { className: "player-card-meta play-stats-split-status", key: "loading" }, "Loading club stats...") : null,
    status === "error" ? h("p", { className: "player-card-meta play-stats-split-status", key: "error" }, "Could not load club scoring stats.") : null,
    h(PlayStatsKindBlock, { compact: false, kind: "competitive", showStatus: false, state, key: "competitive" }),
    h(PlayStatsKindBlock, { compact: false, kind: "casual", showStatus: false, state, key: "casual" }),
  ]);
}

export function PlayStatsPanel({ compact = false }) {
  const state = usePlayStats();
  const [kind, setKind] = React.useState("competitive");
  return h(PlayStatsGrid, { compact, kind, onKind: setKind, state });
}
