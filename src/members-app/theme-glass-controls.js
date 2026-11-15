import React from "react";

import {
  GLASS_LIMITS,
  GLASS_PRESETS,
  GLASS_PRESET_KEYS,
  glassPresetFor,
  sanitizeGlass,
} from "../shared/dashboard-theme-model.js";
import { StudioSection, useScrollSafeRange } from "./theme-studio-section.js";

const h = React.createElement;

function GlassSlider({ name, label, value, disabled, onChange }) {
  const limit = GLASS_LIMITS[name];
  const safeTouch = useScrollSafeRange(value, (original) => onChange(name, original));
  return h("label", { className: "dash-theme-slider dash-theme-glass-slider" }, [
    h("span", { className: "dash-theme-slider-label", key: "label" }, [
      label,
      h("em", { key: "val" }, `${value}${limit.unit}`),
    ]),
    h("input", {
      type: "range",
      min: limit.min,
      max: limit.max,
      step: limit.step,
      value,
      disabled,
      "aria-label": label,
      "aria-valuetext": `${value}${limit.unit}`,
      onChange: (event) => onChange(name, Number(event.target.value)),
      onDoubleClick: () => onChange(name, limit.default),
      ...safeTouch,
      key: "input",
    }),
  ]);
}

// Glass group for the member theme studio: Off / Frosted / Clear / Custom, with the Glass + Blur sliders in a
// nested "Adjust glass" disclosure that opens when Custom is chosen. `glass` is the theme's { opacity, blur };
// `onChange(nextGlass, { commit })` paints live and saves. Works on the club default (no custom theme) too.
export function ThemeGlassControls({ glass, disabled, onChange }) {
  const safe = sanitizeGlass(glass);
  const [pickedCustom, setPickedCustom] = React.useState(false);
  const [openRequest, setOpenRequest] = React.useState(0);
  const preset = glassPresetFor(safe);
  const active = pickedCustom ? "custom" : preset;
  React.useEffect(() => {
    if (preset === "custom") setOpenRequest((n) => n + 1);
  }, [preset]);
  function setPreset(key) {
    const next = GLASS_PRESETS[key];
    setPickedCustom(false);
    onChange({ opacity: next.opacity, blur: next.blur }, { commit: true });
  }
  function chooseCustom() {
    setPickedCustom(true);
    setOpenRequest((n) => n + 1);
  }
  function setSlider(name, value) {
    setPickedCustom(true);
    onChange(sanitizeGlass({ ...safe, [name]: value }), { commit: false });
  }
  const label = active === "custom" ? "Custom" : GLASS_PRESETS[active].label;
  return h(StudioSection, { id: "glass", title: "Glass", state: label, defaultOpen: true, className: "dash-theme-glass", extra: { "data-theme-glass": active } }, [
    h("div", {
      className: "dash-theme-toggle dash-theme-glass-seg",
      role: "group",
      "aria-label": "Glass style",
      key: "seg",
    }, [...GLASS_PRESET_KEYS, "custom"].map((key) => {
      const isCustom = key === "custom";
      return h("button", {
        type: "button",
        className: active === key ? "is-active" : "",
        "aria-pressed": active === key,
        "data-glass-preset": key,
        disabled,
        onClick: () => (isCustom ? chooseCustom() : setPreset(key)),
        key,
      }, isCustom ? "Custom" : GLASS_PRESETS[key].label);
    })),
    h(StudioSection, {
      id: "glass-adjust",
      title: "Adjust glass",
      state: `${safe.opacity}% · ${safe.blur}px`,
      openRequest,
      className: "dash-theme-glass-adjust",
      key: "adjust",
    }, [
      h(GlassSlider, { name: "opacity", label: "Glass", value: safe.opacity, disabled, onChange: setSlider, key: "opacity" }),
      h(GlassSlider, { name: "blur", label: "Blur", value: safe.blur, disabled, onChange: setSlider, key: "blur" }),
    ]),
    h("p", { className: "dash-theme-empty dash-theme-glass-note", key: "note" }, "See-through cards and docks over your wallpaper. Scoring buttons stay solid."),
  ]);
}
