// Admin moderation for Lost & Found: reports, photos still waiting for a redacted copy, AI match review,
// recent karma (with reversal), hidden items and the log. Every action needs a short reason; the Worker logs
// it. Admins see scores and reason codes, never the private ink text or the original photos.
import React from "react";

import { adminJson, adminToken } from "./admin-api.js";
import { currentAdminActiveTab, currentAdminAuthGateState } from "./admin-shell-state.js";

const h = React.createElement;

const REASONS = {
  not_mine: "Claiming someone else's disc", wrong_info: "Wrong or misleading details", privacy: "Shows private information",
  inappropriate: "Inappropriate", spam: "Spam", other: "Something else",
};
const PHOTO_ERRORS = {
  ai_unavailable: "AI unavailable", ai_unsure: "AI unsure about the writing", ai_budget: "Daily AI budget used", redact_failed: "Couldn't process the image",
  original_missing: "Original missing",
};

function access() {
  return currentAdminActiveTab() === "lost-found" && currentAdminAuthGateState().status === "panel";
}

function when(value) {
  const text = String(value || "");
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(" ", "T") + "Z" : text);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function who(person) {
  if (!person) return "Unknown";
  return (person.name || "Someone") + (person.kind === "guest" ? " (guest)" : "");
}

function ReasonField({ value, onChange, id }) {
  return h("label", { className: "admin-market-reason", htmlFor: id }, [
    "Reason (logged)",
    h("input", { id, key: "input", maxLength: 200, onChange: (event) => onChange(event.target.value), type: "text", value }),
  ]);
}

function useModeration(reload) {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  async function act(path, body, done) {
    if (!access() || busy) return false;
    if (!body.reason || body.reason.trim().length < 3) {
      setMessage("Add a reason (3+ characters) first.");
      return false;
    }
    const token = adminToken();
    setBusy(true);
    setMessage("");
    try {
      await adminJson(path, { body: { ...body, reason: body.reason.trim() }, method: "POST", token });
      if (access() && token === adminToken()) {
        setMessage(done);
        window.dispatchEvent(new CustomEvent("gvdg:admin-needs-refresh"));
        await reload();
      }
      return true;
    } catch (error) {
      setMessage(error.status === 409 ? "That changed in the meantime. The list has been refreshed." : "That action couldn't save.");
      if (error.status === 409) await reload();
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { act, busy, message };
}

function Card({ data, title, meta, text, children, reasonId, reload, actions }) {
  const [reason, setReason] = React.useState("");
  const { act, busy, message } = useModeration(reload);
  const btn = ([label, path, body, done, primary]) => h("button", {
    className: primary ? "admin-btn" : "admin-btn secondary", disabled: busy, key: label, onClick: () => act(path, { ...body, reason }, done), type: "button",
  }, label);
  return h("li", { className: "al-section admin-market-report", ...data }, [
    h("h3", { className: "al-h", key: "title" }, title),
    meta ? h("p", { className: "al-note", key: "meta" }, meta) : null,
    text ? h("p", { className: "admin-community-review", key: "text" }, text) : null,
    children,
    actions.length ? h(ReasonField, { id: reasonId, key: "reason", onChange: setReason, value: reason }) : null,
    actions.length ? h("div", { className: "admin-today-actions admin-market-actions", key: "actions" }, actions.filter(Boolean).map(btn)) : null,
    message ? h("p", { className: "dash-note", key: "message", role: "status" }, message) : null,
  ]);
}

/** Close a post, or fold a duplicate into another post of the same kind. */
function PostTools({ reload }) {
  const [postId, setPostId] = React.useState("");
  const [into, setInto] = React.useState("");
  const [reason, setReason] = React.useState("");
  const { act, busy, message } = useModeration(reload);
  const id = /^\d{1,9}$/.test(postId.trim()) ? postId.trim() : "";
  const target = /^\d{1,9}$/.test(into.trim()) ? Number(into.trim()) : null;
  return h("div", { className: "al-section", "data-admin-lf-post-tools": "true" }, [
    h("div", { className: "admin-lf-post-fields", key: "fields" }, [
      h("label", { className: "admin-market-reason", htmlFor: "lf-post-id", key: "post" }, ["Post #",
        h("input", { id: "lf-post-id", inputMode: "numeric", key: "input", maxLength: 9, onChange: (event) => setPostId(event.target.value), type: "text", value: postId })]),
      h("label", { className: "admin-market-reason", htmlFor: "lf-post-into", key: "into" }, ["Duplicate of post # (to merge)",
        h("input", { id: "lf-post-into", inputMode: "numeric", key: "input", maxLength: 9, onChange: (event) => setInto(event.target.value), type: "text", value: into })]),
    ]),
    h(ReasonField, { id: "lf-post-reason", key: "reason", onChange: setReason, value: reason }),
    h("div", { className: "admin-today-actions admin-market-actions", key: "actions" }, [
      h("button", { className: "admin-btn secondary", disabled: busy || !id, key: "close", onClick: () => act(`/admin/lost-found/posts/${id}/close`, { reason }, "Post closed."), type: "button" }, "Close post"),
      h("button", { className: "admin-btn secondary", disabled: busy || !id || !target, key: "merge",
        onClick: () => act(`/admin/lost-found/posts/${id}/merge`, { into: target, reason }, "Post merged."), type: "button" }, "Merge into duplicate"),
    ]),
    message ? h("p", { className: "dash-note", key: "message", role: "status" }, message) : null,
  ]);
}

function list(rows, empty, render, key) {
  return rows.length ? h("ul", { className: "admin-community-list", key }, rows.map(render)) : h("p", { className: "dash-note", key: key + "-none" }, empty);
}

export function AdminLostFoundPanel() {
  const [active, setActive] = React.useState(access);
  const [state, setState] = React.useState({ status: "loading", data: null });
  React.useLayoutEffect(() => {
    const update = () => setActive(access());
    window.addEventListener("gvdg:admin-auth-gate", update);
    window.addEventListener("gvdg:admin-active-tab", update);
    return () => {
      window.removeEventListener("gvdg:admin-auth-gate", update);
      window.removeEventListener("gvdg:admin-active-tab", update);
    };
  }, []);
  const load = React.useCallback(async () => {
    const token = adminToken();
    if (!access()) return;
    try {
      const data = await adminJson("/admin/lost-found/overview", { token });
      if (access() && token === adminToken()) setState({ status: "ready", data });
    } catch {
      if (access()) setState({ status: "error", data: null });
    }
  }, []);
  React.useEffect(() => { if (active) void load(); }, [active, load]);
  if (!active) return null;

  const data = state.data || {};
  const reports = Array.isArray(data.reports) ? data.reports : [];
  const photos = Array.isArray(data.photos) ? data.photos : [];
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const karma = Array.isArray(data.karma) ? data.karma : [];
  const hiddenPosts = Array.isArray(data.hidden?.posts) ? data.hidden.posts : [];
  const hiddenCelebrations = Array.isArray(data.hidden?.celebrations) ? data.hidden.celebrations : [];
  const log = Array.isArray(data.log) ? data.log : [];
  return h("div", { "data-admin-lost-found": state.status === "loading" ? "loading" : "ready" }, [
    h("p", { className: "al-note", key: "intro" }, "Reports, photos waiting for a blurred copy, AI match suggestions and karma. Every action needs a reason and is logged. Private ink text and original photos are never shown here."),
    h("button", { className: "admin-btn secondary", key: "refresh", onClick: () => { void load(); }, type: "button" }, "Refresh"),
    state.status === "loading" ? h("p", { className: "dash-note", key: "loading", role: "status" }, "Loading Lost & Found…") : null,
    state.status === "error" ? h("p", { className: "dash-note", key: "error", role: "alert" }, "Lost & Found couldn't load.") : null,

    h("h2", { className: "admin-pane-kicker", key: "reports-title" }, `Open reports (${reports.length})`),
    list(reports, "No open reports.", (report) => {
      const target = report.target;
      const base = report.kind === "post" ? "posts" : "celebrations";
      return h(Card, {
        actions: [
          target && !target.hidden ? [report.kind === "post" ? "Hide post" : "Hide celebration", `/admin/lost-found/${base}/${report.targetId}/hide`, {}, "Hidden.", true] : null,
          target?.hidden ? [report.kind === "post" ? "Unhide post" : "Unhide celebration", `/admin/lost-found/${base}/${report.targetId}/unhide`, {}, "Visible again."] : null,
          ["Resolve report", `/admin/lost-found/reports/${report.id}`, { action: "resolve" }, "Report resolved."],
          ["Dismiss report", `/admin/lost-found/reports/${report.id}`, { action: "dismiss" }, "Report dismissed."],
        ],
        data: { "data-admin-lf-report": report.id }, key: report.id, reasonId: "lf-report-" + report.id, reload: load,
        meta: [REASONS[report.reason] || report.reason, " · reported by ", who(report.reporter), report.createdAt ? " · " + when(report.createdAt) : ""].join(""),
        text: [report.details, target?.text].filter(Boolean).join(" — "),
        title: (target?.title || "Removed item") + (target?.owner ? " · " + who(target.owner) : ""),
      });
    }, "reports"),

    h("h2", { className: "admin-pane-kicker", key: "photos-title" }, `Photos awaiting a blurred copy (${photos.length})`),
    h("p", { className: "al-note", key: "photos-note" }, "A photo goes public only after the AI read it and the server blurred any writing. These stay private until then; the cron retries with backoff."),
    list(photos, "No photos are waiting.", (photo) => h(Card, {
      actions: [
        ["Retry now", `/admin/lost-found/photos/${photo.id}/retry`, {}, "Retried.", true],
        ["Remove photo", `/admin/lost-found/photos/${photo.id}/remove`, {}, "Photo removed."],
      ],
      data: { "data-admin-lf-photo": photo.id, "data-admin-lf-photo-status": photo.status }, key: photo.id, reasonId: "lf-photo-" + photo.id, reload: load,
      meta: [photo.status === "failed" ? "Gave up after " + photo.attempts + " tries" : "Try " + photo.attempts, PHOTO_ERRORS[photo.lastError] || photo.lastError,
        photo.createdAt ? "posted " + when(photo.createdAt) : ""].filter(Boolean).join(" · "),
      title: photo.title,
    }), "photos"),

    h("h2", { className: "admin-pane-kicker", key: "matches-title" }, `AI match suggestions (${matches.length})`),
    list(matches, "No open suggestions.", (match) => h(Card, {
      actions: [["Dismiss suggestion", `/admin/lost-found/matches/${match.id}/dismiss`, {}, "Suggestion dismissed."]],
      data: { "data-admin-lf-match": match.id }, key: match.id, reasonId: "lf-match-" + match.id, reload: load,
      meta: [`Score ${match.score}`, match.status === "notified" ? "owner notified" : "not notified", match.aiVerdict ? "photo check: " + match.aiVerdict : "",
        match.via === "roster_name" ? "member's name on the disc" : ""].filter(Boolean).join(" · "),
      text: (match.reasons || []).join(" · "),
      title: `${match.found?.title || "Found disc"} → ${match.lost ? match.lost.title + " (lost post)" : who(match.candidate)}`,
    }), "matches"),

    h("h2", { className: "admin-pane-kicker", key: "karma-title" }, "Recent karma"),
    list(karma, "No returns yet.", (row) => h(Card, {
      actions: row.reversed ? [] : [["Reverse karma", `/admin/lost-found/karma/${row.claimId}/reverse`, {}, "Karma reversed."]],
      data: { "data-admin-lf-karma": row.claimId }, key: row.claimId, reasonId: "lf-karma-" + row.claimId, reload: load,
      meta: [`+${row.points} to ${who(row.finder)}`, "owner " + who(row.owner), when(row.createdAt), row.reversed ? "reversed" : ""].filter(Boolean).join(" · "),
      title: row.disc,
    }), "karma"),

    h("h2", { className: "admin-pane-kicker", key: "hidden-title" }, "Hidden items"),
    list([...hiddenPosts.map((post) => ({ kind: "posts", item: post })), ...hiddenCelebrations.map((item) => ({ kind: "celebrations", item }))], "Nothing is hidden.",
      ({ kind, item }) => h(Card, {
        actions: [["Unhide", `/admin/lost-found/${kind}/${item.id}/unhide`, {}, "Visible again."]],
        data: { "data-admin-lf-hidden": kind + "-" + item.id }, key: kind + item.id, reasonId: `lf-unhide-${kind}-${item.id}`, reload: load,
        meta: kind === "posts" ? "Posted by " + who(item.poster) : "By " + who(item.author),
        title: kind === "posts" ? (item.kind === "lost" ? "Lost: " : "Found: ") + item.title : "Celebration: " + (item.caption || item.disc),
      }), "hidden"),

    h("h2", { className: "admin-pane-kicker", key: "post-tools-title" }, "Close or merge a post"),
    h(PostTools, { key: "post-tools", reload: load }),

    h("h2", { className: "admin-pane-kicker", key: "log-title" }, "Moderation log"),
    log.length
      ? h("ul", { className: "admin-market-log", key: "log" }, log.map((row) => h("li", { className: "al-note", key: row.id }, [
        when(row.createdAt), " · ", row.action.replace(/_/g, " "), " · ", row.targetKind, " #", row.targetId, row.reason ? " · " + row.reason : "", row.by ? " · " + row.by : "",
      ].join(""))))
      : h("p", { className: "dash-note", key: "no-log" }, "No moderation actions yet."),
  ]);
}
