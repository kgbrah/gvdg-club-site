import React from "react";

import { readMemberToken, TOKEN_KEY } from "../shared/member-session.js";
import { discCatalog, discChoices, unfilledDiscDetails } from "./bag-disc-catalog.js";
import { BagDiscChoice, BagDiscVoice, BagDiscWeight } from "./bag-disc-inputs.js";

import { MoreLink } from "./more-page.js";
import { memberConfirm } from "./member-dialogs.js";
import {
  distanceBetween, distanceFromMeters, localDate, metersFromDistance, practicePercent,
  puttingMakeTotals, SHOT_TYPES, stagePutting,
} from "./practice-model.js";

const h = React.createElement;
const EMPTY_DISC = { brand: "", model: "", plastic: "", weightGrams: "", notes: "", inBag: true, archived: false };

function field(label, settings) {
  const { options, rows, ...props } = settings;
  const type = options ? "select" : rows ? "textarea" : "input";
  return h("label", { className: "member-practice-field", key: props.name }, [
    h("span", { key: "label" }, label),
    h(type, { ...props, rows, className: "form-input", key: "control" },
      options ? options.map(([value, name]) => h("option", { value, key: value }, name)) : null),
  ]);
}

function formError(error) {
  return error ? h("p", { className: "dash-note", role: "alert", key: "error" }, error) : null;
}

function formButton(label, attrs = {}) {
  return h("button", { className: "dashboard-action", type: "button", ...attrs }, label);
}

function updateField(form, setter, name, settings = {}) {
  return {
    name, value: form[name], ...settings,
    onChange: (event) => {
      const value = event.target.value;
      setter((current) => ({ ...current, [name]: value }));
    },
  };
}

const UNIT_OPTIONS = [["ft", "Feet"], ["m", "Meters"]];

function DiscLabel(disc) {
  return [disc.brand, disc.model].filter(Boolean).join(" ") || "Disc";
}

function draftLabel(entry) {
  if (entry.draftState === "auth" || entry.draftState === "error") return "Needs attention";
  if (entry.draftState) return entry.deleting ? "Removal pending sync" : "Saved on this phone";
  return "";
}

function syncReason(item) {
  const { error, state } = item;
  if (state === "auth") return "Sign in to the same membership to sync.";
  if (error === "disc_unavailable") return "That disc is not available on this account.";
  if (error === "disc_in_use") return "Discard this deletion, remove the disc’s saved throws, then try deleting it again.";
  if (error === "record_limit") return "This kind of record reached the account limit. Export or remove older records before adding more.";
  if (error === "record_changed") return "This record changed. Discard this draft, then review the current record.";
  return "This saved change needs attention.";
}

function SyncStatus({ workspace }) {
  const { drafts, status, error } = workspace;
  const failed = drafts.filter((entry) => entry.state === "error" || entry.state === "auth");
  const count = drafts.length;
  return h("div", { className: "member-practice-status" }, [
    h("p", { className: "dash-note", role: "status", key: "status" }, count
      ? count + (count === 1 ? " change saved on this phone." : " changes saved on this phone.") + " "
        + (status === "offline" ? "Sync when you’re back online." : failed.length === count ? "Review the changes below." : "Waiting to sync.")
      : status === "ready" ? "Practice record synced." : status === "offline" ? "Showing saved data on this phone."
      : status === "auth" ? "Sign in again to sync." : "Loading your practice record…"),
    formError(error),
    count ? formButton("Retry sync", { key: "retry", onClick: workspace.sync }) : null,
    failed.length ? h("ul", { className: "member-practice-problems", key: "errors" }, failed.map((entry) => h("li", { key: entry.id }, [
      h("span", { key: "reason" }, (entry.kind === "disc" ? "Bag" : entry.kind === "throw" ? "Fieldwork" : "Putting") + " · " + syncReason(entry)),
      formButton("Discard draft", { key: "discard", onClick: () => workspace.discard(entry.id) }),
    ]))) : null,
  ]);
}

function ExportPractice({ workspace }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  async function download() {
    setBusy(true);
    setError("");
    try {
      const data = await workspace.download();
      if (!data) {
        setError("Connect and sign in to download your practice and bag.");
        return;
      }
      const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = href;
      link.download = "gvdg-practice-and-bag.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 3000);
    } catch {
      setError("Your export couldn’t download. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return h("details", { className: "player-card member-practice-export" }, [
    h("summary", { key: "summary" }, "Your practice data"),
    h("p", { className: "player-card-meta", key: "privacy" }, "Your bag and practice records are private. Delete individual sessions, throws, or unused archived discs to remove them from your history. Your export includes recorded GPS and drafts stored on this phone."),
    formButton(busy ? "Downloading…" : "Download practice and bag", { key: "download", disabled: busy, onClick: () => { void download(); } }),
    formError(error),
  ]);
}

function bagSessionToken() {
  try {
    // The member shell migrates legacy sessions before this page renders. A
    // lookup here must never copy a retired tab's token back into local storage.
    return window.localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return readMemberToken({ persistent: null });
  }
}

function DiscForm({ initial, onSave, onClose, savedDiscs, scope }) {
  const [form, setForm] = React.useState(() => initial ? { ...initial.record, weightGrams: initial.record.weightGrams ?? "" } : EMPTY_DISC);
  const [error, setError] = React.useState("");
  const notesId = React.useId();
  const catalog = discCatalog(savedDiscs);
  const { brands, models, plastics } = discChoices(catalog, form.brand, form.model);
  const isCurrentSession = () => scope.active && bagSessionToken() === scope.token;

  function submit(event) {
    event.preventDefault();
    if (!isCurrentSession()) return;
    const record = {
      ...form, brand: form.brand.trim(), model: form.model.trim(), plastic: form.plastic.trim(), notes: form.notes.trim(),
      weightGrams: form.weightGrams === "" ? null : Number(form.weightGrams),
    };
    if (!record.brand || !record.model) { setError("Enter the disc’s brand and model."); return; }
    setError(onSave(record, initial) || "");
  }

  function choice(name, label, options, required = false) {
    return h(BagDiscChoice, {
      key: name, label, name, required, options, value: form[name],
      onChange: (value) => setForm((current) => ({ ...current, [name]: value })),
    });
  }

  return h("form", { className: "player-card member-practice-form bag-disc-form", onSubmit: submit }, [
    h("h2", { key: "heading" }, initial ? "Edit disc" : "Add a disc"),
    h(BagDiscVoice, {
      catalog, form, isCurrentSession, key: "voice",
      onFill: (details) => setForm((current) => ({ ...current, ...unfilledDiscDetails(current, details) })),
    }),
    h("div", { className: "member-practice-grid bag-disc-fields", key: "fields" }, [
      choice("brand", "Brand", brands, true),
      choice("model", "Model", models, true),
      choice("plastic", "Plastic", plastics),
      h(BagDiscWeight, {
        key: "weight", value: form.weightGrams,
        onChange: (value) => setForm((current) => ({ ...current, weightGrams: value })),
      }),
    ]),
    h("div", { className: "member-practice-field", key: "notes" }, [
      h("label", { htmlFor: notesId, key: "label" }, "Notes"),
      h("textarea", { className: "form-input", id: notesId, key: "text",
        ...updateField(form, setForm, "notes", { rows: 2, maxLength: 480 }) }),
    ]),
    !form.archived ? h("label", { key: "in-bag" }, [
      h("input", { type: "checkbox", key: "check", checked: form.inBag, onChange: (event) => {
        const inBag = event.target.checked;
        setForm((current) => ({ ...current, inBag }));
      } }), " In my bag",
    ]) : null,
    formError(error),
    h("div", { className: "dashboard-actions", key: "actions" }, [
      formButton("Save disc", { type: "submit", className: "dashboard-action primary", key: "save" }),
      formButton("Cancel", { key: "cancel", onClick: onClose }),
    ]),
  ]);
}

function editRecord(workspace, kind, record, initial = null) {
  return workspace.stage(kind, { id: initial?.id || crypto.randomUUID(), action: "save", expectedRevision: initial?.revision ?? 0, record });
}

function discActions(row, workspace, onEdit, setError) {
  const { record } = row;
  const change = (patch) => setError(editRecord(workspace, "disc", { ...record, ...patch }, row));
  async function remove() {
    const confirmed = await memberConfirm({
      title: "Delete this archived disc?",
      message: "The disc can be deleted after its measured throws are removed.",
      confirmText: "Delete disc",
      danger: true,
    });
    if (confirmed) setError(workspace.stage("disc", { id: row.id, action: "delete", expectedRevision: row.revision }));
  }
  return h("div", { className: "dashboard-actions", key: "actions" }, [
    formButton("Edit", { key: "edit", disabled: Boolean(row.draftState), onClick: () => onEdit(row) }),
    !record.archived ? formButton(record.inBag ? "Take out of bag" : "Put in bag", {
      key: "bag", disabled: Boolean(row.draftState), onClick: () => change({ inBag: !record.inBag }),
    }) : null,
    formButton(record.archived ? "Restore" : "Archive", {
      key: "archive", disabled: Boolean(row.draftState), onClick: () => change({ archived: !record.archived, inBag: false }),
    }),
    record.archived ? formButton("Delete disc", {
      className: "member-record-delete", key: "delete", disabled: Boolean(row.draftState), onClick: () => { void remove(); },
    }) : null,
  ]);
}

export function MemberBagPage({ workspace }) {
  const [editor, setEditor] = React.useState(null);
  const editorScope = React.useRef(null);
  const [error, setError] = React.useState("");
  const [query, setQuery] = React.useState("");
  const closeEditor = React.useCallback(() => {
    if (editorScope.current) editorScope.current.active = false;
    editorScope.current = null;
    setEditor(null);
  }, []);
  React.useEffect(() => {
    function clearPriorEditor(event) {
      if (event.key !== null && event.key !== TOKEN_KEY) return;
      const scope = editorScope.current;
      if (!scope || event.newValue === scope.token) return;
      // Retire the guard synchronously, before any queued recognition result
      // or render can treat the old editor as current.
      scope.active = false;
      try {
        if (window.sessionStorage.getItem(TOKEN_KEY) === scope.token) window.sessionStorage.removeItem(TOKEN_KEY);
      } catch { /* Local credential checks still guard the editor. */ }
      closeEditor();
    }
    window.addEventListener("storage", clearPriorEditor, true);
    return () => window.removeEventListener("storage", clearPriorEditor, true);
  }, [closeEditor]);
  function openEditor(initial) {
    const token = bagSessionToken();
    if (!token) return;
    if (editor?.scope.active && editor.scope.token === token && editor.initial?.id === initial?.id) return;
    if (editorScope.current) editorScope.current.active = false;
    const scope = { token, active: true };
    editorScope.current = scope;
    setEditor({ initial, scope });
  }
  const term = query.trim().toLowerCase();
  const records = workspace.data.discs.filter(({ record }) => [record.brand, record.model, record.plastic].join(" ").toLowerCase().includes(term))
    .sort((a, b) => Number(b.record.inBag) - Number(a.record.inBag) || DiscLabel(a.record).localeCompare(DiscLabel(b.record)));
  const active = records.filter((row) => !row.record.archived);
  const archived = records.filter((row) => row.record.archived);
  const group = (items) => h("div", { className: "member-practice-records", key: "list" }, items.map((row) => h("article", { className: "player-card", key: row.id }, [
    h("h3", { key: "label" }, DiscLabel(row.record)),
    h("p", { className: "player-card-meta", key: "variant" }, [
      row.record.plastic, row.record.weightGrams == null ? "" : row.record.weightGrams + " g",
      row.record.archived ? "Archived" : row.record.inBag ? "In bag" : "Out of bag", draftLabel(row),
    ].filter(Boolean).join(" · ")),
    row.record.notes ? h("p", { className: "player-card-meta", key: "notes" }, row.record.notes) : null,
    discActions(row, workspace, openEditor, setError),
  ])));
  return h("div", { className: "react-play-page player-play member-practice", "data-member-bag": "ready" }, [
    h("div", { className: "member-practice-toolbar", key: "toolbar" }, [
      formButton("Add disc", { className: "dashboard-action primary", key: "add", onClick: () => openEditor(null) }),
      h(MoreLink, { tab: "practice", label: "Log a practice session", key: "practice" }),
    ]),
    h(SyncStatus, { workspace, key: "sync" }),
    editor?.scope.active && editor.scope.token === bagSessionToken() ? h(DiscForm, {
      initial: editor.initial, key: editor.initial?.id || "new",
      savedDiscs: workspace.data.discs, scope: editor.scope,
      onSave: (record, original) => {
        const failure = editRecord(workspace, "disc", record, original);
        if (!failure) closeEditor();
        return failure;
      },
      onClose: closeEditor,
    }) : null,
    workspace.data.discs.length > 5 ? field("Find in my bag", { name: "search", type: "search", value: query, onChange: (event) => setQuery(event.target.value) }) : null,
    formError(error),
    active.length ? group(active) : h("p", { className: "dash-note", key: "empty" }, term ? "No matching discs." : "Add your first disc to log fieldwork."),
    archived.length ? h("details", { className: "player-card", key: "archived" }, [
      h("summary", { key: "label" }, "Archived discs (" + archived.length + ")"), group(archived),
    ]) : null,
    h(ExportPractice, { workspace, key: "export" }),
  ]);
}

function PuttingForm({ workspace, onClose }) {
  const seed = () => ({ distance: "", unit: "ft", attempts: "", makes: "" });
  const [form, setForm] = React.useState(() => ({ date: localDate(), stations: [seed()] }));
  const [error, setError] = React.useState("");
  function submit(event) {
    event.preventDefault();
    const record = stagePutting(form);
    if (!record) {
      setError("Enter each distance once, with at least one attempt and makes no greater than attempts.");
      return;
    }
    const failure = editRecord(workspace, "putting", record);
    if (failure) setError(failure);
    else onClose();
  }
  return h("form", { className: "player-card member-practice-form", onSubmit: submit }, [
    h("h2", { key: "heading" }, "Log putting"),
    field("Date", updateField(form, setForm, "date", { type: "date", max: localDate(), min: "1990-01-01", required: true })),
    ...form.stations.map((row, index) => {
      const change = (name, options) => ({
        name, value: row[name], ...options,
        onChange: (event) => {
          const value = event.target.value;
          setForm((state) => ({ ...state, stations: state.stations.map((station, i) => i === index ? { ...station, [name]: value } : station) }));
        },
      });
      return h("fieldset", { className: "member-practice-station", key: index }, [
        h("legend", { key: "legend" }, "Distance " + (index + 1)),
        h("div", { className: "member-practice-grid", key: "counts" }, [
          field("Distance", change("distance", { type: "number", min: "0.1", max: row.unit === "ft" ? "328.08" : "100", step: "any", required: true })),
          field("Unit", change("unit", { options: UNIT_OPTIONS })),
          field("Attempts", change("attempts", { type: "number", min: "1", max: "500", required: true })),
          field("Makes", change("makes", { type: "number", min: "0", max: row.attempts || "500", required: true })),
        ]),
        form.stations.length > 1 ? formButton("Remove distance " + (index + 1), {
          key: "remove", onClick: () => setForm((state) => ({ ...state, stations: state.stations.filter((_, i) => i !== index) })),
        }) : null,
      ]);
    }),
    formButton("Add another distance", {
      key: "add", disabled: form.stations.length >= 12, onClick: () => setForm((state) => ({ ...state, stations: [...state.stations, seed()] })),
    }),
    formError(error),
    h("div", { className: "dashboard-actions", key: "actions" }, [
      formButton("Save putting session", { key: "save", type: "submit", className: "dashboard-action primary" }),
      formButton("Cancel", { key: "cancel", onClick: onClose }),
    ]),
  ]);
}

function readFix() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("gps_unavailable")); return; }
    navigator.geolocation.getCurrentPosition(({ coords }) => resolve({
      lat: coords.latitude, lng: coords.longitude, accuracyM: coords.accuracy,
    }), reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  });
}

function FieldworkForm({ workspace, onClose }) {
  const discs = workspace.data.discs.filter((row) => !row.record.archived && !row.deleting);
  const choices = [...discs].sort((a, b) => Number(b.record.inBag) - Number(a.record.inBag)).map((row) => [row.id, DiscLabel(row.record)]);
  const [form, setForm] = React.useState(() => ({ date: localDate(), discId: choices[0]?.[0] || "", shotType: "backhand", distance: "", unit: "ft" }));
  const [points, setPoints] = React.useState({});
  const [keepGps, setKeepGps] = React.useState(false);
  const [fixing, setFixing] = React.useState(false);
  const [error, setError] = React.useState("");

  async function capture(place) {
    setFixing(true);
    try {
      const fix = await readFix();
      const next = { ...points, [place]: fix };
      setPoints(next);
      if (next.origin && next.end) {
        const meters = distanceBetween(next.origin, next.end);
        setForm((current) => ({ ...current, distance: distanceFromMeters(meters, current.unit) }));
      }
      setError("");
    } catch {
      setError("Location couldn’t be read. Try again or enter a measured distance.");
    } finally {
      setFixing(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    const meters = metersFromDistance(form.distance, form.unit);
    if (!meters || meters > 1500 || !choices.some(([id]) => id === form.discId)) {
      setError("Choose a disc and enter a measured distance.");
      return;
    }
    const record = {
      ...form, distance: Number(form.distance),
      ...(keepGps && points.origin && points.end ? { origin: points.origin, end: points.end } : {}),
    };
    const failure = editRecord(workspace, "throw", record);
    if (failure) setError(failure);
    else onClose();
  }

  return h("form", { className: "player-card member-practice-form", onSubmit: submit }, [
    h("h2", { key: "heading" }, "Log a measured throw"),
    choices.length ? null : h(MoreLink, { tab: "my-bag", label: "Add a disc first", key: "bag" }),
    h("div", { className: "member-practice-grid", key: "fields" }, [
      field("Disc", updateField(form, setForm, "discId", { options: [["", "Choose a disc"], ...choices], required: true })),
      field("Shot type", updateField(form, setForm, "shotType", { options: SHOT_TYPES })),
      field("Date", updateField(form, setForm, "date", { type: "date", max: localDate(), min: "1990-01-01", required: true })),
      field("Measured distance", updateField(form, setForm, "distance", { type: "number", min: "0.1", max: form.unit === "ft" ? "4921.25" : "1500", step: "any", required: true })),
      field("Unit", {
        name: "unit", value: form.unit, options: UNIT_OPTIONS,
        onChange: (event) => {
          const unit = event.target.value;
          const meters = metersFromDistance(form.distance, form.unit);
          setForm({ ...form, unit, distance: meters ? distanceFromMeters(meters, unit) : "" });
        },
      }),
    ]),
    h("details", { key: "gps" }, [
      h("summary", { key: "label" }, "Measure with GPS"),
      h("p", { className: "player-card-meta", key: "help" }, "Set your throwing spot, then walk to the disc and record where it landed."),
      h("div", { className: "dashboard-actions", key: "buttons" }, [
        formButton(points.origin ? "Reset throwing spot" : "Set throwing spot", { key: "origin", disabled: fixing, onClick: () => { void capture("origin"); } }),
        formButton(points.end ? "Reset landing spot" : "Set landing spot", { key: "end", disabled: fixing || !points.origin, onClick: () => { void capture("end"); } }),
      ]),
      fixing ? h("p", { role: "status", key: "fix" }, "Getting location…") : null,
      points.origin && points.end ? h("div", { key: "accuracy" }, [
        h("p", { className: "player-card-meta", key: "distance" }, "GPS accuracy ±" + Math.round(Math.max(points.origin.accuracyM, points.end.accuracyM)) + " m"),
        h("label", { key: "keep" }, [
          h("input", { type: "checkbox", checked: keepGps, key: "check", onChange: (event) => setKeepGps(event.target.checked) }),
          " Include private GPS locations in this record",
        ]),
      ]) : null,
    ]),
    formError(error),
    h("div", { className: "dashboard-actions", key: "actions" }, [
      formButton("Save measured throw", { type: "submit", className: "dashboard-action primary", disabled: !choices.length, key: "save" }),
      formButton("Cancel", { key: "cancel", onClick: onClose }),
    ]),
  ]);
}

function ratio(makes, attempts) {
  const percentage = practicePercent(makes, attempts);
  return percentage === null ? "No attempts" : percentage + "% (" + makes + "/" + attempts + ")";
}

function PuttingSummary({ data }) {
  const total = data.puttingTotals;
  if (!total?.attempts) return null;
  return h("section", { className: "player-card", "aria-label": "Putting totals and trends" }, [
    h("h2", { key: "heading" }, "Putting totals"),
    h("p", { key: "total" }, ratio(total.makes, total.attempts) + " across " + total.sessions + (total.sessions === 1 ? " saved session" : " saved sessions")),
    h("details", { key: "trend", className: "member-practice-export" }, [
      h("summary", { key: "label" }, "Trends by distance"),
      ...data.puttingTrends.map((row) => h("article", { className: "member-practice-trend", key: row.meters }, [
        h("strong", { key: "distance" }, distanceFromMeters(row.meters, "ft") + " ft · " + row.meters + " m"),
        h("span", { key: "all" }, "All time " + ratio(row.makes, row.attempts)),
        h("span", { key: "today" }, "Last 30 days " + ratio(row.lastMakes, row.lastAttempts)),
        h("span", { key: "before" }, "Prior 30 days " + ratio(row.priorMakes, row.priorAttempts)),
      ])),
    ]),
  ]);
}

function FieldworkSummary({ data }) {
  if (!data.throwGroups.length) return null;
  const names = new Map(data.discs.map((row) => [row.id, DiscLabel(row.record)]));
  return h("details", { className: "player-card member-practice-export" }, [
    h("summary", { key: "label" }, "Distance by disc and shot type"),
    ...data.throwGroups.map((row) => h("article", { className: "member-practice-trend", key: JSON.stringify([row.discId, row.shotType]) }, [
      h("strong", { key: "disc" }, (names.get(row.discId) || "Disc") + " · " + row.shotType),
      h("span", { key: "count" }, row.throws + (row.throws === 1 ? " throw" : " throws")),
      h("span", { key: "avg" }, "Average " + distanceFromMeters(row.averageMeters, "ft") + " ft"),
      h("span", { key: "max" }, "Farthest " + distanceFromMeters(row.farthestMeters, "ft") + " ft"),
    ])),
  ]);
}

function PracticeHistory({ kind, workspace }) {
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const names = new Map(workspace.data.discs.map((row) => [row.id, DiscLabel(row.record)]));
  const list = workspace.data[kind === "throw" ? "throws" : "putting"];
  async function remove(row) {
    const confirmed = await memberConfirm({
      title: kind === "throw" ? "Delete this throw?" : "Delete this putting session?",
      message: "This removes the record from your practice history.",
      confirmText: "Delete record",
      danger: true,
    });
    if (!confirmed) return;
    setError(workspace.stage(kind, { id: row.id, action: "delete", expectedRevision: row.revision }));
  }
  return h("section", { className: "player-card", "aria-label": kind === "throw" ? "Measured throw history" : "Putting history" }, [
    h("h2", { key: "heading" }, kind === "throw" ? "Measured throws" : "Putting sessions"),
    formError(error),
    list.items.length ? h("ul", { className: "member-practice-history", key: "items" }, list.items.map((row) => {
      const record = row.record;
      const total = kind === "putting" ? puttingMakeTotals(record.stations) : null;
      return h("li", { key: row.id }, [
        h("div", { key: "copy" }, [
          h("strong", { key: "label" }, total ? ratio(total.makes, total.attempts) : (names.get(record.discId) || "Disc") + " · " + record.distance + " " + record.unit),
          h("p", { className: "player-card-meta", key: "date" }, [record.date, total ? "" : record.shotType, draftLabel(row)].filter(Boolean).join(" · ")),
          total ? h("p", { className: "player-card-meta", key: "distances" },
            record.stations.map((station) => station.distance + " " + station.unit + " " + station.makes + "/" + station.attempts).join(" · ")) : null,
        ]),
        formButton("Delete", {
          className: "member-record-delete", key: "remove", "aria-label": "Delete " + (kind === "throw" ? "measured throw" : "putting session") + " from " + record.date,
          disabled: Boolean(row.draftState), onClick: () => { void remove(row); },
        }),
      ]);
    })) : h("p", { className: "dash-note", key: "empty" }, kind === "throw" ? "No measured throws yet." : "No putting sessions yet."),
    list.next ? formButton(busy ? "Loading…" : "Load older", {
      key: "more", disabled: busy,
      onClick: async () => { setBusy(true); try { await workspace.loadOlder(kind); } finally { setBusy(false); } },
    }) : null,
  ]);
}

export function MemberPracticePage({ workspace }) {
  const [kind, setKind] = React.useState("putting");
  const [editing, setEditing] = React.useState(false);
  const putting = kind === "putting";
  const select = (mode) => { setEditing(false); setKind(mode); };
  return h("div", { className: "react-play-page player-play member-practice", "data-member-practice": "ready" }, [
    h("div", { className: "member-practice-tabs", role: "group", "aria-label": "Practice type", key: "types" }, [
      formButton("Putting", { key: "putting", "aria-pressed": putting, onClick: () => select("putting") }),
      formButton("Fieldwork", { key: "fieldwork", "aria-pressed": !putting, onClick: () => select("throw") }),
      h(MoreLink, { tab: "my-bag", key: "bag" }),
    ]),
    h(SyncStatus, { workspace, key: "sync" }),
    editing ? h(putting ? PuttingForm : FieldworkForm, { workspace, onClose: () => setEditing(false), key: kind })
      : formButton(putting ? "Log putting" : "Log a measured throw", { key: "start", className: "dashboard-action primary", onClick: () => setEditing(true) }),
    putting ? h(PuttingSummary, { data: workspace.data, key: "summary-putts" }) : h(FieldworkSummary, { data: workspace.data, key: "summary-throws" }),
    h(PracticeHistory, { kind, workspace, key: "history-" + kind }),
    h(ExportPractice, { workspace, key: "export" }),
  ]);
}
