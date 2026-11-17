import React from "react";

import { COVERAGE_LABELS } from "../shared/course-quality.js";
import { adminRequest, adminToken } from "./admin-api.js";
import { useAdminResource as useResource } from "./admin-resource.js";
import { CoursePdgaBaselines, PdgaBaselineTools } from "./pdga-baselines-panel.js";
import { currentAdminAuthGateState, currentAdminRoute } from "./admin-shell-state.js";
import { requestAdminTab } from "./navigation.js";

const h = React.createElement;
const BASE = "/admin/course-health";
const STATUSES = { open: "Open", in_progress: "In progress", completed: "Completed" };
const PRIORITIES = { low: "Low", normal: "Normal", high: "High" };
const REASONS = {
  tee: "Missing tee", basket: "Missing basket", par: "Missing par",
  "confirmed-par": "Placeholder par", "distinct-positions": "Tee and basket positions overlap",
};
const EMPTY_TASK = { title: "", details: "", status: "open", priority: "normal", dueDate: "" };

function useAdminContext() {
  const [route, setRoute] = React.useState(currentAdminRoute);
  const [auth, setAuth] = React.useState(currentAdminAuthGateState);
  React.useEffect(() => {
    const onRoute = () => setRoute(currentAdminRoute());
    const onAuth = () => setAuth(currentAdminAuthGateState());
    window.addEventListener("gvdg:admin-active-tab", onRoute);
    window.addEventListener("gvdg:admin-auth-gate", onAuth);
    onRoute();
    onAuth();
    return () => {
      window.removeEventListener("gvdg:admin-active-tab", onRoute);
      window.removeEventListener("gvdg:admin-auth-gate", onAuth);
    };
  }, []);
  return { route, active: route.tab === "course-health" && auth.status === "panel" };
}

function defaultWindow() {
  const today = new Date();
  return { from: new Date(today.getTime() - 29 * 86_400_000).toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}

function dateLabel(raw) {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return "";
  const date = new Date(raw.slice(0, 10) + "T12:00:00Z");
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(date) : "";
}

function optionNodes(labels) {
  return Object.entries(labels).map(([value, label]) => h("option", { value, key: value }, label));
}

function OperatorMetrics({ rows }) {
  return h("dl", { className: "course-operator-metrics" }, rows.map(([label, value]) =>
    h("div", { key: label }, h("dt", null, label), h("dd", null, value))));
}

function LayoutHealth({ health, courseId, coverageDefinition }) {
  return h("section", { className: "al-section course-operator-section" }, [
    h("h2", { className: "al-h", key: "heading" }, "Layout coverage"),
    h(OperatorMetrics, { key: "metrics", rows: [
      ["Mapped layout holes", health.mappedHoles + " / " + health.holes],
      ["Approved pars", health.approvedPars + " / " + health.holes],
      ["Stale approvals", health.staleApprovals],
      ["Current hole approvals reviewed in range", health.approvalsReviewedInWindow],
      ["Tee signs awaiting review", health.pendingTeeSigns],
    ] }),
    h("p", { className: "al-note", key: "note" }, "Par approval comes from the linked official tee sign. Map and layout edits have separate update dates. Records older than " + health.staleAfterDays + " days are flagged."),
    h("details", { key: "coverage-scope" }, h("summary", null, "How coverage is counted"), h("p", { className: "al-note" }, coverageDefinition)),
    h("div", { className: "course-operator-actions", key: "actions" }, [
      h("button", { className: "admin-btn secondary", key: "layouts", type: "button",
        onClick: () => requestAdminTab("layouts", { courseId }) }, "Edit layouts"),
      h("button", { className: "admin-btn secondary", key: "signs", type: "button",
        onClick: () => requestAdminTab("tee-signs", { courseId, filter: "candidate" }) }, "Review tee signs"),
    ]),
    health.layouts.length ? health.layouts.map((layout) => {
      const issues = layout.issues.filter((hole) => hole.missing.length || hole.verification !== "approved");
      return h("details", { className: "course-operator-detail", key: layout.id }, [
        h("summary", { key: "name" }, layout.name + " · " + COVERAGE_LABELS[layout.coverage]),
        h("p", { className: "al-note", key: "meta" }, [
          layout.mappedHoles + " of " + layout.holes + " mapped · " + layout.approvedPars + " approved pars",
          layout.updatedAt ? "Data updated " + dateLabel(layout.updatedAt) : layout.listedAt ? "Listed " + dateLabel(layout.listedAt) : "No record date",
          layout.freshness === "stale" ? "Review data freshness" : "",
        ].filter(Boolean).join(" · ")),
        issues.length || layout.invalidRows || layout.unlistedHoles ? h("ul", { key: "issues" }, [
          ...issues.map((hole) => {
            const findings = hole.missing.map((key) => REASONS[key]);
            if (hole.verification === "unverified") findings.push("Par has no current tee-sign approval");
            if (hole.verification === "stale") findings.push("Par approval from " + dateLabel(hole.reviewedAt) + " is stale");
            if (hole.verification === "approval-date-unknown") findings.push("Approval date unavailable");
            return h("li", { key: hole.hole }, "Hole " + hole.hole + " · " + findings.join(", "));
          }),
          layout.invalidRows ? h("li", { key: "invalid" }, layout.invalidRows + " invalid or duplicate entries") : null,
          layout.unlistedHoles ? h("li", { key: "unlisted" }, layout.unlistedHoles + " expected hole entries missing") : null,
        ]) : h("p", { className: "al-note", key: "empty" }, "All listed holes have mapped positions and current tee-sign par approval."),
      ]);
    }) : h("p", { className: "al-note", key: "empty" }, "This course has no layouts yet."),
  ]);
}

function ReportWindow({ base, token }) {
  const [draft, setDraft] = React.useState(defaultWindow);
  const [range, setRange] = React.useState(defaultWindow);
  const [error, setError] = React.useState("");
  const [download, setDownload] = React.useState("");
  const activeExport = React.useRef(null);
  const query = new URLSearchParams(range).toString();
  const report = useResource(base + "?" + query, token);
  React.useEffect(() => () => activeExport.current?.abort(), []);

  function apply(event) {
    event.preventDefault();
    const duration = (Date.parse(draft.to) - Date.parse(draft.from)) / 86_400_000;
    if (!Number.isFinite(duration) || duration < 0 || duration > 365) {
      setError("Choose a start and end date spanning at most 366 days.");
      return;
    }
    setError("");
    setRange({ ...draft });
  }
  async function exportCsv() {
    if (activeExport.current) return;
    const controller = new AbortController();
    activeExport.current = controller;
    setDownload("Preparing CSV…");
    try {
      const response = await adminRequest(base + "/export?" + query, { token, signal: controller.signal });
      if (!response.ok) throw new Error("Report unavailable");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "gvdg-course-health.csv";
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDownload("CSV ready.");
    } catch {
      if (!controller.signal.aborted) setDownload("Could not export the full report.");
    } finally {
      if (activeExport.current === controller) activeExport.current = null;
    }
  }

  const data = report.data;
  return h(React.Fragment, null, [
    h("section", { className: "al-section course-operator-section", key: "usage" }, [
      h("h2", { className: "al-h", key: "title" }, "Recorded participation"),
      h("form", { className: "course-operator-fields", onSubmit: apply, key: "range" }, [
        ...[["from", "Start date"], ["to", "End date"]].map(([key, label]) => h("label", { key }, label, h("input", {
          "aria-label": label, type: "date", value: draft[key], required: true, onChange: (event) => setDraft({ ...draft, [key]: event.target.value }),
        }))),
        h("button", { className: "admin-btn secondary", key: "apply", type: "submit" }, "Apply dates"),
      ]),
      error ? h("p", { role: "alert", key: "error" }, error) : null,
      report.status === "loading" ? h("p", { className: "al-note", key: "loading", role: "status" }, "Loading the course report…") : null,
      report.status === "error" ? h("p", { className: "al-note", key: "failed", role: "alert" }, "Could not load the course report.") : null,
      data ? h(OperatorMetrics, { key: "counts", rows: [
        ["Completed rounds", data.participation.completedRounds],
        ["Completed player entries", data.participation.completedPlayerEntries],
        ["Unique identified players", data.participation.uniqueIdentifiedPlayers],
      ] }) : null,
      data ? h("p", { className: "al-note", key: "dates" }, dateLabel(data.window.from) + " to " + dateLabel(data.window.to) +
        " · " + data.participation.completedCompetitionRecords + " event records · " + data.participation.completedCasualCards + " casual cards · " +
        data.participation.guestEntries + " guest entries") : null,
      data ? h("details", { key: "definition" }, h("summary", null, "What counts"), h("p", { className: "al-note" }, data.participationDefinition)) : null,
      data ? h("p", { className: "al-note", key: "export-scope" }, "CSV includes participation for these dates, current layout coverage, and all maintenance tasks.") : null,
      data ? h("div", { className: "course-operator-actions", key: "export" }, [
        h("button", { className: "admin-btn secondary", key: "download", type: "button", disabled: Boolean(activeExport.current),
          onClick: exportCsv }, "Download course report CSV"),
        h("span", { className: "al-note", role: "status", key: "status" }, download),
      ]) : null,
    ]),
    data ? h(LayoutHealth, { health: data.health, courseId: data.course.id, coverageDefinition: data.coverageDefinition, key: "health" }) : null,
  ]);
}

function TaskEditor({ base, token, task, onSaved, onClose, onLatest }) {
  const [input, setInput] = React.useState(() => ({ ...EMPTY_TASK, ...task, dueDate: task?.dueDate || "" }));
  const [status, setStatus] = React.useState("");
  const [latest, setLatest] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const requestKey = React.useRef(null);
  const active = React.useRef(null);
  React.useEffect(() => () => active.current?.abort(), []);

  async function save(event) {
    event.preventDefault();
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setStatus("");
    const body = { requestId: requestKey.current ??= crypto.randomUUID(), title: input.title.trim(), details: input.details,
      priority: input.priority, status: input.status, dueDate: input.dueDate || null, ...(task ? { expectedRevision: task.revision } : {}) };
    try {
      const response = await adminRequest(base + "/tasks" + (task ? "/" + task.id : ""), { token, signal: controller.signal,
        method: task ? "PATCH" : "POST", body });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (response.ok) {
        setInput(EMPTY_TASK);
        requestKey.current = null;
        onSaved(task ? "Task updated." : "Task added.");
      } else if (response.status === 409 && result.current) {
        setLatest(result.current);
        setStatus("Another admin updated this task. Review the latest version before saving.");
      } else if (response.status === 409) {
        setStatus("This request was already used. Reload the task list before trying again.");
      } else {
        setStatus(response.status === 400 ? "Check the task title, details, and due date." : "Could not save the task. Try again.");
      }
    } catch {
      if (!controller.signal.aborted) setStatus("The save could not be confirmed. Retry with the same details.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (active.current === controller) active.current = null;
    }
  }
  function setField(field, value) {
    requestKey.current = null;
    setInput((old) => ({ ...old, [field]: value }));
  }
  function inputFor(field, label, config) {
    return h("label", { key: field }, label, h("input", { "aria-label": label, ...config, value: input[field],
      onChange: (event) => setField(field, event.target.value) }));
  }
  function selectFor(field, label, labels) {
    return h("label", { key: field }, label, h("select", { "aria-label": label, value: input[field],
      onChange: (event) => setField(field, event.target.value) }, optionNodes(labels)));
  }
  return h("form", { className: "course-operator-editor", onSubmit: save, "aria-label": task ? "Edit maintenance task" : "New maintenance task" }, [
    h("fieldset", { key: "fields", disabled: busy }, [
      h("div", { className: "course-operator-fields", key: "inputs" }, [
        inputFor("title", "Title", { type: "text", required: true, maxLength: 120 }),
        selectFor("priority", "Priority", PRIORITIES),
        selectFor("status", "Status", STATUSES),
        inputFor("dueDate", "Due date", { type: "date" }),
      ]),
      h("label", { key: "details" }, "Details", h("textarea", { "aria-label": "Details", rows: 3, maxLength: 2_000, value: input.details,
        onChange: (event) => setField("details", event.target.value) })),
      h("div", { className: "course-operator-actions", key: "actions" }, [
        h("button", { className: "admin-btn", type: "submit", key: "save", disabled: Boolean(latest) },
          busy ? "Saving…" : task ? "Save changes" : "Add task"),
        onClose ? h("button", { className: "admin-btn secondary", type: "button", key: "cancel", onClick: onClose }, "Cancel") : null,
        latest ? h("button", { className: "admin-btn secondary", type: "button", key: "latest", onClick: () => onLatest(latest) }, "Review latest version") : null,
      ]),
    ]),
    status ? h("p", { role: "alert", className: "al-note", key: "status" }, status) : null,
  ]);
}

function Maintenance({ base, token }) {
  const [filter, setFilter] = React.useState("all");
  const [pages, setPages] = React.useState([null]);
  const [editor, setEditor] = React.useState(null);
  const [refresh, setRefresh] = React.useState(0);
  const [notice, setNotice] = React.useState("");
  const query = new URLSearchParams({ status: filter });
  if (pages.at(-1)) query.set("before", String(pages.at(-1)));
  const result = useResource(base + "/tasks?" + query.toString(), token, refresh);
  function changed(message) {
    setEditor(null);
    setNotice(message);
    setRefresh((revision) => revision + 1);
  }
  return h("section", { className: "al-section course-operator-section" }, [
    h("h2", { className: "al-h", key: "heading" }, "Maintenance tasks"),
    h("details", { className: "course-operator-detail", key: "add" }, h("summary", null, "New task"),
      h(TaskEditor, { base, token, onSaved: (message) => { setPages([null]); changed(message); } })),
    h("label", { key: "filter" }, "Task status", h("select", { "aria-label": "Task status", value: filter,
      onChange: (event) => { setPages([null]); setEditor(null); setFilter(event.target.value); } }, optionNodes({ all: "All statuses", ...STATUSES }))),
    h("p", { className: "al-note", key: "status", role: "status" }, notice || (result.status === "loading" ? "Loading maintenance tasks…" : "")),
    result.status === "error" ? h("p", { role: "alert", key: "error" }, "Could not load maintenance tasks.") : null,
    result.data && !result.data.tasks.length ? h("p", { className: "al-note", key: "empty" }, "No matching tasks.") : null,
    ...((result.data?.tasks || []).map((task) => h("article", { className: "course-operator-detail", key: task.id }, [
      h("h3", { key: "title" }, task.title),
      h("p", { className: "al-note", key: "state" }, [
        STATUSES[task.status], PRIORITIES[task.priority] + " priority",
        task.dueDate ? "Due " + dateLabel(task.dueDate) : "", "Updated " + dateLabel(task.updatedAt),
      ].filter(Boolean).join(" · ")),
      task.details ? h("p", { className: "course-operator-task-copy", key: "details" }, task.details) : null,
      editor?.id === task.id ? h(TaskEditor, { key: editor.id + ":" + editor.revision, base, task: editor, token, onSaved: changed,
        onClose: () => setEditor(null), onLatest: setEditor }) : h("button", { className: "admin-btn secondary", key: "edit",
        type: "button", "aria-label": "Edit " + task.title, onClick: () => setEditor(task) }, "Edit task"),
    ]))),
    h("div", { className: "course-operator-actions", key: "pages" }, [
      pages.length > 1 ? h("button", { className: "admin-btn secondary", type: "button", key: "back",
        onClick: () => { setEditor(null); setPages(pages.slice(0, -1)); } }, "Newer tasks") : null,
      result.data?.nextBefore ? h("button", { className: "admin-btn secondary", type: "button", key: "more",
        onClick: () => { setEditor(null); setPages([...pages, result.data.nextBefore]); } }, "Older tasks") : null,
    ]),
  ]);
}

export function AdminCourseHealth() {
  const { route, active } = useAdminContext();
  const token = active ? adminToken() : "";
  const directory = useResource(active ? BASE : "", token);
  const [search, setSearch] = React.useState("");
  const [pdgaRevision, setPdgaRevision] = React.useState(0);
  if (!active) return null;
  const selection = String(route.courseId || "");
  const courses = directory.data?.courses ?? [];
  const filtered = courses.filter((course) => String(course.id) === selection ||
    [course.name, course.location].filter(Boolean).join(" ").toLowerCase().includes(search.trim().toLowerCase()));
  return h("div", { className: "course-operator", "data-react-course-health": directory.status }, [
    h("div", { className: "course-operator-fields", key: "picker" }, [
      h("label", { key: "search" }, "Find a course", h("input", { "aria-label": "Find a course", type: "search",
        value: search, placeholder: "Course or city", onChange: (event) => setSearch(event.target.value) })),
      h("label", { key: "course" }, "Course", h("select", { "aria-label": "Course", value: selection,
        onChange: (event) => requestAdminTab("course-health", { courseId: event.target.value || null }) }, [
        h("option", { value: "", key: "empty" }, directory.status === "loading" ? "Loading courses…" : "Select a course"),
        ...filtered.map((course) => h("option", { key: course.id, value: String(course.id) }, course.name + (course.location ? " · " + course.location : ""))),
      ])),
    ]),
    directory.status === "error" ? h("p", { role: "alert", key: "error" }, "Could not load the course list.") : null,
    !filtered.length && directory.status === "ready" ? h("p", { className: "al-note", key: "empty" }, "No courses match.") : null,
    selection ? h(ReportWindow, { base: BASE + "/" + encodeURIComponent(selection), token, key: "report-" + selection }) : null,
    selection ? h(CoursePdgaBaselines, { courseId: selection, token, revision: pdgaRevision, key: "pdga-" + selection }) : null,
    selection ? h(Maintenance, { base: BASE + "/" + encodeURIComponent(selection), token, key: "maintenance-" + selection }) : null,
    h(PdgaBaselineTools, { token, revision: pdgaRevision, onChanged: () => setPdgaRevision((value) => value + 1), key: "pdga-tools" }),
  ]);
}
