import React from "react";

const h = React.createElement;
export const STUDIO_OPEN_KEY = "gvdg-theme-studio-open";

function readStored() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STUDIO_OPEN_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStored(id, open) {
  try {
    window.localStorage.setItem(STUDIO_OPEN_KEY, JSON.stringify({ ...readStored(), [id]: Boolean(open) }));
  } catch { /* storage blocked: the section still toggles for this visit */ }
}

// One collapsible studio group (native details/summary + the shared trailing chevron).
// A member's own open/closed choice is remembered per device; until they choose, `defaultOpen` rules.
// `openRequest` > 0 (a counter) forces the section open, e.g. when Custom glass is picked.
export function StudioSection({ id, title, state, defaultOpen = false, openRequest = 0, className = "", extra = {}, children }) {
  const [choice, setChoice] = React.useState(() => {
    const stored = readStored()[id];
    return typeof stored === "boolean" ? stored : null;
  });
  const open = choice === null ? Boolean(defaultOpen) : choice;
  React.useEffect(() => {
    if (openRequest > 0) {
      setChoice(true);
      writeStored(id, true);
    }
  }, [openRequest, id]);
  return h("details", {
    className: `dash-theme-section ${className}`.trim(),
    ...extra,
    "data-studio-section": id,
    open,
    onToggle: (event) => {
      const next = event.currentTarget.open;
      if (next === open) return;
      setChoice(next);
      writeStored(id, next);
    },
  }, [
    h("summary", { className: "dash-theme-section-summary", key: "summary" }, [
      h("span", { className: "dash-theme-field", key: "title" }, title),
      state ? h("span", { className: "dash-theme-section-state", key: "state" }, state) : null,
    ]),
    h("div", { className: "dash-theme-section-body", key: "body" }, children),
  ]);
}

// Touch safety for sliders. Browsers jump a range input to the touch point on touchstart, so a finger that
// lands on the track and then swipes vertically would leave a changed value behind while the page scrolls.
// When the browser takes the gesture over for scrolling (pointercancel), put the value back.
export function useScrollSafeRange(value, apply) {
  const startValue = React.useRef(null);
  return {
    onPointerDown: (event) => { startValue.current = event.pointerType === "touch" ? value : null; },
    onPointerUp: () => { startValue.current = null; },
    onPointerCancel: () => {
      const original = startValue.current;
      startValue.current = null;
      if (original !== null) apply(original);
    },
  };
}
