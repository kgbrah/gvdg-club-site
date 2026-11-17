import React from "react";

import { adminConfirm } from "./admin-dialogs.js";
import { useSettledWhileLoading } from "../shared/settled-state.js";
import { parseClubInstant } from "../shared/events-model.js";

const h = React.createElement;

const EMPTY_STATE = { status: "loading", members: [], currentMemberId: null };
const EMPTY_TEMP_PIN_STATE = { member: null, tempPin: "" };

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeMember(member) {
  const source = objectOrEmpty(member);
  const memberId = normalizeText(source.memberId);
  const pdgaNo = normalizeText(source.pdgaNo);
  const udisc = normalizeText(source.udisc);
  const identifier = pdgaNo || udisc || memberId;
  return {
    source,
    identifier,
    isAdmin: source.isAdmin === true,
    memberId,
    mustChangePin: source.mustChangePin === true,
    name: normalizeText(source.name, "Unnamed member"),
    renewalYear: Number.isInteger(source.renewalYear) ? source.renewalYear : null,
    throughYear: Number.isInteger(source.memberThroughYear) ? source.memberThroughYear : null,
    lapsed: source.membershipCurrent === false,
  };
}

function normalizeState(state) {
  return {
    currentMemberId: normalizeText(state.currentMemberId) || null,
    members: Array.isArray(state.members) ? state.members.map(normalizeMember) : [],
    status: state.status === "loading" ? "loading" : "ready",
  };
}

function normalizeTempPinState(state) {
  return {
    member: normalizeMember(state.member),
    tempPin: normalizeText(state.tempPin),
  };
}

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function memberSummary(member) {
  const badges = [
    member.identifier || member.memberId || "no id",
    member.isAdmin ? "admin" : "",
    member.lapsed ? "lapsed" : member.throughYear ? `through ${member.throughYear}` : "",
    member.mustChangePin ? "PIN not set" : "",
  ].filter(Boolean);
  return `${member.name} - ${badges.join(" - ")}`;
}

function memberPinLabel(member) {
  if (member.source && typeof member.source.pdgaNo === "string" && member.source.pdgaNo) return `PDGA# ${member.source.pdgaNo}`;
  return member.source && typeof member.source.udisc === "string" && member.source.udisc
    ? member.source.udisc
    : member.memberId || member.identifier || "member id unavailable";
}

function AdminMemberRow({ adminCount, currentMemberId, member }) {
  const isLastAdmin = member.isAdmin && adminCount <= 1;
  const isSelf = currentMemberId && currentMemberId === member.memberId;
  const removeBlocked = isSelf || isLastAdmin;
  const removeTitle = isLastAdmin
    ? "Can't remove the last admin"
    : isSelf
      ? "You can't remove your own login"
      : undefined;

  async function requestPinReset() {
    const confirmed = await adminConfirm({
      title: "Reissue temporary PIN",
      message: `Issue a new temporary PIN for ${member.name}? Their current PIN stops working.`,
      confirmText: "Reissue PIN",
      danger: true,
    });
    if (!confirmed) return;
    dispatchRequest("gvdg:admin-member-reset-pin-request", { identifier: member.identifier, member: member.source });
  }

  async function requestRoleChange() {
    const promoting = !member.isAdmin;
    const message = promoting
      ? `Grant admin rights to ${member.name}?`
      : isSelf
        ? "Remove your OWN admin access? You'll lose this panel."
        : `Remove admin rights from ${member.name}?`;
    const confirmed = await adminConfirm({
      title: promoting ? "Grant admin rights" : "Remove admin rights",
      message,
      confirmText: promoting ? "Grant admin" : "Remove admin",
      danger: !promoting,
    });
    if (!confirmed) return;
    dispatchRequest("gvdg:admin-member-role-request", { isAdmin: promoting, member: member.source });
  }

  async function requestRenew() {
    const year = member.renewalYear;
    const confirmed = await adminConfirm({
      title: `Renew for ${year}`,
      message: `Mark ${member.name} renewed through December 31, ${year}? Membership renews every January 1.`,
      confirmText: `Renew for ${year}`,
    });
    if (!confirmed) return;
    dispatchRequest("gvdg:admin-member-renew-request", { member: member.source });
  }

  async function requestRemove() {
    const confirmed = await adminConfirm({
      title: "Remove member",
      message: `Remove ${member.name} from the club? They will not be able to sign in. Past scores stay.`,
      confirmText: "Remove member",
      danger: true,
    });
    if (!confirmed) return;
    dispatchRequest("gvdg:admin-member-remove-request", { member: member.source });
  }

  const roleLabel = member.isAdmin ? "Remove admin" : "Make admin";
  const roleTitle = isLastAdmin ? "Can't remove the last admin" : undefined;

  return h("div", { className: "admin-evrow", "data-admin-member-id": member.memberId || member.identifier, "data-member-lapsed": member.lapsed ? "true" : "false" }, [
    h("span", { className: "ev-name", key: "name" }, memberSummary(member)),
    h("button", {
      className: "admin-btn secondary", disabled: !member.identifier, key: "wallet", type: "button",
      onClick: () => dispatchRequest("gvdg:admin-tab-request", { tab: "wallets", memberId: member.identifier }),
    }, "Wallet"),
    h("button", {
      className: "admin-btn",
      disabled: !member.identifier,
      key: "pin",
      onClick: requestPinReset,
      type: "button",
    }, "Reissue PIN"),
    h("button", {
      className: "admin-btn",
      disabled: isLastAdmin || !member.memberId,
      key: "role",
      onClick: requestRoleChange,
      title: roleTitle,
      type: "button",
    }, roleLabel),
    member.renewalYear ? h("button", {
      className: "admin-btn",
      key: "renew",
      onClick: requestRenew,
      type: "button",
    }, `Renew for ${member.renewalYear}`) : null,
    h("button", {
      className: "admin-btn danger",
      disabled: removeBlocked || !member.memberId,
      key: "remove",
      onClick: requestRemove,
      title: removeTitle,
      type: "button",
    }, "Remove member"),
  ]);
}

export function AdminMemberTempPin() {
  const [state, setState] = React.useState(() => normalizeTempPinState(EMPTY_TEMP_PIN_STATE));
  const [copied, setCopied] = React.useState(false);
  const [copyFailed, setCopyFailed] = React.useState(false);
  const resetTimer = React.useRef(0);
  const boxRef = React.useRef(null);

  React.useEffect(() => {
    function update(event) {
      setState(normalizeTempPinState(event.detail && typeof event.detail === "object" ? event.detail : EMPTY_TEMP_PIN_STATE));
    }
    window.addEventListener("gvdg:admin-member-temp-pin", update);
    return () => window.removeEventListener("gvdg:admin-member-temp-pin", update);
  }, []);

  React.useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetTimer.current = 0;
    if (state.tempPin && boxRef.current && typeof boxRef.current.scrollIntoView === "function") {
      boxRef.current.scrollIntoView({ block: "center" });
    }
  }, [state.tempPin]);

  React.useEffect(() => () => {
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
  }, []);

  async function copyPin() {
    try {
      await navigator.clipboard.writeText(state.tempPin);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
      return;
    }
    setCopied(true);
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1200);
  }

  if (!state.tempPin) return null;

  const loginMethod = state.member.source && state.member.source.pdgaNo ? "PDGA#" : "UDisc";
  return h("section", {
    "aria-live": "polite",
    className: "admin-temp-pin",
    "data-react-admin-member-temp-pin": "ready",
    ref: boxRef,
    role: "status",
  }, [
    h("div", { className: "admin-temp-pin-title", key: "title" }, `Temporary PIN for ${state.member.name} (${memberPinLabel(state.member)})`),
    h("div", { className: "admin-temp-pin-row", key: "pin-row" }, [
      h("span", { className: "admin-temp-pin-code", key: "pin" }, state.tempPin),
      h("button", { className: "admin-btn", key: "copy", onClick: copyPin, type: "button" }, copied ? "Copied" : "Copy"),
      h("button", {
        className: "admin-btn secondary",
        key: "hide",
        onClick: () => setState(normalizeTempPinState(EMPTY_TEMP_PIN_STATE)),
        type: "button",
      }, "Hide"),
    ]),
    copyFailed ? h("p", { className: "al-note", key: "copy-error" }, "Select the PIN and copy it manually.") : null,
    h("div", { className: "admin-temp-pin-note", key: "note" }, `Give this to ${state.member.name}. They log in with their ${loginMethod} and this PIN, then set their own PIN. It stays here until you hide it.`),
  ]);
}

const EMPTY_APPLICATIONS = { status: "loading", applications: [], duesOnline: false };

function normalizePayment(value) {
  const source = objectOrEmpty(value);
  const status = source.status === "paid" || source.status === "manual" ? source.status : "unpaid";
  return {
    status,
    amountCents: Number.isFinite(source.amountCents) ? source.amountCents : 0,
    captureId: normalizeText(source.captureId),
    claimedOther: source.claimedOther === true,
    markedBy: normalizeText(source.markedBy),
    note: normalizeText(source.note),
    paidAt: normalizeText(source.paidAt),
  };
}

function normalizeApplication(row) {
  const source = objectOrEmpty(row);
  return {
    source,
    createdAt: normalizeText(source.createdAt),
    id: normalizeText(source.id),
    name: normalizeText(source.name, "Unnamed applicant"),
    payment: normalizePayment(source.payment),
    pdgaNo: normalizeText(source.pdgaNo),
    udisc: normalizeText(source.udisc),
  };
}

function shortDate(iso) {
  const date = parseClubInstant(iso);
  if (!date) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

function money(cents) {
  return `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}

// Payment state shown next to Approve. Approve is never blocked: the admin decides.
export function paymentChipModel(payment, duesOnline) {
  if (payment.status === "paid") {
    const parts = [`Paid ${money(payment.amountCents)}`, "PayPal", shortDate(payment.paidAt), payment.captureId ? `receipt ${payment.captureId}` : ""];
    return { tone: "paid", label: parts.filter(Boolean).join(" · ") };
  }
  if (payment.status === "manual") {
    const who = payment.markedBy ? ` by ${payment.markedBy}` : "";
    const parts = [`Marked paid (cash/other)${who}`, payment.note, shortDate(payment.paidAt)];
    return { tone: "paid", label: parts.filter(Boolean).join(" · ") };
  }
  if (!duesOnline) return { tone: "unpaid", label: "Online dues off \u2014 confirm payment in PayPal or mark paid manually" };
  return { tone: "unpaid", label: payment.claimedOther ? "Not paid yet · applicant says they paid another way" : "Not paid yet" };
}

function ApplicationRow({ row, duesOnline }) {
  const [marking, setMarking] = React.useState(false);
  const [note, setNote] = React.useState("");
  const chip = paymentChipModel(row.payment, duesOnline);
  const paid = row.payment.status !== "unpaid";

  function submitMarkPaid(event) {
    event.preventDefault();
    dispatchRequest("gvdg:admin-membership-mark-paid-request", { id: row.id, name: row.name, note: note.trim() });
    setMarking(false);
    setNote("");
  }

  return h("div", { className: "admin-evrow", "data-admin-application-id": row.id }, [
    h("span", { className: "ev-name", key: "name" }, `${row.name} - ${[row.pdgaNo && `PDGA# ${row.pdgaNo}`, row.udisc].filter(Boolean).join(" - ") || row.id}`),
    h("span", { className: `admin-roster-chip ${chip.tone}`, "data-admin-payment-chip": row.payment.status, key: "chip" }, chip.label),
    marking
      ? h("form", { className: "admin-mark-paid-form", key: "form", onSubmit: submitMarkPaid }, [
        h("input", {
          "aria-label": `Payment note for ${row.name}`, autoFocus: true, key: "note", maxLength: 200,
          onChange: (event) => setNote(event.target.value), placeholder: "Note (cash, check, who took it)", type: "text", value: note,
        }),
        h("button", { className: "admin-btn", key: "save", type: "submit" }, "Save"),
        h("button", { className: "admin-btn secondary", key: "cancel", onClick: () => setMarking(false), type: "button" }, "Cancel"),
      ])
      : paid
        ? null
        : h("button", { className: "admin-btn secondary", key: "mark", onClick: () => setMarking(true), type: "button" },
          // <wbr> lets "(cash/other)" break after the slash on a narrow phone; the accessible name is unchanged.
          ["Mark paid (cash/", h("wbr", { key: "break" }), "other)"]),
    h("button", {
      className: "admin-btn",
      key: "approve",
      type: "button",
      onClick: () => dispatchRequest("gvdg:admin-membership-approve-request", { id: row.id, name: row.name }),
    }, "Approve"),
    h("button", {
      className: "admin-btn danger",
      key: "reject",
      type: "button",
      onClick: () => dispatchRequest("gvdg:admin-membership-reject-request", { id: row.id, name: row.name }),
    }, "Reject"),
  ]);
}

export function AdminMembershipApplications() {
  const [state, setState] = React.useState(EMPTY_APPLICATIONS);

  React.useEffect(() => {
    function update(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : EMPTY_APPLICATIONS;
      setState({
        applications: Array.isArray(detail.applications) ? detail.applications.map(normalizeApplication) : [],
        duesOnline: detail.duesOnline === true,
        status: detail.status === "ready" ? "ready" : "loading",
      });
    }
    window.addEventListener("gvdg:admin-membership-applications", update);
    return () => window.removeEventListener("gvdg:admin-membership-applications", update);
  }, []);

  const view = useSettledWhileLoading(state);

  if (view.status === "loading") {
    return h("p", { className: "al-note", "data-react-admin-membership-applications": "loading", role: "status" }, "Loading…");
  }
  if (!view.applications.length) {
    return h("p", { className: "al-note", "data-react-admin-membership-applications": "empty", role: "status" }, "No pending applications.");
  }
  return h("div", { "data-react-admin-membership-applications": "ready" }, view.applications.map((row) =>
    h(ApplicationRow, { duesOnline: view.duesOnline, key: row.id, row }),
  ));
}

export function AdminMembersList() {
  const [state, setState] = React.useState(() => normalizeState(EMPTY_STATE));

  React.useEffect(() => {
    function update(event) {
      setState(normalizeState(event.detail && typeof event.detail === "object" ? event.detail : EMPTY_STATE));
    }
    window.addEventListener("gvdg:admin-members-list", update);
    return () => window.removeEventListener("gvdg:admin-members-list", update);
  }, []);

  const view = useSettledWhileLoading(state);

  if (view.status === "loading") {
    return h("p", { className: "al-note", "data-react-admin-members-list": "loading", role: "status" }, "Loading…");
  }

  if (!view.members.length) {
    return h("p", { className: "al-note", "data-react-admin-members-list": "empty", role: "status" }, "No members yet.");
  }

  const adminCount = view.members.filter((member) => member.isAdmin).length;
  return h("div", { "data-react-admin-members-list": "ready" }, view.members.map((member, index) => (
    h(AdminMemberRow, {
      adminCount,
      currentMemberId: view.currentMemberId,
      key: member.memberId || member.identifier || `${member.name}-${index}`,
      member,
    })
  )));
}
