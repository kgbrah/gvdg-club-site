import React from "react";

import { DISC_COLORS, useDiscColorSession } from "../shared/disc-color.js";

const h = React.createElement;

export function DiscColorPicker() {
  const { discColor, choose } = useDiscColorSession();
  return h("details", {
    className: "dash-theme disc-color-pref",
    "data-react-disc-color": discColor,
  }, [
    h("summary", { className: "dash-subtitle dash-collapse-summary", key: "summary" }, "Live scoring disc"),
    h("p", { className: "dash-note", key: "note" }, "Pick the plastic that flies on your hole map when you mark a lie or record a score."),
    h("div", { className: "disc-color-grid", key: "grid", role: "radiogroup", "aria-label": "Disc color" },
      DISC_COLORS.map((row) => h("button", {
        "aria-checked": discColor === row.id ? "true" : "false",
        "aria-label": row.label,
        className: "disc-color-swatch" + (discColor === row.id ? " is-active" : ""),
        key: row.id,
        role: "radio",
        style: { "--disc-swatch": "var(" + row.token + ")" },
        type: "button",
        onClick: () => choose(row.id),
      }, [
        h("span", { className: "disc-color-chip", key: "chip", "aria-hidden": "true" }),
        h("span", { className: "disc-color-label", key: "label" }, row.label),
      ])),
    ),
  ]);
}
