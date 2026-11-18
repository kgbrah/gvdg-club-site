// The in-app camera for Marketplace and Lost & Found photos: a full-screen viewfinder that takes several shots in a
// row (the top of the disc, then the bottom) and hands them back as JPEG files, so the form's own resize and upload
// path treats them exactly like picked photos. It never records sound. The camera light goes off whenever the sheet
// closes, the page is hidden or the camera is switched.
import React from "react";
import { createPortal } from "react-dom";
import { Check, SwitchCamera, X } from "lucide-react";

const h = React.createElement;
// Shots are kept a little larger than the 1280 px the forms upload, so the resize still has detail to work with.
const SHOT_LONG_EDGE = 1600;

export const CAMERA_ERRORS = {
  blocked: "Camera access is off for this site. Allow the camera in your browser settings, or use your phone's camera app.",
  missing: "No camera was found on this device.",
  busy: "The camera is busy in another app. Close that app and try again.",
  failed: "The camera didn't start.",
};

export function cameraErrorKind(error) {
  const name = String(error?.name || "");
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "blocked";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "missing";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "failed";
}

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

// Ideal sizes only: iOS drops the preview when asked for a hard size that isn't one of its camera presets.
async function openStream(facing) {
  const attempts = [
    { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } } },
    { audio: false, video: { facingMode: { ideal: facing } } },
    { audio: false, video: true },
  ];
  let last = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      last = error;
      if (cameraErrorKind(error) === "blocked") throw error;
    }
  }
  throw last || new Error("camera_unavailable");
}

function frameToFile(video) {
  return new Promise((resolve) => {
    const width = video?.videoWidth || 0;
    const height = video?.videoHeight || 0;
    if (!width || !height) {
      resolve(null);
      return;
    }
    const scale = Math.min(1, SHOT_LONG_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      resolve(null);
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null);
        return;
      }
      const at = Date.now();
      resolve(new File([blob], `camera-${at}.jpg`, { lastModified: at, type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  });
}

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";

function plural(count, one, many) {
  return count === 1 ? one : many;
}

/**
 * `max`: shots allowed this time (what the form still has room for). `hint`: one short line about what to shoot.
 * `onDone(files)` gets the shots in order. `onNativeCamera` (phones only) hands off to the phone's camera app when the
 * in-app camera can't start; `onChooseFiles` opens the regular photo picker.
 */
export function CameraSheet({ max, hint, onDone, onClose, onNativeCamera, onChooseFiles }) {
  const videoRef = React.useRef(null);
  const streamRef = React.useRef(null);
  const sheetRef = React.useRef(null);
  const shutterRef = React.useRef(null);
  const shotsRef = React.useRef([]);
  const [facing, setFacing] = React.useState("environment");
  const [attempt, setAttempt] = React.useState(0);
  const [hidden, setHidden] = React.useState(() => document.visibilityState === "hidden");
  const [status, setStatus] = React.useState("starting");
  const [errorKind, setErrorKind] = React.useState("");
  const [canFlip, setCanFlip] = React.useState(false);
  const [shots, setShots] = React.useState([]);
  const [snapping, setSnapping] = React.useState(false);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");
  const full = shots.length >= max;
  React.useEffect(() => {
    shotsRef.current = shots;
  }, [shots]);

  // Lock the page behind the sheet, and give focus back to whatever opened it.
  React.useEffect(() => {
    const opener = document.activeElement;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = overflow;
      shotsRef.current.forEach((shot) => URL.revokeObjectURL(shot.url));
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    };
  }, []);

  React.useEffect(() => {
    const onVisibility = () => {
      const isHidden = document.visibilityState === "hidden";
      if (!isHidden) setStatus("starting");
      setHidden(isHidden);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  React.useEffect(() => {
    if (hidden) return undefined;
    let live = true;
    openStream(facing).then(async (stream) => {
      if (!live) {
        stopStream(stream);
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.muted = true;
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          /* autoplay of a muted inline video is allowed; a rare refusal still shows the first frame */
        }
      }
      if (!live) return;
      setStatus("ready");
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (live) setCanFlip(devices.filter((device) => device.kind === "videoinput").length > 1);
      } catch {
        /* no switch button */
      }
    }).catch((error) => {
      if (!live) return;
      setErrorKind(cameraErrorKind(error));
      setStatus("error");
    });
    return () => {
      live = false;
      stopStream(streamRef.current);
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [facing, attempt, hidden]);

  React.useEffect(() => {
    if (status === "ready") shutterRef.current?.focus();
    else if (status === "error") sheetRef.current?.querySelector(".gv-camera-message button")?.focus();
  }, [status]);

  function requestClose() {
    if (shots.length && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  function keepShooting() {
    setConfirmDiscard(false);
    shutterRef.current?.focus();
  }

  // On the document, not the sheet: Escape and Tab still work when focus has fallen to the page (a removed button).
  const onKeyDown = React.useEffectEvent((event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (confirmDiscard) keepShooting();
      else requestClose();
      return;
    }
    if (event.key !== "Tab" || !sheetRef.current) return;
    const items = Array.from(sheetRef.current.querySelectorAll(FOCUSABLE));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const inside = sheetRef.current.contains(document.activeElement);
    if (!inside || (event.shiftKey && document.activeElement === first)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  React.useEffect(() => {
    const listener = (event) => onKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  // A phone's Back button closes the camera rather than leaving the form (and what's typed in it) behind it. The
  // camera adds one history entry at the same address; Back with shots taken asks first, and a second Back discards.
  const onBack = React.useEffectEvent((entry) => {
    if (shotsRef.current.length && !confirmDiscard) {
      history.pushState({ gvCamera: entry }, "");
      setConfirmDiscard(true);
      return;
    }
    onClose();
  });
  React.useEffect(() => {
    const entry = "camera-" + Date.now().toString(36);
    history.pushState({ gvCamera: entry }, "");
    const listener = (event) => {
      if (event.state?.gvCamera !== entry) onBack(entry);
    };
    window.addEventListener("popstate", listener);
    return () => {
      window.removeEventListener("popstate", listener);
      if (history.state?.gvCamera === entry) history.back();
    };
  }, []);

  async function snap() {
    if (full || status !== "ready" || snapping) return;
    setSnapping(true);
    const file = await frameToFile(videoRef.current);
    setSnapping(false);
    if (!file) return;
    try {
      navigator.vibrate?.(12);
    } catch {
      /* no buzz */
    }
    const shot = { file, key: "shot-" + file.lastModified + "-" + Math.random().toString(36).slice(2, 6), url: URL.createObjectURL(file) };
    const count = shots.length + 1;
    setShots((current) => current.concat(shot));
    setAnnouncement(count >= max ? `Photo ${count} taken. That's the most for this post.` : `Photo ${count} taken.`);
  }

  function removeShot(shot, index) {
    URL.revokeObjectURL(shot.url);
    setShots((current) => current.filter((item) => item.key !== shot.key));
    setAnnouncement(`Photo ${index + 1} removed.`);
    shutterRef.current?.focus();
  }

  function flip() {
    setStatus("starting");
    setFacing((current) => (current === "user" ? "environment" : "user"));
  }

  function retry() {
    setStatus("starting");
    setAttempt((current) => current + 1);
  }

  const count = shots.length;
  const stage = [
    h("video", {
      "aria-hidden": true, autoPlay: true, className: "gv-camera-video", "data-facing": facing, disablePictureInPicture: true, key: "video",
      muted: true, playsInline: true, ref: videoRef, "webkit-playsinline": "true",
    }),
    count ? h("div", { "aria-hidden": true, className: "gv-camera-flash", key: "flash-" + count }) : null,
    status === "starting" ? h("p", { className: "gv-camera-status", key: "starting" }, "Starting the camera…") : null,
    status === "error" ? h("div", { className: "gv-camera-message", "data-gv-camera-error": errorKind, key: "error", role: "alert" }, [
      h("p", { key: "text" }, CAMERA_ERRORS[errorKind] || CAMERA_ERRORS.failed),
      h("div", { className: "gv-camera-message-actions", key: "actions" }, [
        errorKind === "busy" || errorKind === "failed" ? h("button", { className: "gv-camera-pill", key: "retry", onClick: retry, type: "button" }, "Try again") : null,
        onNativeCamera && errorKind !== "missing" ? h("button", { className: "gv-camera-pill", key: "native", onClick: onNativeCamera, type: "button" }, "Use the camera app") : null,
        onChooseFiles ? h("button", { className: "gv-camera-pill", key: "choose", onClick: onChooseFiles, type: "button" }, "Choose photos instead") : null,
      ]),
    ]) : null,
    confirmDiscard ? h("div", { className: "gv-camera-message", key: "discard", role: "alertdialog", "aria-label": "Discard photos" }, [
      h("p", { key: "text" }, `Discard ${count === 1 ? "this photo" : `these ${count} photos`}?`),
      h("div", { className: "gv-camera-message-actions", key: "actions" }, [
        h("button", { autoFocus: true, className: "gv-camera-pill", key: "keep", onClick: keepShooting, type: "button" }, "Keep shooting"),
        h("button", { className: "gv-camera-pill danger", key: "discard", onClick: onClose, type: "button" }, "Discard"),
      ]),
    ]) : null,
  ];

  return createPortal(h("div", {
    "aria-label": "Camera", "aria-modal": "true", className: "gv-camera", "data-gv-camera": status, ref: sheetRef, role: "dialog",
  }, [
    h("div", { className: "gv-camera-top", key: "top" }, [
      h("button", { "aria-label": "Close camera", className: "gv-camera-icon", key: "close", onClick: requestClose, type: "button" }, h(X, { "aria-hidden": true, size: 24 })),
      h("p", { className: "gv-camera-hint", key: "hint" }, hint || "Fill the frame with the disc."),
      canFlip
        ? h("button", { "aria-label": facing === "user" ? "Use the back camera" : "Use the front camera", className: "gv-camera-icon", disabled: status === "starting", key: "flip", onClick: flip, type: "button" },
          h(SwitchCamera, { "aria-hidden": true, size: 24 }))
        : h("span", { "aria-hidden": true, className: "gv-camera-icon-space", key: "flip" }),
    ]),
    h("div", { className: "gv-camera-stage", key: "stage" }, stage),
    count ? h("ul", { "aria-label": "Photos taken", className: "gv-camera-strip", key: "strip" }, shots.map((shot, index) => h("li", { className: "gv-camera-shot", key: shot.key }, [
      h("img", { alt: `Photo ${index + 1}`, key: "img", src: shot.url }),
      h("button", { "aria-label": `Remove photo ${index + 1}`, className: "gv-camera-remove", key: "remove", onClick: () => removeShot(shot, index), type: "button" }, h(X, { "aria-hidden": true, size: 16 })),
    ]))) : null,
    h("div", { className: "gv-camera-bar", key: "bar" }, [
      h("span", { className: "gv-camera-count", key: "count" }, `${count} of ${max}`),
      h("button", {
        "aria-label": full ? "Take photo (that's the most for this post)" : "Take photo", className: "gv-camera-shutter", disabled: status !== "ready" || full || snapping,
        key: "shutter", onClick: () => { void snap(); }, ref: shutterRef, type: "button",
      }, h("span", { "aria-hidden": true })),
      h("button", {
        "aria-label": count ? `Use ${count} ${plural(count, "photo", "photos")}` : "Done", className: "gv-camera-done", disabled: !count, key: "done",
        onClick: () => onDone(shots.map((shot) => shot.file)), type: "button",
      }, [h(Check, { "aria-hidden": true, key: "icon", size: 20 }), "Done"]),
    ]),
    h("p", { "aria-live": "polite", className: "gv-camera-sr", key: "live" }, announcement),
  ]), document.body);
}
