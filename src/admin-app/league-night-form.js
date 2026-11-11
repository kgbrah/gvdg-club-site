import React from "react";

import { PuttingStations } from "./scoring-panel.js";
import { defaultPuttingStations } from "./scoring-model.js";

const h = React.createElement;

const EMPTY_FORM = {
  courseId: "",
  date: "",
  format: "singles-matchplay",
  handicap: false,
  layoutId: "",
  leagueId: "",
  matchesText: "",
  start: true,
  stations: defaultPuttingStations(),
  weekLabel: "",
};

const EMPTY_COURSES = { courses: [] };
const EMPTY_LEAGUES = { leagues: [] };
const EMPTY_LAYOUTS = { courseId: "", layouts: [], status: "idle" };

function dispatchRequest(name, detail = {}) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function coursesFromState(state) {
  return (Array.isArray(state.courses) ? state.courses : []).map((course) => {
    const source = objectOrEmpty(course);
    const id = source.id == null ? "" : String(source.id);
    const name = typeof source.name === "string" && source.name ? source.name : "Untitled course";
    return { id, label: name };
  });
}

function leaguesFromState(state) {
  return (Array.isArray(state.leagues) ? state.leagues : []).map((league) => {
    const source = objectOrEmpty(league);
    const id = source.id == null ? "" : String(source.id);
    const name = typeof source.name === "string" && source.name ? source.name : "Untitled league";
    return { id, label: name, format: typeof source.format === "string" ? source.format : "" };
  });
}

function layoutsFromState(state) {
  const source = objectOrEmpty(state);
  return {
    courseId: source.courseId == null ? "" : String(source.courseId),
    layouts: Array.isArray(source.layouts) ? source.layouts : [],
    status: typeof source.status === "string" ? source.status : "idle",
  };
}

function formField({ children, id, label }) {
  return h("div", { key: id }, [
    h("label", { htmlFor: id, key: "label" }, label),
    children,
  ]);
}

function splitNightFormat(value) {
  const text = String(value || "");
  if (text === "putting" || text.endsWith("-putting")) return { group: "singles", scoring: "putting" };
  return {
    group: text.startsWith("doubles") ? "doubles" : "singles",
    scoring: text.endsWith("stroke") ? "stroke" : "matchplay",
  };
}

function nightFormatFromLeague(format) {
  const text = String(format || "").toLowerCase();
  if (!text) return null;
  if (text.includes("putt")) return { format: "putting", handicap: false };
  const doubles = text.includes("double");
  const stroke = text.includes("stroke");
  const match = text.includes("match");
  if (!doubles && !stroke && !match && text !== "singles") return null;
  const scoring = stroke && !match ? "stroke" : "matchplay";
  return {
    format: `${doubles ? "doubles" : "singles"}-${scoring}`,
    handicap: scoring === "stroke" && (text.includes("hcp") || text.includes("handicap")),
  };
}

export function AdminLeagueNightForm() {
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [busy, setBusy] = React.useState(false);
  const [courses, setCourses] = React.useState([]);
  const [leagues, setLeagues] = React.useState([]);
  const [layoutsByCourse, setLayoutsByCourse] = React.useState({});
  const [result, setResult] = React.useState(null);
  const currentRequest = React.useRef("");
  const requestCounter = React.useRef(0);

  React.useLayoutEffect(() => {
    function updateCourses(event) {
      setCourses(coursesFromState(event.detail && typeof event.detail === "object" ? event.detail : EMPTY_COURSES));
    }
    function updateLeagues(event) {
      const next = leaguesFromState(event.detail && typeof event.detail === "object" ? event.detail : EMPTY_LEAGUES);
      setLeagues(next);
      setForm((current) => {
        if (current.leagueId) return current;
        const ryder = next.find((league) => league.label.toLowerCase() === "ryder cup") || next[0];
        return ryder ? { ...current, leagueId: ryder.id } : current;
      });
    }
    function updateLayouts(event) {
      const state = layoutsFromState(event.detail);
      if (!state.courseId) return;
      setLayoutsByCourse((current) => ({ ...current, [state.courseId]: state }));
    }
    function finish(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      if (!detail.requestId || detail.requestId !== currentRequest.current) return;
      setBusy(false);
      if (detail.ok === true) {
        currentRequest.current = "";
        setResult(detail.night || { events: [] });
        setForm((current) => ({ ...current, matchesText: "" }));
      }
    }
    window.addEventListener("gvdg:admin-courses-list", updateCourses);
    window.addEventListener("gvdg:admin-leagues-list", updateLeagues);
    window.addEventListener("gvdg:admin-event-form-layouts", updateLayouts);
    window.addEventListener("gvdg:admin-league-night-result", finish);
    return () => {
      window.removeEventListener("gvdg:admin-courses-list", updateCourses);
      window.removeEventListener("gvdg:admin-leagues-list", updateLeagues);
      window.removeEventListener("gvdg:admin-event-form-layouts", updateLayouts);
      window.removeEventListener("gvdg:admin-league-night-result", finish);
    };
  }, []);

  function updateField(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === "courseId") {
        next.layoutId = "";
        if (value) dispatchRequest("gvdg:admin-event-form-layouts-load-request", { courseId: value });
      }
      if (field === "leagueId") {
        const league = leagues.find((item) => item.id === value);
        const applied = nightFormatFromLeague(league && league.format);
        if (applied) {
          next.format = applied.format;
          next.handicap = applied.handicap;
        }
      }
      if (field === "format" && !String(value).endsWith("stroke")) next.handicap = false;
      return next;
    });
  }

  function submit(event) {
    event.preventDefault();
    const requestId = `league-night-${requestCounter.current += 1}`;
    currentRequest.current = requestId;
    setBusy(true);
    setResult(null);
    const night = splitNightFormat(form.format);
    const putting = night.scoring === "putting";
    const needsLayout = form.start && !putting;
    dispatchRequest("gvdg:admin-league-night-request", {
      requestId,
      body: {
        weekLabel: form.weekLabel.trim(),
        date: form.date || null,
        format: night.group,
        scoringStyle: night.scoring,
        handicap: night.scoring === "stroke" && form.handicap === true,
        course_id: putting || !form.courseId ? null : Number(form.courseId),
        layout_id: putting || !form.layoutId ? null : Number(form.layoutId),
        start: form.start,
        matchesText: form.matchesText,
        ...(putting ? { putting: { stations: form.stations } } : {}),
      },
      leagueId: form.leagueId,
      valid: Boolean(form.leagueId && form.weekLabel.trim() && form.matchesText.trim() && (!needsLayout || form.layoutId)),
    });
    if (!form.leagueId || !form.weekLabel.trim() || !form.matchesText.trim() || (needsLayout && !form.layoutId)) setBusy(false);
  }

  const night = splitNightFormat(form.format);
  const layoutsState = layoutsByCourse[form.courseId] || EMPTY_LAYOUTS;
  const placeholder = night.group === "doubles"
    ? "Juan / Jarrett vs Jesus / Castro"
    : "Jackie vs Jesus";
  const stroke = night.scoring === "stroke";

  return h("form", {
    className: "admin-form",
    "data-react-admin-league-night-form": "ready",
    onSubmit: submit,
  }, [
    h("h3", { className: "roster-title", key: "title" }, "Start a league night"),
    h("p", { className: "al-note", key: "note" }, night.scoring === "putting"
      ? "Putting league night. No course. One player vs player line per card. Set points per make, or leave them at 1 so most makes wins."
      : "Build the night's matches, start live cards, and finished results roll into standings. One Red vs Blue line per match."),
    formField({
      id: "lnLeague",
      label: "League",
      children: h("select", { id: "lnLeague", key: "input", onChange: (event) => updateField("leagueId", event.target.value), required: true, value: form.leagueId }, [
        h("option", { key: "blank", value: "" }, "Select league"),
        ...leagues.map((league) => h("option", { key: league.id, value: league.id }, league.label)),
      ]),
    }),
    formField({
      id: "lnWeek",
      label: "Week label",
      children: h("input", { id: "lnWeek", key: "input", maxLength: 40, onChange: (event) => updateField("weekLabel", event.target.value), placeholder: "Week 7", required: true, value: form.weekLabel }),
    }),
    formField({
      id: "lnDate",
      label: "Date",
      children: h("input", { id: "lnDate", key: "input", onChange: (event) => updateField("date", event.target.value), type: "date", value: form.date }),
    }),
    formField({
      id: "lnFormat",
      label: "Format",
      children: h("select", { id: "lnFormat", key: "input", onChange: (event) => updateField("format", event.target.value), value: form.format }, [
        h("option", { key: "singles-stroke", value: "singles-stroke" }, "Singles stroke play"),
        h("option", { key: "doubles-stroke", value: "doubles-stroke" }, "Doubles stroke play"),
        h("option", { key: "singles-matchplay", value: "singles-matchplay" }, "Singles matchplay"),
        h("option", { key: "doubles-matchplay", value: "doubles-matchplay" }, "Doubles matchplay"),
        h("option", { key: "putting", value: "putting" }, "Putting league"),
      ]),
    }),
    night.scoring === "putting" ? h(PuttingStations, {
      key: "stations",
      onChange: (stations) => updateField("stations", stations),
      stations: Array.isArray(form.stations) && form.stations.length ? form.stations : defaultPuttingStations(),
    }) : null,
    h("label", { key: "handicap", style: { display: "flex", gap: "0.5rem", alignItems: "center" } }, [
      h("input", {
        checked: stroke && form.handicap === true,
        disabled: !stroke,
        key: "box",
        onChange: (event) => updateField("handicap", event.target.checked),
        type: "checkbox",
      }),
      stroke ? "Handicap enabled" : "Handicap enabled (stroke play only)",
    ]),
    formField({
      id: "lnCourse",
      label: "Course",
      children: h("select", { id: "lnCourse", key: "input", onChange: (event) => updateField("courseId", event.target.value), value: form.courseId }, [
        h("option", { key: "blank", value: "" }, "Select course"),
        ...courses.map((course) => h("option", { key: course.id, value: course.id }, course.label)),
      ]),
    }),
    formField({
      id: "lnLayout",
      label: "Layout",
      children: h("select", { id: "lnLayout", key: "input", onChange: (event) => updateField("layoutId", event.target.value), value: form.layoutId }, [
        h("option", { key: "blank", value: "" }, layoutsState.status === "loading" ? "Loading layouts..." : "Select layout"),
        ...(layoutsState.layouts || []).map((layout) => h("option", { key: String(layout.id), value: String(layout.id) }, layout.name || "Layout")),
      ]),
    }),
    formField({
      id: "lnMatches",
      label: night.scoring === "putting" ? "Cards (one player vs player line each)" : stroke ? "Cards (one Red vs Blue line each)" : "Matches (one Red vs Blue line each)",
      children: h("textarea", { id: "lnMatches", key: "input", onChange: (event) => updateField("matchesText", event.target.value), placeholder, required: true, rows: 8, value: form.matchesText }),
    }),
    h("label", { key: "start", style: { display: "flex", gap: "0.5rem", alignItems: "center" } }, [
      h("input", { checked: form.start, key: "box", onChange: (event) => updateField("start", event.target.checked), type: "checkbox" }),
      "Start live cards now",
    ]),
    h("button", { className: "admin-btn", disabled: busy, key: "submit", type: "submit" }, busy ? "Building night..." : "Build matches and start cards"),
    result && Array.isArray(result.events)
      ? h("div", { className: "player-list", key: "result" }, result.events.map((event) =>
          h("a", {
            className: "player-row",
            href: event.livePath || ("score.html?event=" + event.id),
            key: String(event.id),
          }, `${event.name} (${event.status}${event.startError ? " start failed" : ""})`)))
      : null,
  ]);
}
