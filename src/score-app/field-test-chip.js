import React from "react";
import { createPortal } from "react-dom";

import { useAccessibleDialog } from "../shared/a11y.js";
import { FIELD_GUIDE_HREF, FIELD_LOG_HREF } from "../shared/field-test-gate.js";
import { FIELD_PRIVACY_COPY, FieldNoteForm, FieldTestSwitch, useFieldTestMode } from "../shared/field-test-ui.js";

const h = React.createElement;

/** The switch row inside Round tools. */
export function FieldTestToolSwitch() {
  return h("div", { className: "field-test-tool", "data-field-test-tool": "ready" },
    h(FieldTestSwitch, {
      app: "score", rowClass: "field-test-switch", copyClass: "field-test-switch-copy",
      trackClass: "field-test-track", knobClass: "field-test-knob",
    }));
}

/** A small "Field test" pill on the scorecard while the mode is on. It opens notes and the log link. */
export function FieldTestBadge() {
  const on = useFieldTestMode();
  const [open, setOpen] = React.useState(false);
  const titleId = React.useId();
  const triggerRef = React.useRef(null);
  const close = () => setOpen(false);
  const dialog = useAccessibleDialog({ open: on && open, onClose: close, labelledBy: titleId, returnFocus: () => triggerRef.current });
  React.useEffect(() => { if (!on) setOpen(false); }, [on]);
  if (!on) return null;
  return h("div", { className: "field-test-badge-row", "data-field-test-badge": "on" }, [
    h("button", {
      type: "button", className: "field-test-badge", key: "badge", ref: triggerRef, "aria-haspopup": "dialog",
      "aria-label": "Field test on. Add a note", onClick: () => setOpen(true),
    }, [h("span", { className: "field-test-dot", "aria-hidden": "true", key: "dot" }), "Field test"]),
    open && createPortal(h("div", { className: "overlay", "data-a11y-overlay": "true", role: "presentation", ref: dialog.overlayRef },
      h("section", {
        className: "sheet field-test-sheet", role: "dialog", "aria-modal": dialog.isolated ? "true" : undefined,
        "aria-labelledby": titleId, tabIndex: -1, ref: dialog.panelRef,
      },
        h("div", { className: "grab" }),
        h("h2", { id: titleId, className: "section" }, "Field test"),
        h("p", { className: "muted field-test-copy" }, "Tap a note just before you do it: airplane mode, closing the app, restarting the phone."),
        h(FieldNoteForm, { className: "field-note-form", buttonClass: "btn secondary", inputClass: "field" }),
        h("p", { className: "muted field-test-copy" }, FIELD_PRIVACY_COPY),
        h("div", { className: "field-test-links" },
          h("a", { className: "btn secondary", href: FIELD_LOG_HREF }, "Open field log"),
          h("a", { className: "btn secondary", href: FIELD_GUIDE_HREF }, "Volunteer checklist")),
        h(FieldTestToolSwitch),
        h("button", { type: "button", className: "btn secondary sheet-close", onClick: close }, "Back to round"),
      )), document.body),
  ]);
}
