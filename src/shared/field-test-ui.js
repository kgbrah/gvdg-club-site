import React from "react";

import {
  FIELD_NOTE_CHIPS, fieldNote, fieldTestOn, setFieldTestEnabled, subscribeFieldTest,
} from "./field-test-gate.js";

const h = React.createElement;

export const FIELD_PRIVACY_COPY = "The field log stays on this phone until you export it. It records timings, connection changes, "
  + "your own member id and round codes. It never records other players' names or PDGA numbers.";

/** Whether field test mode is on, kept in step with the switch (no DOM listener). */
export function useFieldTestMode() {
  return React.useSyncExternalStore(subscribeFieldTest, fieldTestOn, () => false);
}

/** The on/off switch. Classes let each app keep its own row look. */
export function FieldTestSwitch({ app, icon = null, rowClass, copyClass, trackClass, knobClass, detail }) {
  const on = useFieldTestMode();
  const [busy, setBusy] = React.useState(false);
  const descriptionId = React.useId();
  async function toggle() {
    setBusy(true);
    try { await setFieldTestEnabled(!on, app); } finally { setBusy(false); }
  }
  const text = detail || (on ? "On for this phone. Timings are being recorded." : "Records timings on this phone for a club test round.");
  return h("button", {
    type: "button", role: "switch", className: rowClass, "aria-checked": on ? "true" : "false",
    "aria-label": "Field test mode", "aria-describedby": descriptionId, disabled: busy, onClick: toggle,
    "data-field-test-switch": on ? "on" : "off",
  }, [
    icon,
    h("span", { className: copyClass, key: "copy" }, [
      h("strong", { key: "title" }, "Field test mode"),
      h("small", { id: descriptionId, key: "detail" }, text),
    ]),
    h("span", { className: trackClass + (on ? " is-on" : ""), "aria-hidden": "true", key: "switch" },
      h("span", { className: knobClass })),
  ]);
}

function clockLabel(date) {
  try { return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch { return ""; }
}

/** Quick notes: one tap on a chip, free text, or a battery reading for phones without the battery API. */
export function FieldNoteForm({ className = "field-note-form", buttonClass = "btn secondary", inputClass = "field", onAdded }) {
  const [text, setText] = React.useState("");
  const [battery, setBattery] = React.useState("");
  const [status, setStatus] = React.useState("");
  const textId = React.useId();
  const batteryId = React.useId();
  function added(label) {
    setStatus(label + " noted at " + clockLabel(new Date()));
    if (typeof onAdded === "function") onAdded(label);
  }
  function addChip(chip) {
    fieldNote({ chip });
    added(chip);
  }
  function addText(event) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    fieldNote({ text: value });
    setText("");
    added("Note");
  }
  function addBattery(event) {
    event.preventDefault();
    const value = Number(battery);
    if (!Number.isFinite(value) || value < 0 || value > 100) { setStatus("Enter the battery percent, 0 to 100."); return; }
    fieldNote({ chip: "Battery", battery: value });
    setBattery("");
    added("Battery " + Math.round(value) + "%");
  }
  return h("div", { className, "data-field-note-form": "ready" }, [
    h("div", { className: "field-note-chips", role: "group", "aria-label": "Quick notes", key: "chips" },
      FIELD_NOTE_CHIPS.map((chip) => h("button", { type: "button", className: buttonClass + " field-note-chip", key: chip, onClick: () => addChip(chip) }, chip))),
    h("form", { className: "field-note-row", onSubmit: addText, key: "text" }, [
      h("label", { htmlFor: textId, key: "label" }, "Note"),
      h("input", {
        id: textId, className: inputClass, value: text, maxLength: 280, autoComplete: "off", key: "input",
        placeholder: "What happened?", onChange: (event) => setText(event.target.value),
      }),
      h("button", { type: "submit", className: buttonClass, key: "add" }, "Add note"),
    ]),
    h("form", { className: "field-note-row", onSubmit: addBattery, key: "battery" }, [
      h("label", { htmlFor: batteryId, key: "label" }, "Battery %"),
      h("input", {
        id: batteryId, className: inputClass, value: battery, inputMode: "numeric", type: "number", min: 0, max: 100, key: "input",
        placeholder: "85", onChange: (event) => setBattery(event.target.value),
      }),
      h("button", { type: "submit", className: buttonClass, key: "add" }, "Save battery"),
    ]),
    h("p", { className: "field-note-status", role: "status", "aria-live": "polite", key: "status" }, status),
  ]);
}
