import React from "react";

import { TOKEN_KEY, requestJson, storageGet } from "./api.js";
import { useMemberContext } from "./member-context.js";
import {
  COMPACT_STAT_IDS,
  PLAY_GROUPS,
  PLAY_KINDS,
  PLAY_STYLES,
  formatPct,
  formatRankNeed,
  pdgaRowsFromStats,
  playGroupLabel,
  playKindLabel,
  playStatsByKind,
  playStyleLabel,
  playViewKey,
  scoreMixRows,
  selectPlayStatsView,
} from "../shared/play-stats.js";
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

function shortName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || "Player";
  return parts[0] + " " + parts[parts.length - 1].slice(0, 1) + ".";
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

function MixLegend({ rows, showRank = true }) {
  return h("div", { className: "play-score-legend" }, (Array.isArray(rows) ? rows : []).map((row) => {
    const mine = row.mine;
    return h("div", {
      className: "play-score-legend-item tone-" + (row.tone || "par"),
      key: row.id,
    }, [
      h("span", { className: "play-score-legend-k", key: "k" }, row.short || row.label),
      h("b", { key: "v" }, mine ? formatPct(mine.pct) : "—"),
      h("small", { key: "s" }, showRank ? rankText(row) : sampleText(mine)),
    ]);
  }));
}

function StatCard({ compact, row, showLeaders = true, showRank = true }) {
  const mine = row.mine;
  const pct = mine ? formatPct(mine.pct) : "—";
  const sample = sampleText(mine);
  return h("div", { className: "play-stat-card" + (compact ? " compact" : "") + (row.tone ? " tone-" + row.tone : "") }, [
    h("div", { className: "play-stat-k", key: "k" }, row.label),
    h("div", { className: "play-stat-v", key: "v" }, pct),
    h("div", { className: "play-stat-s", key: "s" }, [showRank ? rankText(row) : null, sample].filter(Boolean).join(" · ")),
    showLeaders && !compact && row.leaders && row.leaders.length
      ? h("ol", { className: "play-stat-leaders", key: "leaders" }, row.leaders.slice(0, 3).map((leader) =>
        h("li", { key: leader.memberId || leader.name }, [
          h("span", { key: "name" }, shortName(leader.name)),
          h("b", { key: "pct" }, formatPct(leader.pct)),
        ]),
      ))
      : null,
  ]);
}

function ChipToggle({ label, options, labels, value, onChange }) {
  return h("div", { className: "play-stats-kind", role: "tablist", "aria-label": label }, options.map((id) =>
    h("button", {
      "aria-pressed": value === id ? "true" : "false",
      className: value === id ? "active" : "",
      key: id,
      type: "button",
      onClick: () => onChange && onChange(id),
    }, labels(id)),
  ));
}

export function PlayStatsKindBlock({
  compact = false,
  group = "all",
  kind,
  onKind,
  showToggle = false,
  showStatus = true,
  state,
  style = "all",
}) {
  const selected = kind === "casual" ? "casual" : kind === "pdga" ? "pdga" : "competitive";
  const bucket = selectPlayStatsView(state?.payload?.[selected], group, style);
  const rows = Array.isArray(bucket?.categories) ? bucket.categories : [];
  const mix = scoreMixRows(rows);
  const pdga = selected === "pdga";
  const cards = compact
    ? rows.filter((row) => COMPACT_STAT_IDS.includes(row.id) && (!pdga || row.group !== "throw"))
    : rows.filter((row) => row.group !== "mix" && (!pdga || row.group !== "throw"));
  const holes = Number(bucket?.mine?.totals?.holes) || 0;
  const kindLabel = playKindLabel(selected);
  const formatBits = [
    group !== "all" ? playGroupLabel(group) : null,
    style !== "all" ? playStyleLabel(style) : null,
  ].filter(Boolean);
  const formatNote = formatBits.length ? formatBits.join(" · ").toLowerCase() + " " : "";
  const hasSample = holes > 0 || cards.some((row) => row.mine && row.mine.att);
  const status = state?.status || "idle";
  const emptyCopy = selected === "pdga"
    ? "PDGA live scorecards for recent events will fill this mix. Club event ranks stay separate."
    : selected === "casual"
      ? "Finish a casual round to start those percentages. Mark lies for fairways, C1/C2, and putting."
      : "Finish a club event to start competitive percentages. Mark lies for fairways, C1/C2, and putting.";
  return h("section", {
    className: "player-card play-stats-panel",
    "data-play-stats-kind": selected,
    "data-play-stats-view": playViewKey(group, style),
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
        : h("p", { className: "player-card-meta", key: "meta" }, holes
          ? holes + " " + formatNote + "holes this season"
          : "Club ranks by percentage"),
    ]),
    showToggle ? h(ChipToggle, {
      key: "kind",
      label: "Scoring kind",
      options: (Array.isArray(state?.kinds) && state.kinds.length ? state.kinds : PLAY_KINDS.filter((id) => id !== "pdga")),
      labels: playKindLabel,
      value: selected,
      onChange: onKind,
    }) : null,
    showStatus && status === "loading" ? h("p", { className: "player-card-meta", key: "loading" }, "Loading club stats...") : null,
    showStatus && status === "error" ? h("p", { className: "player-card-meta", key: "error" }, "Could not load club scoring stats.") : null,
    hasSample
      ? h("div", { className: "play-score-mix-wrap", key: "mix" }, [
        h("div", { className: "play-stat-k", key: "label" }, "Scoring mix"),
        h(MixBar, { key: "bar", rows: mix }),
        h(MixLegend, { key: "legend", rows: mix, showRank: !pdga }),
      ])
      : null,
    hasSample && cards.length
      ? h("div", { className: compact ? "play-stats-grid compact" : "play-stats-grid", key: "grid" },
        cards.map((row) => h(StatCard, { compact, key: row.id, row, showLeaders: !pdga, showRank: !pdga })))
      : status === "ready"
        ? h("p", { className: "player-card-meta", key: "empty" }, formatBits.length
          ? "No " + formatNote + kindLabel.toLowerCase() + " holes this season yet."
          : emptyCopy)
        : null,
  ]);
}

export function PlayStatsGrid({ compact = false, kind, onKind, state, group, onGroup, style, onStyle }) {
  const selected = kind === "casual" ? "casual" : kind === "pdga" ? "pdga" : "competitive";
  const status = state?.status || "idle";
  const kinds = Array.isArray(state?.kinds) && state.kinds.length ? state.kinds : PLAY_KINDS.filter((id) => id !== "pdga");
  if (compact) {
    return h(PlayStatsKindBlock, {
      compact: true,
      kind: selected,
      onKind,
      showToggle: true,
      state: { ...state, kinds },
    });
  }
  return h("div", {
    className: "play-stats-split",
    "data-play-stats-split": "true",
    "data-react-play-stats": status,
  }, [
    h("div", { className: "play-stats-filters", key: "filters" }, [
      h(ChipToggle, { key: "group", label: "Group format", options: PLAY_GROUPS, labels: playGroupLabel, value: group || "all", onChange: onGroup }),
      h(ChipToggle, { key: "style", label: "Scoring style", options: PLAY_STYLES, labels: playStyleLabel, value: style || "all", onChange: onStyle }),
    ]),
    status === "loading" ? h("p", { className: "player-card-meta play-stats-split-status", key: "loading" }, "Loading club stats...") : null,
    status === "error" ? h("p", { className: "player-card-meta play-stats-split-status", key: "error" }, "Could not load club scoring stats.") : null,
    ...kinds.map((id) => h(PlayStatsKindBlock, {
      compact: false,
      group: group || "all",
      kind: id,
      showStatus: false,
      state,
      style: style || "all",
      key: id,
    })),
  ]);
}

export function PlayStatsPanel({ compact = false, pdgaStats = null }) {
  const context = useMemberContext();
  const state = usePlayStats();
  const [kind, setKind] = React.useState("competitive");
  const [group, setGroup] = React.useState("all");
  const [style, setStyle] = React.useState("all");
  const memberId = context.sub || "me";
  const pdgaRows = React.useMemo(
    () => pdgaRowsFromStats(pdgaStats, memberId, context.name),
    [pdgaStats, memberId, context.name],
  );
  const mergedPayload = React.useMemo(() => {
    if (!state.payload) return state.payload;
    return {
      ...state.payload,
      pdga: pdgaRows.length ? playStatsByKind(pdgaRows, memberId).pdga : state.payload.pdga,
    };
  }, [state.payload, pdgaRows, memberId]);
  const hasPdga = Boolean(context.pdgaNo) || pdgaRows.length > 0 || Number(mergedPayload?.pdga?.mine?.totals?.holes) > 0;
  const kinds = hasPdga ? PLAY_KINDS : PLAY_KINDS.filter((id) => id !== "pdga");
  return h(PlayStatsGrid, {
    compact,
    kind: kinds.includes(kind) ? kind : "competitive",
    onKind: setKind,
    group,
    onGroup: setGroup,
    style,
    onStyle: setStyle,
    state: { ...state, payload: mergedPayload, kinds },
  });
}
