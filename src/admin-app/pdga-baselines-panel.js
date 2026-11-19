import React from "react";

import { adminRequest } from "./admin-api.js";
import { useAdminResource } from "./admin-resource.js";
import { PdgaCredit, PdgaLink, pdgaEventHref } from "../shared/pdga-credit.js";

const h = React.createElement;
const BASE = "/admin/pdga-baselines";
const QUALITY = {
  exact: "Exact match", close: "Close match", unverified: "Needs hole lengths",
  ambiguous: "Two layouts equally close", none: "No matching layout",
};
const QUEUE_STATUS = { pending: "Waiting", in_progress: "Reading", done: "Finished", failed: "Failed" };
const REVIEW_ERRORS = {
  layout_geometry_mismatch: "That layout has a different hole count or different pars.",
  layout_not_found: "That layout was not found.",
  layout_required: "Choose one of our layouts first.",
};

/** Like useAdminResource, but keeps showing the last loaded data while a refresh is in flight. */
function useSteadyResource(path, token, revision) {
  const result = useAdminResource(path, token, revision);
  const [last, setLast] = React.useState(null);
  React.useEffect(() => {
    if (result.status === "ready") setLast({ path, data: result.data });
  }, [path, result.status, result.data]);
  return { status: result.status, data: result.data ?? (last?.path === path ? last.data : null) };
}

function dateLabel(raw) {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return "";
  const date = new Date(raw.slice(0, 10) + "T12:00:00Z");
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(date) : "";
}

function count(value, one, many) {
  return value + " " + (value === 1 ? one : many);
}

function ssaLabel(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "–";
}

function signed(value) {
  return typeof value === "number" ? (value > 0 ? "+" : "") + value : "–";
}

function Metrics({ rows, className = "" }) {
  return h("dl", { className: "course-operator-metrics" + (className ? " " + className : "") }, rows.map(([label, value]) =>
    h("div", { key: label }, h("dt", null, label), h("dd", null, value))));
}

function LayoutRounds({ layout }) {
  const baseline = layout.baseline;
  return h("details", { className: "course-operator-detail", "data-admin-pdga-layout": layout.id }, [
    h("summary", { key: "name" }, layout.name + " · " + (baseline ? "SSA\u00a0" + ssaLabel(baseline.ssa) : "No usable PDGA rounds")),
    baseline ? h("p", { className: "al-note", key: "provenance" }, baseline.provenance + ". No-wind range " + ssaLabel(baseline.minSsa) +
      "–" + ssaLabel(baseline.maxSsa) + " · " + count(baseline.officialRounds, "official", "official") + ".") : null,
    h("ul", { key: "rounds" }, layout.rounds.map((round) => h("li", { key: round.tournId + ":" + round.round + ":" + round.pdgaLayoutId }, [
      dateLabel(round.date) + " · ",
      h(PdgaLink, { href: pdgaEventHref(round.tournId), key: "event" }, round.eventName + " round " + round.round),
      " · ",
    ], [
      round.pdgaLayoutName, "SSA\u00a0" + ssaLabel(round.ssa),
      count(round.ratedPlayers, "rated player", "rated players"),
      round.gustMph != null ? "gust " + round.gustMph + " mph" : round.weatherStatus === "pending" ? "wind pending" : "no wind data",
      round.ratingsStatus === "official" ? "official ratings" : "ratings unconfirmed",
      round.reviewStatus === "confirmed" ? "confirmed by an admin" : QUALITY[round.quality],
      round.fitsCurrentLayout === "none" && round.reviewStatus !== "confirmed" ? "no longer fits this layout" : "",
    ].filter(Boolean).join(" · ")))),
  ]);
}

/** PDGA rounds matched to the selected course's layouts, with each layout's baseline and provenance. */
export function CoursePdgaBaselines({ courseId, token, revision }) {
  const result = useSteadyResource(BASE + "/courses/" + encodeURIComponent(courseId), token, revision);
  const layouts = result.data?.layouts ?? [];
  const withRounds = layouts.filter((layout) => layout.rounds.length);
  const without = layouts.filter((layout) => !layout.rounds.length);
  return h("section", { className: "al-section course-operator-section", "data-admin-pdga-course": result.status, "aria-labelledby": "admin-pdga-course-title" }, [
    h("h2", { className: "al-h", id: "admin-pdga-course-title", key: "title" }, "PDGA rating baselines"),
    h("p", { className: "al-note", key: "about" }, "Official SSAs from PDGA rated rounds on layouts that match this course, adjusted to no wind. Casual rounds and small events (fewer than three rated players) use the median of the six most recent rounds from the three years before them, plus their own wind."),
    result.status === "loading" && !result.data ? h("p", { className: "al-note", role: "status", key: "loading" }, "Loading PDGA rounds…") : null,
    result.status === "error" ? h("p", { className: "al-note", role: "alert", key: "error" }, "Could not load PDGA rounds for this course.") : null,
    ...withRounds.map((layout) => h(LayoutRounds, { layout, key: layout.id })),
    result.status === "ready" && !withRounds.length ? h("p", { className: "al-note", key: "empty" }, "No PDGA rated rounds match this course's layouts yet.") : null,
    without.length && withRounds.length ? h("p", { className: "al-note", key: "without" }, "No PDGA rounds: " + without.map((layout) => layout.name).join(", ")) : null,
    h(PdgaCredit, { key: "pdga-credit" }),
  ]);
}

function ReviewItem({ item, token, onChanged }) {
  const options = item.candidates;
  const [choice, setChoice] = React.useState(String(item.proposedLayoutId ?? options[0]?.layoutId ?? ""));
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const choiceId = Number(choice);

  async function decide(action) {
    setBusy(true);
    setMessage("");
    try {
      const response = await adminRequest(BASE + "/matches/" + item.pdgaLayoutId, { token, method: "POST",
        body: action === "reject" ? { action } : choiceId === item.proposedLayoutId ? { action: "confirm" } : { action: "assign", layoutId: choiceId } });
      const body = await response.json().catch(() => ({}));
      if (response.ok) onChanged(action === "reject" ? "PDGA layout rejected." : "PDGA layout matched.");
      else setMessage(REVIEW_ERRORS[body.error] || "Could not save the decision.");
    } catch {
      setMessage("Could not save the decision.");
    } finally {
      setBusy(false);
    }
  }

  const summary = item.courseName + " · " + item.layoutName;
  return h("details", { className: "course-operator-detail", "data-admin-pdga-review": item.pdgaLayoutId }, [
    h("summary", { key: "name" }, summary),
    h("p", { className: "al-note", key: "facts" }, [
      count(item.holes, "hole", "holes"), item.par ? "par " + item.par : "", item.lengthFt ? Number(item.lengthFt).toLocaleString() + " ft" : "",
      count(item.rounds, "round", "rounds"), item.eventName, dateLabel(item.lastDate),
    ].filter(Boolean).join(" · ")),
    h("p", { className: "al-note", key: "quality" }, QUALITY[item.quality] + (item.reason ? ". " + item.reason + "." : ".")),
    options.length ? h("label", { key: "choice" }, "Our layout", h("select", { "aria-label": "Our layout for " + summary, value: choice, disabled: busy,
      onChange: (event) => setChoice(event.target.value) }, options.map((option) => h("option", { key: option.layoutId, value: String(option.layoutId) },
      option.layoutName + " · " + option.parMatches + "/" + option.holes + " pars · " + option.lengthMatches + "/" + option.holes +
        " lengths · " + option.courseName))))
      : h("label", { key: "choice" }, "Our layout ID", h("input", { "aria-label": "Our layout ID for " + summary, inputMode: "numeric",
        value: choice, disabled: busy, onChange: (event) => setChoice(event.target.value.replace(/\D/g, "")) })),
    h("div", { className: "course-operator-actions", key: "actions" }, [
      h("button", { className: "admin-btn secondary", type: "button", key: "match", disabled: busy || !(choiceId > 0),
        onClick: () => decide("match") }, choiceId === item.proposedLayoutId ? "Confirm match" : "Use this layout"),
      h("button", { className: "admin-btn secondary", type: "button", key: "reject", disabled: busy, onClick: () => decide("reject") }, "Reject"),
    ]),
    message ? h("p", { className: "al-note", role: "alert", key: "message" }, message) : null,
  ]);
}

function Validation({ token, revision }) {
  const report = useSteadyResource(BASE + "/validation", token, revision);
  const data = report.data;
  return h("section", { className: "course-operator-section", "data-admin-pdga-validation": report.status, key: "validation" }, [
    h("h3", { className: "al-h", key: "title" }, "Prediction check"),
    report.status === "loading" && !data ? h("p", { className: "al-note", role: "status", key: "loading" }, "Checking predictions…") : null,
    report.status === "error" ? h("p", { className: "al-note", role: "alert", key: "error" }, "Could not load the prediction check.") : null,
    data && data.status === "no-data" ? h("p", { className: "al-note", key: "none" },
      "Not measured yet: a layout needs matched PDGA rounds on at least two different days.") : null,
    data && data.status !== "no-data" ? h(Metrics, { key: "metrics", rows: [
      ["Rounds predicted", data.predictedRounds],
      ["Player ratings compared", data.ratingPairs],
      ["Average error", data.maeRating + " pts"],
      ["Bias", signed(data.biasRating) + " pts"],
      ["SSA error", data.maeSsaStrokes + " strokes"],
    ] }) : null,
    data ? h("p", { className: "al-note", key: "method" }, [
      "Each PDGA round is predicted only from PDGA rounds of earlier events on the same layout, then compared with the ratings PDGA published.",
      data.status === "small-sample" ? "Small sample: treat these numbers as early evidence." : "",
      data.formulaPairs ? "Formula check: from each round's published PDGA SSA the engine reproduces " + count(data.formulaPairs, "published rating", "published ratings") +
        " within " + data.formulaMaeRating + " pts on average (largest gap " + data.formulaMaxAbsRating + "; PDGA rates an event's rounds on one layout from a shared SSA)." : "",
      data.clubComparisons ? "Club layout baselines vs PDGA: " + signed(data.clubMinusPdgaSsaMean) + " strokes on average over " +
        count(data.clubComparisons, "comparison", "comparisons") + "." : "",
    ].filter(Boolean).join(" ")) : null,
  ]);
}

/** Club-wide PDGA ingest: add an event, read now, review unmatched layouts, and the prediction check. */
export function PdgaBaselineTools({ token, revision, onChanged }) {
  const overview = useSteadyResource(BASE, token, revision);
  const [eventId, setEventId] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const [status, setStatus] = React.useState("");
  const data = overview.data;
  const counts = data?.queue.counts ?? {};
  const matched = (data?.matches.auto?.layouts ?? 0) + (data?.matches.confirmed?.layouts ?? 0);

  async function post(path, body, done) {
    setBusy(path);
    setStatus("");
    try {
      const response = await adminRequest(BASE + path, { token, method: "POST", body });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "failed");
      setStatus(done(result));
      onChanged();
    } catch (error) {
      setStatus(error.message === "invalid_tourn_id" ? "Enter a PDGA event number." : "That did not finish. Try again.");
    } finally {
      setBusy("");
    }
  }
  function addEvent(event) {
    event.preventDefault();
    const tournId = eventId.trim();
    void post("/events", { tournId }, () => {
      setEventId("");
      return "PDGA event " + tournId + " added. Choose Read PDGA events now, or the hourly job will pick it up.";
    });
  }
  function ingest() {
    void post("/ingest", {}, ({ summary }) => count(summary.fetches, "PDGA request", "PDGA requests") + ", " +
      count(summary.roundsStored, "round", "rounds") + " stored, " + count(summary.eventsCompleted, "event", "events") + " finished" +
      (summary.errors.length ? ". Some requests failed and will retry." : "."));
  }

  return h("section", { className: "al-section course-operator-section", "data-admin-pdga-tools": overview.status, "aria-labelledby": "admin-pdga-tools-title" }, [
    h("h2", { className: "al-h", id: "admin-pdga-tools-title", key: "title" }, "PDGA rated rounds"),
    h("p", { className: "al-note", key: "about" }, "Events come from members' public PDGA rating history (the last three years, in towns with our courses) and are read a few at a time each hour. Layouts must match ours on par and hole lengths before their SSAs are used, and each matched round's wind comes from Open-Meteo's historical archive."),
    overview.status === "error" ? h("p", { className: "al-note", role: "alert", key: "error" }, "Could not load PDGA rounds.") : null,
    data ? h(Metrics, { key: "metrics", className: "pdga-stat-grid", rows: [
      ["Events waiting", (counts.pending ?? 0) + (counts.in_progress ?? 0)],
      ["Events read", counts.done ?? 0],
      ["Matched layouts", matched],
      ["Needs review", data.review.length],
    ] }) : null,
    h("form", { className: "course-operator-fields", onSubmit: addEvent, key: "add" }, [
      h("label", { key: "id" }, "PDGA event number", h("input", { "aria-label": "PDGA event number", inputMode: "numeric", value: eventId,
        placeholder: "e.g. 104547", required: true, pattern: "[0-9]{1,8}", onChange: (event) => setEventId(event.target.value.replace(/\D/g, "")) })),
      h("button", { className: "admin-btn secondary", type: "submit", key: "submit", disabled: Boolean(busy) }, "Add PDGA event"),
    ]),
    h("div", { className: "course-operator-actions", key: "actions" }, [
      h("button", { className: "admin-btn secondary", type: "button", key: "ingest", disabled: Boolean(busy), onClick: ingest },
        busy === "/ingest" ? "Reading PDGA…" : "Read PDGA events now"),
    ]),
    h("p", { className: "al-note", role: "status", key: "status" }, status),
    data?.review.length ? h("h3", { className: "al-h", key: "review-title" }, "Layouts to review") : null,
    ...(data?.review ?? []).map((item) => h(ReviewItem, { item, token, key: item.pdgaLayoutId, onChanged: (message) => { setStatus(message); onChanged(); } })),
    data && !data.review.length ? h("p", { className: "al-note", key: "no-review" }, "No PDGA layouts are waiting for review.") : null,
    data?.queue.items.length ? h("details", { className: "course-operator-detail", key: "queue" }, [
      h("summary", { key: "title" }, "Event queue"),
      h("ul", { key: "items" }, data.queue.items.map((item) => h("li", { key: item.tournId }, [
        h(PdgaLink, { href: pdgaEventHref(item.tournId), key: "event" }, "#" + item.tournId + (item.name ? " " + item.name : "")),
        " · ",
      ], [
        dateLabel(item.date), QUEUE_STATUS[item.status] || item.status,
        item.remainingFetches ? count(item.remainingFetches, "request left", "requests left") : "",
        item.lastError && item.status !== "done" ? "last error " + item.lastError : "",
      ].filter(Boolean).join(" · ")))),
    ]) : null,
    h(Validation, { token, revision, key: "validation" }),
    h(PdgaCredit, { key: "pdga-credit" }),
  ]);
}
