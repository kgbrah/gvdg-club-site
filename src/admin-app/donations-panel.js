// Admin › Money › Donations: donations members reported (the Donate buttons, the $1 prompts, fundraisers). PayPal.me
// can't tell the app who gave, so an admin checks the club's PayPal and confirms; confirmed, the member gets +10 karma
// for every whole dollar and a thank-you (owner: "Let's make ALL donations reward +10 karma per dollar").
import React from "react";
import { adminRequest } from "./admin-api.js";

const h = React.createElement;

const SOURCES = { "club-card": "Club page", round: "after a round", event: "event results", fundraiser: "fundraiser", other: "elsewhere" };
const money = (cents) => "$" + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));
const when = (iso) => {
  const time = Date.parse(String(iso || "").replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(iso || "")) ? "" : "Z"));
  return Number.isFinite(time) ? new Date(time).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
};

async function call(path, options) {
  try {
    const response = await adminRequest(path, options);
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, data };
  } catch {
    return { ok: false, data: { error: "network" } };
  }
}

function PendingRow({ row, karmaPerDollar, onDone }) {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState("Nothing in the club's PayPal");
  async function review(decision, note = "") {
    if (busy) return;
    setBusy(true);
    setMessage("");
    const result = await call(`/admin/donations/${row.id}/review`, { method: "POST", body: { decision, reason: note.trim() } });
    setBusy(false);
    if (result.ok) onDone();
    else setMessage(result.data.error === "already_reviewed" ? "Someone already reviewed this one." : "Couldn't save. Try again.");
  }
  const karma = Math.floor(row.amountCents / 100) * karmaPerDollar;
  return h("li", { className: "admin-evrow", "data-admin-donation": row.id }, [
    h("span", { className: "ev-name", key: "who" }, `${row.memberName} · ${money(row.amountCents)}`),
    h("span", { className: "admin-event-meta", key: "meta" }, `Reported ${when(row.createdAt)}, ${SOURCES[row.source] || "elsewhere"} · +${karma} karma when confirmed`),
    rejecting ? h("form", {
      className: "admin-mark-paid-form",
      key: "reject-form",
      onSubmit: (event) => {
        event.preventDefault();
        void review("not_received", reason);
      },
    }, [
      h("input", {
        "aria-label": `Reason for marking ${row.memberName}'s donation not received`,
        autoFocus: true,
        key: "reason",
        maxLength: 200,
        onChange: (event) => setReason(event.target.value),
        placeholder: "Why? (the member sees this)",
        type: "text",
        value: reason,
      }),
      h("button", { className: "admin-btn secondary", disabled: busy, key: "confirm", type: "submit" }, busy ? "Saving…" : "Confirm not received"),
      h("button", { className: "admin-btn secondary", disabled: busy, key: "cancel", onClick: () => setRejecting(false), type: "button" }, "Cancel"),
    ]) : h(React.Fragment, { key: "actions" }, [
      h("button", { className: "admin-btn", type: "button", key: "yes", disabled: busy, onClick: () => void review("received") }, "Received"),
      h("button", { className: "admin-btn secondary", type: "button", key: "no", disabled: busy, onClick: () => setRejecting(true) }, "Not received"),
    ]),
    message ? h("span", { className: "al-note", role: "status", key: "message" }, message) : null,
  ]);
}

export function AdminDonationsPanel() {
  const [state, setState] = React.useState({ status: "loading", pending: [], recent: [], karmaPerDollar: 10 });
  const load = React.useCallback(async () => {
    const result = await call("/admin/donations");
    if (!result.ok) { setState((current) => ({ ...current, status: "error" })); return; }
    setState({ status: "ready", pending: result.data.pending || [], recent: result.data.recent || [], karmaPerDollar: result.data.karmaPerDollar || 10 });
    window.dispatchEvent(new CustomEvent("gvdg:admin-needs-refresh"));
  }, []);
  React.useEffect(() => {
    load();
    const onHash = () => { if (/#donations/.test(window.location.hash)) load(); };
    const onTab = (event) => { if (event.detail?.tab === "donations") load(); };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("gvdg:admin-active-tab", onTab);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("gvdg:admin-active-tab", onTab);
    };
  }, [load]);
  return h("div", { className: "al-section admin-donations", "data-admin-donations": state.status }, [
    h("h3", { className: "al-h", key: "title" }, "Donations to confirm"),
    h("p", { className: "al-note", key: "how" }, `Members tell the club when they donate by PayPal. Check the club's PayPal (paypal.me/greenvillediscgolf), then Received gives them +${state.karmaPerDollar} karma for every dollar and a thank-you; Not received tells them it wasn't found.`),
    state.status === "error" ? h("p", { className: "al-note", role: "alert", key: "error" }, "Couldn't load donations.") : null,
    state.status === "ready" && !state.pending.length ? h("p", { className: "al-note", key: "none" }, "Nothing waiting.") : null,
    state.pending.length ? h("ul", { className: "admin-donation-list", key: "pending" }, state.pending.map((row) => h(PendingRow, { row, karmaPerDollar: state.karmaPerDollar, onDone: load, key: row.id }))) : null,
    state.recent.length ? h("h4", { className: "al-h", key: "recent-title" }, "Recently reviewed") : null,
    state.recent.length ? h("ul", { className: "al-note admin-donation-recent", key: "recent" }, state.recent.map((row) => h("li", { key: row.id },
      `${row.memberName} · ${money(row.amountCents)} · ${row.status === "confirmed" ? `received, +${row.karma} karma` : `not received${row.reviewNote ? ` (${row.reviewNote})` : ""}`} · ${when(row.reviewedAt)}`))) : null,
    h("button", { className: "admin-btn secondary", type: "button", key: "refresh", onClick: load }, "Refresh"),
  ]);
}
