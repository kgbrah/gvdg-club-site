import React from "react";
import { currentAdminRoute } from "./admin-shell-state.js";
import { adminConfirm } from "./admin-dialogs.js";
import { AutocompleteInput } from "../shared/autocomplete.js";

const h = React.createElement;

const EMPTY_FORM = {
  amount: "",
  memberId: "",
  note: "",
};

function newKey() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function dollarsToCents(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function formBody(form) {
  const amount = dollarsToCents(form.amount);
  return {
    body: {
      amount_cents: amount,
      member_id: form.memberId.trim(),
      note: form.note.trim() || null,
    },
    valid: Boolean(form.memberId.trim() && amount != null && amount !== 0),
  };
}

export function AdminWalletAdjustmentForm() {
  const [form, setForm] = React.useState(() => ({ ...EMPTY_FORM, memberId: currentAdminRoute().memberId || "" }));
  const [busy, setBusy] = React.useState(false);
  // Member names to autocomplete, from the balances list below (picking one fills the member's id: no ambiguity).
  const [roster, setRoster] = React.useState([]);
  React.useEffect(() => {
    const take = (event) => setRoster(Array.isArray(event.detail?.members) ? event.detail.members : []);
    window.addEventListener("gvdg:admin-wallet-roster", take);
    return () => window.removeEventListener("gvdg:admin-wallet-roster", take);
  }, []);
  const currentRequest = React.useRef("");
  const idempotencyKeyRef = React.useRef("");
  const requestCounter = React.useRef(0);

  React.useEffect(() => {
    function selectMember(event) {
      if (event.detail?.tab !== "wallets" || !event.detail.memberId) return;
      idempotencyKeyRef.current = "";
      setForm({ ...EMPTY_FORM, memberId: event.detail.memberId });
    }
    // "Adjust" in the balances list below fills the member (and puts the cursor in the amount).
    function adjustMember(event) {
      if (!event.detail?.memberId) return;
      idempotencyKeyRef.current = "";
      setForm({ ...EMPTY_FORM, memberId: event.detail.memberId });
      window.requestAnimationFrame(() => document.getElementById("waAmount")?.focus());
    }
    window.addEventListener("gvdg:admin-active-tab", selectMember);
    window.addEventListener("gvdg:admin-wallet-member", adjustMember);
    return () => {
      window.removeEventListener("gvdg:admin-active-tab", selectMember);
      window.removeEventListener("gvdg:admin-wallet-member", adjustMember);
    };
  }, []);

  React.useEffect(() => {
    function update(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      if (!detail.requestId || detail.requestId !== currentRequest.current) return;
      setBusy(false);
      if (detail.ok === true) {
        setForm(EMPTY_FORM);
        currentRequest.current = "";
        idempotencyKeyRef.current = "";
      }
    }
    window.addEventListener("gvdg:admin-wallet-adjustment-result", update);
    return () => window.removeEventListener("gvdg:admin-wallet-adjustment-result", update);
  }, []);

  function updateField(field, value) {
    idempotencyKeyRef.current = "";
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const payload = formBody(form);
    const requestId = `wallet-adjustment-${requestCounter.current += 1}`;
    if (!payload.valid) {
      currentRequest.current = requestId;
      dispatchRequest("gvdg:admin-wallet-adjustment-request", { ...payload, requestId });
      return;
    }
    const cents = payload.body.amount_cents;
    const dollars = `${cents < 0 ? "-" : "+"}$${(Math.abs(cents) / 100).toFixed(2)}`;
    const confirmed = await adminConfirm({
      title: "Post wallet adjustment?",
      message: `${dollars} for ${payload.body.member_id}${payload.body.note ? ` (${payload.body.note})` : ""}.`,
      confirmText: "Post adjustment",
      danger: cents < 0,
    });
    if (!confirmed) return;
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = newKey();
    currentRequest.current = requestId;
    setBusy(true);
    dispatchRequest("gvdg:admin-wallet-adjustment-request", {
      ...payload,
      body: { ...payload.body, idempotency_key: idempotencyKeyRef.current },
      requestId,
    });
  }

  return h("form", {
    className: "admin-form admin-surface",
    "data-react-admin-wallet-form": "ready",
    id: "adminWalletForm",
    onSubmit: submit,
  }, [
    h("div", { key: "member" }, [
      h("label", { htmlFor: "waMemberId", key: "label" }, "Member"),
      h(AutocompleteInput, {
        suggestions: roster.map((member) => ({ label: member.name, value: member.memberId, hint: member.pdgaNo ? "PDGA #" + member.pdgaNo : "", key: member.memberId })),
        id: "waMemberId",
        key: "input",
        maxLength: 80,
        onChange: (event) => updateField("memberId", event.target.value),
        placeholder: "Name, PDGA#, or UDisc",
        required: true,
        value: form.memberId,
      }),
    ]),
    h("div", { key: "amount" }, [
      h("label", { htmlFor: "waAmount", key: "label" }, "Adjustment ($)"),
      h("input", {
        id: "waAmount",
        key: "input",
        onChange: (event) => updateField("amount", event.target.value),
        required: true,
        step: "0.01",
        type: "number",
        value: form.amount,
      }),
    ]),
    h("div", { className: "admin-wallet-form-wide", key: "note" }, [
      h("label", { htmlFor: "waNote", key: "label" }, "Note"),
      h("input", {
        id: "waNote",
        key: "input",
        maxLength: 300,
        onChange: (event) => updateField("note", event.target.value),
        placeholder: "League payout, correction, volunteer credit",
        value: form.note,
      }),
    ]),
    h("button", { className: "admin-btn", disabled: busy, key: "submit", type: "submit" }, busy ? "Posting…" : "Post wallet adjustment"),
  ]);
}
