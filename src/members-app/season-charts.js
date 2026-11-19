import React from "react";

import { formatPct, playKindLabel } from "../shared/play-stats.js";
import { CLUB_TIME_ZONE, clubCivilInstant, parseClubInstant } from "../shared/events-model.js";

const h = React.createElement;

/* Rating labels used on this page only:
   "Round rating"  - one number per finished round (the plotted line)
   "Club rating"   - the GVDG engine's live value from /my-ratings
   "PDGA official rating" - the official PDGA number
   "Live rating estimate" - our estimate from recent PDGA round ratings     */

const RANGES = [
  { id: "90", label: "3 mo", days: 90 },
  { id: "365", label: "1 yr", days: 365 },
  { id: "all", label: "All", days: null },
];
const DAY = 86400000;

export function ratingSeries(ratings, kind = "competitive") {
  const group = kind === "casual" ? ratings?.casual : ratings?.competitive;
  const rounds = Array.isArray(group?.rounds) ? group.rounds : [];
  return rounds
    .map((round) => ({ t: parseRoundDate(round.date), rating: Number(round.rating) }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.rating) && point.rating > 0)
    .sort((a, b) => a.t - b.t);
}

function parseRoundDate(value) {
  const civil = clubCivilInstant(value);
  if (civil) return civil.getTime();
  return parseClubInstant(value)?.getTime() ?? NaN;
}

function niceTicks(min, max) {
  const span = Math.max(max - min, 10);
  const step = span <= 30 ? 10 : span <= 60 ? 20 : 25;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = lo; value <= hi; value += step) ticks.push(value);
  return { lo, hi, ticks };
}

export function chartDate(t, withYear) {
  return new Date(t).toLocaleDateString("en-US", withYear
    ? { month: "short", day: "numeric", year: "numeric", timeZone: CLUB_TIME_ZONE }
    : { month: "short", day: "numeric", timeZone: CLUB_TIME_ZONE });
}

function SkeletonBlocks({ heights, label }) {
  return h("div", { className: "stats-skel", role: "status", "aria-busy": "true", "aria-label": label },
    heights.map((height, index) => h("div", { className: "stats-skeleton", style: { height }, key: index })));
}

function RatingKey({ ratings, kind, pdgaStats }) {
  const group = kind === "casual" ? ratings?.casual : ratings?.competitive;
  const items = [
    group?.live_rating != null ? { label: kind === "casual" ? "Club rating (casual)" : "Club rating", value: group.live_rating, note: "GVDG live" } : null,
    pdgaStats?.official_rating != null ? { label: "PDGA official rating", value: pdgaStats.official_rating, note: "official" } : null,
    pdgaStats?.live_rating != null ? { label: "Live rating estimate", value: pdgaStats.live_rating, note: "estimate" } : null,
  ].filter(Boolean);
  if (!items.length) return null;
  return h("dl", { className: "stats-rating-key" }, items.map((item) =>
    h("div", { key: item.label }, [
      h("dt", { key: "k" }, item.label),
      h("dd", { key: "v" }, [h("b", { key: "b" }, String(item.value)), h("small", { key: "s" }, item.note)]),
    ])));
}

export function RatingTrend({ ratings, status = "ready", pdgaStats = null, now = Date.now() }) {
  const [kind, setKind] = React.useState("competitive");
  const [range, setRange] = React.useState("365");
  const wrap = React.useRef(null);
  const [width, setWidth] = React.useState(320);
  React.useEffect(() => {
    const node = wrap.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  });
  const all = React.useMemo(() => ratingSeries(ratings, kind), [ratings, kind]);
  const kinds = ["competitive", "casual"].filter((id) => ratingSeries(ratings, id).length);
  const head = (extra) => h("div", { className: "stats-head", key: "head" }, [h("h3", { className: "stats-h", key: "h" }, "Rating trend"), extra ? h(React.Fragment, { key: "x" }, extra) : null]);
  const shell = (state, body) => h("section", { className: "stats-section stats-trend", id: "stats-trend", "aria-label": "Rating trend", "data-stats-trend": state }, body);

  if (status === "loading") {
    return shell("loading", [head(null), h(SkeletonBlocks, { heights: [28, 190], label: "Loading rating trend", key: "s" })]);
  }
  if (!ratings) {
    return shell("error", [head(null), h("p", { className: "stats-empty", role: "alert", key: "e" },
      "Could not load your rating history. The rest of your season is below. Reopen Stats to try again.")]);
  }
  if (!all.length) {
    return shell("empty", [head(null), h("p", { className: "stats-empty", key: "e" },
      "Finish rated rounds to draw your trend. Eight eligible rounds in the past year unlock your Club rating."),
    h(RatingKey, { ratings, kind: "competitive", pdgaStats, key: "key" })]);
  }

  const days = RANGES.find((item) => item.id === range)?.days;
  const inRange = days ? all.filter((point) => point.t >= now - days * DAY) : all;
  const shown = inRange.length >= 2 ? inRange : all.slice(-2);
  const W = width;
  const H = Math.round(Math.min(240, Math.max(170, width * 0.5)));
  const padL = 38; const padR = 14; const padT = 14; const padB = 28;
  const values = shown.map((point) => point.rating);
  const { lo, hi, ticks } = niceTicks(Math.min(...values), Math.max(...values));
  const first = shown[0];
  const last = shown[shown.length - 1];
  const x = (t) => padL + (last.t === first.t ? (W - padL - padR) / 2 : ((t - first.t) / (last.t - first.t)) * (W - padL - padR));
  const y = (value) => padT + (1 - (value - lo) / (hi - lo || 1)) * (H - padT - padB);
  const line = shown.map((point, index) => (index ? "L" : "M") + x(point.t).toFixed(1) + " " + y(point.rating).toFixed(1)).join(" ");
  const delta = last.rating - first.rating;
  const best = shown.reduce((a, b) => (b.rating > a.rating ? b : a), shown[0]);
  const withYear = last.t - first.t > 300 * DAY;
  const kindName = playKindLabel(kind);
  const summary = `${kindName} round ratings: latest ${last.rating}, ${delta === 0 ? "unchanged" : delta > 0 ? "up " + delta : "down " + Math.abs(delta)} over ${shown.length} rounds, high ${best.rating} on ${chartDate(best.t, true)}.`;
  const seg = (label, options, value, onChange, labelOf) => h("div", { className: "stats-seg", role: "group", "aria-label": label },
    options.map((id) => h("button", { type: "button", key: id, "aria-pressed": value === id ? "true" : "false", onClick: () => onChange(id) }, labelOf(id))));

  return shell("ready", [
    head(seg("Trend range", RANGES.map((item) => item.id), range, setRange, (id) => RANGES.find((item) => item.id === id).label)),
    kinds.length > 1 ? h("div", { key: "kind" }, seg("Rating stream", kinds, kind, setKind, playKindLabel)) : null,
    h("div", { className: "stats-trend-read", key: "read" }, [
      h("span", { className: "stats-trend-cap", key: "cap" }, kindName + " round rating, latest"),
      h("span", { className: "stats-trend-now", key: "now" }, String(last.rating)),
      h("span", { className: "stats-delta " + (delta > 0 ? "up" : delta < 0 ? "down" : ""), key: "d" },
        (delta > 0 ? "+" : delta < 0 ? "−" : "") + Math.abs(delta) + " over " + shown.length + " rounds"),
    ]),
    h("div", { className: "stats-trend-wrap", ref: wrap, key: "wrap" }, h("svg", { className: "stats-trend-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": summary }, [
      ...ticks.map((tick) => h("g", { key: "t" + tick }, [
        h("line", { className: "stats-grid", x1: padL, x2: W - padR, y1: y(tick), y2: y(tick), key: "l" }),
        h("text", { className: "stats-axis", x: padL - 7, y: y(tick) + 4, textAnchor: "end", key: "x" }, String(tick)),
      ])),
      h("text", { className: "stats-axis", x: padL, y: H - 7, key: "xa" }, chartDate(first.t, withYear)),
      h("text", { className: "stats-axis", x: W - padR, y: H - 7, textAnchor: "end", key: "xb" }, chartDate(last.t, withYear)),
      h("path", { className: "stats-line", d: line, key: "line" }),
      ...(shown.length <= 24 ? shown.map((point, index) => h("circle", { className: "stats-dot", cx: x(point.t), cy: y(point.rating), r: 2.5, key: "p" + index })) : []),
      h("circle", { className: "stats-dot-last", cx: x(last.t), cy: y(last.rating), r: 5, key: "last" }),
      h("text", { className: "stats-label", x: Math.min(x(last.t) - 9, W - padR), y: y(last.rating) - 10, textAnchor: "end", key: "lt" }, String(last.rating)),
    ])),
    h("p", { className: "stats-note", key: "note" }, `High ${best.rating} on ${chartDate(best.t, true)}. The line plots your Round rating for each finalized GVDG round.`),
    h(RatingKey, { ratings, kind, pdgaStats, key: "key" }),
  ]);
}

/* ---------- Score-mix distribution (counts + percentages) ---------- */

const MIX_TOTAL = { ace: "aces", eagle: "eagles", birdieMix: "birdies", parMix: "pars", bogey: "bogeys", double: "doubles_plus" };

export function ScoreDistribution({ rows, totals }) {
  const list = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ row, count: Number(totals?.[MIX_TOTAL[row.id]]) || 0, pct: row.mine?.pct || 0 }))
    .filter((item) => item.row.id !== "ace" || item.count > 0);
  if (!list.length || !list.some((item) => item.count > 0)) return null;
  const max = Math.max(1, ...list.map((item) => item.pct));
  return h("div", { className: "stats-dist", role: "list", "aria-label": "Score distribution by hole count" }, list.map(({ row, count, pct }) =>
    h("div", { className: "stats-dist-row tone-" + (row.tone || "par"), role: "listitem", key: row.id }, [
      h("span", { className: "stats-dist-k", key: "k" }, row.label),
      h("span", { className: "stats-dist-bar", "aria-hidden": "true", key: "b" }, h("i", { style: { width: Math.max(pct ? 2 : 0, (pct / max) * 100) + "%" } })),
      h("span", { className: "stats-dist-n", key: "n" }, count + (count === 1 ? " hole" : " holes")),
      h("b", { className: "stats-dist-v", key: "v" }, formatPct(pct)),
    ])));
}

/* ---------- Slim metric bar ---------- */

export function MetricBar({ pct }) {
  if (pct == null || !Number.isFinite(Number(pct))) return null;
  return h("span", { className: "stats-metric-bar", "aria-hidden": "true" }, h("i", { style: { width: Math.min(100, Math.max(0, Number(pct))) + "%" } }));
}

/* ---------- Sticky jump bar ---------- */

export function JumpBar({ sections }) {
  const present = sections;
  const [active, setActive] = React.useState(present[0]?.[0]);
  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => {
      const hit = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: "-130px 0px -60% 0px" });
    for (const [id] of present) { const node = document.getElementById(id); if (node) observer.observe(node); }
    return () => observer.disconnect();
  }, [present.length]);
  React.useEffect(() => {
    const onScroll = () => { if (window.scrollY < 80) setActive(present[0]?.[0]); };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [present.length]);
  const bar = React.useRef(null);
  const settled = React.useRef(false);
  React.useEffect(() => {
    // Never on first render; afterwards nudge only the bar (not the page) so the active chip is visible.
    if (!settled.current) { settled.current = true; return; }
    const node = bar.current;
    const chip = node?.querySelector("[aria-current='true']");
    if (!node || !chip) return;
    const left = chip.offsetLeft - node.offsetLeft;
    const target = Math.max(0, Math.min(left - (node.clientWidth - chip.offsetWidth) / 2, node.scrollWidth - node.clientWidth));
    node.scrollTo({ left: target, behavior: "auto" });
  }, [active]);
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return h("nav", { className: "stats-jump", "aria-label": "Stats sections", ref: bar }, present.map(([id, label]) =>
    h("button", {
      type: "button", key: id, "aria-current": active === id ? "true" : undefined,
      onClick: () => { setActive(id); document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }); },
    }, label)));
}

/* ---------- CSV export ---------- */

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) || /^[=+\-@]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

export function seasonCsv(results, roundRatingOf) {
  const header = ["date", "kind", "event_or_course", "layout", "place", "total", "to_par", "round_rating"];
  const rows = (Array.isArray(results) ? results : []).map((row) => [
    String(row.event_date || row.finalized_at || "").slice(0, 10), row.kind === "casual" ? "casual" : "event",
    row.kind === "casual" ? (row.course_name || row.event_name) : row.event_name, row.layout_name || "",
    row.place ?? "", row.total ?? "", row.to_par ?? "", roundRatingOf(row) ?? "",
  ]);
  return [header, ...rows].map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function downloadCsv(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { SkeletonBlocks };
