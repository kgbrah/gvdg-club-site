// The shared autocomplete (owner: "auto complete for all searches, especially player names, across all surfaces in
// the member app"). A drop-in for a search/name <input>: the same props, plus `suggestions` (strings, or
// { label, value, hint }) and an optional `onPick(item)`. As you type, the best matches show under the field; tap one
// (or arrow to it and press Enter) to fill the field. It fires the input's own onChange, so callers keep their state as
// they do now. ARIA combobox; theme colours from tokens.css (.ac-*).
import React from "react";
import { highlightParts, rankSuggestions } from "./autocomplete-rank.js";

const h = React.createElement;
let nextId = 0;
const LIST_MAX_PX = 288; // .ac-list max-height (18rem)
const BOTTOM_BAR_ROOM = 84; // the apps' bottom tab bars
const TOP_BAR_ROOM = 64;

/** Set an input's value the way typing does, so React's onChange runs with a real event. */
function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export const AutocompleteInput = React.forwardRef(function AutocompleteInput(props, forwardedRef) {
  const {
    suggestions = [], onPick, max = 6, minChars = 1, wrapperClassName = "", listLabel,
    onKeyDown, onFocus, onBlur, value, defaultValue, ...inputProps
  } = props;
  const ownRef = React.useRef(null);
  const [listId] = React.useState(() => "ac-list-" + (++nextId));
  const [focused, setFocused] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const [typed, setTyped] = React.useState(String(value ?? defaultValue ?? ""));
  const blurTimer = React.useRef(0);
  const [upward, setUpward] = React.useState(false);
  const query = value != null ? String(value) : typed;

  const setRef = React.useCallback((node) => {
    ownRef.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  const matches = React.useMemo(
    () => (query.trim().length >= minChars ? rankSuggestions(query, suggestions, max) : []),
    [query, suggestions, max, minChars],
  );
  const open = focused && !dismissed && matches.length > 0;
  // Open upward when the space under the field (above the on-screen keyboard and the app's bottom bar) is too small.
  React.useLayoutEffect(() => {
    if (!open || !ownRef.current) return;
    const rect = ownRef.current.getBoundingClientRect();
    const keyboard = Number(navigator.virtualKeyboard?.boundingRect?.height) || 0;
    const visible = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight;
    const bottom = Math.min(visible, window.innerHeight - keyboard) - BOTTOM_BAR_ROOM;
    const wanted = Math.min(matches.length * 46 + 10, LIST_MAX_PX);
    const below = bottom - rect.bottom;
    setUpward(below < wanted && rect.top - TOP_BAR_ROOM > below);
  }, [open, matches.length]);
  React.useEffect(() => { setActive(-1); setDismissed(false); }, [query]);
  React.useEffect(() => () => window.clearTimeout(blurTimer.current), []);

  function pick(item) {
    const input = ownRef.current;
    if (input) typeInto(input, item.value);
    setTyped(item.value);
    setDismissed(true);
    setActive(-1);
    onPick?.(item);
  }

  return h("span", { className: "ac" + (upward ? " ac-up" : "") + (wrapperClassName ? " " + wrapperClassName : "") }, [
    h("input", {
      autoComplete: "off",
      ...inputProps,
      ...(value != null ? { value } : { defaultValue }),
      key: "input",
      ref: setRef,
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": open ? "true" : "false",
      "aria-controls": listId,
      "aria-activedescendant": open && active >= 0 ? listId + "-" + active : undefined,
      onChange: (event) => {
        setTyped(event.target.value);
        inputProps.onChange?.(event);
      },
      onFocus: (event) => { window.clearTimeout(blurTimer.current); setFocused(true); onFocus?.(event); },
      // A short delay, so a tap on a suggestion lands before the list closes.
      onBlur: (event) => { blurTimer.current = window.setTimeout(() => setFocused(false), 150); onBlur?.(event); },
      onKeyDown: (event) => {
        if (open && event.key === "ArrowDown") { event.preventDefault(); setActive((at) => (at + 1) % matches.length); return; }
        if (open && event.key === "ArrowUp") { event.preventDefault(); setActive((at) => (at <= 0 ? matches.length - 1 : at - 1)); return; }
        if (open && event.key === "Enter" && active >= 0) { event.preventDefault(); pick(matches[active]); return; }
        if (open && event.key === "Escape") { event.preventDefault(); setDismissed(true); return; }
        if (!open && event.key === "ArrowDown" && matches.length) { setDismissed(false); }
        onKeyDown?.(event);
      },
    }),
    h("ul", {
      className: "ac-list",
      id: listId,
      role: "listbox",
      // Its own name, so it never shares the field's label (screen readers and tests find the field by that).
      "aria-label": listLabel || "Suggestions",
      hidden: !open,
      key: "list",
    }, open ? matches.map((item, index) => h("li", {
      className: "ac-option" + (index === active ? " active" : ""),
      id: listId + "-" + index,
      role: "option",
      "aria-selected": index === active ? "true" : "false",
      "data-ac-option": item.value,
      key: item.key,
      // Keep focus in the field (so the keyboard stays up), then fill it.
      onMouseDown: (event) => event.preventDefault(),
      onClick: () => pick(item),
    }, [
      h("span", { className: "ac-label", key: "label" }, highlightParts(item.label, query).map((part, at) =>
        part.match ? h("b", { key: at }, part.text) : part.text)),
      item.hint ? h("span", { className: "ac-hint", key: "hint" }, item.hint) : null,
    ])) : null),
  ]);
});

/** Club member names for a signed-in member, as they type (the same list Messages searches; held accounts left out). */
export function useMemberNameSuggestions(query, { token, request, enabled = true, minChars = 2 } = {}) {
  const [names, setNames] = React.useState([]);
  React.useEffect(() => {
    const typed = String(query ?? "").trim();
    if (!enabled || !token || typed.length < minChars || typed.length > 40 || typeof request !== "function") {
      setNames([]);
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      request("/me/messages/people?q=" + encodeURIComponent(typed), { token, signal: controller.signal })
        .then((data) => setNames((Array.isArray(data?.people) ? data.people : []).map((person) => ({
          label: person.name, value: person.name, key: person.memberId,
        }))))
        .catch(() => {});
    }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, token, request, enabled, minChars]);
  return names;
}
