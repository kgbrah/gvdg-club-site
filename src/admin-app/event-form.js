import React from "react";

const h = React.createElement;

const EMPTY_FORM = {
  checkinDeadline: "",
  courseId: "",
  date: "",
  format: "",
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
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toLocalDateTime(raw) {
  if (!raw) return "";
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formFromEvent(event) {
  const source = event && typeof event === "object" ? event : {};
  return {
    checkinDeadline: toLocalDateTime(source.checkin_deadline),
    courseId: source.course_id == null ? "" : String(source.course_id),
    date: typeof source.date === "string" ? source.date : "",
    format: typeof source.format === "string" ? source.format : "",
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

function eventPayload(form, layoutChoice, quickLayout) {
  const body = {
    checkin_deadline: toIso(form.checkinDeadline),
    course_id: form.courseId ? Number(form.courseId) : null,
    date: form.date || null,
    format: form.format || null,
    league_id: form.leagueId ? Number(form.leagueId) : null,
    name: form.name.trim(),
    notes: form.notes.trim() || null,
    registration_deadline: toIso(form.registrationDeadline),
    starts_at: toIso(form.startsAt),
    status: form.status,
    type: form.type,
  };
  if (!body.name) return { body, message: "Name required", valid: false };
  if (layoutChoice && layoutChoice !== "__new__") body.layout_id = Number(layoutChoice);
  if (layoutChoice === "__new__") {
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

function formField({ children, id, label }) {
  return h("div", { key: id }, [
    h("label", { htmlFor: id, key: "label" }, label),
    children,
  ]);
}

function option(value, label) {
  return h("option", { key: value || "blank", value }, label);
}

export function AdminEventForm() {
  const [courses, setCourses] = React.useState(() => coursesFromState(EMPTY_COURSES_STATE));
  const [leagues, setLeagues] = React.useState(() => leaguesFromState(EMPTY_LEAGUES_STATE));
  const [layoutsState, setLayoutsState] = React.useState(() => normalizeLayoutsState(EMPTY_LAYOUTS_STATE));
  const [editingEvent, setEditingEvent] = React.useState(null);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [layoutChoice, setLayoutChoice] = React.useState("");
  const [quickLayout, setQuickLayout] = React.useState({ defaultPar: "3", holeCount: "18", name: "" });
  const [busy, setBusy] = React.useState(false);
  const currentRequest = React.useRef("");
  const requestCounter = React.useRef(0);
  const nameInput = React.useRef(null);

  function resetForm() {
    setEditingEvent(null);
    setForm(EMPTY_FORM);
    setLayoutChoice("");
    setQuickLayout({ defaultPar: "3", holeCount: "18", name: "" });
    setBusy(false);
  }

  function loadLayouts(courseId, selectedLayoutId = "") {
    const nextCourseId = courseId == null ? "" : String(courseId);
    if (!nextCourseId) {
      setLayoutsState(normalizeLayoutsState(EMPTY_LAYOUTS_STATE));
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
      setLayoutsState(normalizeLayoutsState(event.detail && typeof event.detail === "object" ? event.detail : EMPTY_LAYOUTS_STATE));
    }
    window.addEventListener("gvdg:admin-courses-list", updateCourses);
    window.addEventListener("gvdg:admin-leagues-list", updateLeagues);
    window.addEventListener("gvdg:admin-event-form-layouts", updateLayouts);
    return () => {
      window.removeEventListener("gvdg:admin-courses-list", updateCourses);
      window.removeEventListener("gvdg:admin-leagues-list", updateLeagues);
      window.removeEventListener("gvdg:admin-event-form-layouts", updateLayouts);
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
      setEditingEvent(source);
      setForm(formFromEvent(source));
      setLayoutChoice(source.layout_id == null ? "" : String(source.layout_id));
      loadLayouts(source.course_id, source.layout_id);
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
    setForm((current) => ({ ...current, [field]: value }));
  }

  function selectCourse(courseId) {
    updateField("courseId", courseId);
    setLayoutChoice("");
    loadLayouts(courseId);
  }

  function submit(event) {
    event.preventDefault();
    const requestId = `event-save-${requestCounter.current += 1}`;
    const payload = eventPayload(form, layoutChoice, quickLayout);
    currentRequest.current = requestId;
    setBusy(payload.valid);
    dispatchRequest("gvdg:admin-event-save-request", { ...payload, eventId: editingEvent?.id ?? null, requestId });
  }

  const layoutOptions = layoutsState.layouts.map((layout) => option(String(layout.id), `${layout.name}${layout.total_par != null ? ` (par ${layout.total_par})` : ""}`));
  const note = editingEvent ? `Editing "${editingEvent.name || "event"}" from the Events menu.` : "Create a scheduled event, fundraiser, meeting, or league round.";

  return h("div", { "data-react-admin-event-form": editingEvent ? "edit" : "create" }, [
    h("p", { className: "admin-form-note", id: "aeModeNote", key: "note" }, note),
    h("form", { className: "admin-form", id: "adminCreateForm", key: "form", onSubmit: submit }, [
      formField({ id: "aeType", label: "Type", children: h("select", { id: "aeType", key: "input", onChange: (event) => updateField("type", event.target.value), value: form.type }, [option("tournament", "Tournament"), option("league_round", "League round"), option("fundraiser", "Fundraiser"), option("meeting", "Meeting")]) }),
      formField({ id: "aeName", label: "Name", children: h("input", { id: "aeName", key: "input", maxLength: 200, onChange: (event) => updateField("name", event.target.value), ref: nameInput, required: true, value: form.name }) }),
      formField({ id: "aeDate", label: "Date", children: h("input", { id: "aeDate", key: "input", onChange: (event) => updateField("date", event.target.value), type: "date", value: form.date }) }),
      formField({ id: "aeStartsAt", label: "Start time (ET)", children: h("input", { id: "aeStartsAt", key: "input", onChange: (event) => updateField("startsAt", event.target.value), type: "datetime-local", value: form.startsAt }) }),
      formField({ id: "aeRegistrationDeadline", label: "Registration deadline (ET)", children: h("input", { id: "aeRegistrationDeadline", key: "input", onChange: (event) => updateField("registrationDeadline", event.target.value), type: "datetime-local", value: form.registrationDeadline }) }),
      formField({ id: "aeCheckinDeadline", label: "Check-in deadline (ET)", children: h("input", { id: "aeCheckinDeadline", key: "input", onChange: (event) => updateField("checkinDeadline", event.target.value), type: "datetime-local", value: form.checkinDeadline }) }),
      formField({ id: "aeStatus", label: "Status", children: h("select", { id: "aeStatus", key: "input", onChange: (event) => updateField("status", event.target.value), value: form.status }, [option("scheduled", "Scheduled"), option("live", "Live"), option("final", "Final"), option("cancelled", "Cancelled")]) }),
      formField({ id: "aeFormat", label: "Format", children: h("select", { id: "aeFormat", key: "input", onChange: (event) => updateField("format", event.target.value), value: form.format }, [option("", "-"), option("stroke", "Stroke"), option("matchplay", "Matchplay"), option("doubles", "Doubles")]) }),
      formField({ id: "aeCourse", label: "Course", children: h("select", { id: "aeCourse", key: "input", onChange: (event) => selectCourse(event.target.value), value: form.courseId }, [option("", "-"), ...courses.map((course) => option(course.id, course.label))]) }),
      formField({ id: "aeLayout", label: "Layout", children: h("select", { disabled: !form.courseId || layoutsState.status === "loading", id: "aeLayout", key: "input", onChange: (event) => setLayoutChoice(event.target.value), value: layoutChoice }, [option("", layoutsState.status === "loading" ? "Loading layouts..." : "- no layout yet -"), ...layoutOptions, form.courseId ? option("__new__", "+ Create basic layout") : null]) }),
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
