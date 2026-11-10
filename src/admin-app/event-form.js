import React from "react";

import { clubToday, clubWallClockToIso, isoToClubWallClock } from "../shared/events-model.js";
import { applyEventVoice, VoiceFill } from "./voice-fill.js";
import { defaultPuttingStations } from "./scoring-model.js";
import {
  calendarDaysBetween,
  minusWallMinutes,
  nextWeeklyDate,
  pickRepeatEvent,
  repeatLabel,
  shiftWallByDays,
} from "./repeat-draft.js";

const h = React.createElement;

const EMPTY_FORM = {
  checkinDeadline: "",
  courseId: "",
  date: "",
  format: "",
  handicap: false,
  leagueId: "",
  layoutName: "",
  name: "",
  notes: "",
  registrationDeadline: "",
  startsAt: "",
  status: "scheduled",
  type: "tournament",
};

const EMPTY_COURSES_STATE = { courses: [] };
const EMPTY_LEAGUES_STATE = { leagues: [] };
const EMPTY_LAYOUTS_STATE = { courseId: "", layouts: [], status: "idle" };
const PRIMARY_COURSE_ROW_KEY = "primary";

function dispatchRequest(name, detail = {}) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function normalizeCourse(course) {
  const source = course && typeof course === "object" ? course : {};
  const id = source.id == null ? "" : String(source.id);
  const name = typeof source.name === "string" && source.name ? source.name : "Untitled course";
  const location = typeof source.location === "string" && source.location ? ` - ${source.location}` : "";
  return { id, label: `${name}${location}` };
}

function normalizeLeague(league) {
  const source = league && typeof league === "object" ? league : {};
  const id = source.id == null ? "" : String(source.id);
  const name = typeof source.name === "string" && source.name ? source.name : "Untitled league";
  const season = typeof source.season === "string" && source.season ? ` (${source.season})` : "";
  return { id, label: `${name}${season}` };
}

function coursesFromState(state) {
  return Array.isArray(state.courses) ? state.courses.map(normalizeCourse) : [];
}

function leaguesFromState(state) {
  return Array.isArray(state.leagues) ? state.leagues.map(normalizeLeague) : [];
}

function normalizeLayoutsState(state) {
  const source = state && typeof state === "object" ? state : EMPTY_LAYOUTS_STATE;
  return {
    courseId: source.courseId == null ? "" : String(source.courseId),
    layouts: Array.isArray(source.layouts) ? source.layouts : [],
    status: typeof source.status === "string" ? source.status : "idle",
  };
}

function toIso(value) {
  return clubWallClockToIso(value);
}

function toLocalDateTime(raw) {
  return isoToClubWallClock(raw);
}

function parsedLiveConfig(source) {
  const raw = source.liveScoringConfig ?? source.live_scoring_config ?? null;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
      return {};
    } catch {
      return {};
    }
  }
  return {};
}

function formatFromEvent(source) {
  const live = parsedLiveConfig(source);
  const stored = typeof source.format === "string" ? source.format : "";
  if (!stored && live.scoringStyle == null && source.play_format == null) return { format: "", handicap: false };
  if (stored === "putting" || live.scoringStyle === "putting") return { format: "putting", handicap: false };
  const doubles = source.play_format === "doubles" || stored === "doubles" || live.groupFormat === "doubles";
  const scoring = stored === "stroke" || (stored !== "matchplay" && stored !== "doubles" && live.scoringStyle === "stroke")
    ? "stroke"
    : "matchplay";
  return {
    format: `${doubles ? "doubles" : "singles"}-${scoring}`,
    handicap: scoring === "stroke" && live.handicap === true,
  };
}

function formFromEvent(event) {
  const source = event && typeof event === "object" ? event : {};
  const primary = courseRowsFromEvent(source)[0];
  const scoring = formatFromEvent(source);
  return {
    checkinDeadline: toLocalDateTime(source.checkin_deadline),
    courseId: primary?.courseId ?? "",
    date: typeof source.date === "string" ? source.date : "",
    format: scoring.format,
    handicap: scoring.handicap,
    leagueId: source.league_id == null ? "" : String(source.league_id),
    layoutName: "",
    name: typeof source.name === "string" ? source.name : "",
    notes: typeof source.notes === "string" ? source.notes : "",
    registrationDeadline: toLocalDateTime(source.registration_deadline),
    startsAt: toLocalDateTime(source.starts_at),
    status: typeof source.status === "string" ? source.status : "scheduled",
    type: typeof source.type === "string" ? source.type : "tournament",
  };
}

function blankCourseRows() {
  return [{ key: PRIMARY_COURSE_ROW_KEY, courseId: "", layoutId: "" }];
}

function courseRowsFromEvent(event) {
  const source = event && typeof event === "object" ? event : {};
  const rows = Array.isArray(source.event_courses)
    ? source.event_courses.map((row, index) => {
      const item = row && typeof row === "object" ? row : {};
      return {
        key: index === 0 ? PRIMARY_COURSE_ROW_KEY : `event-course-${index}`,
        courseId: item.course_id == null ? "" : String(item.course_id),
        layoutId: item.layout_id == null ? "" : String(item.layout_id),
      };
    }).filter((row) => row.courseId)
    : [];
  if (!rows.length && source.course_id != null) {
    rows.push({
      key: PRIMARY_COURSE_ROW_KEY,
      courseId: String(source.course_id),
      layoutId: source.layout_id == null ? "" : String(source.layout_id),
    });
  }
  if (!rows.length) return blankCourseRows();
  return rows.map((row, index) => ({ ...row, key: index === 0 ? PRIMARY_COURSE_ROW_KEY : row.key }));
}

function normalizedCourseRows(rows) {
  return (Array.isArray(rows) ? rows : blankCourseRows()).map((row) => ({
    courseId: row?.courseId == null ? "" : String(row.courseId),
    layoutId: row?.layoutId == null ? "" : String(row.layoutId),
  }));
}

function eventPayload(form, courseRows, quickLayout) {
  const venueRows = normalizedCourseRows(courseRows);
  const selectedRows = venueRows.filter((row) => row.courseId || row.layoutId);
  if (selectedRows.some((row) => !row.courseId && row.layoutId)) {
    return { body: {}, message: "Pick a course before choosing a layout", valid: false };
  }
  const primaryRow = selectedRows[0] ?? { courseId: form.courseId ? String(form.courseId) : "", layoutId: "" };
  if (!venueRows[0]?.courseId && selectedRows.length > 0) {
    return { body: {}, message: "Primary course required before adding more courses", valid: false };
  }
  const chosen = String(form.format || "");
  const putting = chosen === "putting";
  const doubles = !putting && chosen.startsWith("doubles");
  const scoring = putting ? "putting" : chosen.endsWith("stroke") ? "stroke" : chosen.endsWith("matchplay") ? "matchplay" : null;
  const body = {
    checkin_deadline: toIso(form.checkinDeadline),
    course_id: primaryRow.courseId ? Number(primaryRow.courseId) : null,
    date: form.date || null,
    format: scoring === "putting" ? "putting" : scoring,
    league_id: form.leagueId ? Number(form.leagueId) : null,
    name: form.name.trim(),
    notes: form.notes.trim() || null,
    registration_deadline: toIso(form.registrationDeadline),
    starts_at: toIso(form.startsAt),
    status: form.status,
    type: form.type,
  };
  if (scoring) {
    body.play_format = doubles ? "doubles" : "singles";
    body.liveScoringConfig = {
      groupFormat: body.play_format,
      scoringStyle: scoring,
      handicap: scoring === "stroke" && form.handicap === true,
      ...(scoring === "putting" ? { putting: { stations: defaultPuttingStations() } } : {}),
    };
  }
  if (!body.name) return { body, message: "Name required", valid: false };
  const eventCourses = venueRows
    .filter((row) => row.courseId)
    .map((row, index) => ({
      course_id: Number(row.courseId),
      layout_id: row.layoutId && row.layoutId !== "__new__" ? Number(row.layoutId) : null,
      sort_order: index,
    }));
  body.event_courses = eventCourses;
  if (primaryRow.layoutId && primaryRow.layoutId !== "__new__") body.layout_id = Number(primaryRow.layoutId);
  if (primaryRow.layoutId === "__new__") {
    if (!body.course_id) return { body, message: "Pick a course before creating a layout", valid: false };
    const holeCount = Number.parseInt(quickLayout.holeCount, 10);
    const defaultPar = Number.parseInt(quickLayout.defaultPar, 10);
    if (!(holeCount >= 1 && holeCount <= 36) || !(defaultPar >= 1 && defaultPar <= 15)) {
      return { body, message: "Layout holes must be 1-36 and par 1-15", valid: false };
    }
    body.layout = { default_par: defaultPar, hole_count: holeCount, name: quickLayout.name.trim() || "Main" };
  }
  return { body, labelText: body.name, valid: true };
}

export function repeatSavePayload(source, today = clubToday(new Date())) {
  const base = formFromEvent(source);
  const anchor = base.date || String(base.startsAt || "").slice(0, 10);
  const nextDate = nextWeeklyDate(anchor, today) || anchor;
  const days = calendarDaysBetween(anchor, nextDate);
  return eventPayload({
    ...base,
    checkinDeadline: shiftWallByDays(base.checkinDeadline, days),
    date: nextDate,
    registrationDeadline: shiftWallByDays(base.registrationDeadline, days),
    startsAt: shiftWallByDays(base.startsAt, days),
    status: "scheduled",
  }, courseRowsFromEvent(source), { defaultPar: "3", holeCount: "18", name: "" });
}

function wallClockLabel(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!match) return "";
  const hour = Number(match[2]);
  const shown = hour % 12 || 12;
  const suffix = hour < 12 ? "AM" : "PM";
  const day = new Date(`${match[1]}T12:00:00Z`).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${day}, ${shown}:${match[3]} ${suffix}`;
}

function formField({ children, id, label }) {
  return h("div", { key: id }, [
    h("label", { htmlFor: id, key: "label" }, label),
    children,
  ]);
}

function option(value, label) {
  return h("option", { key: value || "blank", value }, label);
}

function layoutOption(layout) {
  return option(String(layout.id), `${layout.name}${layout.total_par != null ? ` (par ${layout.total_par})` : ""}`);
}

export function AdminEventForm() {
  const [courses, setCourses] = React.useState(() => coursesFromState(EMPTY_COURSES_STATE));
  const [leagues, setLeagues] = React.useState(() => leaguesFromState(EMPTY_LEAGUES_STATE));
  const [layoutsByCourse, setLayoutsByCourse] = React.useState({});
  const [editingEvent, setEditingEvent] = React.useState(null);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [courseRows, setCourseRows] = React.useState(blankCourseRows);
  const [layoutChoice, setLayoutChoice] = React.useState("");
  const [quickLayout, setQuickLayout] = React.useState({ defaultPar: "3", holeCount: "18", name: "" });
  const [busy, setBusy] = React.useState(false);
  const [savedEvents, setSavedEvents] = React.useState([]);
  const [timesOpen, setTimesOpen] = React.useState(false);
  const currentRequest = React.useRef("");
  const requestCounter = React.useRef(0);
  const rowCounter = React.useRef(0);
  const nameInput = React.useRef(null);

  function resetForm() {
    setEditingEvent(null);
    setForm(EMPTY_FORM);
    setCourseRows(blankCourseRows());
    setLayoutChoice("");
    setQuickLayout({ defaultPar: "3", holeCount: "18", name: "" });
    setTimesOpen(false);
    setBusy(false);
  }

  function loadLayouts(courseId, selectedLayoutId = "") {
    const nextCourseId = courseId == null ? "" : String(courseId);
    if (!nextCourseId) {
      return;
    }
    dispatchRequest("gvdg:admin-event-form-layouts-load-request", { courseId: nextCourseId, selectedLayoutId });
  }

  React.useLayoutEffect(() => {
    function updateCourses(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : EMPTY_COURSES_STATE;
      setCourses(coursesFromState(detail));
    }
    function updateLeagues(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : EMPTY_LEAGUES_STATE;
      setLeagues(leaguesFromState(detail));
    }
    function updateLayouts(event) {
      const state = normalizeLayoutsState(event.detail && typeof event.detail === "object" ? event.detail : EMPTY_LAYOUTS_STATE);
      if (!state.courseId) return;
      setLayoutsByCourse((current) => ({ ...current, [state.courseId]: state }));
    }
    function updateEvents(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      setSavedEvents(Array.isArray(detail.events) ? detail.events : []);
    }
    window.addEventListener("gvdg:admin-courses-list", updateCourses);
    window.addEventListener("gvdg:admin-leagues-list", updateLeagues);
    window.addEventListener("gvdg:admin-event-form-layouts", updateLayouts);
    window.addEventListener("gvdg:admin-events-list", updateEvents);
    return () => {
      window.removeEventListener("gvdg:admin-courses-list", updateCourses);
      window.removeEventListener("gvdg:admin-leagues-list", updateLeagues);
      window.removeEventListener("gvdg:admin-event-form-layouts", updateLayouts);
      window.removeEventListener("gvdg:admin-events-list", updateEvents);
    };
  }, []);

  React.useEffect(() => {
    function finish(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      if (!detail.requestId || detail.requestId !== currentRequest.current) return;
      setBusy(false);
      if (detail.ok === true) {
        currentRequest.current = "";
        resetForm();
      }
    }
    function edit(event) {
      const source = event.detail && event.detail.event;
      if (!source) return;
      const rows = courseRowsFromEvent(source);
      const filled = formFromEvent(source);
      setEditingEvent(source);
      setForm(filled);
      setCourseRows(rows);
      setLayoutChoice(rows[0]?.layoutId ?? "");
      setTimesOpen(Boolean(filled.registrationDeadline || filled.checkinDeadline));
      rows.forEach((row) => {
        if (row.courseId) loadLayouts(row.courseId, row.layoutId);
      });
      window.requestAnimationFrame(() => {
        nameInput.current?.focus();
        nameInput.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
    window.addEventListener("gvdg:admin-event-save-result", finish);
    window.addEventListener("gvdg:admin-event-form-edit", edit);
    window.addEventListener("gvdg:admin-event-form-reset", resetForm);
    return () => {
      window.removeEventListener("gvdg:admin-event-save-result", finish);
      window.removeEventListener("gvdg:admin-event-form-edit", edit);
      window.removeEventListener("gvdg:admin-event-form-reset", resetForm);
    };
  }, []);

  function updateField(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === "format" && !String(value).endsWith("stroke")) next.handicap = false;
      return next;
    });
  }

  function updateCourseRow(key, patch) {
    setCourseRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function selectCourse(courseId) {
    updateField("courseId", courseId);
    setLayoutChoice("");
    updateCourseRow(PRIMARY_COURSE_ROW_KEY, { courseId, layoutId: "" });
    loadLayouts(courseId);
  }

  function selectPrimaryLayout(layoutId) {
    setLayoutChoice(layoutId);
    updateCourseRow(PRIMARY_COURSE_ROW_KEY, { layoutId });
  }

  function selectAdditionalCourse(key, courseId) {
    updateCourseRow(key, { courseId, layoutId: "" });
    loadLayouts(courseId);
  }

  function selectAdditionalLayout(key, layoutId) {
    updateCourseRow(key, { layoutId });
  }

  function addCourseRow() {
    rowCounter.current += 1;
    setCourseRows((current) => [...current, { key: `event-course-new-${rowCounter.current}`, courseId: "", layoutId: "" }]);
  }

  function removeCourseRow(key) {
    setCourseRows((current) => current.filter((row) => row.key === PRIMARY_COURSE_ROW_KEY || row.key !== key));
  }

  function applyRepeat(source) {
    const today = clubToday(new Date());
    const base = formFromEvent(source);
    const anchor = base.date || String(base.startsAt || "").slice(0, 10);
    const nextDate = nextWeeklyDate(anchor, today) || anchor;
    const days = calendarDaysBetween(anchor, nextDate);
    const rows = courseRowsFromEvent(source);
    setEditingEvent(null);
    setForm({
      ...base,
      checkinDeadline: shiftWallByDays(base.checkinDeadline, days),
      date: nextDate,
      registrationDeadline: shiftWallByDays(base.registrationDeadline, days),
      startsAt: shiftWallByDays(base.startsAt, days),
      status: "scheduled",
    });
    setCourseRows(rows);
    setLayoutChoice(rows[0]?.layoutId ?? "");
    setTimesOpen(false);
    rows.forEach((row) => {
      if (row.courseId) loadLayouts(row.courseId, row.layoutId);
    });
  }

  function formForSave() {
    if (timesOpen || form.registrationDeadline || form.checkinDeadline || !form.startsAt) return form;
    return {
      ...form,
      checkinDeadline: minusWallMinutes(form.startsAt, 15),
      registrationDeadline: form.startsAt,
    };
  }

  function submit(event) {
    event.preventDefault();
    const requestId = `event-save-${requestCounter.current += 1}`;
    const payload = eventPayload(formForSave(), courseRows, quickLayout);
    currentRequest.current = requestId;
    setBusy(payload.valid);
    dispatchRequest("gvdg:admin-event-save-request", { ...payload, eventId: editingEvent?.id ?? null, requestId });
  }

  function layoutsStateFor(courseId) {
    return courseId ? (layoutsByCourse[courseId] ?? { courseId, layouts: [], status: "idle" }) : EMPTY_LAYOUTS_STATE;
  }

  function courseRowFields(row, index) {
    const primary = index === 0;
    const rowLayoutsState = layoutsStateFor(row.courseId);
    const rowLayoutOptions = rowLayoutsState.layouts.map(layoutOption);
    const courseId = primary ? "aeCourse" : `aeCourse-${row.key}`;
    const layoutId = primary ? "aeLayout" : `aeLayout-${row.key}`;
    return h("div", { className: `admin-event-course-row${primary ? " primary" : ""}`, key: row.key }, [
      formField({
        id: courseId,
        label: primary ? "Primary course" : `Course ${index + 1}`,
        children: h("select", {
          id: courseId,
          key: "input",
          onChange: (event) => primary ? selectCourse(event.target.value) : selectAdditionalCourse(row.key, event.target.value),
          value: primary ? form.courseId : row.courseId,
        }, [option("", "-"), ...courses.map((course) => option(course.id, course.label))]),
      }),
      formField({
        id: layoutId,
        label: primary ? "Primary layout" : `Layout ${index + 1}`,
        children: h("select", {
          disabled: !row.courseId || rowLayoutsState.status === "loading",
          id: layoutId,
          key: "input",
          onChange: (event) => primary ? selectPrimaryLayout(event.target.value) : selectAdditionalLayout(row.key, event.target.value),
          value: primary ? layoutChoice : row.layoutId,
        }, [
          option("", rowLayoutsState.status === "loading" ? "Loading layouts..." : "- no layout yet -"),
          ...rowLayoutOptions,
          primary && row.courseId ? option("__new__", "Create basic layout") : null,
        ]),
      }),
      primary ? null : h("button", {
        "aria-label": `Remove course ${index + 1}`,
        className: "admin-btn danger",
        key: "remove",
        onClick: () => removeCourseRow(row.key),
        type: "button",
      }, "Remove"),
    ]);
  }

  const repeatSource = editingEvent ? null : pickRepeatEvent(savedEvents, clubToday(new Date()));
  const repeatWhen = repeatSource ? nextWeeklyDate(repeatSource.date, clubToday(new Date())) : "";
  const note = editingEvent ? `Editing "${editingEvent.name || "event"}" from the Events menu.` : "Create a scheduled event, fundraiser, meeting, or league round.";
  const registrationText = wallClockLabel(form.registrationDeadline || form.startsAt);
  const checkinText = wallClockLabel(form.checkinDeadline || (form.startsAt ? minusWallMinutes(form.startsAt, 15) : ""));
  const timeNote = form.startsAt
    ? `Registration closes ${registrationText || "at the start"}. Check-in closes ${checkinText || "15 minutes before"}.`
    : "Add a start time. Registration closes then, and check-in closes 15 minutes before.";

  return h("div", { "data-react-admin-event-form": editingEvent ? "edit" : "create" }, [
    h("p", { className: "admin-form-note", id: "aeModeNote", key: "note" }, note),
    repeatSource ? h("button", {
      className: "admin-btn secondary",
      key: "repeat",
      onClick: () => applyRepeat(repeatSource),
      type: "button",
    }, repeatLabel(repeatSource, repeatWhen)) : null,
    h(VoiceFill, {
      form: "event",
      key: "voice",
      onFields: (fields) => setForm((current) => applyEventVoice(current, fields, courses)),
    }),
    h("form", { className: "admin-form", id: "adminCreateForm", key: "form", onSubmit: submit }, [
      formField({ id: "aeType", label: "Type", children: h("select", { id: "aeType", key: "input", onChange: (event) => updateField("type", event.target.value), value: form.type }, [option("tournament", "Tournament"), option("league_round", "League round"), option("fundraiser", "Fundraiser"), option("meeting", "Meeting")]) }),
      formField({ id: "aeName", label: "Name", children: h("input", { id: "aeName", key: "input", maxLength: 200, onChange: (event) => updateField("name", event.target.value), ref: nameInput, required: true, value: form.name }) }),
      formField({ id: "aeDate", label: "Date", children: h("input", { id: "aeDate", key: "input", onChange: (event) => updateField("date", event.target.value), type: "date", value: form.date }) }),
      formField({ id: "aeStartsAt", label: "Start time (ET)", children: h("input", { id: "aeStartsAt", key: "input", onChange: (event) => updateField("startsAt", event.target.value), type: "datetime-local", value: form.startsAt }) }),
      h("div", { key: "times" }, [
        h("p", { className: "admin-form-note", key: "summary" }, timeNote),
        h("button", {
          className: "admin-btn secondary",
          key: "toggle",
          onClick: () => setTimesOpen((open) => !open),
          type: "button",
        }, timesOpen ? "Hide times" : "Change times"),
        timesOpen ? formField({ id: "aeRegistrationDeadline", label: "Registration deadline (ET)", children: h("input", { id: "aeRegistrationDeadline", key: "input", onChange: (event) => updateField("registrationDeadline", event.target.value), type: "datetime-local", value: form.registrationDeadline }) }) : null,
        timesOpen ? formField({ id: "aeCheckinDeadline", label: "Check-in deadline (ET)", children: h("input", { id: "aeCheckinDeadline", key: "input", onChange: (event) => updateField("checkinDeadline", event.target.value), type: "datetime-local", value: form.checkinDeadline }) }) : null,
      ]),
      formField({ id: "aeStatus", label: "Status", children: h("select", { id: "aeStatus", key: "input", onChange: (event) => updateField("status", event.target.value), value: form.status }, [
        form.status === "live" ? h("option", { key: "live", value: "live", disabled: true, hidden: true }, "Live (from scoring)") : null,
        option("scheduled", "Scheduled"),
        option("final", "Final"),
        option("cancelled", "Cancelled"),
      ]) }),
      formField({ id: "aeFormat", label: "Format", children: h("select", { id: "aeFormat", key: "input", onChange: (event) => updateField("format", event.target.value), value: form.format }, [
        option("", "-"),
        option("singles-stroke", "Singles stroke play"),
        option("doubles-stroke", "Doubles stroke play"),
        option("singles-matchplay", "Singles matchplay"),
        option("doubles-matchplay", "Doubles matchplay"),
        option("putting", "Putting league"),
      ]) }),
      h("label", { key: "handicap", style: { display: "flex", gap: "0.5rem", alignItems: "center" } }, [
        h("input", {
          checked: String(form.format).endsWith("stroke") && form.handicap === true,
          disabled: !String(form.format).endsWith("stroke"),
          key: "box",
          onChange: (event) => updateField("handicap", event.target.checked),
          type: "checkbox",
        }),
        String(form.format).endsWith("stroke") ? "Handicap enabled" : "Handicap enabled (stroke play only)",
      ]),
      h("div", { className: "admin-event-courses", key: "event-courses" }, [
        h("h4", { className: "al-h", key: "title" }, "Courses & layouts"),
        courseRows.map(courseRowFields),
        h("button", { className: "admin-btn secondary admin-event-course-add", key: "add", onClick: addCourseRow, type: "button" }, "Add course/layout"),
      ]),
      layoutChoice === "__new__" ? h("div", { className: "al-section", id: "aeQuickLayout", key: "quick", style: { margin: 0 } }, [
        h("h4", { className: "al-h", key: "title" }, "Create layout"),
        h("div", { className: "al-row", key: "row" }, [
          h("input", { id: "aeLayoutName", key: "name", maxLength: 60, onChange: (event) => setQuickLayout((current) => ({ ...current, name: event.target.value })), placeholder: "Layout name", value: quickLayout.name }),
          h("span", { key: "holes" }, ["Holes ", h("input", { id: "aeHoleCount", key: "input", max: 36, min: 1, onChange: (event) => setQuickLayout((current) => ({ ...current, holeCount: event.target.value })), style: { width: "4.5rem" }, type: "number", value: quickLayout.holeCount })]),
          h("span", { key: "par" }, ["Par ", h("input", { id: "aeDefaultPar", key: "input", max: 15, min: 1, onChange: (event) => setQuickLayout((current) => ({ ...current, defaultPar: event.target.value })), style: { width: "4.5rem" }, type: "number", value: quickLayout.defaultPar })]),
        ]),
      ]) : null,
      formField({ id: "aeLeague", label: "League (for league rounds)", children: h("select", { id: "aeLeague", key: "input", onChange: (event) => updateField("leagueId", event.target.value), value: form.leagueId }, [option("", "-"), ...leagues.map((league) => option(league.id, league.label))]) }),
      formField({ id: "aeNotes", label: "Notes", children: h("textarea", { id: "aeNotes", key: "input", maxLength: 5000, onChange: (event) => updateField("notes", event.target.value), rows: 3, value: form.notes }) }),
      h("div", { className: "admin-form-actions", key: "actions" }, [
        h("button", { className: "admin-btn", disabled: busy, id: "aeSubmitBtn", key: "submit", type: "submit" }, busy ? (editingEvent ? "Updating..." : "Creating...") : (editingEvent ? "Update event" : "Create event")),
        editingEvent ? h("button", { className: "admin-btn secondary", id: "aeCancelEdit", key: "cancel", onClick: () => dispatchRequest("gvdg:admin-event-edit-cancel-request"), type: "button" }, "Cancel edit") : null,
      ]),
    ]),
  ]);
}
