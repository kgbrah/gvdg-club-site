import React from "react";
import { remainingFt } from "../shared/hole-map-model.js";
import { describeShot, MAX_LEDGER_STROKES, SHOT_ATTEMPTS, SHOT_LABELS, SHOT_LIES, SHOT_OUTCOMES, shotLedgerQuality, shotPoint } from "../shared/shot-ledger.js";
import { formatClubListTime } from "../shared/events-model.js";

const h = React.createElement;
const listStyle = { paddingInlineStart: "1.25rem" };

function qualityLabel(rows, score) {
  switch (shotLedgerQuality(rows, score)) {
    case "different-count": return `${rows.length} recorded ${rows.length === 1 ? "stroke" : "strokes"} and ${score} on the card. Review these shots or the score.`;
    case "unknown-outcome": return "Some outcomes are unknown. Complete them to include this hole in shot stats.";
    case "unknown-attempt": return "Some stroke types are unknown. Choose throw or putt to include this hole in shot stats.";
    case "missing-finish": return "Check which stroke completed the hole before these shots count in stats.";
    case "unscored": return "Add or confirm the score on the card to use these shots in stats.";
    case "complete": return `${rows.length} recorded ${rows.length === 1 ? "stroke matches" : "strokes match"} the score.`;
    default: return "Add throws, putts, and any penalty strokes. The score is entered on the card.";
  }
}

function describedPoint(point) {
  if (!point) return "GPS position unknown";
  const accuracy = point.accuracyM == null ? "" : ` · ±${point.accuracyM} m`;
  const time = point.observedAt == null ? "" : " · " + (formatClubListTime(point.observedAt) || "");
  return "GPS captured" + accuracy + time;
}

function SelectField({ label, options, value, onChange }) {
  const id = React.useId();
  return h("div", null, h("label", { className: "lbl", htmlFor: id }, label),
    h("select", { className: "field", id, value, onChange: (event) => onChange(event.target.value) },
      options.map((option) => h("option", { key: option, value: option }, SHOT_LABELS[option]))));
}

function NumberField({ label, value, onChange }) {
  const id = React.useId();
  return h("div", null, h("label", { className: "lbl", htmlFor: id }, label),
    h("input", { className: "field", id, type: "number", inputMode: "decimal", min: 0, max: 4000, step: "0.1",
      value: value ?? "", onChange: (event) => onChange(event.target.value === "" ? undefined : Number(event.target.value)) }));
}

function LocationCapture({ label, point, onCapture, onClear }) {
  return h("div", null,
    h("p", { className: "muted" }, label + " · " + describedPoint(point)),
    h("button", { className: "btn secondary", type: "button", onClick: onCapture }, "Capture " + label.toLowerCase() + " GPS"),
    point && h("button", { className: "btn secondary", type: "button", onClick: onClear }, "Clear " + label.toLowerCase() + " position"));
}

function ShotEditor({ edit, getFix, enableGps, measured, onCancel, onSave }) {
  const [draft, setDraft] = React.useState(edit.row);
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const update = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const isThrow = draft.kind === "throw";
  const formRef = React.useRef(null);
  React.useEffect(() => { formRef.current?.focus(); }, []);

  function capture(key) {
    const fix = shotPoint(getFix?.());
    if (!fix || fix.observedAt == null || Math.abs(Date.now() - fix.observedAt) > 30_000) {
      enableGps?.();
      setNotice("Waiting for a fresh GPS fix. Tap capture again in a moment.");
      return;
    }
    update({ [key]: fix, ...(draft.distanceSource === "gps" ? { distanceFt: undefined, distanceSource: undefined } : {}) });
    setNotice("GPS position captured.");
  }

  function clearPosition(key) {
    update({ [key]: undefined, ...(draft.distanceSource === "gps" ? { distanceFt: undefined, distanceSource: undefined } : {}) });
    setNotice("");
  }

  async function save(row) {
    if (busy) return;
    setBusy(true);
    try {
      if (await onSave(edit, row)) return;
      setNotice("This change could not be saved. Review the card and try again.");
    } finally {
      setBusy(false);
    }
  }

  return h("form", { className: "stack shot-editor", ref: formRef, tabIndex: -1, onSubmit: (event) => { event.preventDefault(); void save(draft); } },
    h("h3", null, `${edit.existing ? "Edit" : "Add"} ${draft.kind === "penalty" ? "penalty" : "shot"}`),
    h("fieldset", { disabled: busy, className: "shot-editor-fields" },
      isThrow && h(SelectField, { label: "Stroke type", options: SHOT_ATTEMPTS, value: draft.attempt,
        onChange: (attempt) => update({ attempt, ...(attempt !== "putt" ? { puttDistanceFt: undefined } : {}) }) }),
      isThrow && h(SelectField, { label: "Outcome", options: SHOT_OUTCOMES, value: draft.outcome, onChange: (outcome) => update({ outcome }) }),
      isThrow && h(SelectField, { label: "Starting lie", options: SHOT_LIES, value: draft.originLie, onChange: (originLie) => update({ originLie }) }),
      h(SelectField, { label: isThrow ? "Landing or resting lie" : "Lie after penalty", options: SHOT_LIES, value: draft.landingLie,
        onChange: (landingLie) => update({ landingLie }) }),
      h("details", null,
        h("summary", null, "GPS and measured distances"),
        isThrow && h(LocationCapture, { label: "Start", point: draft.origin, onCapture: () => capture("origin"), onClear: () => clearPosition("origin") }),
        h(LocationCapture, { label: isThrow ? "Landing" : "Next lie", point: draft.landing, onCapture: () => capture("landing"), onClear: () => clearPosition("landing") }),
        isThrow && h(NumberField, { label: "Measured shot distance in feet", value: draft.distanceFt,
          onChange: (distanceFt) => update({ distanceFt, distanceSource: distanceFt == null ? undefined : "manual" }) }),
        isThrow && draft.origin && draft.landing && h("button", { className: "btn secondary", type: "button",
          onClick: () => update({ distanceFt: remainingFt(draft.origin, draft.landing), distanceSource: "gps" }) }, "Measure between captured positions"),
        isThrow && measured != null && h("button", { className: "btn secondary", type: "button",
          onClick: () => update({ distanceFt: measured, distanceSource: "manual" }) }, `Use round measurement · ${measured} ft`),
        isThrow && draft.attempt === "putt" && h(NumberField, { label: "Measured starting distance to basket in feet", value: draft.puttDistanceFt,
          onChange: (puttDistanceFt) => update({ puttDistanceFt }) })),
      h("p", { className: "muted", role: "status" }, notice),
      h("div", { className: "shot-editor-actions" },
        h("button", { className: "btn", type: "submit" }, "Save shot"),
        h("button", { className: "btn secondary", type: "button", onClick: onCancel }, "Cancel edit")),
      edit.existing && (confirmRemove
        ? h("button", { className: "btn danger shot-remove", type: "button", onClick: () => { void save(null); } }, "Confirm remove shot")
        : h("button", { className: "btn ghost shot-remove", type: "button", onClick: () => setConfirmRemove(true) }, "Remove shot"))));
}

export function ShotLedgerPanel({ model, score, getFix, enableGps, measured, onSave, onDiscard }) {
  const [edit, setEdit] = React.useState(null);
  if (!model) return null;
  const { rows, target } = model;

  function begin(row, existing) {
    setEdit({ row, existing, base: model });
  }

  function add(attempt) {
    const common = { id: crypto.randomUUID(), recordedAt: Date.now(), landingLie: "unknown" };
    begin(attempt === "penalty" ? { ...common, kind: "penalty" }
      : { ...common, kind: "throw", attempt, outcome: "unknown", originLie: "unknown" }, false);
  }

  async function save(draft, row) {
    const previous = draft.base.rows;
    const next = draft.existing ? previous.flatMap((existing) => existing.id !== draft.row.id ? [existing] : row ? [row] : []) : [...previous, row];
    if (await onSave?.(draft.base, next)) { setEdit(null); return true; }
    return false;
  }

  return h("div", { className: "stack shot-ledger" },
    h("p", { className: "muted shot-owner" }, (target.scope === "team" ? "Your record of team shots · " : "Shots for ") + target.label),
    h("p", { role: "status" }, qualityLabel(rows, score)),
    model.pending && h("p", { className: "muted" }, "Shot changes saved on this phone, awaiting sync."),
    model.previousTeam?.rows.length > 0 && h("details", null,
      h("summary", null, "Shots from the previous assignment"),
      h("p", { className: "muted" }, "Saving new shots replaces this ledger for the hole."),
      h("ol", { style: listStyle }, model.previousTeam.rows.map((row) => h("li", { key: row.id }, describeShot(row))))),
    model.review && h("details", null,
      h("summary", null, "Saved change needs review"),
      h("p", { className: "muted" }, "Compare these edits with the current ledger before entering them again."),
      h("ol", { style: listStyle }, model.review.body.ledger.rows.map((row) => h("li", { key: row.id }, describeShot(row)))),
      ["error", "auth"].includes(model.review.state) && h("button", { className: "btn secondary", type: "button",
        onClick: () => onDiscard?.(model.review.id) }, "Discard saved change")),
    edit ? h(ShotEditor, { key: edit.row.id, edit, getFix, enableGps, measured, onSave: save, onCancel: () => setEdit(null) })
      : h(React.Fragment, null,
        rows.length > 0 && h("ol", { className: "shot-ledger-list" }, rows.map((row, index) => h("li", { key: row.id },
          h("p", null, describeShot(row)),
          onSave && h("button", { className: "btn secondary", type: "button", "aria-label": `Edit stroke ${index + 1}`,
            onClick: () => begin(row, true) }, "Edit")))),
        onSave && h("div", { className: "shot-add-actions" }, ["throw", "putt", "penalty"].map((attempt) =>
          h("button", { className: "btn secondary", type: "button", key: attempt, disabled: rows.length >= MAX_LEDGER_STROKES,
            onClick: () => add(attempt) }, `Add ${attempt}`))),
        !onSave && h("p", { className: "muted" }, "This ledger is read-only until the card is open for scoring.")));
}
