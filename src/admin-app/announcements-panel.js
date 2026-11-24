// Admin > Members > Announcements: post club-wide announcements that show on Member Home,
// add an inbox notice for active members, and send Web Push to members with announcements enabled.
import React from "react";

import { adminRequest } from "./admin-api.js";
import { adminConfirm } from "./admin-dialogs.js";

const h = React.createElement;

const LINK_OPTIONS = [
  ["/gvdg-members.html#home", "Member Home"],
  ["/gvdg-members.html#events", "Events"],
  ["/gvdg-members.html#board", "Message board"],
  ["/gvdg-members.html#club", "Club directory"],
];

function linkLabelFor(href) {
  return LINK_OPTIONS.find(([value]) => value === href)?.[1] || "Member Home";
}

async function apiJson(path, options) {
  try {
    const response = await adminRequest(path, options);
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "network" } };
  }
}

export function AdminAnnouncementsPanel() {
  const [announcements, setAnnouncements] = React.useState([]);
  const [status, setStatus] = React.useState("loading");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [href, setHref] = React.useState("/gvdg-members.html#home");
  const [submitting, setSubmitting] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState(null);
  const [notice, setNotice] = React.useState("");
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    const res = await apiJson("/admin/announcements");
    if (!res.ok) {
      setStatus("error");
      return;
    }
    setAnnouncements(Array.isArray(res.data?.announcements) ? res.data.announcements : []);
    setStatus("ready");
  }, []);

  React.useEffect(() => {
    void load();
    const onTab = (event) => { if (event.detail?.tab === "announcements") void load(); };
    const onHash = () => { if (/#announcements/.test(window.location.hash)) void load(); };
    window.addEventListener("gvdg:admin-active-tab", onTab);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("gvdg:admin-active-tab", onTab);
      window.removeEventListener("hashchange", onHash);
    };
  }, [load]);

  async function submitAnnouncement(event) {
    event.preventDefault();
    if (submitting) return;
    setError("");
    setNotice("");
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle || !trimmedBody) {
      setError("Enter both a title and a message.");
      return;
    }
    setSubmitting(true);
    const res = await apiJson("/admin/announcements", {
      method: "POST",
      body: { title: trimmedTitle, body: trimmedBody, href },
    });
    setSubmitting(false);
    if (!res.ok || !res.data?.announcement) {
      setError("Could not post announcement. Check fields and try again.");
      return;
    }
    const created = res.data.announcement;
    const count = Number(res.data?.notifiedCount) || 0;
    setAnnouncements((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    setTitle("");
    setBody("");
    setNotice(`Posted "${created.title}" and queued push notifications (${count} active member(s)).`);
  }

  async function removeAnnouncement(item) {
    if (deletingId != null) return;
    const confirmed = await adminConfirm({
      title: "Delete announcement?",
      message: `Remove "${item.title}" from club announcements?`,
      confirmText: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;
    setDeletingId(item.id);
    setError("");
    const res = await apiJson(`/admin/announcements/${item.id}`, { method: "DELETE" });
    setDeletingId(null);
    if (!res.ok) {
      setError("Could not delete announcement.");
      return;
    }
    setAnnouncements((current) => current.filter((row) => row.id !== item.id));
  }

  return h("div", { className: "admin-announcements-panel", "data-admin-announcements": status }, [
    h("form", {
      className: "admin-surface admin-form admin-announcements-form",
      key: "form",
      onSubmit: submitAnnouncement,
    }, [
      h("h2", { className: "al-h", key: "heading" }, "Post club announcement"),
      h("p", { className: "al-note", key: "sub" }, "Shows on Member Home, adds an inbox notice, and sends a push notification to members with notifications enabled."),
      h("div", { className: "admin-announcements-field", key: "title" }, [
        h("label", { htmlFor: "annTitle", key: "l" }, "Title"),
        h("input", {
          id: "annTitle",
          key: "i",
          maxLength: 80,
          placeholder: "e.g. Saturday Course Update",
          required: true,
          value: title,
          onChange: (event) => setTitle(event.target.value),
        }),
      ]),
      h("div", { className: "admin-announcements-field", key: "body" }, [
        h("label", { htmlFor: "annBody", key: "l" }, "Message"),
        h("textarea", {
          id: "annBody",
          key: "i",
          maxLength: 500,
          placeholder: "Share club news, schedule changes, or updates…",
          required: true,
          rows: 3,
          value: body,
          onChange: (event) => setBody(event.target.value),
        }),
      ]),
      h("div", { className: "admin-announcements-field", key: "href" }, [
        h("label", { htmlFor: "annHref", key: "l" }, "Link button opens"),
        h("select", {
          id: "annHref",
          key: "i",
          value: href,
          onChange: (event) => setHref(event.target.value),
        }, LINK_OPTIONS.map(([value, label]) => h("option", { key: value, value }, label))),
      ]),
      error ? h("p", { className: "al-note", key: "err", role: "alert" }, error) : null,
      notice ? h("p", { className: "al-note", key: "note", role: "status" }, notice) : null,
      h("button", {
        className: "admin-btn",
        disabled: submitting,
        key: "submit",
        type: "submit",
      }, submitting ? "Sending…" : "Post announcement & send push"),
    ]),
    h("section", { className: "admin-announcements-list", key: "list", "aria-label": "Recent announcements" }, [
      h("h3", { className: "al-h", key: "title" }, "Recent announcements"),
      status === "loading" ? h("p", { className: "al-note", key: "loading", role: "status" }, "Loading announcements…") : null,
      status === "error" ? h("p", { className: "al-note", key: "load-err", role: "alert" }, "Could not load announcements.") : null,
      status === "ready" && !announcements.length ? h("p", { className: "al-note", key: "empty" }, "No announcements posted yet.") : null,
      ...announcements.map((item) => h("article", {
        className: "admin-surface admin-announcement-card",
        "data-admin-announcement": item.id,
        key: item.id,
      }, [
        h("div", { className: "admin-announcement-head", key: "head" }, [
          h("h4", { className: "admin-announcement-title", key: "title" }, item.title),
          h("p", { className: "al-note admin-announcement-meta", key: "meta" }, [
            item.authorName || "Club admin",
            String(item.createdAt || "").slice(0, 10),
            `Opens ${linkLabelFor(item.href)}`,
          ].filter(Boolean).join(" · ")),
        ]),
        h("p", { className: "admin-announcement-body", key: "body" }, item.body),
        h("div", { className: "admin-announcement-actions", key: "actions" }, [
          h("button", {
            className: "admin-btn secondary",
            disabled: deletingId === item.id,
            key: "delete",
            onClick: () => void removeAnnouncement(item),
            type: "button",
          }, deletingId === item.id ? "Deleting…" : "Delete"),
        ]),
      ])),
    ]),
  ]);
}
