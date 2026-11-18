import React from "react";
import { ChevronDown, Mic, Square } from "lucide-react";

import { discChoiceKey, parseSpokenDisc, unfilledDiscDetails } from "./bag-disc-catalog.js";
import { useBagDiscVoice } from "./bag-disc-voice.js";
import { colorName, parseSpokenDisc as parseSharedDisc } from "../shared/disc-catalog.js";
import { clockSeconds } from "../shared/voice-clip.js";

const h = React.createElement;
const LIMIT = 20;

export function BagDiscChoice({ label, name, value, options, onChange, required }) {
  const id = React.useId();
  const input = React.useRef(null);
  const list = React.useRef(null);
  const composing = React.useRef(false);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const key = discChoiceKey(query);
  const valueKey = discChoiceKey(value);
  const matches = options.filter((choice) => !key || discChoiceKey(choice).includes(key)).slice(0, LIMIT);
  const custom = !value.trim() || !valueKey || !options.some((choice) => discChoiceKey(choice) === valueKey);
  const entries = matches.map((choice) => ({ label: choice, value: choice, key: choice }));
  if (custom) entries.push({
    label: value.trim() ? "Use “" + value.trim() + "”" : "Type a custom " + label.toLowerCase(),
    value: value.trim(), key: null,
  });

  function close() {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }

  function show() {
    setOpen(true);
    setQuery("");
    setActiveIndex(-1);
  }

  function select(entry) {
    onChange(entry.value);
    close();
    input.current?.focus();
  }

  function onKeyDown(event) {
    if (composing.current || event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) show();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const start = direction === 1 ? 0 : entries.length - 1;
      setActiveIndex((current) => current < 0 ? start : Math.max(0, Math.min(entries.length - 1, current + direction)));
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      if (entries[activeIndex]) select(entries[activeIndex]);
      else close();
    }
  }

  React.useLayoutEffect(() => {
    const node = list.current?.children[activeIndex];
    if (node) node.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return h("div", {
    className: "member-practice-field bag-disc-choice",
    onBlur: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); },
  }, [
    h("label", { htmlFor: id, key: "label" }, label),
    h("div", { className: "bag-disc-choice-control", key: "control" }, [
      h("input", {
        "aria-activedescendant": open && entries[activeIndex] ? id + "-option-" + activeIndex : undefined,
        "aria-autocomplete": "list",
        "aria-controls": id + "-list",
        "aria-expanded": open,
        autoComplete: "off",
        className: "form-input",
        id, key: "input", maxLength: 80, name, required, ref: input, role: "combobox", value,
        onChange: (event) => {
          onChange(event.target.value);
          setQuery(event.target.value);
          setOpen(true);
          setActiveIndex(-1);
        },
        onClick: () => { if (!open) show(); },
        onCompositionStart: () => { composing.current = true; },
        onCompositionEnd: () => { composing.current = false; },
        onKeyDown,
      }),
      h("button", {
        "aria-controls": id + "-list",
        "aria-expanded": open,
        "aria-label": (open ? "Hide " : "Show ") + label.toLowerCase() + " choices",
        className: "bag-disc-menu-toggle",
        key: "toggle",
        onClick: () => {
          input.current?.focus();
          if (open) close();
          else show();
        },
        onPointerDown: (event) => event.preventDefault(),
        tabIndex: -1, type: "button",
      }, h(ChevronDown, { "aria-hidden": true, size: 18 })),
    ]),
    h("ul", { "aria-label": label + " choices", className: "bag-disc-options", hidden: !open, id: id + "-list", key: "options", ref: list, role: "listbox" },
      open ? entries.map((entry, index) => h("li", {
        "aria-selected": index === activeIndex,
        className: entry.key == null ? "bag-disc-custom" : undefined,
        id: id + "-option-" + index, key: entry.key == null ? "custom" : "choice:" + entry.key, role: "option",
        onClick: () => select(entry),
        onPointerDown: (event) => event.preventDefault(),
      }, entry.label)) : null),
  ]);
}

const COMMON_WEIGHTS = [150, 160, 165, 170, 172, 173, 174, 175, 176, 177, 180];

export function BagDiscWeight({ value, onChange }) {
  const id = React.useId();
  return h("div", { className: "member-practice-field bag-disc-choice" }, [
    h("label", { htmlFor: id, key: "label" }, "Weight (g)"),
    h("div", { className: "bag-disc-choice-control", key: "weight" }, [
      h("input", {
        className: "form-input", id, inputMode: "decimal", key: "input",
        min: "40", max: "220", name: "weightGrams", step: "0.1", type: "number", value,
        onChange: (event) => onChange(event.target.value),
      }),
      h("div", { className: "bag-disc-menu-toggle bag-disc-weight-picker", key: "presets" }, [
        h(ChevronDown, { "aria-hidden": true, key: "icon", size: 18 }),
        h("select", {
          "aria-label": "Common weights", key: "weights", title: "Common weights",
          value: COMMON_WEIGHTS.includes(Number(value)) ? Number(value) : "",
          onChange: (event) => { if (event.target.value) onChange(event.target.value); },
        }, [
          h("option", { disabled: true, key: "choose", value: "" }, "Common weights"),
          ...COMMON_WEIGHTS.map((weight) => h("option", { key: weight, value: weight }, weight + " g")),
        ]),
      ]),
    ]),
  ]);
}

const DETAIL_LABELS = { brand: "Brand", model: "Model", plastic: "Plastic", weightGrams: "Weight", color: "Colour" };

/** What the bag catalog hears (brand, model, plastic, weight; the member's own discs count), plus the colour. */
function heardDisc(transcript, catalog, form) {
  const parsed = parseSpokenDisc(transcript, catalog, form);
  const color = colorName(parseSharedDisc(transcript).color || "");
  return color ? { ...parsed, color } : parsed;
}

export function BagDiscVoice({ catalog, form, isCurrentSession, onFill }) {
  const voice = useBagDiscVoice(isCurrentSession);
  const id = React.useId();
  const recording = ["starting", "listening", "processing"].includes(voice.phase);
  const review = voice.phase === "review";
  const details = review ? unfilledDiscDetails(form, heardDisc(voice.transcript, catalog, form)) : {};
  const fields = Object.keys(details);

  if (!voice.supported) return h("p", { className: "bag-disc-voice-fallback" },
    "Voice entry is unavailable in this browser. You can type or use your keyboard’s dictation.");

  const cancel = h("button", {
    className: "bag-disc-button", key: "cancel", type: "button", onClick: () => voice.cancel(),
  }, "Cancel voice");
  return h("section", { className: "bag-disc-voice", "aria-label": "Voice entry" }, [
    !review ? h("div", { className: "bag-disc-voice-actions", key: "actions" }, [
      !recording && !review ? h("button", {
        "aria-describedby": id + "-hint",
        className: "bag-disc-button", key: "start", type: "button", onClick: voice.start,
      }, h(Mic, { "aria-hidden": true, size: 17 }), " Add by voice") : null,
      recording && h("button", {
        className: "bag-disc-button", disabled: voice.phase !== "listening", key: "stop", type: "button", onClick: voice.stop,
      }, h(Square, { "aria-hidden": true, size: 14 }), " Stop listening"),
      voice.phase === "listening" ? h("span", { "aria-hidden": true, className: "bag-disc-voice-clock", key: "clock" },
        clockSeconds(voice.seconds) + " / " + clockSeconds(voice.maxSeconds)) : null,
      recording ? cancel : null,
    ]) : null,
    !review ? h("p", { id: id + "-hint", key: "hint" },
      `Try “Innova Star Destroyer, orange, 175 grams.” Take your time; tap Stop listening when you’re done (up to ${voice.maxSeconds} seconds). The club’s voice service turns it into text and doesn’t keep the recording.`) : null,
    voice.message ? h("p", { className: "bag-disc-voice-status", key: "status", role: "status" }, voice.message) : null,
    review ? h("div", { className: "bag-disc-voice-review", key: "review" }, [
      h("div", { className: "member-practice-field", key: "transcript" }, [
        h("label", { htmlFor: id + "-transcript", key: "label" }, "Voice transcript"),
        h("textarea", {
          className: "form-input", id: id + "-transcript", key: "text", maxLength: 480, rows: 2, value: voice.transcript,
          onChange: (event) => voice.changeTranscript(event.target.value),
        }),
      ]),
      fields.length ? h("dl", { className: "bag-disc-voice-details", key: "details" }, fields.map((field) => h("div", { key: field }, [
        h("dt", { key: "label" }, DETAIL_LABELS[field]),
        h("dd", { key: "value" }, details[field] + (field === "weightGrams" ? " g" : "")),
      ]))) : h("p", { key: "manual" }, "For custom discs, say “brand” and “model” before the names, or type the details below."),
      h("div", { className: "bag-disc-voice-actions", key: "review-actions" }, [
        fields.length ? h("button", {
          className: "bag-disc-button", key: "fill", type: "button",
          onClick: () => {
            if (!isCurrentSession()) { voice.cancel(); return; }
            onFill(details);
            voice.cancel("Disc details added to the form. Review them, then save the disc.");
          },
        }, "Fill empty fields") : null,
        cancel,
      ]),
    ]) : null,
  ]);
}
