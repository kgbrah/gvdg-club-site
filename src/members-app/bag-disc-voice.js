// My Bag "Add by voice": records until the member taps Stop (never on a pause), up to VOICE_MAX_SECONDS with a running
// clock, then Whisper (through the Worker's /voice/disc) turns it into a transcript the member checks before anything
// fills the form. Same rules as before: a change of disc, editor or signed-in member drops the recording and its
// result, and nothing is saved by voice alone.
import React from "react";

import { transcribeClip, VOICE_MAX_SECONDS, voiceRecorderMime, voiceRecordingSupported } from "../shared/voice-clip.js";

const ERROR_COPY = {
  "not-allowed": "Microphone permission was denied. Allow it in your browser or type the disc details.",
  "audio-capture": "The microphone couldn’t start. Check your microphone or type the disc details.",
  "no-speech": "No speech was detected. Try again or type the disc details.",
  network: "Couldn’t reach the club to read your voice. Check your connection or type the disc details.",
  "rate-limited": "That’s a lot of tries. Wait a minute or type the disc details.",
  resting: "Voice entry is resting for today. You can type the disc details.",
  unavailable: "Voice entry isn’t available right now. You can type the disc details.",
};
const IDLE = { phase: "idle", message: "", transcript: "", seconds: 0 };

function failureCopy(result) {
  if (result.status === 0) return ERROR_COPY.network;
  if (result.status === 422 || (result.status === 200 && !result.transcript)) return ERROR_COPY["no-speech"];
  if (result.code === "voice_resting") return ERROR_COPY.resting;
  if (result.status === 429) return ERROR_COPY["rate-limited"];
  return ERROR_COPY.unavailable;
}

function dispose(job) {
  clearInterval(job.tick);
  job.cancelled = true;
  job.controller.abort();
  try {
    if (job.recorder && job.recorder.state !== "inactive") job.recorder.stop();
  } catch { /* already stopped */ }
  job.stream?.getTracks().forEach((track) => track.stop());
}

export function useBagDiscVoice(isCurrentSession) {
  const [state, setState] = React.useState(IDLE);
  const session = React.useRef(null);

  const discard = React.useCallback(() => {
    const job = session.current;
    session.current = null;
    if (job) dispose(job);
  }, []);
  React.useLayoutEffect(() => discard, [discard]);

  function fail(job, message) {
    if (session.current !== job) return;
    session.current = null;
    dispose(job);
    setState({ ...IDLE, message: isCurrentSession() ? message : "" });
  }

  async function transcribe(job, blob, type) {
    if (session.current !== job) return;
    if (!isCurrentSession()) { discard(); setState(IDLE); return; }
    setState({ phase: "processing", message: "Turning your words into text…", transcript: "", seconds: 0 });
    const result = await transcribeClip(blob, type, { signal: job.controller.signal });
    if (session.current !== job || job.cancelled) return;
    session.current = null;
    if (!isCurrentSession()) { setState(IDLE); return; }
    if (!result.ok) { setState({ ...IDLE, message: failureCopy(result) }); return; }
    setState({ phase: "review", message: "Check the voice transcript and disc details.", transcript: result.transcript.slice(0, 480), seconds: 0 });
  }

  function stop() {
    const job = session.current;
    if (!job || job.stopping) return;
    if (!isCurrentSession()) { discard(); setState(IDLE); return; }
    job.stopping = true;
    clearInterval(job.tick);
    try {
      job.recorder.stop();
    } catch {
      fail(job, "The browser couldn’t finish recording. You can type the disc details.");
    }
  }

  async function start() {
    if (!voiceRecordingSupported() || session.current || !isCurrentSession()) return;
    const job = { controller: new AbortController(), recorder: null, stream: null, tick: 0, cancelled: false, stopping: false, started: 0 };
    session.current = job;
    setState({ phase: "starting", message: "Waiting for the microphone…", transcript: "", seconds: 0 });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      fail(job, error?.name === "NotAllowedError" || error?.name === "SecurityError" ? ERROR_COPY["not-allowed"] : ERROR_COPY["audio-capture"]);
      return;
    }
    job.stream = stream;
    if (session.current !== job || !isCurrentSession()) {
      stream.getTracks().forEach((track) => track.stop());
      if (session.current === job) { discard(); setState(IDLE); }
      return;
    }
    const mime = voiceRecorderMime();
    const chunks = [];
    try {
      job.recorder = new MediaRecorder(stream, { mimeType: mime });
    } catch {
      fail(job, ERROR_COPY.unavailable);
      return;
    }
    job.recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    job.recorder.onstop = () => {
      clearInterval(job.tick);
      stream.getTracks().forEach((track) => track.stop());
      if (job.cancelled || session.current !== job) return;
      const type = mime.split(";")[0];
      const blob = new Blob(chunks, { type });
      if (blob.size < 256) { fail(job, ERROR_COPY["no-speech"]); return; }
      void transcribe(job, blob, type);
    };
    job.recorder.start();
    job.started = Date.now();
    setState({ phase: "listening", message: "Listening…", transcript: "", seconds: 0 });
    job.tick = setInterval(() => {
      if (session.current !== job) return;
      const seconds = Math.min(VOICE_MAX_SECONDS, Math.floor((Date.now() - job.started) / 1000));
      if (!isCurrentSession()) { discard(); setState(IDLE); return; }
      setState((current) => (current.phase === "listening" ? { ...current, seconds } : current));
      if (seconds >= VOICE_MAX_SECONDS) stop();
    }, 250);
  }

  function cancel(message = "Voice entry cancelled.") {
    discard();
    setState({ ...IDLE, message });
  }

  return {
    supported: voiceRecordingSupported(), maxSeconds: VOICE_MAX_SECONDS, ...state, start: () => { void start(); }, stop, cancel,
    changeTranscript: (transcript) => setState((current) => ({ ...current, transcript })),
  };
}
