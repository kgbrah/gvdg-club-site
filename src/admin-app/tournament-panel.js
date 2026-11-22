// Admin: a club event run as a PDGA event, registered on the club site. Link the PDGA event, publish the rules (cap,
// members only, non-member fee, division rating limits), choose payment options (players cover PayPal's fee, Zelle),
// and run the field: paid players in order of payment, Zelle payments to confirm, the waitlist to offer spots from,
// and the pre-registration list to post on the PDGA event page each week (PDGA Competition Manual 1.02.7).
import React from "react";
import { adminRequest } from "./admin-api.js";
import { PdgaCredit, PdgaLink, pdgaEventHref, pdgaPlayerHref } from "../shared/pdga-credit.js";
import { formatPdgaTier, STANDARD_DIVISION_LIMITS } from "../shared/pdga-divisions.js";

const h = React.createElement;

const ERRORS = {
  invalid_pdga_event: "Enter the PDGA event number (digits only).",
  pdga_event_not_found: "PDGA has no event with that number.",
  pdga_unavailable: "PDGA couldn't be reached. Try again in a few minutes.",
  invalid_rules: "Check the rating limits (300–1200) and the non-member fee.",
  invalid_cap: "The cap must be a whole number of players.",
  invalid_td_email: "Check the TD's email address.",
  td_email_required: "Enter the TD's email address (required for PDGA withdrawal requests).",
  field_full: "The field is full, so this payment can't be entered. Refund it, or offer the spot when one opens.",
  already_paid: "Already marked paid.",
  not_waitlisted: "That player isn't on the waitlist.",
  waitlist_order: "Offer the spot to the first player on the waitlist before later waitlisted players.",
  offer_expired: "That 48-hour offer expired and the player moved back to the waitlist.",
};

function dollars(cents) {
  return "$" + ((Number(cents) || 0) / 100).toFixed(2);
}

async function call(path, options) {
  const response = await adminRequest(path, options);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The pre-registration list for the PDGA event page: paid players in field order, then the waitlist. */
export function preRegistrationCsv(field, waitlist) {
  const rows = [["List", "Order", "Name", "PDGA #", "Division", "Paid at", "Method"]];
  field.forEach((row, index) => rows.push(["Registered", index + 1, row.name, row.pdga_number, row.division, row.paid_at, row.payment_method]));
  waitlist.forEach((row, index) => rows.push(["Waitlist", index + 1, row.name, row.pdga_number, row.division, "", ""]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function fieldRows(registrations) {
  const paid = registrations.filter((row) => Number(row.paid_entry) === 1).sort((a, b) =>
    String(a.paid_at || "￿").localeCompare(String(b.paid_at || "￿"))
      || (Number(a.pdga_number) || Infinity) - (Number(b.pdga_number) || Infinity) || a.id - b.id);
  const waitlist = registrations.filter((row) => Number(row.paid_entry) !== 1 && Number(row.waitlisted) === 1)
    .sort((a, b) => String(a.waitlisted_at || "\uffff").localeCompare(String(b.waitlisted_at || "\uffff"))
      || (Number(a.pdga_number) || Infinity) - (Number(b.pdga_number) || Infinity) || a.id - b.id);
  const pending = registrations.filter((row) => Number(row.paid_entry) !== 1 && Number(row.waitlisted) !== 1);
  return { paid, waitlist, pending };
}

function Settings({ eventId, settings, onSaved }) {
  const [form, setForm] = React.useState(() => ({
    pdgaEventId: settings?.pdgaEventId ?? "", playerCap: settings?.playerCap ?? "", membersOnly: Boolean(settings?.rules?.membersOnly),
    nonMemberFee: settings?.rules?.nonMemberFeeCents ? (settings.rules.nonMemberFeeCents / 100).toFixed(2) : "",
    limits: { ...(settings?.rules?.divisionLimits || {}) }, paypalFeePassthrough: settings ? Boolean(settings.paypalFeePassthrough) : true,
    zelleTo: settings?.zelleTo ?? "", zelleName: settings?.zelleName ?? "", tdEmail: settings?.tdEmail ?? "",
  }));
  const [pdgaEvent, setPdgaEvent] = React.useState(settings?.pdgaEvent ?? null);
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value });

  async function lookUp() {
    setMessage("");
    if (!String(form.pdgaEventId).trim()) return;
    const result = await call(`/admin/pdga-events/${encodeURIComponent(String(form.pdgaEventId).trim())}`);
    if (result.ok) {
      const ev = result.data.event;
      setPdgaEvent(ev);
      if (!settings?.pdgaEventId && ev?.tier) {
        const tier = String(ev.tier).trim().toUpperCase();
        if (["A", "B", "M", "ES", "NT", "XA", "XB", "XM"].includes(tier)) {
          setForm((prev) => ({ ...prev, membersOnly: true, nonMemberFee: "" }));
        } else if (["C", "XC"].includes(tier)) {
          setForm((prev) => ({ ...prev, membersOnly: false, nonMemberFee: prev.nonMemberFee === "" ? "15.00" : prev.nonMemberFee }));
        }
      }
    } else setMessage(ERRORS[result.data.error] || "Couldn't look that up.");
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const fee = String(form.nonMemberFee).trim();
    const result = await call(`/admin/events/${eventId}/tournament`, { method: "PUT", body: {
      pdgaEventId: String(form.pdgaEventId).trim() || null, playerCap: String(form.playerCap).trim() || null,
      rules: { membersOnly: form.membersOnly, nonMemberFeeCents: fee ? Math.round(Number(fee) * 100) : 0, divisionLimits: form.limits },
      paypalFeePassthrough: form.paypalFeePassthrough, zelleTo: form.zelleTo.trim() || null, zelleName: form.zelleName.trim() || null,
      tdEmail: form.tdEmail.trim() || null,
    } });
    setBusy(false);
    if (!result.ok) { setMessage(ERRORS[result.data.error] || "Couldn't save."); return; }
    setPdgaEvent(result.data.settings?.pdgaEvent ?? null);
    setMessage("Saved.");
    onSaved();
  }

  const divisions = settings?.divisions || [];
  const hasStandardDivisions = divisions.some((division) => STANDARD_DIVISION_LIMITS[division] != null);
  return h("form", { className: "course-operator-fields tournament-settings", onSubmit: save }, [
    h("label", { key: "pdga" }, ["PDGA event number", h("input", { key: "input", inputMode: "numeric", value: form.pdgaEventId,
      onChange: (e) => setForm({ ...form, pdgaEventId: e.target.value.replace(/\D/g, "") }), onBlur: lookUp })]),
    pdgaEvent ? h("p", { className: "al-note", key: "event" }, [
      h(PdgaLink, { href: pdgaEventHref(pdgaEvent.id), key: "link" }, pdgaEvent.name),
      `${pdgaEvent.tier ? ` · ${formatPdgaTier(pdgaEvent.tier)}` : ""}${pdgaEvent.startDate ? ` · ${pdgaEvent.startDate}` : ""}${pdgaEvent.director ? ` · TD ${pdgaEvent.director}` : ""}`,
    ]) : null,
    pdgaEvent && !settings?.pdgaEventId ? h(PdgaCredit, { key: "preview-credit" }) : null,
    h("label", { key: "cap" }, ["Player cap (blank = no cap)", h("input", { key: "input", inputMode: "numeric", value: form.playerCap,
      onChange: (e) => setForm({ ...form, playerCap: e.target.value.replace(/\D/g, "") }) })]),
    h("label", { key: "members" }, [h("input", { key: "box", type: "checkbox", checked: form.membersOnly, onChange: set("membersOnly") }), " Current PDGA members only"]),
    h("label", { key: "fee" }, ["Non-member fee ($, for players who aren't current PDGA members)", h("input", { key: "input", inputMode: "decimal", value: form.nonMemberFee, onChange: set("nonMemberFee") })]),
    divisions.length ? h("fieldset", { key: "limits" }, [
      h("legend", { key: "legend" }, "Highest rating allowed (blank = no limit)"),
      ...divisions.map((division) => h("label", { key: division }, [division, h("input", { key: "input", inputMode: "numeric", value: form.limits[division] ?? "",
        onChange: (e) => setForm({ ...form, limits: { ...form.limits, [division]: e.target.value.replace(/\D/g, "") } }) })])),
      hasStandardDivisions ? h("button", {
        className: "admin-btn secondary", type: "button", key: "fill-caps",
        onClick: () => setForm((prev) => {
          const limits = { ...prev.limits };
          for (const div of divisions) {
            if (STANDARD_DIVISION_LIMITS[div] != null) limits[div] = String(STANDARD_DIVISION_LIMITS[div]);
          }
          return { ...prev, limits };
        }),
      }, "Fill PDGA standard caps") : null,
    ]) : h("p", { className: "al-note", key: "no-divisions" }, "Add divisions in the event's registration settings to set rating limits."),
    h("label", { key: "passthrough" }, [h("input", { key: "box", type: "checkbox", checked: form.paypalFeePassthrough, onChange: set("paypalFeePassthrough") }), " Players cover PayPal's fee"]),
    h("label", { key: "zelle" }, ["Zelle to (email or phone; blank = no Zelle)", h("input", { key: "input", value: form.zelleTo, onChange: set("zelleTo") })]),
    h("label", { key: "zelle-name" }, ["Zelle account name", h("input", { key: "input", value: form.zelleName, onChange: set("zelleName") })]),
    h("label", { key: "td" }, ["TD email (withdrawals go here)", h("input", { key: "input", type: "email", value: form.tdEmail, onChange: set("tdEmail") })]),
    h("div", { className: "course-operator-actions", key: "actions" }, h("button", { className: "admin-btn", type: "submit", disabled: busy }, busy ? "Saving…" : "Save tournament settings")),
    message ? h("p", { className: "al-note", role: "status", key: "message" }, message) : null,
  ]);
}

function Row({ eventId, row, kind, onChanged }) {
  const [received, setReceived] = React.useState("");
  const [message, setMessage] = React.useState("");
  async function act(path, body) {
    setMessage("");
    const result = await call(`/admin/events/${eventId}/registrations/${row.id}/${path}`, { method: "POST", body });
    if (!result.ok) { setMessage(ERRORS[result.data.error] || "Didn't work."); return; }
    onChanged();
  }
  const pdga = row.pdga_number
    ? [h(PdgaLink, { href: pdgaPlayerHref(row.pdga_number), key: "pdga" }, `#${row.pdga_number}`), row.pdga_rating ? ` · ${row.pdga_rating}` : "", row.pdga_status && row.pdga_status !== "current" ? ` · ${row.pdga_status}` : ""]
    : " · no PDGA #";
  return h("li", { "data-tournament-row": row.id }, [
    row.pdga_number ? h(PdgaLink, { href: pdgaPlayerHref(row.pdga_number), key: "name" }, row.name) : h("b", { key: "name" }, row.name),
    row.division ? ` · ${row.division}` : "", " · ", ...[].concat(pdga),
    kind === "paid" ? ` · ${row.payment_method || "marked paid"} ${dollars(row.amount_paid_cents)}${row.donation_cents ? ` (gift ${dollars(row.donation_cents)})` : ""}${row.paid_at ? ` · ${new Date(row.paid_at).toLocaleString()}` : ""}` : "",
    kind === "pending" && row.payment_method === "zelle" ? ` · Zelle ${row.zelle_code || ""}${row.zelle_sent_at ? ` · says sent ${new Date(row.zelle_sent_at).toLocaleString()}` : ""}` : "",
    kind === "pending" && row.offered_at ? " · spot offered" : "",
    kind === "pending" && row.payment_method === "zelle" ? h("span", { className: "course-operator-actions", key: "zelle" }, [
      h("input", { key: "at", type: "datetime-local", "aria-label": `When ${row.name}'s Zelle arrived`, value: received, onChange: (e) => setReceived(e.target.value) }),
      h("button", { className: "admin-btn secondary", type: "button", key: "go", onClick: () => act("zelle-received", { receivedAt: received ? new Date(received).toISOString() : undefined }) }, "Zelle received"),
    ]) : null,
    kind === "waitlist" ? h("button", { className: "admin-btn secondary", type: "button", key: "offer", onClick: () => act("offer") }, "Offer spot") : null,
    message ? h("span", { className: "al-note", role: "alert", key: "message" }, ` ${message}`) : null,
  ]);
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * Rows for PDGA Tournament Manager's Upload page, which takes rows pasted from the TD Report (PDGA's help). Two kinds:
 *   - players: the event's player list (paid in field order, then the waitlist), so players registered here show on
 *     pdga.com (owner: "Yes please" to a copy-ready list; PDGA asks for it at least weekly);
 *   - results: after the event, every club event linked to the PDGA event is a round, in date order.
 */
const PASTE_KINDS = {
  players: {
    path: "pdga-players", title: "Players for PDGA", get: "Get players for PDGA", copy: "Copy players for PDGA", label: "Players for PDGA",
    how: "Players who register here show on pdga.com once you add them in PDGA Tournament Manager (PDGA asks for the list at least weekly): open the event's Upload page, paste these rows, keep \u201cFirst row in results contain field names\u201d ticked, leave \u201cOverwrite results\u201d unticked, check the Field Mappings, then match each player or mark them New.",
    empty: "No paid players yet: players are on PDGA's list once their entry fee is in.",
    has: (data) => data.rows.length > 0,
    summary: (data) => [plural(data.registered, "registered player", "registered players"), data.waitlisted ? plural(data.waitlisted, "on the waitlist", "on the waitlist") : "", data.unpaid ? `${data.unpaid} signed up, not paid (not listed)` : ""].filter(Boolean).join(" · "),
    warnings: (data) => [
      data.noDivision ? `${plural(data.noDivision, "player has", "players have")} no division: set it in Tournament Manager.` : "",
      data.noPdga ? `${plural(data.noPdga, "player has", "players have")} no PDGA number: Tournament Manager marks them New, to match or add.` : "",
      data.waitlisted ? "Waitlisted players carry \u201cWaitlist #N\u201d in the Start field, which PDGA shows on the event page." : "",
    ],
  },
  results: {
    path: "pdga-results", title: "Results for PDGA", get: "Get results for PDGA", copy: "Copy for PDGA", label: "Results for PDGA",
    how: "After the event, report the results in PDGA Tournament Manager: open the event's Upload page, paste these rows, tick \u201cFirst row in results contain field names\u201d, leave \u201cOverwrite results\u201d unticked, and set T.O. and Place to blank in Field Mappings.",
    empty: "No scores yet: results show up once a round is finished.",
    has: (data) => data.players > 0,
    summary: (data) => `${plural(data.players, "player", "players")} · ${data.rounds.map((round, index) => `Rd${index + 1}: ${round.name}${round.date ? ` (${round.date})` : ""}`).join(" · ")}`,
    warnings: (data) => [
      data.missingScores ? `${plural(data.missingScores, "player is", "players are")} missing a round score: enter PDGA's code for them (888 or 999) in Tournament Manager.` : "",
      data.noDivision ? `${plural(data.noDivision, "player has", "players have")} no division: set it in Tournament Manager.` : "",
      data.noPdga ? `${plural(data.noPdga, "player has", "players have")} no PDGA number: Tournament Manager marks them New, to match or add.` : "",
      data.extraRounds ? `Only the first 4 rounds are included (${data.extraRounds} more linked).` : "",
    ],
  },
};

function PdgaPaste({ eventId, kind }) {
  const copy = PASTE_KINDS[kind];
  const [state, setState] = React.useState({ status: "idle", data: null });
  const [copied, setCopied] = React.useState(false);
  async function load() {
    setCopied(false);
    setState({ status: "loading", data: null });
    const result = await call(`/admin/events/${eventId}/${copy.path}`);
    setState({ status: result.ok ? "ready" : "error", data: result.data });
  }
  const data = state.data;
  const ready = state.status === "ready" && data && copy.has(data);
  const warnings = ready ? copy.warnings(data).filter(Boolean) : [];
  return h("div", { className: "pdga-results", [`data-admin-${copy.path}`]: state.status, key: copy.path }, [
    h("h4", { className: "al-h", key: "title" }, copy.title),
    h("p", { className: "al-note", key: "how" }, copy.how),
    h("button", { className: "admin-btn secondary", type: "button", key: "get", disabled: state.status === "loading", onClick: load },
      state.status === "idle" ? copy.get : state.status === "loading" ? "Getting the rows…" : "Refresh"),
    state.status === "error" ? h("p", { className: "al-note", role: "status", key: "error" }, "The rows couldn't be put together. Try again.") : null,
    state.status === "ready" && !ready ? h("p", { className: "al-note", role: "status", key: "empty" }, copy.empty) : null,
    ready ? h("p", { className: "al-note", key: "summary" }, copy.summary(data)) : null,
    warnings.length ? h("ul", { className: "al-note", key: "warnings" }, warnings.map((text) => h("li", { key: text }, text))) : null,
    ready ? h("textarea", { key: "rows", readOnly: true, value: data.text, rows: Math.min(14, data.rows.length + 1), "aria-label": copy.label,
      style: { width: "100%", fontFamily: "ui-monospace, monospace", fontSize: ".8rem", whiteSpace: "pre", overflowX: "auto" } }) : null,
    ready ? h("button", { className: "admin-btn", type: "button", key: "copy", onClick: async () => {
      try { await navigator.clipboard.writeText(data.text); setCopied(true); } catch { setCopied(false); }
    } }, copied ? "Copied" : copy.copy) : null,
  ]);
}

/** After the event: results for PDGA (also on the event's Results screen). */
export function PdgaResults({ eventId }) {
  return h(PdgaPaste, { eventId, kind: "results" });
}

export function AdminTournamentPanel({ eventId }) {
  const [state, setState] = React.useState({ status: "loading", settings: null, registrations: [] });
  const [copied, setCopied] = React.useState(false);
  const load = React.useCallback(async () => {
    const [settings, registrations] = await Promise.all([
      call(`/admin/events/${eventId}/tournament`), call(`/admin/events/${eventId}/registrations`),
    ]);
    setState({ status: settings.ok ? "ready" : "error", settings: settings.data.settings ?? null, registrations: registrations.data.registrations ?? [] });
  }, [eventId]);
  React.useEffect(() => { load(); }, [load]);
  // The event form linked or unlinked the PDGA event.
  React.useEffect(() => {
    const changed = (event) => { if (String(event.detail?.eventId) === String(eventId)) load(); };
    window.addEventListener("gvdg:admin-tournament-changed", changed);
    return () => window.removeEventListener("gvdg:admin-tournament-changed", changed);
  }, [eventId, load]);
  if (state.status === "loading") return null;

  const linked = Boolean(state.settings?.pdgaEventId);
  const { paid, waitlist, pending } = fieldRows(state.registrations);
  const link = `${window.location.origin}/events#event/${eventId}`;
  const csv = preRegistrationCsv(paid, waitlist);
  return h("details", { className: "al-section course-operator-detail", "data-admin-tournament": linked ? "linked" : "off", open: linked || undefined }, [
    h("summary", { className: "al-h", key: "title" }, linked ? "PDGA event registration" : "Run as a PDGA event (register here, not Disc Golf Scene)"),
    h(Settings, { eventId, settings: state.settings, onSaved: load, key: "settings-" + (state.settings?.pdgaEventId ?? "new") }),
    linked ? h("p", { className: "al-note", key: "link" }, [
      "Put this registration link on the PDGA event page: ", h("code", { key: "url" }, link), " ",
      h("button", { className: "admin-btn secondary", type: "button", key: "copy", onClick: async () => {
        try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); }
      } }, copied ? "Copied" : "Copy"),
    ]) : null,
    linked ? h("h4", { className: "al-h", key: "paid-title" }, `Registered and paid (${paid.length}${state.settings.playerCap ? ` of ${state.settings.playerCap}` : ""}), in order of payment`) : null,
    linked ? h("ol", { key: "paid" }, paid.map((row) => h(Row, { eventId, row, kind: "paid", onChanged: load, key: row.id }))) : null,
    linked && pending.length ? h("h4", { className: "al-h", key: "pending-title" }, `Signed up, not paid (${pending.length})`) : null,
    linked && pending.length ? h("ul", { key: "pending" }, pending.map((row) => h(Row, { eventId, row, kind: "pending", onChanged: load, key: row.id }))) : null,
    linked && waitlist.length ? h("h4", { className: "al-h", key: "wait-title" }, `Waitlist (${waitlist.length}), in order`) : null,
    linked && waitlist.length ? h("ol", { key: "wait" }, waitlist.map((row) => h(Row, { eventId, row, kind: "waitlist", onChanged: load, key: row.id }))) : null,
    linked ? h("p", { className: "al-note", key: "csv" }, [
      "PDGA asks for the pre-registration list on the PDGA event page, updated at least weekly (paid players in field order, then the waitlist): ",
      h("a", { href: "data:text/csv;charset=utf-8," + encodeURIComponent(csv), download: `pdga-${state.settings.pdgaEventId}-registrations.csv`, key: "a" }, "Download the list (CSV)"),
    ]) : null,
    linked ? h(PdgaPaste, { eventId, kind: "players", key: "players" }) : null,
    linked ? h(PdgaResults, { eventId, key: "results" }) : null,
    linked ? h(PdgaCredit, { key: "credit" }) : null,
  ]);
}
