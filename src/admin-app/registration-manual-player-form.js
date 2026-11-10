import React from "react";

import { configuredNames, useAdminRegistrationControlsState } from "./registration-controls.js";

const h = React.createElement;

const EMPTY_FORM = {
  division: "",
  memberId: "",
  name: "",
  pdgaNo: "",
  team: "",
};

function requestId() {
  return `manual-player-${Date.now()}`;
}

function dispatchRequest(detail) {
  window.dispatchEvent(new CustomEvent("gvdg:admin-registration-manual-player-add-request", { detail }));
}

function nameControl({ disabled, id, names, onChange, placeholder, value }) {
  if (names.length) {
    const options = value && !names.includes(value) ? [value, ...names] : names;
    return h("select", {
      disabled,
      id,
      key: id,
      onChange: (event) => onChange(event.target.value),
      value,
    }, [
      h("option", { key: "empty", value: "" }, placeholder),
      ...options.map((name) => h("option", { key: name, value: name }, name)),
    ]);
  }
  return h("input", {
    disabled,
    id,
    key: id,
    maxLength: 40,
    onChange: (event) => onChange(event.target.value),
    placeholder,
    value,
  });
}

export function AdminRegistrationManualPlayerForm() {
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [pendingRequest, setPendingRequest] = React.useState("");
  const [error, setError] = React.useState("");
  const controls = useAdminRegistrationControlsState();
  const playFormat = String(controls.config && controls.config.play_format || "").toLowerCase();
  const doubles = playFormat === "doubles";
  const teamEvent = playFormat === "teams";
  const divisions = configuredNames(controls.config && controls.config.divisions);
  const teams = configuredNames(controls.config && controls.config.teams);

  React.useEffect(() => {
    function update(event) {
      if (event.detail?.requestId !== pendingRequest) return;
      setPendingRequest("");
      if (event.detail?.ok === true) setForm(EMPTY_FORM);
      if (event.detail?.ok === true) setError("");
    }
    if (!pendingRequest) return undefined;
    window.addEventListener("gvdg:admin-registration-manual-player-add-result", update);
    return () => window.removeEventListener("gvdg:admin-registration-manual-player-add-result", update);
  }, [pendingRequest]);

  function setField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit(event) {
    event.preventDefault();
    if (pendingRequest) return;
    if (!form.name.trim()) {
      setError("Enter a player name.");
      return;
    }
    if (doubles && !form.team.trim()) {
      setError("Doubles needs a pair label (same label on both teammates).");
      return;
    }
    if (teamEvent && teams.length && !form.team.trim()) {
      setError("Pick a team for this player.");
      return;
    }
    const id = requestId();
    setPendingRequest(id);
    setError("");
    dispatchRequest({
      body: {
        division: form.division.trim() || null,
        member_id: form.memberId.trim() || null,
        name: form.name.trim(),
        pdga_no: form.pdgaNo.trim() || null,
        team: form.team.trim() || null,
      },
      requestId: id,
      valid: Boolean(form.name.trim()) && (!doubles || Boolean(form.team.trim())) && (!(teamEvent && teams.length) || Boolean(form.team.trim())),
    });
  }

  const busy = Boolean(pendingRequest);

  return h("div", {
    className: "al-section",
    "data-react-admin-registration-manual-player-form": "",
    style: { marginTop: "1rem" },
  }, [
    h("h4", { className: "al-h", key: "title" }, "Add a walk-on / non-member"),
    h("form", { className: "al-row", key: "form", onSubmit: submit }, [
      h("input", {
        id: "rgPlayerName",
        key: "name",
        maxLength: 100,
        onChange: (event) => setField("name", event.target.value),
        placeholder: "Player name",
        value: form.name,
      }),
      h("input", {
        id: "rgPlayerMember",
        key: "member",
        maxLength: 64,
        onChange: (event) => setField("memberId", event.target.value),
        placeholder: "member id (optional)",
        value: form.memberId,
      }),
      h("input", {
        id: "rgPlayerPdga",
        key: "pdga",
        maxLength: 20,
        onChange: (event) => setField("pdgaNo", event.target.value),
        placeholder: "PDGA #",
        value: form.pdgaNo,
      }),
      nameControl({
        disabled: busy,
        id: "rgPlayerDivision",
        names: divisions,
        onChange: (value) => setField("division", value),
        placeholder: "division",
        value: form.division,
      }),
      nameControl({
        disabled: busy,
        id: "rgPlayerTeam",
        names: teamEvent ? teams : [],
        onChange: (value) => setField("team", value),
        placeholder: doubles ? "pair label (e.g. KG/TJ)" : (teamEvent && !teams.length ? "Add teams in settings" : "team"),
        value: form.team,
      }),
      h("button", { className: "admin-btn secondary", disabled: busy, key: "submit", type: "submit" }, busy ? "Adding..." : "Add player"),
    ]),
    h("p", { className: "al-note", key: "note", style: { marginTop: "0.4rem" }, role: error ? "alert" : undefined }, error || (doubles
      ? "For doubles, use the same pair label on both teammates before starting live scoring."
      : teamEvent
        ? "Add the teams in registration settings, then pick one here. Each player still keeps their own score."
        : "Added players appear under Registered players above and play alongside registrants.")),
  ]);
}
