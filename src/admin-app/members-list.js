import React from "react";

const h = React.createElement;

const EMPTY_STATE = { status: "loading", members: [], currentMemberId: null };

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function currentState() {
  const state = window.__gvdgAdminMembersListState;
  return state && typeof state === "object" ? state : EMPTY_STATE;
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
  };
}

function normalizeState(state) {
  return {
    currentMemberId: normalizeText(state.currentMemberId) || null,
    members: Array.isArray(state.members) ? state.members.map(normalizeMember) : [],
    status: state.status === "loading" ? "loading" : "ready",
  };
}

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function memberSummary(member) {
  const badges = [
    member.identifier || member.memberId || "no id",
    member.isAdmin ? "admin" : "",
    member.mustChangePin ? "PIN not set" : "",
  ].filter(Boolean);
  return `${member.name} - ${badges.join(" - ")}`;
}

function AdminMemberRow({ adminCount, currentMemberId, member }) {
  const isLastAdmin = member.isAdmin && adminCount <= 1;
  const isSelf = currentMemberId && currentMemberId === member.memberId;
  const roleLabel = member.isAdmin ? "Remove admin" : "Make admin";
  const roleTitle = isLastAdmin ? "Can't remove the last admin" : undefined;

  function requestPinReset() {
    if (!window.confirm(`Issue a new temporary PIN for ${member.name}? Their current PIN stops working.`)) return;
    dispatchRequest("gvdg:admin-member-reset-pin-request", { identifier: member.identifier, member: member.source });
  }

  function requestRoleChange() {
    const promoting = !member.isAdmin;
    const message = promoting
      ? `Grant admin rights to ${member.name}?`
      : isSelf
        ? "Remove your OWN admin access? You'll lose this panel."
        : `Remove admin rights from ${member.name}?`;
    if (!window.confirm(message)) return;
    dispatchRequest("gvdg:admin-member-role-request", { isAdmin: promoting, member: member.source });
  }

  return h("div", { className: "admin-evrow", "data-admin-member-id": member.memberId || member.identifier }, [
    h("span", { className: "ev-name", key: "name" }, memberSummary(member)),
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
  ]);
}

export function AdminMembersList() {
  const [state, setState] = React.useState(() => normalizeState(currentState()));

  React.useEffect(() => {
    function update(event) {
      setState(normalizeState(event.detail && typeof event.detail === "object" ? event.detail : currentState()));
    }
    window.addEventListener("gvdg:admin-members-list", update);
    setState(normalizeState(currentState()));
    return () => window.removeEventListener("gvdg:admin-members-list", update);
  }, []);

  if (state.status === "loading") {
    return h("p", { className: "al-note", "data-react-admin-members-list": "loading", role: "status" }, "Loading...");
  }

  if (!state.members.length) {
    return h("p", { className: "al-note", "data-react-admin-members-list": "empty", role: "status" }, "No members yet.");
  }

  const adminCount = state.members.filter((member) => member.isAdmin).length;
  return h("div", { "data-react-admin-members-list": "ready" }, state.members.map((member, index) => (
    h(AdminMemberRow, {
      adminCount,
      currentMemberId: state.currentMemberId,
      key: member.memberId || member.identifier || `${member.name}-${index}`,
      member,
    })
  )));
}
