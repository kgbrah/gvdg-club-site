// Admin › More: the club's PDGA discount code ($5 off a new or renewing PDGA membership; PDGA issues a new one each
// year). Members see it beside "Join or renew with PDGA"; guests and the public never do.
import React from "react";
import { adminRequest } from "./admin-api.js";

const h = React.createElement;

export function AdminPdgaPromo() {
  const [form, setForm] = React.useState({ code: "", validThrough: "" });
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    adminRequest("/admin/club-settings/pdga-promo").then((response) => response.json()).then((data) => {
      if (data && data.promo) setForm({ code: data.promo.code, validThrough: data.promo.validThrough || "" });
    }).catch(() => {});
  }, []);
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await adminRequest("/admin/club-settings/pdga-promo", { method: "PUT", body: { code: form.code.trim(), validThrough: form.validThrough.trim() } });
      const data = await response.json().catch(() => ({}));
      setMessage(response.ok ? (data.promo ? "Saved. Members see it next to Join or renew with PDGA." : "Cleared.")
        : data.error === "invalid_code" ? "Use letters, numbers, - or _ (2–40)." : data.error === "invalid_valid_through" ? "Good through: a year (2027) or a date (2027-03-31)." : "Couldn't save.");
    } catch {
      setMessage("Couldn't save.");
    } finally {
      setBusy(false);
    }
  }
  return h("section", { className: "admin-tools-group", "aria-label": "PDGA club discount code", "data-admin-pdga-promo": "" }, [
    h("h2", { className: "admin-pane-kicker", key: "title" }, "PDGA club discount code"),
    h("p", { className: "al-note", key: "about" }, "PDGA's $5-off code for club members (it changes each year). Members see it beside “Join or renew with PDGA”; PDGA asks clubs not to share it outside the club, so guests never see it."),
    h("form", { className: "course-operator-fields", onSubmit: save, key: "form" }, [
      h("label", { key: "code" }, ["Code", h("input", { key: "input", value: form.code, autoComplete: "off", onChange: (e) => setForm({ ...form, code: e.target.value }) })]),
      h("label", { key: "through" }, ["Good through (year or date)", h("input", { key: "input", value: form.validThrough, placeholder: String(new Date().getFullYear()),
        onChange: (e) => setForm({ ...form, validThrough: e.target.value }) })]),
      h("div", { className: "course-operator-actions", key: "actions" }, h("button", { className: "admin-btn", type: "submit", disabled: busy }, busy ? "Saving…" : "Save code")),
    ]),
    message ? h("p", { className: "al-note", role: "status", key: "message" }, message) : null,
  ]);
}
