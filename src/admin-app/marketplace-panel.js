// Admin moderation for the used-disc marketplace: open reports, hidden items, suspensions, and the log.
// Every action needs a short reason; the Worker logs it.
import React from "react";

import { adminJson, adminToken } from "./admin-api.js";
import { currentAdminActiveTab, currentAdminAuthGateState } from "./admin-shell-state.js";

const h = React.createElement;

const REASONS = {
  scam: "Looks like a scam", prohibited: "Not allowed here", wrong_info: "Wrong or misleading details",
  abusive: "Abusive or rude", spam: "Spam", other: "Something else",
};
const KIND_LABELS = { listing: "Listing", wanted: "WANTED post", feedback: "Feedback" };

function access() {
  return currentAdminActiveTab() === "marketplace" && currentAdminAuthGateState().status === "panel";
}

function when(value) {
  const text = String(value || "");
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(" ", "T") + "Z" : text);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function whenTime(value) {
  const text = String(value || "");
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(" ", "T") + "Z" : text);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function who(trader) {
  if (!trader) return "Unknown";
  return (trader.name || "Trader") + (trader.kind === "guest" ? " (guest)" : "") + (trader.suspended ? " · suspended" : "");
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

function ReportCard({ report, reload }) {
  const [reason, setReason] = React.useState("");
  const { act, busy, message } = useModeration(reload);
  const target = report.target;
  const owner = target?.owner;
  const id = "market-report-reason-" + report.id;
  const hideable = report.kind === "listing" || report.kind === "wanted";
  const base = report.kind === "listing" ? "listings" : "wanted";
  const btn = (label, onClick, primary = false) => h("button", {
    className: primary ? "admin-btn" : "admin-btn secondary", disabled: busy, key: label, onClick, type: "button",
  }, label);
  return h("li", { className: "al-section admin-market-report", "data-admin-market-report": report.id }, [
    h("h3", { className: "al-h", key: "title" }, (KIND_LABELS[report.kind] || "Item") + ": " + (target?.title || "Removed item")),
    h("p", { className: "al-note", key: "meta" }, [
      REASONS[report.reason] || report.reason, " · reported by ", who(report.reporter), report.createdAt ? " · " + when(report.createdAt) : "",
    ].join("")),
    report.details ? h("p", { className: "admin-community-review", key: "details" }, report.details) : null,
    target ? h("p", { className: "al-note", key: "target" }, [
      "Owner: ", who(owner),
      target.status ? " · " + target.status : "",
      target.hidden ? " · hidden" : "",
    ].join("")) : null,
    target?.text ? h("p", { className: "admin-community-review", key: "text" }, target.text) : null,
    h(ReasonField, { id, key: "reason", onChange: setReason, value: reason }),
    h("div", { className: "admin-today-actions admin-market-actions", key: "actions" }, [
      hideable && target && !target.hidden ? btn(report.kind === "listing" ? "Hide listing" : "Hide WANTED", () => act(`/admin/market/${base}/${report.targetId}/hide`, { reason }, "Hidden."), true) : null,
      hideable && target?.hidden ? btn(report.kind === "listing" ? "Unhide listing" : "Unhide WANTED", () => act(`/admin/market/${base}/${report.targetId}/unhide`, { reason }, "Visible again.")) : null,
      report.kind === "feedback" && target ? btn("Remove feedback", () => act(`/admin/market/feedback/${report.targetId}/remove`, { reason }, "Feedback removed."), true) : null,
      owner?.key && !owner.suspended ? btn("Suspend " + (owner.name || "owner"), () => act("/admin/market/suspensions", { key: owner.key, reason }, "Suspended from the marketplace.")) : null,
      btn("Resolve report", () => act(`/admin/market/reports/${report.id}`, { action: "resolve", reason }, "Report resolved.")),
      btn("Dismiss report", () => act(`/admin/market/reports/${report.id}`, { action: "dismiss", reason }, "Report dismissed.")),
    ]),
    message ? h("p", { className: "dash-note", key: "message", role: "status" }, message) : null,
  ]);
}

function UnhideRow({ kind, item, reload }) {
  const [reason, setReason] = React.useState("");
  const { act, busy, message } = useModeration(reload);
  const base = kind === "listing" ? "listings" : "wanted";
  return h("li", { className: "al-section", "data-admin-market-hidden": kind + "-" + item.id }, [
    h("h3", { className: "al-h", key: "title" }, (KIND_LABELS[kind] || "Item") + ": " + (item.title || "Untitled")),
    h("p", { className: "al-note", key: "owner" }, "Owner: " + who(kind === "listing" ? item.seller : item.poster)),
    h(ReasonField, { id: `market-unhide-${kind}-${item.id}`, key: "reason", onChange: setReason, value: reason }),
    h("button", { className: "admin-btn secondary", disabled: busy, key: "unhide", onClick: () => act(`/admin/market/${base}/${item.id}/unhide`, { reason }, "Visible again."), type: "button" }, "Unhide"),
    message ? h("p", { className: "dash-note", key: "message", role: "status" }, message) : null,
  ]);
}

function SuspensionRow({ suspension, reload }) {
  const [reason, setReason] = React.useState("");
  const { act, busy, message } = useModeration(reload);
  return h("li", { className: "al-section", "data-admin-market-suspension": suspension.id }, [
    h("h3", { className: "al-h", key: "title" }, who(suspension.trader)),
    h("p", { className: "al-note", key: "why" }, [suspension.reason, suspension.by ? " · by " + suspension.by : "", suspension.createdAt ? " · " + when(suspension.createdAt) : ""].join("")),
    h(ReasonField, { id: "market-lift-" + suspension.id, key: "reason", onChange: setReason, value: reason }),
    h("button", { className: "admin-btn secondary", disabled: busy, key: "lift", onClick: () => act(`/admin/market/suspensions/${suspension.id}/lift`, { reason }, "Suspension lifted."), type: "button" }, "Lift suspension"),
    message ? h("p", { className: "dash-note", key: "message", role: "status" }, message) : null,
  ]);
}

export function AdminMarketplacePanel() {
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
      const data = await adminJson("/admin/market/overview", { token });
      if (access() && token === adminToken()) {
        setState({ status: "ready", data });
      }
    } catch {
      if (access()) setState({ status: "error", data: null });
    }
  }, []);
  React.useEffect(() => { if (active) void load(); }, [active, load]);

  if (!active) return null;
  const data = state.data || {};
  const reports = Array.isArray(data.reports) ? data.reports : [];
  const hiddenListings = Array.isArray(data.hidden?.listings) ? data.hidden.listings : [];
  const hiddenWanted = Array.isArray(data.hidden?.wanted) ? data.hidden.wanted : [];
  const withdrawn = Array.isArray(data.withdrawn) ? data.withdrawn : [];
  const suspensions = Array.isArray(data.suspensions) ? data.suspensions : [];
  const log = Array.isArray(data.log) ? data.log : [];
  return h("div", { "data-admin-marketplace": state.status === "loading" ? "loading" : "ready" }, [
    h("p", { className: "al-note", key: "intro" }, "Members and verified guests report listings, WANTED posts and feedback here. Hide, remove or suspend with a reason; every action is logged."),
    h("button", { className: "admin-btn secondary", key: "refresh", onClick: () => { void load(); }, type: "button" }, "Refresh"),
    state.status === "loading" ? h("p", { className: "dash-note", key: "loading", role: "status" }, "Loading reports…") : null,
    state.status === "error" ? h("p", { className: "dash-note", key: "error", role: "alert" }, "Marketplace reports couldn't load.") : null,
    h("h2", { className: "admin-pane-kicker", key: "reports-title" }, `Open reports (${reports.length})`),
    reports.length
      ? h("ul", { className: "admin-community-list", key: "reports" }, reports.map((report) => h(ReportCard, { key: report.id, reload: load, report })))
      : state.status === "ready" ? h("p", { className: "dash-note", key: "no-reports" }, "No open reports.") : null,
    h("h2", { className: "admin-pane-kicker", key: "hidden-title" }, "Hidden items"),
    hiddenListings.length || hiddenWanted.length
      ? h("ul", { className: "admin-community-list", key: "hidden" }, [
        ...hiddenListings.map((item) => h(UnhideRow, { item, key: "l" + item.id, kind: "listing", reload: load })),
        ...hiddenWanted.map((item) => h(UnhideRow, { item, key: "w" + item.id, kind: "wanted", reload: load })),
      ])
      : h("p", { className: "dash-note", key: "no-hidden" }, "Nothing is hidden."),
    h("h2", { className: "admin-pane-kicker", key: "withdrawn-title" }, "Withdrawn, relist window open"),
    withdrawn.length
      ? h("ul", { className: "admin-community-list", key: "withdrawn" }, withdrawn.map((item) => h("li", { className: "al-section", "data-admin-market-withdrawn": item.id, key: item.id }, [
        h("h3", { className: "al-h", key: "title" }, "Listing: " + (item.title || "Untitled")),
        h("p", { className: "al-note", key: "meta" }, "Owner: " + who(item.seller) + (item.relistUntil ? " · final after " + whenTime(item.relistUntil) : "")),
      ])))
      : h("p", { className: "dash-note", key: "no-withdrawn" }, "No listings are waiting to become final."),
    h("h2", { className: "admin-pane-kicker", key: "susp-title" }, "Suspended from the marketplace"),
    suspensions.length
      ? h("ul", { className: "admin-community-list", key: "suspensions" }, suspensions.map((suspension) => h(SuspensionRow, { key: suspension.id, reload: load, suspension })))
      : h("p", { className: "dash-note", key: "no-susp" }, "No one is suspended."),
    h("h2", { className: "admin-pane-kicker", key: "log-title" }, "Moderation log"),
    log.length
      ? h("ul", { className: "admin-market-log", key: "log" }, log.slice(0, 30).map((row) => h("li", { className: "al-note", key: row.id }, [
        when(row.createdAt), " · ", row.action, " · ", (KIND_LABELS[row.targetKind] || row.targetKind || "item"), row.targetId != null ? " #" + row.targetId : "",
        row.reason ? " · " + row.reason : "", row.by ? " · " + row.by : "",
      ].join(""))))
      : h("p", { className: "dash-note", key: "no-log" }, "No moderation actions yet."),
  ]);
}
