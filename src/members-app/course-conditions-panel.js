import React from "react";

import { request, requestJson } from "./api.js";
import { useSessionToken } from "./session-token.js";
import {
  COURSE_CONDITION_LABELS,
  COURSE_CONDITION_STATUSES,
  latestConditionsByCourse,
  normalizeCondition,
} from "../shared/course-conditions-model.js";

const h = React.createElement;

function fallbackUnlessAborted(error, fallback) {
  if (error?.name === "AbortError") throw error;
  return fallback;
}

function postErrorMessage(status) {
  if (status === 401) return "Sign in to report course conditions.";
  if (status === 429) return "Too many reports. Try again in a bit.";
  if (status === 400) return "Pick a valid course condition.";
  if (status === 404) return "That course isn't in the club catalog.";
  if (status === 413) return "Keep the note under 280 characters.";
  return "Couldn't save that report.";
}

function ConditionPill({ condition }) {
  return h("span", {
    className: "course-condition-badge " + condition.status,
    "data-course-condition": condition.status,
  }, condition.label);
}

function ReportRow({ report }) {
  const note = report.note ? " — " + report.note : "";
  return h("div", { className: "course-conditions-row" }, [
    h("div", { className: "course-conditions-copy", key: "copy" }, [
      h("div", { className: "course-conditions-course", key: "name" }, report.courseName || "Course"),
      h("div", { className: "course-conditions-meta", key: "meta" }, [
        report.memberName || "Member",
        report.when ? " · " + report.when : "",
        note,
      ].join("")),
    ]),
    h(ConditionPill, { condition: report, key: "pill" }),
  ]);
}

export function CourseConditionsPanel() {
  const token = useSessionToken();
  const [courses, setCourses] = React.useState([]);
  const [reports, setReports] = React.useState([]);
  const [courseId, setCourseId] = React.useState("");
  const [status, setStatus] = React.useState("playable");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState({ text: "", tone: "" });

  const reload = React.useCallback((signal) => {
    return Promise.all([
      requestJson("/courses", { signal }).catch((error) => fallbackUnlessAborted(error, { courses: [] })),
      requestJson("/course-conditions", { signal }).catch((error) => fallbackUnlessAborted(error, { reports: [] })),
    ]).then(([courseData, reportData]) => {
      const list = Array.isArray(courseData?.courses) ? courseData.courses : [];
      setCourses(list.filter((course) => course && course.id != null && course.name).sort((a, b) => String(a.name).localeCompare(String(b.name))));
      setReports(latestConditionsByCourse(reportData?.reports));
    }).catch((error) => {
      if (error?.name === "AbortError") return;
      setMessage({ text: "Couldn't load course conditions.", tone: "error" });
    });
  }, []);

  React.useEffect(() => {
    const ac = new AbortController();
    reload(ac.signal);
    return () => ac.abort();
  }, [reload]);

  async function onSubmit(event) {
    event.preventDefault();
    if (!token) {
      setMessage({ text: "Sign in to report course conditions.", tone: "error" });
      return;
    }
    const id = Number(courseId);
    if (!Number.isInteger(id) || id <= 0) {
      setMessage({ text: "Pick a course.", tone: "error" });
      return;
    }
    setBusy(true);
    setMessage({ text: "", tone: "" });
    try {
      const response = await request(`/courses/${id}/conditions`, {
        token,
        method: "POST",
        body: { status, note: note.trim() || undefined },
      });
      if (!response.ok) {
        setMessage({ text: postErrorMessage(response.status), tone: "error" });
        return;
      }
      const payload = await response.json();
      const created = normalizeCondition(payload?.report);
      setNote("");
      setMessage({ text: "Report posted. Thanks.", tone: "success" });
      if (created) {
        setReports((current) => latestConditionsByCourse([created, ...current]));
      } else {
        await reload();
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      setMessage({ text: "Couldn't save that report.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return h("section", {
    className: "course-conditions-panel",
    "data-react-course-conditions": "ready",
    "aria-labelledby": "reactCourseConditionsTitle",
  }, [
    h("h3", { className: "course-conditions-title", id: "reactCourseConditionsTitle", key: "title" }, "Course conditions"),
    h("p", { className: "course-conditions-note", key: "intro" }, "If you just walked a course, tell the club whether it's dry, playable, wet, flooded, or closed."),
    h("form", { className: "casual-form", onSubmit, key: "form" }, [
      h("label", { className: "casual-field", key: "course" }, [
        "Course",
        h("select", {
          className: "form-input",
          value: courseId,
          onChange: (event) => setCourseId(event.target.value),
          required: true,
        }, [
          h("option", { value: "", key: "empty" }, "Select a course"),
          ...courses.map((course) => h("option", { value: String(course.id), key: course.id }, course.name)),
        ]),
      ]),
      h("label", { className: "casual-field", key: "status" }, [
        "Condition",
        h("select", {
          className: "form-input",
          value: status,
          onChange: (event) => setStatus(event.target.value),
        }, COURSE_CONDITION_STATUSES.map((value) => h("option", { value, key: value }, COURSE_CONDITION_LABELS[value]))),
      ]),
      h("label", { className: "casual-field notes", key: "note" }, [
        "Note (optional)",
        h("input", {
          className: "form-input",
          maxLength: 280,
          placeholder: "Standing water on 12, skip the woods layout, etc.",
          value: note,
          onChange: (event) => setNote(event.target.value),
        }),
      ]),
      h("button", { type: "submit", className: "passkey-btn", disabled: busy || !token, key: "submit" }, busy ? "Posting..." : "Post condition"),
      message.text ? h("div", { className: "casual-status " + (message.tone === "error" ? "error" : ""), key: "status" }, message.text) : null,
    ]),
    reports.length
      ? h("div", { className: "course-conditions-list", key: "list" }, reports.map((report) => h(ReportRow, { report, key: report.id || report.courseName })))
      : h("p", { className: "dash-note", key: "empty" }, "No member reports yet. Be the first after you play."),
  ]);
}
