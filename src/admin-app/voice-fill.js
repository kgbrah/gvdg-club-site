import React from "react";

import { adminAuthBase, adminToken } from "./admin-api.js";

const h = React.createElement;
// Records until the admin taps again (never on a pause), up to MAX_SECONDS with a running clock.
const MAX_SECONDS = 45;

export function matchCourseId(courses, spoken) {
  const want = String(spoken || "").trim().toLowerCase();
  if (!want) return "";
  const rows = Array.isArray(courses) ? courses : [];
  const nameOf = (course) => String(course.label || "").toLowerCase().split(" - ")[0].trim();
  const exact = rows.find((course) => nameOf(course) === want || String(course.label || "").toLowerCase() === want);
  if (exact) return String(exact.id);
  const partial = rows.find((course) => {
    const name = nameOf(course);
    return name && (name.includes(want) || want.includes(name));
  });
  return partial ? String(partial.id) : "";
}

export function applyShopVoice(form, fields) {
  const next = { ...form };
  for (const key of ["name", "brand", "category", "productType", "color", "weight", "price", "stock", "description"]) {
    if (fields && fields[key]) next[key] = String(fields[key]);
  }
  return next;
}

export function applyEventVoice(form, fields, courses) {
  const next = { ...form };
  const source = fields && typeof fields === "object" ? fields : {};
  for (const key of ["type", "name", "date", "startsAt", "registrationDeadline", "checkinDeadline", "status", "format", "notes"]) {
    if (source[key]) next[key] = String(source[key]);
  }
  if (source.handicap === true && String(next.format).endsWith("stroke")) next.handicap = true;
  const courseId = matchCourseId(courses, source.courseName);
  if (courseId) next.courseId = courseId;
  return next;
}

function audioMime() {
  if (typeof MediaRecorder === "undefined") return "";
  if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  return "";
}

function failureNote(status) {
  if (status === 401 || status === 403) return "Sign in as an admin before using voice.";
  if (status === 413) return "That recording is too long. Keep it under 45 seconds.";
  if (status === 422) return "I didn't catch any words. Try again closer to the phone.";
  if (status === 429) return "Too many voice commands. Give it a minute.";
  return "Voice fill is unavailable right now.";
}

export function VoiceFill(props) {
  const [phase, setPhase] = React.useState("idle");
  const [note, setNote] = React.useState("");
  const recorderRef = React.useRef(null);
  const chunksRef = React.useRef([]);
  const timerRef = React.useRef(0);
  const clockRef = React.useRef(0);
  const streamRef = React.useRef(null);
  const [seconds, setSeconds] = React.useState(0);

  React.useEffect(() => () => {
    window.clearTimeout(timerRef.current);
    window.clearInterval(clockRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop());
  }, []);

  async function send(blob) {
    setPhase("sending");
    const token = adminToken();
    try {
      const response = await fetch(adminAuthBase() + "/admin/voice-fill?form=" + props.form, {
        body: blob,
        headers: {
          ...(token ? { Authorization: "Bearer " + token } : {}),
          "Content-Type": blob.type || "application/octet-stream",
        },
        method: "POST",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        setNote(failureNote(response.status));
        setPhase("idle");
        return;
      }
      const fields = data.fields && typeof data.fields === "object" ? data.fields : {};
      if (props.onFields) props.onFields(fields);
      const heard = typeof data.transcript === "string" ? data.transcript : "";
      setNote(Object.keys(fields).length
        ? "Heard: " + heard
        : "Heard \"" + heard + "\", but nothing mapped onto the form. Fix it by hand or try again.");
    } catch {
      setNote("Network hiccup. The form was not changed.");
    }
    setPhase("idle");
  }

  function stop() {
    window.clearTimeout(timerRef.current);
    window.clearInterval(clockRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") recorder.stop();
  }

  async function start() {
    setNote("");
    const mime = audioMime();
    if (!mime || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setNote("This phone can't record audio in the browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mime.split(";")[0] });
        if (!blob.size) {
          setNote("The recording was empty. Try again.");
          setPhase("idle");
          return;
        }
        void send(blob);
      };
      recorderRef.current = recorder;
      recorder.start();
      setPhase("listening");
      const started = Date.now();
      setSeconds(0);
      window.clearInterval(clockRef.current);
      clockRef.current = window.setInterval(() => setSeconds(Math.min(MAX_SECONDS, Math.floor((Date.now() - started) / 1000))), 250);
      timerRef.current = window.setTimeout(stop, MAX_SECONDS * 1000);
    } catch {
      setNote("Microphone permission is needed to fill the form by voice.");
      setPhase("idle");
    }
  }

  const listening = phase === "listening";
  const label = phase === "sending" ? "Filling…" : listening ? "Listening… tap to stop" : "Fill by voice";
  const clock = (value) => Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
  const hint = props.form === "event" ? "Say the event name, date, and course." : "Say the item name, price, and stock.";
  return h("div", { className: "admin-voice" + (listening ? " is-listening" : ""), "data-admin-voice": props.form }, [
    h("button", {
      className: "admin-btn secondary",
      disabled: phase === "sending",
      key: "mic",
      onClick: listening ? stop : () => { void start(); },
      type: "button",
    }, label),
    listening ? h("span", { "aria-hidden": true, className: "admin-voice-clock", key: "clock" }, clock(seconds) + " / " + clock(MAX_SECONDS)) : null,
    h("p", { className: "admin-voice-note", key: "note" }, listening ? "Take your time; tap again when you're done." : note || hint),
  ]);
}
