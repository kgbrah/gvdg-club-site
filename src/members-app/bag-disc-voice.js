import React from "react";

const MAX_LISTEN_MS = 20_000;
const MAX_PROCESS_MS = 4_000;

const ERROR_COPY = {
  "not-allowed": "Microphone permission was denied. Allow it in your browser or type the disc details.",
  "service-not-allowed": "Your browser blocked its speech service. You can type the disc details.",
  "audio-capture": "The microphone couldn’t start. Check your microphone or type the disc details.",
  "no-speech": "No speech was detected. Try again or type the disc details.",
  network: "The browser’s speech service couldn’t connect. You can type the disc details.",
  "language-not-supported": "The browser’s speech service doesn’t support this language. You can type the disc details.",
};
const IDLE = { phase: "idle", message: "", transcript: "" };

function recognitionConstructor() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
}

function dispose(job, abort) {
  clearTimeout(job.timer);
  const recognition = job.recognition;
  recognition.onstart = recognition.onresult = recognition.onerror = recognition.onnomatch = recognition.onend = null;
  if (abort) {
    try { recognition.abort(); } catch { /* The browser may already have ended the session. */ }
  }
}

export function useBagDiscVoice(isCurrentSession) {
  const [state, setState] = React.useState(IDLE);
  const session = React.useRef(null);

  const discard = React.useCallback(() => {
    const job = session.current;
    session.current = null;
    if (job) dispose(job, true);
  }, []);
  React.useLayoutEffect(() => discard, [discard]);

  function finish(job, message = "", abort = false) {
    if (session.current !== job) return;
    session.current = null;
    dispose(job, abort);
    if (!isCurrentSession()) { setState(IDLE); return; }
    const transcript = message ? "" : job.transcript;
    setState({
      phase: transcript ? "review" : "idle",
      message: message || (transcript ? "Check the voice transcript and disc details." : ERROR_COPY["no-speech"]),
      transcript,
    });
  }

  function stop() {
    const job = session.current;
    if (!job || job.stopping) return;
    if (!isCurrentSession()) { discard(); setState(IDLE); return; }
    job.stopping = true;
    clearTimeout(job.timer);
    setState({ phase: "processing", message: "Finishing voice recognition…", transcript: "" });
    job.timer = setTimeout(() => finish(job, job.transcript ? "" : "Voice entry timed out. Try again or type the disc details.", true), MAX_PROCESS_MS);
    try {
      job.recognition.stop();
    } catch {
      finish(job, "The browser couldn’t finish voice entry. You can type the disc details.", true);
    }
  }

  function start() {
    const Recognition = recognitionConstructor();
    if (!Recognition || session.current || !isCurrentSession()) return;
    let recognition;
    try {
      recognition = new Recognition();
    } catch {
      setState({ ...IDLE, message: "Voice entry is unavailable right now. You can type the disc details." });
      return;
    }
    const job = { recognition, transcript: "", timer: null, stopping: false };
    session.current = job;
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (session.current !== job || job.stopping) return;
      if (!isCurrentSession()) { discard(); setState(IDLE); return; }
      setState({ phase: "listening", message: "Listening…", transcript: "" });
    };
    recognition.onresult = (event) => {
      if (session.current !== job) return;
      if (!isCurrentSession()) { discard(); setState(IDLE); return; }
      job.transcript = Array.from(event.results).filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript || "").join(" ").trim().slice(0, 480);
    };
    recognition.onerror = (event) => finish(job, ERROR_COPY[event.error] || "Voice entry ended early. Try again or type the disc details.", true);
    recognition.onnomatch = () => finish(job, ERROR_COPY["no-speech"], true);
    recognition.onend = () => finish(job);
    setState({ phase: "starting", message: "Waiting for the microphone…", transcript: "" });
    job.timer = setTimeout(stop, MAX_LISTEN_MS);
    try {
      recognition.start();
    } catch (error) {
      finish(job, error?.name === "NotAllowedError" ? ERROR_COPY["not-allowed"] : "Voice entry is unavailable right now. You can type the disc details.", true);
    }
  }

  function cancel(message = "Voice entry cancelled.") {
    discard();
    setState({ ...IDLE, message });
  }

  return {
    supported: Boolean(recognitionConstructor()), ...state, start, stop, cancel,
    changeTranscript: (transcript) => setState((current) => ({ ...current, transcript })),
  };
}
