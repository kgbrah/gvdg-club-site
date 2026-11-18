// One-thumb disc details for the Marketplace and Lost & Found forms: the phone's own pick-lists for brand, plastic
// (the brand's own), colour, weight and hole, each with "Other…" for anything not listed, plus "Say it": a short
// recording that Whisper (through the club's Worker and OpenRouter) turns into words, which fill the same lists.
import React from "react";
import { Mic, Square } from "lucide-react";

import { clockSeconds, transcribeClip, VOICE_MAX_SECONDS, voiceRecorderMime, voiceRecordingSupported } from "../shared/voice-clip.js";
import {
  canonicalChoice, choiceKey, colorName, DISC_BRAND_NAMES, DISC_COLOR_NAMES, DISC_WEIGHTS, moldsFor, parseSpokenDisc, plasticsFor,
} from "../shared/disc-catalog.js";

const h = React.createElement;
const OTHER = "__other__";

/**
 * A native select (the phone's wheel / sheet, easy with a thumb). `options`: strings or [value, label]. Unless
 * `allowOther` is false, "Other…" opens a text box below for a value that isn't listed; a value set from outside
 * (voice, an older listing) that isn't listed shows the same way.
 */
export function PickList({ id, label, value, options, onChange, placeholder, allowOther = true, maxLength = 40, error, hint, field }) {
  const rows = options.map((option) => (Array.isArray(option) ? option : [option, option]));
  const text = String(value ?? "");
  const listed = rows.find(([optionValue]) => choiceKey(optionValue) === choiceKey(text));
  const [typing, setTyping] = React.useState(() => Boolean(text) && !listed);
  const otherRef = React.useRef(null);
  const showOther = allowOther && !listed && (typing || Boolean(text));
  const selectValue = listed ? listed[0] : showOther ? OTHER : "";
  function choose(event) {
    const next = event.target.value;
    if (next === OTHER) {
      setTyping(true);
      onChange("");
      requestAnimationFrame(() => otherRef.current?.focus());
      return;
    }
    setTyping(false);
    onChange(next);
  }
  return h("div", { className: "market-field disc-pick" + (error ? " has-error" : ""), "data-disc-field": field || id, "data-lf-field": field || undefined }, [
    h("label", { htmlFor: id, key: "label" }, label),
    h("select", { id, key: "select", onChange: choose, value: selectValue }, [
      h("option", { key: "none", value: "" }, placeholder || "Choose"),
      ...rows.map(([optionValue, optionLabel]) => h("option", { key: optionValue, value: optionValue }, optionLabel)),
      allowOther ? h("option", { key: "other", value: OTHER }, "Other…") : null,
    ]),
    showOther ? h("input", {
      "aria-label": label + " (not listed)", className: "disc-pick-other", key: "other", maxLength, onChange: (event) => onChange(event.target.value),
      placeholder: "Type the " + label.toLowerCase(), ref: otherRef, type: "text", value: text,
    }) : null,
    hint ? h("small", { className: "market-hint", key: "hint" }, hint) : null,
    error ? h("small", { className: "market-note error", key: "error", role: "alert" }, error) : null,
  ]);
}

export function BrandPick(props) {
  return h(PickList, { ...props, field: props.field || "brand", label: props.label || "Brand", options: DISC_BRAND_NAMES, placeholder: "Choose a brand" });
}

/** The brand's plastics; with no brand chosen, every listed plastic. */
export function PlasticPick({ brand, ...props }) {
  return h(PickList, { ...props, field: props.field || "plastic", label: props.label || "Plastic", options: plasticsFor(brand), placeholder: "Choose a plastic" });
}

export function ColorPick(props) {
  return h(PickList, { ...props, field: props.field || "color", label: props.label || "Colour", maxLength: props.maxLength || 30, options: DISC_COLOR_NAMES, placeholder: "Choose a colour" });
}

export function WeightPick(props) {
  return h(PickList, {
    ...props, allowOther: false, field: props.field || "weightG", label: props.label || "Weight", options: DISC_WEIGHTS.map((grams) => [String(grams), grams + " g"]),
    placeholder: props.placeholder || "Choose a weight", value: props.value == null ? "" : String(props.value),
  });
}

/** Mold stays typed (there are hundreds), with the brand's molds offered as you type. */
export function MoldInput({ id, brand, value, onChange, maxLength = 40, placeholder = "Destroyer, Buzzz…", label = "Mold", error }) {
  const listId = id + "-molds";
  const molds = moldsFor(brand);
  return h("div", { className: "market-field" + (error ? " has-error" : ""), "data-disc-field": "mold", "data-lf-field": "mold" }, [
    h("label", { htmlFor: id, key: "label" }, label),
    h("input", { autoComplete: "off", id, key: "input", list: listId, maxLength, onChange: (event) => onChange(event.target.value), placeholder, type: "text", value }),
    h("datalist", { id: listId, key: "list" }, molds.map((mold) => h("option", { key: mold, value: mold }))),
    error ? h("small", { className: "market-note error", key: "error", role: "alert" }, error) : null,
  ]);
}

/** Values heard by voice, tidied to the pick-lists' spelling. */
export function heardFields(fields) {
  const out = {};
  if (fields.brand) out.brand = canonicalChoice(fields.brand, DISC_BRAND_NAMES);
  if (fields.mold) out.mold = canonicalChoice(fields.mold, moldsFor(out.brand || fields.brand));
  if (fields.plastic) out.plastic = canonicalChoice(fields.plastic, plasticsFor(out.brand || fields.brand));
  if (fields.color) out.color = colorName(fields.color) || fields.color;
  if (fields.weightG) out.weightG = String(fields.weightG);
  if (fields.hole) out.hole = String(fields.hole);
  if (fields.area) out.area = String(fields.area);
  return out;
}

/** The order "Filled in the …" reads in, and each field's name there. */
const FIELD_NAMES = [["brand", "brand"], ["mold", "mold"], ["plastic", "plastic"], ["color", "colour"], ["weightG", "weight"], ["courseId", "course"],
  ["hole", "hole"], ["area", "where exactly"]];
export const DISC_VOICE_FIELDS = ["brand", "mold", "plastic", "color", "weightG"];

export function voiceSupported() {
  return typeof window !== "undefined" && voiceRecordingSupported();
}

function voiceError(status, code) {
  if (code === "voice_resting") return "Voice entry is resting for today. Pick from the lists instead.";
  if (status === 429) return "That's a lot of tries. Wait a minute, or pick from the lists.";
  if (status === 422) return "Didn't catch that. Try again, a little closer to the phone.";
  if (status === 413) return `That was a long one. Keep it under ${VOICE_MAX_SECONDS} seconds.`;
  if (status === 0) return "Couldn't reach the club. Check your connection, or pick from the lists.";
  return "Voice entry isn't working right now. Pick from the lists instead.";
}

/**
 * "Say it": tap, describe the disc, tap Stop (it never stops on a pause; at most VOICE_MAX_SECONDS). `onFields(fields)` gets what was heard, already spelled
 * like the pick-lists, limited to `fields` (the ones this form has). `holes` limits "hole N" to the course;
 * `extraParse(transcript)` adds the form's own matches (Lost & Found: the course). Hidden where audio can't be recorded.
 */
export function VoiceDiscButton({ onFields, holes = 27, example, fields = DISC_VOICE_FIELDS, extraParse }) {
  const [phase, setPhase] = React.useState("idle");
  const [note, setNote] = React.useState(null);
  const [seconds, setSeconds] = React.useState(0);
  const job = React.useRef(null);
  const supported = React.useMemo(() => voiceSupported(), []);

  React.useEffect(() => () => {
    const current = job.current;
    job.current = null;
    if (!current) return;
    clearInterval(current.tick);
    current.cancelled = true;
    current.stream?.getTracks().forEach((track) => track.stop());
    if (current.recorder?.state === "recording") current.recorder.stop();
  }, []);

  async function send(blob, type) {
    setPhase("sending");
    const result = await transcribeClip(blob, type);
    if (!job.current?.cancelled) job.current = null;
    if (!result.ok) {
      setNote({ tone: "error", text: voiceError(result.status === 200 ? 422 : result.status, result.code) });
      setPhase("idle");
      return;
    }
    const data = { transcript: result.transcript };
    let extra = {};
    try { extra = (extraParse && extraParse(data.transcript)) || {}; } catch { extra = {}; }
    const all = { ...heardFields(parseSpokenDisc(data.transcript, { holes: extra.courseId ? 40 : holes })), ...extra };
    const heard = {};
    for (const key of fields) if (all[key]) heard[key] = all[key];
    const filled = FIELD_NAMES.filter(([key]) => heard[key]).map(([, name]) => name);
    if (filled.length) onFields(heard);
    setNote({
      heard: data.transcript, tone: filled.length ? "success" : "error",
      text: filled.length ? "Filled in the " + listWords(filled) + ". Check them below." : "Nothing matched the lists. Pick them below, or try again.",
    });
    setPhase("idle");
  }

  async function start() {
    if (phase !== "idle") return;
    setNote(null);
    const mime = voiceRecorderMime();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setNote({ tone: "error", text: error?.name === "NotAllowedError"
        ? "The microphone is blocked for this site. Allow it in your browser settings, or pick from the lists."
        : "The microphone didn't start. Pick from the lists instead." });
      return;
    }
    const chunks = [];
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime });
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setNote({ tone: "error", text: "This browser can't record here. Pick from the lists instead." });
      return;
    }
    const current = { recorder, stream, tick: 0, cancelled: false, started: Date.now() };
    job.current = current;
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    recorder.onstop = () => {
      clearInterval(current.tick);
      stream.getTracks().forEach((track) => track.stop());
      if (current.cancelled) return;
      const type = mime.split(";")[0];
      const blob = new Blob(chunks, { type });
      if (blob.size < 256) {
        job.current = null;
        setNote({ tone: "error", text: "That recording was empty. Tap Say it and talk, then tap Stop." });
        setPhase("idle");
        return;
      }
      void send(blob, type);
    };
    recorder.start();
    setSeconds(0);
    setPhase("recording");
    current.tick = setInterval(() => {
      const elapsed = Math.floor((Date.now() - current.started) / 1000);
      setSeconds(elapsed);
      if (elapsed >= VOICE_MAX_SECONDS && recorder.state === "recording") recorder.stop();
    }, 250);
  }

  function stop() {
    const recorder = job.current?.recorder;
    if (recorder?.state === "recording") recorder.stop();
  }

  if (!supported) return null;
  const recording = phase === "recording";
  return h("div", { className: "disc-voice", "data-disc-voice": phase }, [
    h("button", {
      "aria-label": recording ? "Stop recording" : "Say the disc details", className: "shop-btn secondary disc-voice-button", disabled: phase === "sending",
      key: "button", onClick: recording ? stop : () => { void start(); }, type: "button",
    }, recording
      ? [h(Square, { "aria-hidden": true, key: "icon", size: 16 }), "Stop", h("span", { "aria-hidden": true, className: "disc-voice-time", key: "time" }, clockSeconds(seconds) + " / " + clockSeconds(VOICE_MAX_SECONDS))]
      : [h(Mic, { "aria-hidden": true, key: "icon", size: 18 }), phase === "sending" ? "Listening back…" : "Say it"]),
    h("p", { className: "market-hint disc-voice-example", key: "example" }, recording ? "Listening… take your time and tap Stop when you're done." : example || "Try: “Orange Star Destroyer, 175 grams.”"),
    h("div", { "aria-live": "polite", className: "disc-voice-result", key: "result", role: "status" }, note ? [
      note.heard ? h("p", { className: "disc-voice-heard", key: "heard" }, "Heard: “" + note.heard + "”") : null,
      h("p", { className: "market-note" + (note.tone === "error" ? " error" : ""), key: "text" }, note.text),
    ] : null),
  ]);
}

function listWords(words) {
  if (words.length <= 1) return words.join("");
  return words.slice(0, -1).join(", ") + " and " + words[words.length - 1];
}
