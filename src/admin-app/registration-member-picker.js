import React from "react";

const h = React.createElement;

const EMPTY_MEMBERS = { members: [], status: "loading" };
const EMPTY_ROSTER = { registrations: [] };

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function memberIdOf(value) {
  const source = objectOrEmpty(value);
  return normalizeText(source.memberId || source.member_id).trim();
}

export function availableClubMembers(members, registrations, query) {
  const registered = new Set(
    (Array.isArray(registrations) ? registrations : []).map(memberIdOf).filter(Boolean),
  );
  const q = normalizeText(query).trim().toLowerCase();
  return (Array.isArray(members) ? members : []).flatMap((member) => {
    const source = objectOrEmpty(member);
    const memberId = memberIdOf(source);
    if (!memberId || registered.has(memberId)) return [];
    const name = normalizeText(source.name, memberId);
    const pdgaNo = normalizeText(source.pdgaNo || source.pdga_no);
    const udisc = normalizeText(source.udisc);
    if (q) {
      const haystack = `${name} ${memberId} ${pdgaNo} ${udisc}`.toLowerCase();
      if (!haystack.includes(q)) return [];
    }
    return [{ memberId, name, pdgaNo, udisc }];
  });
}

function requestId() {
  return `register-members-${Date.now()}`;
}

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function memberMeta(member) {
  const bits = [];
  if (member.pdgaNo) bits.push(`#${member.pdgaNo}`);
  if (member.udisc) bits.push(member.udisc);
  return bits.join(" / ");
}

export function AdminRegistrationMemberPicker() {
  const [membersState, setMembersState] = React.useState(EMPTY_MEMBERS);
  const [registrations, setRegistrations] = React.useState([]);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState(() => new Set());
  const [division, setDivision] = React.useState("");
  const [ctp, setCtp] = React.useState(false);
  const [ace, setAce] = React.useState(false);
  const [paidEntry, setPaidEntry] = React.useState(false);
  const [pendingRequest, setPendingRequest] = React.useState("");

  React.useEffect(() => {
    function updateMembers(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : EMPTY_MEMBERS;
      setMembersState({
        members: Array.isArray(detail.members) ? detail.members : [],
        status: detail.status === "error" ? "error" : detail.status === "loading" ? "loading" : "ready",
      });
    }
    function updateRoster(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : EMPTY_ROSTER;
      setRegistrations(Array.isArray(detail.registrations) ? detail.registrations : []);
    }
    window.addEventListener("gvdg:admin-registration-members-list", updateMembers);
    window.addEventListener("gvdg:admin-registration-roster", updateRoster);
    return () => {
      window.removeEventListener("gvdg:admin-registration-members-list", updateMembers);
      window.removeEventListener("gvdg:admin-registration-roster", updateRoster);
    };
  }, []);

  React.useEffect(() => {
    if (!pendingRequest) return undefined;
    function update(event) {
      if (event.detail?.requestId !== pendingRequest) return;
      setPendingRequest("");
      if (event.detail?.ok === true) {
        setSelected(new Set());
        setQuery("");
      }
    }
    window.addEventListener("gvdg:admin-registration-members-add-result", update);
    return () => window.removeEventListener("gvdg:admin-registration-members-add-result", update);
  }, [pendingRequest]);

  const available = availableClubMembers(membersState.members, registrations, query);
  const availableIds = new Set(available.map((member) => member.memberId));
  const selectedIds = [...selected].filter((id) => availableIds.has(id));
  const busy = Boolean(pendingRequest);

  function toggleMember(memberId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  function selectAllShown() {
    setSelected((current) => {
      const next = new Set(current);
      for (const member of available) next.add(member.memberId);
      return next;
    });
  }

  function submit(event) {
    event.preventDefault();
    if (busy) return;
    const id = requestId();
    setPendingRequest(id);
    dispatchRequest("gvdg:admin-registration-members-add-request", {
      body: {
        addons: { ctp, ace },
        division: division.trim() || null,
        member_ids: selectedIds,
        paid_entry: paidEntry,
      },
      requestId: id,
      valid: selectedIds.length > 0,
    });
  }

  const listBody = membersState.status === "loading"
    ? h("p", { className: "al-note rg-member-empty", key: "loading", role: "status" }, "Loading club members...")
    : membersState.status === "error"
      ? h("p", { className: "al-note err rg-member-empty", key: "error", role: "alert" }, "Unable to load club members.")
      : available.length
        ? available.map((member) => h("label", {
          className: "rg-member-option",
          key: member.memberId,
        }, [
          h("input", {
            checked: selected.has(member.memberId),
            disabled: busy,
            key: "check",
            onChange: () => toggleMember(member.memberId),
            type: "checkbox",
          }),
          h("span", { key: "name" }, member.name),
          memberMeta(member) ? h("span", { className: "rg-member-meta", key: "meta" }, memberMeta(member)) : null,
        ]))
        : h("p", { className: "al-note rg-member-empty", key: "empty", role: "status" }, query.trim()
          ? "No matching members left to add."
          : "Every club member is already registered.");

  return h("div", {
    className: "al-section",
    "data-react-admin-registration-member-picker": membersState.status,
    style: { marginTop: "1rem" },
  }, [
    h("h4", { className: "al-h", key: "title" }, "Add club members"),
    h("p", { className: "al-note", key: "note" }, "Search the roster and add members who paid cash at the event. They show up as registered players, not walk-ons."),
    h("div", { className: "al-row", key: "search", style: { marginTop: "0.5rem" } }, [
      h("input", {
        "aria-label": "Search club members",
        className: "rg-member-search",
        disabled: busy || membersState.status === "loading",
        id: "rgMemberSearch",
        key: "query",
        onChange: (event) => setQuery(event.target.value),
        placeholder: "Search name, PDGA, or UDisc",
        type: "search",
        value: query,
      }),
      h("button", {
        className: "admin-btn secondary",
        disabled: busy || !available.length,
        key: "all",
        onClick: selectAllShown,
        type: "button",
      }, "Select all shown"),
      h("button", {
        className: "admin-btn secondary",
        disabled: busy || !selectedIds.length,
        key: "clear",
        onClick: () => setSelected(new Set()),
        type: "button",
      }, "Clear"),
    ]),
    h("div", { className: "rg-member-list", key: "list" }, listBody),
    h("form", { className: "al-row", key: "form", onSubmit: submit }, [
      h("input", {
        disabled: busy,
        id: "rgMemberDivision",
        key: "division",
        maxLength: 40,
        onChange: (event) => setDivision(event.target.value),
        placeholder: "division (optional)",
        value: division,
      }),
      h("label", { className: "register-addon", htmlFor: "rgMemberAddonCtp", key: "ctp" }, [
        h("input", {
          checked: ctp,
          disabled: busy,
          id: "rgMemberAddonCtp",
          onChange: (event) => setCtp(event.target.checked),
          type: "checkbox",
        }),
        " CTP",
      ]),
      h("label", { className: "register-addon", htmlFor: "rgMemberAddonAce", key: "ace" }, [
        h("input", {
          checked: ace,
          disabled: busy,
          id: "rgMemberAddonAce",
          onChange: (event) => setAce(event.target.checked),
          type: "checkbox",
        }),
        " Ace pot",
      ]),
      h("label", { className: "register-addon", htmlFor: "rgMemberPaid", key: "paid" }, [
        h("input", {
          checked: paidEntry,
          disabled: busy,
          id: "rgMemberPaid",
          onChange: (event) => setPaidEntry(event.target.checked),
          type: "checkbox",
        }),
        " Mark selected as paid (cash collected)",
      ]),
      h("button", {
        className: "admin-btn",
        disabled: busy || !selectedIds.length,
        id: "rgMemberAddBtn",
        key: "submit",
        type: "submit",
      }, busy ? "Adding..." : (selectedIds.length ? `Add selected (${selectedIds.length})` : "Add selected")),
    ]),
  ]);
}
