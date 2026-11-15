import React from "react";
import { request, requestJson, storageGet, TOKEN_KEY } from "./api.js";
import { formatPct, playStyleLabel, statPct } from "../shared/play-stats.js";
import { SHOT_STAT_DEFINITIONS } from "../shared/shot-stats-model.js";
import { describeShot } from "../shared/shot-ledger.js";

const h = React.createElement;
const initialFilters = { window: "year", last: "10", from: "", to: "", source: "all", group: "singles", style: "stroke", course: "", layout: "", hole: "" };
const sourceNames = { competitive: "Club event", casual: "Casual", udisc: "UDisc import", offline: "Personal offline round" };
const inputStyle = { display: "block", width: "100%", minHeight: "2.25rem" };
const filterStyle = { display: "grid", gap: ".75rem", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 9rem), 1fr))", alignItems: "end", marginBottom: "1rem" };

function options(names) {
  return Object.entries(names).map(([key, label]) => ({ key, label }));
}

function selectField(label, name, values, draft, change) {
  return h("label", { key: name }, label, h("select", {
    name, value: draft[name], style: inputStyle, onChange: (event) => change(name, event.target.value),
  }, values.map(({ key, label: text }) => h("option", { key, value: key }, text))));
}

function field(label, name, config, draft, change) {
  return h("label", { key: name }, label, h("input", {
    ...config, name, style: inputStyle, value: draft[name], onChange: (event) => change(name, event.target.value),
  }));
}

function filtersQuery(filters) {
  return new URLSearchParams(Object.entries(filters).filter(([key, value]) =>
    value && (key !== "last" || filters.window === "last") &&
    ((key !== "from" && key !== "to") || filters.window === "custom"),
  )).toString();
}

function usePersonalHistory(token, query, revision) {
  const [state, setState] = React.useState({ status: "loading", payload: null });
  React.useEffect(() => {
    if (!token) {
      setState({ status: "idle", payload: null });
      return undefined;
    }
    const controller = new AbortController();
    const url = "/my-play-history?" + query;
    setState((current) => ({ status: "loading", payload: current.owner === token ? current.payload : null, owner: token }));
    requestJson(url, { token, signal: controller.signal }).then((payload) => {
      if (!controller.signal.aborted) setState({ status: "ready", payload, owner: token });
    }).catch(() => {
      if (!controller.signal.aborted) setState((current) => ({ ...current, status: "error" }));
    });
    return () => controller.abort();
  }, [query, revision, token]);
  return state.owner === token ? state : { status: "loading", payload: null };
}

function signed(n) {
  if (n == null) return "—";
  return n > 0 ? "+" + n : String(n);
}

function ArchivedShots({ round, token }) {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState({ status: "loading", holes: [] });
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ shotResult: `${round.source}:${round.resultId}` });
    setState({ status: "loading", holes: [] });
    requestJson("/my-play-history?" + query, { token, signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setState({ status: "ready", holes: data.holes });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: "error", holes: [] });
    });
    return () => controller.abort();
  }, [open, round.resultId, round.source, token]);
  const details = state.status === "ready"
    ? state.holes.map(({ hole, strokes, shotLedger }) => h("section", { key: hole },
      h("p", null, `Hole ${hole}` + (strokes == null ? " · Unscored" : ` · ${strokes} on card`) + (shotLedger.scope === "team" ? " · Team shots" : "")),
      !shotLedger.matchesResult && h("p", { className: "player-card-meta" }, round.source === "offline"
        ? "Recorded outside the completed match." : "Record from an earlier scoring assignment."),
      h("ol", null, shotLedger.rows.map((shot) => h("li", { key: shot.id }, describeShot(shot))))))
    : h("p", { role: "status" }, state.status === "error" ? "Could not load these shots. Close and try again." : "Loading saved shots…");
  return h("details", { onToggle: (event) => setOpen(event.currentTarget.open) },
    h("summary", null, `Shot records on ${round.explicitLedgerHoles} ${round.explicitLedgerHoles === 1 ? "hole" : "holes"}`),
    open && details);
}

function historySummary(view, token) {
  const overall = view.scoreTrend;
  const totals = view.totals;
  const latest = view.latest;
  const prior = view.previous;
  const scoreDelta = latest.averageToParPerHole == null || prior.averageToParPerHole == null ? null :
    Math.round(100 * (latest.averageToParPerHole - prior.averageToParPerHole)) / 100;
  const puttDelta = latest.c1x.percentage == null || prior.c1x.percentage == null ? null : Math.round(10 * (latest.c1x.percentage - prior.c1x.percentage)) / 10;
  function putts(prefix) {
    const made = totals[prefix + "_putt_hit"];
    const attempts = totals[prefix + "_putt_att"];
    return attempts ? formatPct(statPct(made, attempts)) + " (" + made + "/" + attempts + ")" : "—";
  }
  const summaryRows = [
    ["Score vs. par per hole", signed(overall.averageToParPerHole) + " · " + overall.scoreHoles + " holes with par"],
    ["C1 putting", putts("c1")],
    ["C1X putting", putts("c1x")],
    ["C2 putting", putts("c2")],
  ];
  return h(React.Fragment, null,
    h("p", { className: "player-card-meta" }, view.roundCount + " matching rounds"),
    h("dl", { className: "play-stats-grid" }, summaryRows.map(([label, value]) => h("div", {
      key: label, className: "play-stat-card",
    }, h("dt", { className: "play-stat-k" }, label), h("dd", { className: "play-stat-s", style: { margin: 0 } }, value)))),
    h("p", { className: "player-card-meta" }, [
      `${totals.shot_verified_holes} of ${totals.shot_eligible_holes} scored non-ace holes have a complete shot ledger.`,
      totals.shot_count_matched_holes ? ` ${totals.shot_count_matched_holes} have marked-lie estimates.` : "",
      totals.shot_incomplete_holes ? ` ${totals.shot_incomplete_holes} have incomplete records.` : "",
      view.coverage.noArchivedGeometry ? " " + view.coverage.noArchivedGeometry + " marked holes are missing archived basket positions." : "",
      view.coverage.withheldMarkHoles ? " " + view.coverage.withheldMarkHoles + " holes have marks that cannot be attributed to your account." : "",
    ].join("")),
    scoreDelta != null || puttDelta != null ? h("p", { className: "player-card-meta" },
      "Latest " + latest.rounds + " matching rounds vs. the previous " + prior.rounds + ": ",
      [
        scoreDelta == null ? null : signed(scoreDelta) + " strokes to par per hole (" + latest.scoreHoles + " vs. " + prior.scoreHoles + " holes)",
        puttDelta == null ? null : signed(puttDelta) + " percentage points in C1X (" + latest.c1x.attempts + " vs. " + prior.c1x.attempts + " attempts)",
      ].filter(Boolean).join(" · "), ".") : null,
    h("details", { className: "player-card-meta" }, h("summary", null, "How the numbers are calculated"),
      h("p", null, SHOT_STAT_DEFINITIONS.putting), h("p", null, SHOT_STAT_DEFINITIONS.ledger), h("p", null, SHOT_STAT_DEFINITIONS.legacy),
      h("p", null, "Score trends use positive hole scores with known pars. Putting leagues are excluded.")),
    h("div", { className: "member-history-table", style: { overflowX: "auto" } }, h("table", { style: { width: "100%", textAlign: "left" } },
      h("caption", { style: { textAlign: "left", marginBlock: ".5rem" } }, "Recent matching rounds"),
      h("thead", null, h("tr", null, ["Date", "Course / layout", "Holes with scores", "Strokes", "To par"].map((title) => h("th", { key: title, scope: "col" }, title)))),
      h("tbody", null, view.recentRounds.map((round) => h("tr", { key: round.id },
        h("td", null, round.date || "—"),
        h("td", null, [round.course || round.eventName || sourceNames[round.source], round.layout].filter(Boolean).join(" / "),
          h("small", { style: { display: "block" } }, sourceNames[round.source] + (round.group === "doubles" ? " · Team score" : "")),
          round.explicitLedgerHoles > 0 && h(ArchivedShots, { round, token }),
          round.source === "offline" && h("a", { href: "score.html?offline=1&archive=" + round.resultId }, "View offline card")),
        h("td", null, round.scoredHoles || "—"),
        h("td", null, round.strokes ?? "—"),
        h("td", null, signed(round.toPar)),
      ))))),
  );
}

function saveFile(body, format) {
  const mime = format === "csv" ? "text/csv" : "application/json";
  const url = URL.createObjectURL(new Blob([body], { type: mime + ";charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "gvdg-play-history." + format;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}

function csvAfterManifest(csv) {
  const headerEnd = csv.indexOf("\r\n");
  if (headerEnd < 0) throw new Error("Download is missing its CSV header");
  const manifestEnd = csv.indexOf("\r\n", headerEnd + 2);
  if (manifestEnd < 0) throw new Error("Download is missing its CSV manifest");
  return csv.slice(manifestEnd + 2);
}

async function downloadArchive(format, token, signal, onPage) {
  const seen = new Set();
  let cursor = null;
  let archive = null;
  const csv = [];
  do {
    const query = new URLSearchParams({ format });
    if (cursor) query.set("cursor", cursor);
    const response = await request("/my-play-export?" + query, { token, signal });
    if (!response.ok) throw new Error(String(response.status));
    if (format === "csv") {
      const contents = await response.text();
      csv.push(cursor ? csvAfterManifest(contents) : contents);
    } else {
      const page = await response.json();
      if (!archive) archive = page;
      else {
        if (archive.schemaVersion !== page.schemaVersion || archive.memberId !== page.memberId) throw new Error("Download pages did not match");
        archive.rounds.push(...page.rounds);
        archive.clips.push(...page.clips);
      }
    }
    cursor = response.headers.get("X-GVDG-Next-Export");
    if (seen.has(cursor)) throw new Error("Download page repeated");
    if (cursor) seen.add(cursor);
    onPage();
  } while (cursor);
  if (!signal.aborted) saveFile(format === "csv" ? csv.join("") : JSON.stringify(archive, null, 2), format);
}

function PlayExport({ token }) {
  const fetching = React.useRef(null);
  const [status, setStatus] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => () => fetching.current?.abort(), [token]);
  async function download(format) {
    if (fetching.current) return;
    const controller = new AbortController();
    fetching.current = controller;
    setBusy(true);
    setStatus("Preparing your archive…");
    let pages = 0;
    try {
      await downloadArchive(format, token, controller.signal, () => {
        if (!controller.signal.aborted) setStatus("Preparing your archive… " + ++pages + " pages read.");
      });
      if (!controller.signal.aborted) setStatus("Your download is ready.");
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error.message === "401" ? "Sign in again to download your history." : "Could not download your full history. Try again.");
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        fetching.current = null;
      }
    }
  }
  return h("details", { key: "export", style: { marginBlock: ".75rem" } }, h("summary", null, "Download my play data"),
    h("p", { className: "player-card-meta" }, "Includes your saved scores, shot records, attributable marks, layout details, imported rounds, and references to clips you uploaded. The download includes your full archive regardless of the filters above."),
    h("div", { className: "play-stats-kind", role: "group", "aria-label": "Download format" }, ["json", "csv"].map((format) =>
      h("button", { key: format, disabled: busy, type: "button", onClick: () => download(format) }, "Download " + format.toUpperCase()))),
    h("p", { className: "player-card-meta", role: "status" }, status),
  );
}

export function PersonalPlayHistory() {
  const token = storageGet(TOKEN_KEY);
  const [draft, setDraft] = React.useState(initialFilters);
  const [query, setQuery] = React.useState(() => filtersQuery(initialFilters));
  const [revision, revise] = React.useState(0);
  const [formError, setFormError] = React.useState("");
  const { payload, status } = usePersonalHistory(token, query, revision);
  const filterOptions = payload?.options;
  if (!token) return null;
  function change(key, value) {
    setFormError("");
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (["source", "group", "style"].includes(key)) next.course = "";
      if (["source", "group", "style", "course"].includes(key)) next.layout = "";
      if (key !== "hole") next.hole = "";
      if (key === "source") next.group = value === "udisc" ? "unknown" : value === "offline" ? "all" : "singles";
      return next;
    });
  }
  function apply(event) {
    event.preventDefault();
    if (draft.window === "custom" && draft.from > draft.to) {
      setFormError("End date must be on or after the start date.");
      return;
    }
    setQuery(filtersQuery(draft));
    revise((current) => current + 1);
  }
  const all = { key: "", label: "All" };
  const extraControls = draft.window === "last"
    ? [field("Round count", "last", { type: "number", min: 1, max: 200, required: true }, draft, change)]
    : draft.window === "custom" ? [
      field("Start date", "from", { type: "date", required: true }, draft, change),
      field("End date", "to", { type: "date", required: true }, draft, change),
    ] : [];
  // Use facet choices for the currently applied upstream filters; clear dependent choices
  // whenever their source changes. Applying refreshes the available choices.
  const sameSource = [draft.source, draft.group, draft.style].every((value, index) => value === [payload?.filters?.source, payload?.filters?.group, payload?.filters?.style][index]);
  const sameCourse = sameSource && draft.course === payload?.filters?.course;
  const sameLayout = sameCourse && draft.layout === payload?.filters?.layout;
  return h("section", { className: "player-card member-history-panel", "aria-label": "Personal play history" },
    h("h3", null, "My play history"),
    h("form", { onSubmit: apply, "aria-label": "Filter my play history" }, h("div", { style: filterStyle },
      selectField("Period", "window", options({ year: "This year", all: "All time", last: "Last N rounds", custom: "Custom dates" }), draft, change),
      ...extraControls,
      selectField("Source", "source", options({ all: "All sources", ...sourceNames }), draft, change),
      selectField("Group format", "group", options({ singles: "Singles", doubles: "Doubles", unknown: "Not recorded", all: "All formats" }), draft, change),
      selectField("Scoring style", "style", options({ stroke: playStyleLabel("stroke"), matchplay: playStyleLabel("matchplay"), all: "All styles" }), draft, change),
      selectField("Course", "course", [all, ...(sameSource ? filterOptions?.courses || [] : [])], draft, change),
      selectField("Layout", "layout", [all, ...(sameCourse ? filterOptions?.layouts || [] : [])], draft, change),
      selectField("Hole", "hole", [all, ...(sameLayout ? filterOptions?.holes || [] : []).map((hole) => ({ key: String(hole), label: "Hole " + hole }))], draft, change),
      h("div", { key: "apply", className: "play-stats-kind" }, h("button", { type: "submit" }, "Apply filters")),
    ), formError ? h("p", { role: "alert" }, formError) : null),
    status === "loading" ? h("p", { className: "player-card-meta", role: "status" }, "Loading your rounds…") : null,
    status === "error" ? h("p", { className: "player-card-meta", role: "alert" }, "Could not load play history.") : null,
    status === "ready" && payload?.truncated ? h("p", { className: "player-card-meta", role: "status" },
      "This view checks up to " + payload.maxSavedRoundsPerSource.toLocaleString() + " recently saved rounds per source. The full archive is available below.") : null,
    status === "ready" && payload?.roundCount ? historySummary(payload, token) : null,
    status === "ready" && !payload?.roundCount ? h("p", { className: "player-card-meta" }, "No saved rounds match these filters.") : null,
    h(PlayExport, { key: token, token }),
  );
}
