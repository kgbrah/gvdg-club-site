import React from "react";

import { useSettledWhileLoading } from "../shared/settled-state.js";

import { AdminScoringLeaderboard, AdminScoringOverride, AdminScoringScorecard } from "./scoring-scorecard.js";
import { AdminScoringTeeSigns } from "./scoring-tee-signs.js";
import { eventConfig, isPutting, layoutLabel, normalizeConfig, playableEvents } from "./scoring-model.js";

const h = React.createElement;
const EMPTY_EVENTS_STATE = { events: [], status: "loading" };
const EMPTY_SCORING_STATE = { eventId: "", layouts: [], status: "idle" };

function dispatchRequest(name, detail = {}) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function normalizeEventsState(state) {
  return {
    events: Array.isArray(state.events) ? state.events : [],
    status: state.status === "error" || state.status === "ready" ? state.status : "loading",
  };
}

function normalizeScoringState(state) {
  return {
    ...EMPTY_SCORING_STATE,
    ...(state && typeof state === "object" ? state : {}),
    eventId: state?.eventId == null ? "" : String(state.eventId),
    layouts: Array.isArray(state?.layouts) ? state.layouts : [],
    status: typeof state?.status === "string" ? state.status : "idle",
  };
}

function FormatButtons({ label, name, onChange, options, value }) {
  return h("div", { className: "sc-start-field" }, [
    h("span", { key: "label" }, label),
    h("input", { id: name, key: "input", readOnly: true, type: "hidden", value }),
    h("div", { className: "fmt-btns", id: `${name}Btns`, key: "buttons" }, options.map((option) => h("button", {
      "aria-pressed": String(option.value === value),
      className: "fmt-btn",
      "data-val": option.value,
      key: option.value,
      onClick: () => onChange(option.value),
      type: "button",
    }, option.label))),
  ]);
}

const PUTT_DISTANCES = [8, 10, 12, 15, 18, 20, 25, 30, 33, 35, 40, 45, 50, 60, 66, 80];
const PUTT_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const PUTT_POINTS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20];

function presetLabel(option, suffix) {
  if (suffix === "pt") return option === 1 ? "1 pt" : `${option} pts`;
  if (suffix === "putt") return option === 1 ? "1 putt" : `${option} putts`;
  return suffix ? `${option} ${suffix}` : String(option);
}

function PresetOrCustom({ label, max, min, onChange, options, suffix, value }) {
  const numeric = Number(value);
  const listed = Number.isInteger(numeric) && options.includes(numeric);
  const [custom, setCustom] = React.useState(!listed);
  const [draft, setDraft] = React.useState(Number.isInteger(numeric) ? String(numeric) : "");

  React.useEffect(() => {
    if (!(Number.isInteger(numeric) && options.includes(numeric))) setCustom(true);
    setDraft(Number.isInteger(numeric) ? String(numeric) : "");
  }, [numeric, options]);

  function commitDraft(nextDraft) {
    const next = Number(nextDraft);
    if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
  }

  return h("label", { className: "putt-field" }, [
    h("span", { key: "label" }, label),
    h("select", {
      "aria-label": label,
      key: "select",
      onChange: (event) => {
        if (event.target.value === "custom") {
          setCustom(true);
          setDraft(Number.isInteger(numeric) ? String(numeric) : "");
          return;
        }
        setCustom(false);
        onChange(Number(event.target.value));
      },
      value: custom ? "custom" : String(numeric),
    }, [
      ...options.map((option) => h("option", { key: option, value: String(option) }, presetLabel(option, suffix))),
      h("option", { key: "custom", value: "custom" }, "Custom"),
    ]),
    custom ? h("input", {
      "aria-label": `${label} custom`,
      inputMode: "numeric",
      key: "custom",
      max: String(max),
      min: String(min),
      onBlur: () => {
        const next = Number(draft);
        if (!(Number.isInteger(next) && next >= min && next <= max)) {
          setDraft(Number.isInteger(numeric) ? String(numeric) : "");
        }
      },
      onChange: (event) => {
        setDraft(event.target.value);
        commitDraft(event.target.value);
      },
      placeholder: `${min}-${max}`,
      type: "number",
      value: draft,
    }) : null,
  ]);
}

export function PuttingStations({ onChange, stations }) {
  function update(index, patch) {
    onChange(stations.map((station, stationIndex) => stationIndex === index ? { ...station, ...patch } : station));
  }
  const weighted = stations.some((station) => Number(station.points) > 1);
  return h("div", { className: "putt-stations", key: "stations" }, [
    h("span", { className: "putt-stations-title", key: "label" }, "Putting stations"),
    h("div", { className: "putt-station-list", key: "list" }, stations.map((station, index) => h("div", { className: "putt-station", key: `station-${index}` }, [
      h("div", { className: "putt-station-head", key: "head" }, [
        h("strong", { key: "title" }, `Station ${index + 1}`),
        stations.length > 1 ? h("button", {
          className: "putt-remove",
          key: "remove",
          onClick: () => onChange(stations.filter((_, stationIndex) => stationIndex !== index)),
          type: "button",
        }, "Remove") : null,
      ]),
      h("div", { className: "putt-station-grid", key: "grid" }, [
        h(PresetOrCustom, {
          key: "distance",
          label: "Distance",
          max: 80,
          min: 8,
          onChange: (distanceFt) => update(index, { distanceFt }),
          options: PUTT_DISTANCES,
          suffix: "ft",
          value: station.distanceFt,
        }),
        h(PresetOrCustom, {
          key: "putts",
          label: "Putts",
          max: 10,
          min: 1,
          onChange: (putts) => update(index, { putts }),
          options: PUTT_COUNTS,
          suffix: "putt",
          value: station.putts,
        }),
        h(PresetOrCustom, {
          key: "points",
          label: "Points",
          max: 20,
          min: 1,
          onChange: (points) => update(index, { points }),
          options: PUTT_POINTS,
          suffix: "pt",
          value: station.points || 1,
        }),
      ]),
    ]))),
    stations.length < 12 ? h("button", {
      className: "admin-btn secondary putt-add",
      key: "add",
      onClick: () => onChange(stations.concat([{ distanceFt: 35, putts: stations[0]?.putts || 5, points: 1 }])),
      type: "button",
    }, "Add station") : null,
    h("p", { className: "al-note", key: "note" }, weighted
      ? "Players still enter makes. Each make is worth that station's points, and the highest point total wins."
      : "Pick a distance, putt count, and points per make. Choose Custom for a value that is not in the list. Leave points at 1 to rank by makes."),
  ]);
}

function EventSelector({ eventsState, selectedId }) {
  const events = playableEvents(eventsState.events);
  return h("div", { "data-react-admin-scoring-events": eventsState.status }, [
    h("label", { htmlFor: "scEvent", key: "label" }, "Event"),
    h("select", {
      disabled: eventsState.status === "loading",
      id: "scEvent",
      key: "select",
      onChange: (event) => dispatchRequest("gvdg:admin-scoring-select-event-request", { eventId: event.target.value }),
      value: selectedId,
    }, [
      h("option", { key: "none", value: "" }, eventsState.status === "loading" ? "Loading events..." : "select a scheduled or live event"),
      ...events.map((event) => h("option", { key: event.id, value: event.id }, `${event.name} [${event.status}]${event.date ? ` - ${event.date}` : ""}`)),
    ]),
  ]);
}

function StartControls({ state }) {
  const initialConfig = normalizeConfig(state.config || eventConfig(state.event || {}));
  const [config, setConfig] = React.useState(initialConfig);
  const [layoutId, setLayoutId] = React.useState(state.layoutId == null ? "" : String(state.layoutId));
  const [pending, setPending] = React.useState(false);
  const [validation, setValidation] = React.useState(state.validation || "");

  React.useEffect(() => {
    setConfig(normalizeConfig(state.config || eventConfig(state.event || {})));
    setLayoutId(state.layoutId == null ? "" : String(state.layoutId));
    setValidation(state.validation || "");
    setPending(false);
  }, [state.eventId, state.config, state.layoutId, state.validation]);

  React.useEffect(() => {
    function finish(event) {
      if (event.detail?.kind === "start") setPending(false);
    }
    window.addEventListener("gvdg:admin-scoring-action-result", finish);
    return () => window.removeEventListener("gvdg:admin-scoring-action-result", finish);
  }, []);

  function updateConfig(patch) {
    setConfig((current) => ({ ...current, ...patch }));
    setValidation("");
  }

  function start() {
    const liveScoringConfig = normalizeConfig(config);
    if (liveScoringConfig.scoringStyle === "matchplay") {
      setValidation("Match play requires exactly two score targets per card; start will be blocked if the roster/pairs do not satisfy that.");
    }
    setPending(true);
    dispatchRequest("gvdg:admin-scoring-start-request", {
      eventId: state.eventId,
      layoutId: config.scoringStyle === "putting" ? "" : layoutId,
      liveScoringConfig,
    });
  }

  const putting = config.scoringStyle === "putting";
  const stroke = config.scoringStyle === "stroke";
  return h("div", { "data-react-admin-scoring-start": "ready", id: "scStart", style: { marginTop: "1rem" } }, [
    h("div", { className: "sc-start-grid", key: "grid" }, [
      putting ? null : h("label", { className: "sc-start-field", htmlFor: "scLayout", key: "layout" }, [
        h("span", { key: "label" }, "Layout"),
        h("select", { id: "scLayout", key: "select", onChange: (event) => setLayoutId(event.target.value), value: layoutId }, [
          h("option", { key: "none", value: "" }, "event's current layout"),
          ...state.layouts.map((layout) => h("option", { key: String(layout.id), value: String(layout.id) }, layoutLabel(layout))),
        ]),
      ]),
      h(FormatButtons, {
        key: "style",
        label: "Scoring",
        name: "scScoringStyle",
        onChange: (value) => updateConfig(value === "matchplay"
          ? { scoringStyle: value, handicap: false }
          : value === "putting"
            ? { scoringStyle: "putting", groupFormat: "singles", handicap: false, putting: config.putting || { stations: normalizeConfig({ scoringStyle: "putting" }).putting.stations } }
            : { scoringStyle: value }),
        options: [{ label: "Stroke play", value: "stroke" }, { label: "Match play", value: "matchplay" }, { label: "Putting", value: "putting" }],
        value: config.scoringStyle,
      }),
      putting ? null : h(FormatButtons, {
        key: "group",
        label: "Group",
        name: "scGroupFormat",
        onChange: (value) => updateConfig({ groupFormat: value }),
        options: [{ label: "Singles", value: "singles" }, { label: "Doubles", value: "doubles" }],
        value: config.groupFormat,
      }),
      stroke ? h(FormatButtons, {
        key: "handicap",
        label: "Handicap",
        name: "scHandicap",
        onChange: (value) => updateConfig({ handicap: value === "on" }),
        options: [{ label: "Off", value: "off" }, { label: "On", value: "on" }],
        value: config.handicap === true ? "on" : "off",
      }) : null,
      putting ? h(PuttingStations, {
        key: "stations",
        onChange: (stations) => updateConfig({ putting: { stations } }),
        stations: config.putting?.stations || [],
      }) : null,
      h("div", { className: "sc-start-actions", key: "actions" }, [
        h("button", { className: "admin-btn", disabled: pending, id: "scStartBtn", key: "start", onClick: start, type: "button" }, pending ? "Starting..." : "Start live scoring"),
        h("button", {
          className: "admin-btn secondary",
          id: "scAddPlayersBtn",
          key: "roster",
          onClick: () => {
            dispatchRequest("gvdg:admin-tab-request", { tab: "registration" });
            dispatchRequest("gvdg:admin-registration-event-select-request", { eventId: state.eventId });
          },
          type: "button",
        }, "Add players"),
      ]),
    ]),
    h("p", { className: "al-note", id: "scStartValidation", key: "validation", role: validation ? "status" : undefined }, validation),
    h("p", { className: "al-note", key: "note" }, putting
      ? "Putting does not use a course, groups, or handicap. Players enter makes at each station."
      : stroke
        ? "Handicap ranks by each player's start plus this round. Leave it off to score the round as shot. The layout still needs pars."
        : "Match play needs exactly two score targets per card. Doubles needs pair labels in Registration."),
  ]);
}

function LiveControls({ state }) {
  const snap = state.snap || {};
  const submitted = Array.isArray(snap.lockedCardIds) ? snap.lockedCardIds.length : 0;
  return h("div", { "data-react-admin-scoring-live": snap.status || "ready", id: "scLive", style: { marginTop: "1rem" } }, [
    h("h4", { className: "al-h", key: "score-title" }, [
      "Scorecard ",
      h("span", { className: "al-note", key: "note" }, isPutting(snap) ? "(enter makes - saves and pushes live instantly)" : "(enter strokes - saves and pushes live instantly)"),
    ]),
    h(AdminScoringScorecard, { key: "grid", snapshot: snap }),
    h(AdminScoringOverride, { canOverride: state.canOverride === true, key: "override", snapshot: snap }),
    h("h4", { className: "al-h", key: "tee-title", style: { marginTop: "1rem" } }, [
      "Tee signs ",
      h("span", { className: "al-note", key: "note" }, "(official, or unverified candidates awaiting review)"),
    ]),
    h(AdminScoringTeeSigns, { key: "tee-signs", state }),
    h("h4", { className: "al-h", key: "board-title", style: { marginTop: "1rem" } }, "Live leaderboard"),
    h(AdminScoringLeaderboard, { key: "board", snapshot: snap }),
    h("div", { className: "al-row", key: "actions", style: { marginTop: "0.75rem" } }, [
      h("button", { className: "admin-btn danger", id: "scFinalizeBtn", key: "finalize", onClick: () => dispatchRequest("gvdg:admin-scoring-finalize-request"), type: "button" }, "Finalize results"),
      state.canCancel === true ? h("button", { className: "admin-btn secondary", id: "scCancelBtn", key: "cancel", onClick: () => dispatchRequest("gvdg:admin-scoring-cancel-request"), type: "button" }, "Cancel scoring") : null,
      h("span", { className: "al-note", key: "note" }, submitted
        ? submitted + " card" + (submitted === 1 ? "" : "s") + " submitted. Finalize writes results and closes the event. Cancel scraps a mis-started round and returns the event to Scheduled."
        : "Finalize writes results and closes the event. Cancel scraps a mis-started round and returns the event to Scheduled."),
    ]),
  ]);
}

export function AdminScoringPanel() {
  const [eventsState, setEventsState] = React.useState(() => normalizeEventsState(EMPTY_EVENTS_STATE));
  const [state, setState] = React.useState(() => normalizeScoringState(EMPTY_SCORING_STATE));

  React.useEffect(() => {
    function updateEvents(event) {
      setEventsState(normalizeEventsState(event.detail && typeof event.detail === "object" ? event.detail : EMPTY_EVENTS_STATE));
    }
    function updateScoring(event) {
      setState(normalizeScoringState(event.detail && typeof event.detail === "object" ? event.detail : EMPTY_SCORING_STATE));
    }
    window.addEventListener("gvdg:admin-scoring-events-state", updateEvents);
    window.addEventListener("gvdg:admin-scoring-state", updateScoring);
    dispatchRequest("gvdg:admin-scoring-load-events-request");
    return () => {
      window.removeEventListener("gvdg:admin-scoring-events-state", updateEvents);
      window.removeEventListener("gvdg:admin-scoring-state", updateScoring);
    };
  }, []);

  const eventsView = useSettledWhileLoading(eventsState);

  return h("div", { className: "admin-scoring-card", "data-react-admin-scoring": state.status }, [
    h("div", { className: "admin-scoring-card-block", key: "events" }, h(EventSelector, { eventsState: eventsView, selectedId: state.eventId })),
    state.status === "loading" ? h("p", { className: "al-note", key: "loading", role: "status" }, "Loading live scoring...") : null,
    state.status === "error" ? h("p", { className: "al-note err", key: "error", role: "alert" }, state.message || "Unable to load live scoring.") : null,
    state.status === "start" ? h("div", { className: "admin-scoring-card-block", key: `start-${state.eventId}` }, h(StartControls, { state })) : null,
    state.status === "live" || state.status === "final" ? h(LiveControls, { key: `live-${state.eventId}`, state }) : null,
  ]);
}
