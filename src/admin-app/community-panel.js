import React from "react";
import { adminJson, adminToken } from "./admin-api.js";
import { currentAdminActiveTab, currentAdminAuthGateState } from "./admin-shell-state.js";
import { adminConfirm } from "./admin-dialogs.js";
import { AMENITY_OPTIONS, communityDate, COURSE_AMENITIES, COURSE_DIFFICULTIES, REVIEW_REASONS } from "../shared/community-labels.js";

const h = React.createElement;

function access() {
  return currentAdminActiveTab() === "review-queue" && currentAdminAuthGateState().status === "panel";
}

function btn(label, props = {}) {
  return h("button", { className: "admin-btn secondary", type: "button", ...props }, label);
}
function status(text, key = "message") {
  return text ? h("p", { className: "dash-note", role: "status", key }, text) : null;
}
function options(rows) {
  return rows.map(([value, label]) => h("option", { value, key: value }, label));
}

function MetadataEditor({ course, saved }) {
  const [draft, setDraft] = React.useState(course);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  async function submit(event) {
    event.preventDefault();
    const token = adminToken();
    if (!access() || !token || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const { course: data } = await adminJson("/admin/community/courses/" + course.id, { token, method: "PUT", body: {
        difficulty: draft.difficulty, amenities: draft.amenities, notes: draft.notes, revision: course.revision,
      } });
      if (access() && token === adminToken()) {
        setDraft(data);
        setMessage("Course details saved.");
        saved(data);
      }
    } catch (error) {
      setMessage(error.status === 409 ? "These course details changed. Reload the course before trying again." : "Course details couldn’t save.");
    } finally { setBusy(false); }
  }

  return h("form", { className: "admin-form", "aria-label": "Course discovery metadata", onSubmit: submit }, [
    h("h3", { className: "al-h", key: "title" }, course.name),
    h("label", { key: "difficulty" }, [
      "Difficulty", h("select", { key: "option", value: draft.difficulty, onChange: (event) => setDraft({ ...draft, difficulty: event.target.value }) }, options(COURSE_DIFFICULTIES)),
    ]),
    ...COURSE_AMENITIES.map(([key, label]) => h("label", { key }, [
      label, h("select", {
        key: "option", value: draft.amenities[key],
        onChange: (event) => setDraft({ ...draft, amenities: { ...draft.amenities, [key]: event.target.value } }),
      }, options(AMENITY_OPTIONS)),
    ])),
    h("label", { key: "notes" }, [
      "Public access notes", h("textarea", { key: "input", rows: 3, maxLength: 400, value: draft.notes, onChange: (event) => setDraft({ ...draft, notes: event.target.value }) }),
    ]),
    status(course.updatedAt ? "Last updated " + communityDate(course.updatedAt) : "Choose Unknown for anything you haven’t verified.", "date"),
    status(message),
    btn(busy ? "Saving…" : "Save course details", { className: "admin-btn", key: "save", type: "submit", disabled: busy }),
  ]);
}

function CourseMetadataPanel() {
  const [query, setQuery] = React.useState("");
  const [rows, setRows] = React.useState([]);
  const [course, setCourse] = React.useState(null);
  const [message, setMessage] = React.useState("");
  async function search(event) {
    event.preventDefault();
    const token = adminToken();
    if (!access()) return;
    setMessage("");
    try {
      const { courses } = await adminJson("/community/courses?" + new URLSearchParams({ q: query.trim() }), { token });
      if (access() && token === adminToken()) {
        setRows(courses);
        setMessage(courses.length ? "" : "No courses match the search.");
      }
    } catch { setMessage("Couldn’t load courses."); }
  }
  async function select(id) {
    const token = adminToken();
    if (!id || !access()) { setCourse(null); return; }
    try {
      const { course: data } = await adminJson("/community/courses/" + id + "/reviews", { token });
      if (access() && token === adminToken()) setCourse(data);
    } catch { setMessage("Couldn’t load course details."); }
  }
  return h("details", { className: "al-section" }, [
    h("summary", { className: "al-h", key: "heading" }, "Maintain course amenities"),
    h("form", { className: "admin-form", role: "search", key: "search", onSubmit: search }, [
      h("label", { key: "label" }, ["Course name or town", h("input", { key: "input", type: "search", value: query, maxLength: 80, onChange: (event) => setQuery(event.target.value) })]),
      btn("Find course", { type: "submit", key: "find" }),
    ]),
    status(message),
    rows.length ? h("label", { className: "admin-form", key: "course" }, [
      "Course to edit", h("select", { key: "select", value: course ? String(course.id) : "", onChange: (event) => { void select(event.target.value); } },
        options([["", "Choose a course"], ...rows.map((row) => [String(row.id), row.name])])),
    ]) : null,
    course ? h(MetadataEditor, { course, key: course.id, saved: setCourse }) : null,
  ]);
}

export function AdminCommunityPanel() {
  const [active, setActive] = React.useState(access);
  const [queue, setQueue] = React.useState({ rows: [], more: false, offset: 0 });
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useLayoutEffect(() => {
    const update = () => setActive(access());
    window.addEventListener("gvdg:admin-auth-gate", update);
    window.addEventListener("gvdg:admin-active-tab", update);
    return () => {
      window.removeEventListener("gvdg:admin-auth-gate", update);
      window.removeEventListener("gvdg:admin-active-tab", update);
    };
  }, []);

  const load = React.useCallback(async (offset = 0) => {
    const token = adminToken();
    if (!access()) return;
    try {
      const data = await adminJson("/admin/community/reviews?offset=" + offset, { token });
      if (access() && token === adminToken()) setQueue((prior) => ({
        rows: offset ? prior.rows.concat(data.queue) : data.queue, more: data.more, offset,
      }));
    } catch { if (access()) setMessage("Review queue couldn’t load."); }
  }, []);
  React.useEffect(() => { if (active) void load(); }, [active, load]);

  async function moderate(row, action) {
    if (!access() || busy) return;
    if (action === "hide") {
      const yes = await adminConfirm({ title: "Hide this course review?", message: "Readers won’t see this version on the course.", confirmText: "Hide review", danger: true });
      if (!yes || !access()) return;
    }
    const token = adminToken();
    setBusy(true);
    setMessage("");
    try {
      await adminJson("/admin/community/reviews/" + row.id, { token, method: "PUT", body: { action, revision: row.revision } });
      if (access() && token === adminToken()) {
        setMessage(action === "approve" ? "Review published." : action === "hide" ? "Review hidden." : "Reports dismissed.");
        await load();
      }
    } catch (error) {
      setMessage(error.status === 409 ? "The member edited this review. The queue has been refreshed." : "This moderation action couldn’t save.");
      if (error.status === 409) await load();
    } finally { setBusy(false); }
  }

  if (!active) return null;
  const reasons = new Map(REVIEW_REASONS);
  return h("div", { "data-admin-review-queue": "ready" }, [
    status(message),
    btn("Refresh queue", { key: "refresh", onClick: () => { void load(); } }),
    queue.rows.length ? h("ul", { className: "admin-community-list", key: "reviews" }, queue.rows.map((row) => h("li", { className: "al-section", key: row.id }, [
      h("h2", { className: "al-h", key: "course" }, row.courseName),
      h("p", { className: "al-note", key: "details" }, row.rating + "/5 · " + communityDate(row.updatedAt) + (row.reportCount ? " · " + row.reportCount + " open reports" : " · Awaiting approval")),
      row.reasons ? h("p", { className: "al-note", key: "reasons" }, row.reasons.split(",").map((reason) => reasons.get(reason) || reason).join(" · ")) : null,
      row.text ? h("p", { className: "admin-community-review", key: "text" }, row.text) : null,
      h("div", { className: "admin-today-actions", key: "actions" }, [
        row.state === "pending" ? btn("Publish review", { key: "approve", disabled: busy, className: "admin-btn", onClick: () => { void moderate(row, "approve"); } }) : null,
        row.reportCount ? btn("Dismiss reports", { key: "dismiss", disabled: busy, onClick: () => { void moderate(row, "dismiss"); } }) : null,
        btn("Hide review", { key: "hide", disabled: busy, onClick: () => { void moderate(row, "hide"); } }),
      ]),
    ]))) : status("No reviews waiting.", "empty"),
    queue.more ? btn("More reviews", { key: "more", onClick: () => { void load(queue.offset + 25); } }) : null,
    h(CourseMetadataPanel, { key: "courses" }),
  ]);
}
