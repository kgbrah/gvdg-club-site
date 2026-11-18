// Voice entry, the shared parts: record until the player taps Stop (never on a pause), up to VOICE_MAX_SECONDS, then
// POST the clip to the Worker's /voice/disc (Whisper on Groq, OpenRouter as the backup) for a transcript. Used by
// My Bag ("Add by voice") and the Marketplace / Lost & Found forms ("Say it").
import { resolveApiBase } from "./api-base.js";

/** Long enough for brand, mold, plastic, colour, weight, course, hole and where it was, said at an easy pace. */
export const VOICE_MAX_SECONDS = 30;

export function voiceRecorderMime() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export function voiceRecordingSupported() {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(voiceRecorderMime());
}

/** "0:07" */
export function clockSeconds(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
}

/** The clip -> { ok, transcript, status, code }. status 0 = no connection (or cancelled). */
export async function transcribeClip(blob, type, { signal } = {}) {
  let response;
  try {
    response = await fetch(resolveApiBase({ datasetKeys: ["authBase"] }) + "/voice/disc", {
      body: blob, cache: "no-store", headers: { "Content-Type": type }, method: "POST", signal,
    });
  } catch {
    return { ok: false, transcript: "", status: 0, code: "network" };
  }
  const data = await response.json().catch(() => null);
  const transcript = typeof data?.transcript === "string" ? data.transcript : "";
  return { ok: response.ok && Boolean(transcript), transcript, status: response.status, code: typeof data?.error === "string" ? data.error : "" };
}
