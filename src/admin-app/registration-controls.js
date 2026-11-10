import React from "react";

import { normalizeConfig } from "./scoring-model.js";

const h = React.createElement;

const EMPTY_STATE = {
  config: null,
  configStatus: "idle",
  events: [],
  notice: "",
  selectedEventId: null,
  status: "loading",
};

const FORMATS = [
  ["", "format..."],
  ["singles", "Singles"],
  ["doubles", "Doubles"],
  ["teams", "Teams"],
];

let registrationControlsStateSnapshot = EMPTY_STATE;

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeStatus(value, fallback = "ready") {
  return value === "loading" || value === "error" || value === "idle" || value === "ready" ? value : fallback;
}

function selectedIdValue(value) {
  return value == null || value === "" ? "" : String(value);
}

function currentControlsState() {
  const state = registrationControlsStateSnapshot;
  return state && typeof state === "object" ? state : EMPTY_STATE;
}

function setCurrentControlsState(state) {
  registrationControlsStateSnapshot = state && typeof state === "object" ? state : EMPTY_STATE;
}

function normalizeEvent(event) {
  const source = objectOrEmpty(event);
  const id = selectedIdValue(source.id);
  const name = normalizeText(source.name, "Event") || "Event";
  const status = normalizeText(source.status);
  return {
    id,
    label: status ? `${name} [${status}]` : name,
    source,
    status,
  };
}

function normalizeControlsState(state) {
  return {
    config: state.config && typeof state.config === "object" ? state.config : null,
    configStatus: normalizeStatus(state.configStatus, "idle"),
    events: Array.isArray(state.events) ? state.events.map(normalizeEvent).filter((event) => event.id) : [],
    notice: typeof state.notice === "string" && state.notice.trim() ? state.notice.trim() : "",
    selectedEventId: selectedIdValue(state.selectedEventId),
    status: normalizeStatus(state.status),
  };
}

export function configuredNames(value) {
  if (Array.isArray(value)) return cleanNames(value);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return cleanNames(parsed);
  } catch (error) {
    // A legacy comma list is still a valid division field.
  }
  return cleanNames(value.split(","));
}

function cleanNames(values) {
  const names = [];
  const seen = new Set();
  for (const item of values) {
    const name = String(item || "").trim().slice(0, 40);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function addName(list, raw) {
  return cleanNames([...(Array.isArray(list) ? list : []), raw]);
}

function dollarsFromCents(value) {
  if (value == null || value === "") return "";
  const cents = Number(value);
  return Number.isFinite(cents) ? String(cents / 100) : "";
}

function dollarsToCents(value) {
  const amount = Number.parseFloat(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function formFromConfig(config) {
  const cfg = objectOrEmpty(config);
  return {
    aceFee: dollarsFromCents(cfg.ace_fee_cents),
    ctpFee: dollarsFromCents(cfg.ctp_fee_cents),
    divisions: configuredNames(cfg.divisions),
    entryFee: dollarsFromCents(cfg.entry_fee_cents),
    playFormat: normalizeText(cfg.play_format),
    registrationOpen: Boolean(cfg.registration_open),
    teams: configuredNames(cfg.teams),
  };
}

function requestId(prefix) {
  return `${prefix}-${Date.now()}`;
}

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function useAdminRegistrationControlsState() {
  const [state, setState] = React.useState(() => normalizeControlsState(currentControlsState()));

  React.useEffect(() => {
    function update(event) {
      const next = event.detail && typeof event.detail === "object" ? event.detail : currentControlsState();
      setCurrentControlsState(next);
      setState(normalizeControlsState(next));
    }
    window.addEventListener("gvdg:admin-registration-controls", update);
    setState(normalizeControlsState(currentControlsState()));
    return () => window.removeEventListener("gvdg:admin-registration-controls", update);
  }, []);

  return state;
}

function EventSelector({ state }) {
  return h("div", { "data-react-admin-registration-controls": state.status }, [
    h("label", { htmlFor: "rgEvent", key: "label" }, "Event"),
    h("select", {
      disabled: state.status === "loading" && !state.events.length,
      id: "rgEvent",
      key: "select",
      onChange: (event) => dispatchRequest("gvdg:admin-registration-event-select-request", { eventId: event.target.value || null }),
      value: state.selectedEventId,
    }, [
      h("option", { key: "empty", value: "" }, "- select an event -"),
      ...state.events.map((event) => h("option", { key: event.id, value: event.id }, event.label)),
    ]),
    state.status === "loading" && !state.events.length ? h("p", { className: "al-note", key: "loading", role: "status" }, "Loading registration events...") : null,
    state.status === "error" ? h("p", { className: "al-note err", key: "error", role: "alert" }, "Unable to load registration events.") : null,
    state.notice ? h("p", { className: "al-note", key: "notice", role: "status" }, state.notice) : null,
  ]);
}

function NameListEditor({ addId, disabled, hint, label, names, onChange, placeholder }) {
  const [draft, setDraft] = React.useState("");

  function add(event) {
    event.preventDefault();
    const next = addName(names, draft);
    if (next.length !== names.length) onChange(next);
    setDraft("");
  }

  return h("div", { className: "al-name-list", key: addId }, [
    h("span", { className: "al-name-label", key: "label" }, label),
    hint ? h("span", { className: "al-note", key: "hint" }, hint) : null,
    names.length ? h("div", { className: "al-name-chips", key: "chips" }, names.map((name) => h("button", {
      "aria-label": `Remove ${name}`,
      className: "al-name-chip",
      disabled,
      key: name,
      onClick: () => onChange(names.filter((item) => item !== name)),
      type: "button",
    }, name))) : null,
    h("div", { className: "al-row", key: "add" }, [
      h("input", {
        disabled,
        id: addId,
        maxLength: 40,
        onChange: (event) => setDraft(event.target.value),
        onKeyDown: (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          add(event);
        },
        placeholder,
        value: draft,
      }),
      h("button", { className: "admin-btn secondary", disabled: disabled || !draft.trim(), onClick: add, type: "button" }, "Add"),
    ]),
  ]);
}

function SettingsForm({ state }) {
  const [form, setForm] = React.useState(() => formFromConfig(state.config));
  const [pendingRequest, setPendingRequest] = React.useState("");

  React.useEffect(() => {
    const active = typeof document !== "undefined" ? document.activeElement : null;
    const editing = active && active.closest && active.closest("[data-react-admin-registration-settings]") && active.matches("input, textarea, select");
    if (editing) return;
    setForm(formFromConfig(state.config));
    setPendingRequest("");
  }, [state.selectedEventId, state.config]);

  React.useEffect(() => {
    if (!pendingRequest) return undefined;
    function update(event) {
      if (event.detail?.requestId !== pendingRequest) return;
      setPendingRequest("");
    }
    window.addEventListener("gvdg:admin-registration-config-save-result", update);
    return () => window.removeEventListener("gvdg:admin-registration-config-save-result", update);
  }, [pendingRequest]);

  function setField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit(event) {
    event.preventDefault();
    if (pendingRequest) return;
    const id = requestId("registration-config");
    setPendingRequest(id);
    const existing = normalizeConfig(state.config && (state.config.liveScoringConfig || state.config.live_scoring_config), form.playFormat, null);
    dispatchRequest("gvdg:admin-registration-config-save-request", {
      body: {
        ace_fee_cents: dollarsToCents(form.aceFee),
        ctp_fee_cents: dollarsToCents(form.ctpFee),
        divisions: form.divisions,
        teams: form.teams,
        entry_fee_cents: dollarsToCents(form.entryFee),
        liveScoringConfig: {
          groupFormat: form.playFormat === "doubles" ? "doubles" : "singles",
          scoringStyle: existing.scoringStyle,
          handicap: existing.handicap === true && existing.scoringStyle !== "matchplay",
        },
        play_format: form.playFormat || null,
        registration_open: form.registrationOpen,
      },
      requestId: id,
      valid: true,
    });
  }

  const busy = Boolean(pendingRequest);
  const disabled = busy || state.configStatus === "loading";

  return h("div", { className: "al-section", "data-react-admin-registration-settings": state.configStatus }, [
    h("h4", { className: "al-h", key: "title" }, "Registration settings"),
    state.configStatus === "loading" ? h("p", { className: "al-note", key: "loading", role: "status" }, "Loading registration settings...") : null,
    state.configStatus === "error" ? h("p", { className: "al-note err", key: "error", role: "alert" }, "Unable to load saved settings.") : null,
    h("form", { key: "form", onSubmit: submit }, [
      h("label", { className: "register-addon", htmlFor: "rgOpen", key: "open" }, [
        h("input", {
          checked: form.registrationOpen,
          disabled,
          id: "rgOpen",
          onChange: (event) => setField("registrationOpen", event.target.checked),
          type: "checkbox",
        }),
        " Registration open",
      ]),
      h("div", { className: "al-row", key: "fees", style: { marginTop: "0.5rem" } }, [
        h("label", { key: "entry" }, ["Entry $", h("input", { disabled, id: "rgEntry", min: "0", onChange: (event) => setField("entryFee", event.target.value), size: 5, step: "1", type: "number", value: form.entryFee })]),
        h("label", { key: "ctp" }, ["CTP $", h("input", { disabled, id: "rgCtp", min: "0", onChange: (event) => setField("ctpFee", event.target.value), size: 5, step: "1", type: "number", value: form.ctpFee })]),
        h("label", { key: "ace" }, ["Ace $", h("input", { disabled, id: "rgAce", min: "0", onChange: (event) => setField("aceFee", event.target.value), size: 5, step: "1", type: "number", value: form.aceFee })]),
        h("select", { disabled, id: "rgFormat", key: "format", onChange: (event) => setField("playFormat", event.target.value), value: form.playFormat }, FORMATS.map(([value, label]) => h("option", { key: value || "empty", value }, label))),
      ]),
      h("div", { key: "menus" }, [
        h(NameListEditor, {
          addId: "rgDivisions",
          disabled,
          hint: "Players and the roster pick from this menu.",
          key: "divisions",
          label: "Divisions",
          names: form.divisions,
          onChange: (names) => setField("divisions", names),
          placeholder: "Add a division",
        }),
        form.playFormat === "teams" ? h(NameListEditor, {
          addId: "rgTeams",
          disabled,
          hint: "Add every team, save, then assign players on the roster.",
          key: "teams",
          label: "Teams",
          names: form.teams,
          onChange: (names) => setField("teams", names),
          placeholder: "Add a team",
        }) : null,
      ]),
      h("button", { className: "admin-btn", disabled: busy, key: "submit", style: { marginTop: "0.5rem" }, type: "submit" }, busy ? "Saving..." : "Save settings"),
    ]),
  ]);
}

export function AdminRegistrationControls({ state }) {
  const controlsState = state || useAdminRegistrationControlsState();
  return h(React.Fragment, null, [
    h(EventSelector, { key: "event", state: controlsState }),
    controlsState.selectedEventId ? h(SettingsForm, { key: "settings", state: controlsState }) : null,
  ]);
}
