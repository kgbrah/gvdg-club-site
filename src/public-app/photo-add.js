// "Take photo" + "Choose photos" for the Marketplace and Lost & Found photo pickers. Take photo opens the in-app camera
// (camera-sheet.js). Phones whose browser can't run it get the phone's camera app instead, and a computer with no
// camera only sees the regular picker, worded as it always was.
import React from "react";
import { Camera, ImagePlus } from "lucide-react";

import { CameraSheet } from "./camera-sheet.js";

const h = React.createElement;
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp,image/*";

function coarsePointer() {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

function liveCameraApi() {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext !== false;
}

/**
 * "live": the in-app camera. "app": the phone's camera app (a capture input). "none": no camera on this device.
 * "probe": still asking the browser whether a computer has a camera (nothing camera-related shows yet).
 */
export function useCameraMode() {
  const [mode, setMode] = React.useState(() => {
    if (typeof window === "undefined") return "none";
    if (!liveCameraApi()) return coarsePointer() ? "app" : "none";
    return coarsePointer() ? "live" : "probe";
  });
  React.useEffect(() => {
    if (!liveCameraApi() || typeof navigator.mediaDevices.enumerateDevices !== "function") {
      setMode((current) => (current === "probe" ? "live" : current));
      return undefined;
    }
    let live = true;
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      if (!live) return;
      // Before permission browsers still list one entry per kind, so an empty list means "can't tell": offer the camera.
      const camera = !devices.length || devices.some((device) => device.kind === "videoinput");
      setMode(camera ? "live" : coarsePointer() ? "app" : "none");
    }).catch(() => {
      if (live) setMode((current) => (current === "probe" ? "live" : current));
    });
    return () => { live = false; };
  }, []);
  return mode;
}

/** Opens the phone's camera app (or, with capture off, the photo picker) through a short-lived file input. */
export function openPhotoInput({ capture = false, multiple = false, onFiles }) {
  document.querySelectorAll("input[data-gv-photo-input]").forEach((stale) => stale.remove());
  const input = document.createElement("input");
  input.type = "file";
  input.accept = PHOTO_ACCEPT;
  input.multiple = multiple;
  if (capture) input.setAttribute("capture", "environment");
  input.className = "public-sr-only";
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  input.setAttribute("data-gv-photo-input", capture ? "camera" : "choose");
  input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (files.length) onFiles(files);
  }, { once: true });
  input.addEventListener("cancel", () => input.remove(), { once: true });
  // iOS only reports the choice for an input that is in the page.
  document.body.appendChild(input);
  input.click();
}

/** The in-app camera, or the phone's camera app when the in-app one isn't available. Returns [open, sheet]. */
export function useCameraCapture({ max, hint, mode, onFiles, chooseFiles }) {
  const [open, setOpen] = React.useState(false);
  const nativeCamera = React.useCallback(() => openPhotoInput({ capture: true, onFiles }), [onFiles]);
  const start = React.useCallback(() => {
    if (mode === "app") nativeCamera();
    else setOpen(true);
  }, [mode, nativeCamera]);
  const sheet = open ? h(CameraSheet, {
    hint, key: "camera-sheet", max,
    onChooseFiles: chooseFiles ? () => { setOpen(false); chooseFiles(); } : null,
    onClose: () => setOpen(false),
    onDone: (files) => { setOpen(false); onFiles(files); },
    onNativeCamera: coarsePointer() ? () => { setOpen(false); nativeCamera(); } : null,
  }) : null;
  return [start, sheet];
}

/**
 * The add-photo row: Take photo (when the device has a camera) and Choose photos. `remaining` is how many more photos
 * fit. `inputLabel` names the hidden picker for screen readers (and the browser checks). Renders the picker even when
 * full, disabled, so the form keeps one stable input.
 */
export function PhotoAddButtons({ remaining, disabled = false, multiple = true, onFiles, inputLabel = "Choose disc photos", hasPhotos = false, cameraHint }) {
  const inputId = React.useId();
  const inputRef = React.useRef(null);
  const mode = useCameraMode();
  const camera = mode === "live" || mode === "app";
  const open = remaining > 0;
  const chooseFiles = React.useCallback(() => inputRef.current?.click(), []);
  const [startCamera, sheet] = useCameraCapture({ chooseFiles, hint: cameraHint, max: Math.max(1, remaining), mode, onFiles });
  const chooseText = camera ? (multiple ? "Choose photos" : "Choose a photo") : hasPhotos ? "Add another photo" : "Add photos";
  return h("div", { className: "photo-add-row", "data-photo-camera": mode, key: "photo-add" }, [
    open && camera ? h("button", { className: "shop-filter-reset photo-add-camera", disabled, key: "camera", onClick: startCamera, type: "button" }, [
      h(Camera, { "aria-hidden": true, key: "icon", size: 18 }), "Take photo",
    ]) : null,
    h("input", {
      accept: PHOTO_ACCEPT, "aria-label": inputLabel, className: "public-sr-only", disabled: disabled || !open, id: inputId, key: "input", multiple,
      onChange: (event) => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) onFiles(files.slice(0, remaining)); },
      ref: inputRef, type: "file",
    }),
    open ? h("label", { className: "shop-filter-reset market-photo-add", htmlFor: inputId, key: "choose" }, [
      camera ? h(ImagePlus, { "aria-hidden": true, key: "icon", size: 18 }) : null, chooseText,
    ]) : null,
    sheet,
  ]);
}
