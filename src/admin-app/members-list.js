import React from "react";
import { KarmaChip } from "../shared/karma.js";

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
    tier: source.tier === "admin" || source.tier === "guest" ? source.tier : source.isAdmin === true ? "admin" : "member",
    held: source.held === true,
    lapsed: source.membershipCurrent === false && source.tier !== "guest" && source.held !== true,
  };
}

const TIER_LABEL = { admin: "Admin", member: "Member", guest: "Guest" };

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
  const badges = member.held ? [
    "held: no sign-in yet",
    member.tier === "guest" ? "guest" : member.throughYear ? `through ${member.throughYear}` : "",
  ].filter(Boolean) : [
    member.identifier || member.memberId || "no id",
    member.tier === "admin" ? "admin" : member.tier === "guest" ? (member.source.guestPromo === true ? "guest (promo)" : "guest") : "",
    member.tier === "guest" ? [member.source.email, member.source.phone].filter((value) => typeof value === "string" && value).join(" - ") : "",
    member.tier === "guest" ? "" : member.lapsed ? "lapsed" : member.throughYear ? `through ${member.throughYear}` : "",
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

function TierPicker({ member, isSelf, isLastAdmin }) {
  async function choose(tier) {
    if (tier === member.tier) return;
    const leavingAdmin = member.tier === "admin";
    const confirmed = await adminConfirm({
      title: `Make ${member.name} ${tier === "admin" ? "an admin" : tier === "guest" ? "a guest" : "a member"}?`,
      message: tier === "admin" ? "Admins can manage everything in the club's admin."
        : tier === "guest" ? "Guests sign in, play, register for events and buy, but can't list discs for sale and don't pay dues."
          : "Members are dues-paying club members.",
      confirmText: `Make ${TIER_LABEL[tier].toLowerCase()}`,
      danger: leavingAdmin && isSelf,
    });
    if (confirmed) dispatchRequest("gvdg:admin-member-tier-request", { member: member.source, tier });
  }
  const id = "member-tier-" + (member.memberId || member.identifier);
  return h("label", { className: "admin-member-tier", htmlFor: id, key: "tier" }, [
    h("select", {
      "aria-label": `Tier for ${member.name}`, disabled: !member.memberId || isLastAdmin, id, key: "s", onChange: (event) => { void choose(event.target.value); },
      title: isLastAdmin ? "Can't remove the last admin" : undefined, value: member.tier,
    }, ["admin", "member", "guest"].filter((tier) => !(member.held && tier === "admin")).map((tier) => h("option", { key: tier, value: tier }, TIER_LABEL[tier]))),
  ]);
}

/** A held account from the club's sheets is someone already in the app: move it onto them. */
function LinkHeld({ member, members }) {
  const id = "member-link-" + member.memberId;
  const choices = members.filter((other) => !other.held && other.memberId);
  async function choose(memberId) {
    const target = choices.find((other) => other.memberId === memberId);
    if (!target) return;
    const confirmed = await adminConfirm({
      title: `Link to ${target.name}?`,
      message: `${member.name}'s store credit, dues and bag tag from the sheets move to ${target.name}, and the held account goes away.`,
      confirmText: "Link",
    });
    if (confirmed) dispatchRequest("gvdg:admin-member-link-held-request", { heldId: member.memberId, memberId });
  }
  return h("label", { className: "admin-member-tier admin-member-wide", htmlFor: id, key: "link" }, [
    h("select", { "aria-label": `Link ${member.name} to a member already in the app`, id, key: "s", onChange: (event) => { void choose(event.target.value); }, value: "" }, [
      h("option", { key: "none", value: "" }, "Link to member…"),
      ...choices.map((other) => h("option", { key: other.memberId, value: other.memberId }, other.name)),
    ]),
  ]);
}

function AdminMemberRow({ adminCount, currentMemberId, member, members = [] }) {
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

  const renew = member.renewalYear && member.tier !== "guest" && !member.held;
  return h("div", {
    className: "admin-evrow admin-member-row", "data-admin-member-id": member.memberId || member.identifier, "data-member-lapsed": member.lapsed ? "true" : "false",
    "data-member-tier": member.tier, "data-member-held": member.held ? "true" : "false",
  }, [
    h("div", { className: "admin-member-head", key: "head" }, [
      h("span", { className: "ev-name", key: "name" }, memberSummary(member)),
      h(KarmaChip, { key: "karma", memberId: member.memberId }),
    ]),
    h("div", { className: "admin-member-actions", key: "actions" }, [
      // The one thing to do now, full width: renew when it's due, or match a held account from the sheets.
      renew ? h("button", { className: "admin-btn admin-member-wide", key: "renew", onClick: requestRenew, type: "button" }, `Renew for ${member.renewalYear}`) : null,
      member.held ? h(LinkHeld, { key: "link", member, members }) : null,
      h(TierPicker, { isLastAdmin, isSelf, key: "tier", member }),
      h("button", {
        className: "admin-btn secondary", disabled: !member.identifier, key: "wallet", type: "button",
        onClick: () => dispatchRequest("gvdg:admin-tab-request", { tab: "wallets", memberId: member.identifier }),
      }, "Wallet"),
      h(MemberMoreMenu, {
        key: "more", member,
        items: [
          member.held || !member.identifier ? null : { key: "pin", label: "Reissue PIN", onSelect: requestPinReset },
          member.held || !member.memberId ? null : {
            key: "locks", label: "Clear lockouts", attrs: { "data-admin-clear-locks": member.memberId },
            onSelect: () => dispatchRequest("gvdg:admin-member-clear-locks-request", { member: member.source }),
          },
          { key: "remove", label: "Remove member", danger: true, disabled: removeBlocked || !member.memberId, title: removeTitle, onSelect: requestRemove },
        ].filter(Boolean),
      }),
    ]),
  ]);
}

/** The member actions you need now and then (Reissue PIN, Clear lockouts, Remove member), behind one "More". */
function MemberMoreMenu({ member, items }) {
  const ref = React.useRef(null);
  const summary = React.useRef(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  React.useEffect(() => {
    if (!menuOpen) return undefined;
    function outside(event) {
      if (ref.current?.open && !ref.current.contains(event.target)) ref.current.open = false;
    }
    function escape(event) {
      if (event.key !== "Escape" || !ref.current?.open) return;
      ref.current.open = false;
      summary.current?.focus();
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);
  return h("details", { className: "admin-member-more", onToggle: (event) => setMenuOpen(event.currentTarget.open), ref }, [
    h("summary", { className: "admin-btn secondary", "aria-label": `More for ${member.name}`, key: "summary", ref: summary }, "More"),
    h("div", { className: "admin-member-more-menu", role: "menu", key: "menu" }, items.map((item) => h("button", {
      ...(item.attrs || {}),
      className: item.danger ? "admin-member-more-item is-danger" : "admin-member-more-item",
      disabled: item.disabled,
      key: item.key,
      onClick: () => {
        if (ref.current) ref.current.open = false;
        item.onSelect();
      },
      role: "menuitem",
      title: item.title,
      type: "button",
    }, item.label))),
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
    guest: source.kind === "guest",
    email: normalizeText(source.contact?.email),
    phone: normalizeText(source.contact?.phone),
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
  const [busyAction, setBusyAction] = React.useState("");
  const chip = paymentChipModel(row.payment, duesOnline);
  const paid = row.payment.status !== "unpaid";

  React.useEffect(() => {
    function finish(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      if (String(detail.id ?? "") === String(row.id)) setBusyAction("");
    }
    window.addEventListener("gvdg:admin-membership-action-result", finish);
    return () => window.removeEventListener("gvdg:admin-membership-action-result", finish);
  }, [row.id]);

  function submitMarkPaid(event) {
    event.preventDefault();
    if (busyAction) return;
    dispatchRequest("gvdg:admin-membership-mark-paid-request", { id: row.id, name: row.name, note: note.trim() });
    setMarking(false);
    setNote("");
  }

  function approveApplication() {
    if (busyAction) return;
    setBusyAction("approve");
    dispatchRequest("gvdg:admin-membership-approve-request", { id: row.id, name: row.name });
  }

  async function rejectApplication() {
    if (busyAction) return;
    const confirmed = await adminConfirm({
      title: `Reject ${row.name}?`,
      message: "Remove this membership application? They can reapply later if needed.",
      confirmText: "Reject",
      danger: true,
    });
    if (!confirmed) return;
    setBusyAction("reject");
    dispatchRequest("gvdg:admin-membership-reject-request", { id: row.id, name: row.name });
  }

  return h("div", { className: "admin-evrow", "data-admin-application-id": row.id, "data-admin-application-kind": row.guest ? "guest" : "member" }, [
    h("span", { className: "ev-name", key: "name" }, `${row.name} - ${[row.guest && "Guest account", row.pdgaNo && `PDGA# ${row.pdgaNo}`, row.udisc, row.email, row.phone].filter(Boolean).join(" - ") || row.id}`),
    // Guests pay no dues.
    row.guest ? null : h("span", { className: `admin-roster-chip ${chip.tone}`, "data-admin-payment-chip": row.payment.status, key: "chip" }, chip.label),
    marking
      ? h("form", { className: "admin-mark-paid-form", key: "form", onSubmit: submitMarkPaid }, [
        h("input", {
          "aria-label": `Payment note for ${row.name}`, autoFocus: true, key: "note", maxLength: 200,
          onChange: (event) => setNote(event.target.value), placeholder: "Note (cash, check, who took it)", type: "text", value: note,
        }),
        h("button", { className: "admin-btn", key: "save", type: "submit" }, "Save"),
        h("button", { className: "admin-btn secondary", key: "cancel", onClick: () => setMarking(false), type: "button" }, "Cancel"),
      ])
      : paid || row.guest
        ? null
        : h("button", { className: "admin-btn secondary", disabled: Boolean(busyAction), key: "mark", onClick: () => setMarking(true), type: "button" },
          // <wbr> lets "(cash/other)" break after the slash on a narrow phone; the accessible name is unchanged.
          ["Mark paid (cash/", h("wbr", { key: "break" }), "other)"]),
    h("button", {
      className: "admin-btn",
      disabled: Boolean(busyAction),
      key: "approve",
      type: "button",
      onClick: approveApplication,
    }, busyAction === "approve" ? "Approving…" : "Approve"),
    h("button", {
      className: "admin-btn danger",
      disabled: Boolean(busyAction),
      key: "reject",
      type: "button",
      onClick: () => { void rejectApplication(); },
    }, busyAction === "reject" ? "Rejecting…" : "Reject"),
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
  const lapsed = view.members.filter((member) => member.lapsed && member.tier === "member").length;
  const held = view.members.filter((member) => member.held).length;
  async function moveLapsed() {
    const confirmed = await adminConfirm({
      title: `Move ${lapsed} lapsed ${lapsed === 1 ? "member" : "members"} to Guest?`,
      message: "They keep signing in, playing and buying, but stop counting as club members until they renew (an admin makes them a member again).",
      confirmText: "Move to Guest",
    });
    if (confirmed) dispatchRequest("gvdg:admin-members-lapsed-to-guest-request", {});
  }
  return h("div", { "data-react-admin-members-list": "ready" }, [
    lapsed ? h("button", { className: "admin-btn secondary", "data-admin-lapsed-to-guest": lapsed, key: "lapsed", onClick: () => { void moveLapsed(); }, type: "button" },
      `Move ${lapsed} lapsed ${lapsed === 1 ? "member" : "members"} to Guest`) : null,
    held ? h("p", { className: "al-note", key: "held" }, `${held} held ${held === 1 ? "account" : "accounts"} from the club's sheets: they carry over when that player signs up, or link one to a member already here.`) : null,
    ...view.members.map((member, index) => (
      h(AdminMemberRow, {
        adminCount,
        currentMemberId: view.currentMemberId,
        key: member.memberId || member.identifier || `${member.name}-${index}`,
        member,
        members: view.members,
      })
    )),
  ]);
}
