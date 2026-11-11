import React from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, Video, X } from "lucide-react";

import { useAccessibleDialog } from "../shared/a11y.js";
import { resolveApiBase } from "../shared/api-base.js";
import { liveRoundCodeFromSearch } from "../shared/live-watch.js";
import { readMemberToken } from "../shared/member-session.js";
import { readOpenPlayToken } from "./open-play-session.js";

const h = React.createElement;
const MAX_SECONDS = 15;
const MAX_CLIP_BYTES = 80_000_000;
const NATIVE_UHD_EDGE = 3840;
const HIGH_RES_WIDTH = 1920;
const HIGH_RES_HEIGHT = 1080;
const CLIPS_EVENT = "gvdg:throw-clips";
const CLIP_POLL_MS = 5000;

function icon(Icon) {
  return h(Icon, { "aria-hidden": "true", focusable: "false", size: 16, strokeWidth: 2.4 });
}

export function suggestedMoment(strokes, par) {
  if (typeof strokes !== "number" || typeof par !== "number") return null;
  if (strokes === 1) return "ace";
  if (strokes < par) return "birdie";
  return null;
}

export function clipScopeFromLocation(loc) {
  const params = new URLSearchParams((loc && loc.search) || "");
  const code = liveRoundCodeFromSearch(params);
  const eventId = String(params.get("event") || "").replace(/[^0-9]/g, "");
  if (code) return { key: code, listPath: "/rounds/" + code + "/live/clips" };
  if (eventId) return { key: eventId, listPath: "/events/" + eventId + "/live/clips" };
  return null;
}

function guestToken() {
  try {
    return new URLSearchParams(window.location.search).get("gt") || "";
  } catch {
    return "";
  }
}

function authHeaders(token) {
  return token ? { Authorization: "Bearer " + token } : {};
}

function withGuest(path) {
  const token = readMemberToken() || readOpenPlayToken() || "";
  const gt = token ? "" : guestToken();
  if (!gt) return { path, token };
  return { path: path + (path.includes("?") ? "&" : "?") + "gt=" + encodeURIComponent(gt), token };
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

export function useThrowClips(options) {
  const refresh = !options || options.refresh !== false;
  const scope = React.useMemo(() => clipScopeFromLocation(window.location), []);
  const api = React.useMemo(() => resolveApiBase({ datasetKeys: ["apiBase"] }), []);
  const [clips, setClips] = React.useState([]);

  React.useEffect(() => {
    if (!scope) return undefined;
    let alive = true;
    const controller = new AbortController();
    async function load() {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const { path } = withGuest(scope.listPath);
        const response = await fetch(api + path, { cache: "no-store", signal: controller.signal });
        const data = response.ok ? await response.json() : null;
        if (alive && data && Array.isArray(data.clips)) setClips(data.clips);
      } catch {
        /* keep the last list; a blip shouldn't blank the round */
      }
    }
    void load();
    const onChange = () => { void load(); };
    window.addEventListener(CLIPS_EVENT, onChange);
    const timer = refresh ? window.setInterval(() => { void load(); }, CLIP_POLL_MS) : 0;
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    if (refresh && typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      controller.abort();
      window.removeEventListener(CLIPS_EVENT, onChange);
      if (timer) window.clearInterval(timer);
      if (refresh && typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    };
  }, [api, refresh, scope]);

  return { api, clips, scope };
}

function momentLabel(moment) {
  if (moment === "ace") return "Ace";
  if (moment === "birdie") return "Birdie";
  return "Highlight";
}

function filmPlaceLabel(hole, putting) {
  if (!putting) return "Hole " + (hole && hole.hole) + " throw";
  const distance = Number(hole && (hole.distance_ft != null ? hole.distance_ft : hole.distanceFt));
  if (Number.isFinite(distance) && distance > 0) return distance + " ft putt";
  return "Station " + (hole && hole.hole) + " putt";
}

export function RoundHighlights(props) {
  const { api, clips } = useThrowClips({ refresh: props.live !== false });
  const landscape = usePhoneLandscape();
  const [open, setOpen] = React.useState(false);
  const rows = clips.filter((clip) => clip && clip.mediaPath);
  if (!rows.length) return null;
  const canStar = props.canStar === true;
  const putting = props.putting === true;
  const videosLabel = putting ? "Putt videos" : "Throw videos";
  const placeLabel = putting ? "Station " : "Hole ";
  const countLabel = rows.length === 1 ? "1 clip" : rows.length + " clips";
  async function toggle(clip) {
    const { path, token } = withGuest(clip.mediaPath.replace(/\/media$/, "/highlight"));
    const response = await fetch(api + path, {
      body: JSON.stringify({ highlight: !clip.highlight }),
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      method: "POST",
    });
    if (response.ok) window.dispatchEvent(new CustomEvent(CLIPS_EVENT));
  }
  return h("section", {
    className: "throw-highlights" + (open ? " open" : "") + (landscape ? " is-landscape" : " is-portrait"),
    "data-react-throw-highlights": open ? "open" : "collapsed",
  }, [
    h("button", {
      "aria-controls": "throw-videos-body",
      "aria-expanded": open ? "true" : "false",
      "aria-label": (open ? "Minimize " : "Expand ") + videosLabel.toLowerCase(),
      className: "throw-highlights-head",
      key: "head",
      type: "button",
      onClick: () => setOpen((value) => !value),
    }, [
      h("span", { className: "throw-highlights-copy", key: "copy" }, [
        h("span", { className: "throw-highlights-title", key: "title" }, videosLabel),
        h("span", { className: "throw-highlights-meta", key: "meta" }, countLabel + " · stays with this round"),
      ]),
      h("span", { className: "throw-highlights-toggle", key: "toggle" }, [
        h("span", { key: "label" }, open ? "Minimize" : "Expand"),
        h(open ? ChevronUp : ChevronDown, {
          "aria-hidden": "true",
          focusable: "false",
          key: "chev",
          size: 14,
          strokeWidth: 2.4,
        }),
      ]),
    ]),
    open ? h("div", { className: "throw-highlights-row", id: "throw-videos-body", key: "row" }, rows.map((clip) =>
      h("figure", { className: "throw-highlight", key: clip.id }, [
        h("video", appleVideoAttrs({
          controls: true,
          key: "video",
          onLoadedMetadata: markClipFrame,
          preload: "metadata",
          src: api + clip.mediaPath,
        })),
        h("figcaption", { key: "cap" }, [
          clip.highlight ? momentLabel(clip.moment) + " · " : "",
          clip.playerName,
          " · " + placeLabel + clip.hole,
        ]),
        canStar ? h("button", {
          className: "throw-highlight-star",
          key: "star",
          onClick: () => { void toggle(clip); },
          type: "button",
        }, clip.highlight ? "Unstar" : "Star highlight") : null,
      ]),
    )) : null,
  ]);
}

export function frameOrientation(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return "landscape";
  return h > w ? "portrait" : "landscape";
}

export function phoneIsLandscape(win) {
  const target = win || (typeof window !== "undefined" ? window : null);
  if (!target) return true;
  const type = target.screen && target.screen.orientation && target.screen.orientation.type;
  if (typeof type === "string" && type) return type.indexOf("landscape") === 0;
  if (typeof target.matchMedia === "function") {
    try { return target.matchMedia("(orientation: landscape)").matches; } catch { /* old webviews */ }
  }
  return !target.innerHeight || target.innerWidth >= target.innerHeight;
}

function usePhoneLandscape() {
  const [landscape, setLandscape] = React.useState(() => phoneIsLandscape());
  React.useEffect(() => {
    const apply = () => setLandscape(phoneIsLandscape());
    apply();
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(orientation: landscape)") : null;
    if (mq && mq.addEventListener) mq.addEventListener("change", apply);
    window.addEventListener("orientationchange", apply);
    window.addEventListener("resize", apply);
    return () => {
      if (mq && mq.removeEventListener) mq.removeEventListener("change", apply);
      window.removeEventListener("orientationchange", apply);
      window.removeEventListener("resize", apply);
    };
  }, []);
  return landscape;
}

function markClipFrame(event) {
  const video = event.currentTarget;
  if (!video) return;
  const orientation = frameOrientation(video.videoWidth, video.videoHeight);
  video.dataset.orientation = orientation;
  if (video.videoWidth && video.videoHeight) video.style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
}

function appleVideoAttrs(extra) {
  return {
    playsInline: true,
    "webkit-playsinline": "true",
    ...extra,
  };
}

function isAppleMobile() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function captureConstraints(capabilities, landscape) {
  const caps = capabilities || {};
  const capW = Number(caps.width && caps.width.max);
  const capH = Number(caps.height && caps.height.max);
  // Phones offer a 3840-wide sensor. Fifteen seconds of that often exceeds the 100 MB
  // request cap, so the saved picture stops at 1080p. Portrait swaps the edges.
  const longEdge = Math.min(Number.isFinite(capW) && capW > 0 ? capW : NATIVE_UHD_EDGE, HIGH_RES_WIDTH);
  const shortEdge = Math.min(Number.isFinite(capH) && capH > 0 ? capH : 2160, HIGH_RES_HEIGHT);
  const width = landscape ? longEdge : Math.min(shortEdge, HIGH_RES_HEIGHT);
  const height = landscape ? Math.min(shortEdge, HIGH_RES_HEIGHT) : longEdge;
  return {
    frameRate: { ideal: 30, max: 30 },
    width: { ideal: width, max: width },
    height: { ideal: height, max: height },
  };
}

function throwVideoBitrate(width, height) {
  const pixels = Math.min((Number(width) || HIGH_RES_WIDTH) * (Number(height) || HIGH_RES_HEIGHT), HIGH_RES_WIDTH * HIGH_RES_HEIGHT);
  const wanted = Math.round(pixels * 30 * 0.12);
  return Math.min(Math.max(wanted, 4_000_000), 8_000_000);
}

async function useSaveableCameraMode(stream, landscape) {
  const track = stream.getVideoTracks()[0];
  if (!track || typeof track.getCapabilities !== "function") return track || null;
  // iOS rejects a hard max that is not one of its camera presets and drops the preview.
  if (isAppleMobile()) return track;
  const caps = track.getCapabilities() || {};
  try {
    await track.applyConstraints(captureConstraints(caps, landscape));
  } catch {
    /* keep whatever the camera already opened */
  }
  return track;
}

export function trackSupportsTorch(track) {
  if (!track) return false;
  if (typeof track.getCapabilities !== "function") return true;
  const caps = track.getCapabilities() || {};
  if (caps.torch === false) return false;
  if (caps.torch === true) return true;
  const facing = typeof track.getSettings === "function" ? String(track.getSettings().facingMode || "") : "";
  return facing !== "user";
}

export function torchConstraints(on) {
  // Send the light by itself. Resending picture size restarts the camera and drops the recording.
  return { advanced: [{ torch: Boolean(on) }] };
}

export async function setTrackTorch(track, on) {
  if (!track || track.readyState === "ended" || typeof track.applyConstraints !== "function") return false;
  try {
    await track.applyConstraints(torchConstraints(on));
    return track.readyState !== "ended";
  } catch {
    return false;
  }
}

function recorderMime() {
  if (typeof MediaRecorder === "undefined") return "";
  // mp4 plays on iPhone and Android. webm does not play on iPhone.
  if (MediaRecorder.isTypeSupported("video/mp4")) return "video/mp4";
  if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")) return "video/webm;codecs=vp8,opus";
  if (MediaRecorder.isTypeSupported("video/webm")) return "video/webm";
  return "";
}

function cameraRequest(landscape) {
  const size = landscape
    ? { width: HIGH_RES_WIDTH, height: HIGH_RES_HEIGHT }
    : { width: HIGH_RES_HEIGHT, height: HIGH_RES_WIDTH };
  return {
    audio: true,
    video: {
      facingMode: { ideal: "environment" },
      frameRate: { ideal: 30 },
      width: { ideal: size.width },
      height: { ideal: size.height },
    },
  };
}

async function openCamera(landscape) {
  const attempts = [
    cameraRequest(landscape),
    { audio: true, video: { facingMode: { ideal: "environment" } } },
    { audio: false, video: { facingMode: "environment" } },
  ];
  let lastError = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
      if (error && error.name === "NotAllowedError") throw error;
    }
  }
  throw lastError || new Error("camera_unavailable");
}

function makeRecorder(stream, mime, bitrate) {
  try {
    return new MediaRecorder(stream, {
      mimeType: mime,
      audioBitsPerSecond: 128000,
      videoBitsPerSecond: bitrate,
    });
  } catch {
    // iOS throws if videoBitsPerSecond is set. The mime type alone still records.
    return new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  }
}

export function ThrowFilm(props) {
  const { api, scope } = useThrowClips();
  const [open, setOpen] = React.useState(false);
  const rows = Array.isArray(props.rows) ? props.rows : [];
  const hole = props.hole && props.hole.hole;
  const par = props.hole && props.hole.par;
  const putting = props.putting === true;
  if (!scope || !rows.length || !hole) return null;
  const filmLabel = putting ? "Film a putt" : "Film a throw";
  return h(React.Fragment, null, [
    h("button", {
      "aria-label": filmLabel,
      className: "score-glove-tool",
      key: "film",
      title: filmLabel,
      type: "button",
      onClick: () => setOpen(true),
    }, [icon(Video), h("span", { key: "label" }, "Film")]),
    open ? h(ThrowFilmSheet, {
      api,
      hole,
      key: "sheet",
      listPath: scope.listPath,
      par,
      placeLabel: filmPlaceLabel(props.hole, putting),
      putting,
      rows,
      onClose: () => setOpen(false),
    }) : null,
  ]);
}

function ThrowFilmSheet(props) {
  const dialog = useAccessibleDialog({
    open: true,
    onClose: props.onClose,
    labelledBy: "throw-film-title",
    label: props.putting ? "Film a putt" : "Film a throw",
  });
  const rows = props.rows;
  const landscape = usePhoneLandscape();
  const [playerKey, setPlayerKey] = React.useState(() => {
    const me = rows.find((row) => row.isMe);
    return String((me || rows[0]).key);
  });
  const player = rows.find((row) => String(row.key) === playerKey) || rows[0];
  const moment = props.putting ? null : suggestedMoment(player.currentScore, props.par);
  const [highlight, setHighlight] = React.useState(Boolean(moment));
  const [phase, setPhase] = React.useState("idle");
  const [error, setError] = React.useState("");
  const [seconds, setSeconds] = React.useState(0);
  const [clipUrl, setClipUrl] = React.useState("");
  const [blob, setBlob] = React.useState(null);
  const liveRef = React.useRef(null);
  const playRef = React.useRef(null);
  const streamRef = React.useRef(null);
  const recorderRef = React.useRef(null);
  const chunksRef = React.useRef([]);
  const timerRef = React.useRef(0);
  const [torchOn, setTorchOn] = React.useState(false);
  const [lightReady, setLightReady] = React.useState(true);
  const torchOnRef = React.useRef(false);
  const openingRef = React.useRef(null);

  React.useEffect(() => {
    if (props.putting) return;
    setHighlight(Boolean(suggestedMoment(player.currentScore, props.par)));
  }, [player.key, player.currentScore, props.par, props.putting]);

  React.useEffect(() => () => {
    window.clearInterval(timerRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop());
    if (clipUrl) URL.revokeObjectURL(clipUrl);
  }, [clipUrl]);

  const dropRef = React.useRef(false);

  function stopStream() {
    const stream = streamRef.current;
    streamRef.current = null;
    torchOnRef.current = false;
    setTorchOn(false);
    if (!stream) return;
    stream.getTracks().forEach((item) => item.stop());
  }

  async function attachPreview(stream) {
    streamRef.current = stream;
    const landscapeNow = phoneIsLandscape();
    const track = await useSaveableCameraMode(stream, landscapeNow);
    const settings = track && typeof track.getSettings === "function" ? track.getSettings() : {};
    setLightReady(trackSupportsTorch(track));
    if (liveRef.current) {
      liveRef.current.srcObject = stream;
      const orientation = frameOrientation(settings.width, settings.height);
      liveRef.current.dataset.orientation = orientation;
      if (settings.width && settings.height) liveRef.current.style.aspectRatio = settings.width + " / " + settings.height;
      liveRef.current.play().catch(() => {});
    }
    return { settings, track };
  }

  async function ensurePreview() {
    if (streamRef.current) return streamRef.current;
    if (openingRef.current) return openingRef.current;
    openingRef.current = (async () => {
      try {
        const stream = await openCamera(phoneIsLandscape());
        await attachPreview(stream);
        setPhase((current) => current === "idle" ? "preview" : current);
        return stream;
      } finally {
        openingRef.current = null;
      }
    })();
    return openingRef.current;
  }

  async function toggleLight() {
    const want = !torchOnRef.current;
    torchOnRef.current = want;
    setTorchOn(want);
    setError("");
    try {
      const stream = await ensurePreview();
      const track = stream.getVideoTracks()[0];
      const lit = await setTrackTorch(track, want);
      if (want && !lit) {
        torchOnRef.current = false;
        setTorchOn(false);
        setLightReady(trackSupportsTorch(track));
        setError("This phone won't turn the light on from the browser.");
      }
    } catch (error) {
      torchOnRef.current = false;
      setTorchOn(false);
      const denied = error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      setError(denied ? "Camera permission is needed to use the light." : "The camera didn't open. Try again.");
    }
  }

  async function start() {
    setError("");
    const mime = recorderMime();
    if (!mime || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError("This phone can't record video in the browser.");
      return;
    }
    try {
      const stream = await ensurePreview();
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === "ended") {
        stopStream();
        setPhase("idle");
        setError("The light reset the camera. Tap Record again.");
        return;
      }
      const settings = track.getSettings ? track.getSettings() : {};
      chunksRef.current = [];
      const recorder = makeRecorder(stream, mime, throwVideoBitrate(settings.width, settings.height));
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopStream();
        if (dropRef.current) {
          dropRef.current = false;
          chunksRef.current = [];
          props.onClose();
          return;
        }
        const next = new Blob(chunksRef.current, { type: mime.split(";")[0] });
        if (!next.size) {
          setError("The recording was empty. Try again.");
          setPhase("idle");
          return;
        }
        if (clipUrl) URL.revokeObjectURL(clipUrl);
        setBlob(next);
        setClipUrl(URL.createObjectURL(next));
        setPhase("review");
      };
      recorderRef.current = recorder;
      try {
        recorder.start(1000);
      } catch {
        recorder.start();
      }
      setSeconds(0);
      setPhase("recording");
      const started = Date.now();
      timerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS && recorder.state === "recording") recorder.stop();
      }, 250);
    } catch (error) {
      const denied = error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      setError(denied ? "Camera permission is needed to film the " + (props.putting ? "putt" : "throw") + "." : "The camera didn't open. Try again.");
    }
  }

  function discard() {
    if (phase === "saving") return;
    dropRef.current = true;
    window.clearInterval(timerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.stop();
      return;
    }
    stopStream();
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    setBlob(null);
    setClipUrl("");
    props.onClose();
  }

  function stop() {
    window.clearInterval(timerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") recorder.stop();
    else stopStream();
  }

  async function save() {
    if (!blob || phase === "saving") return;
    if (blob.size > MAX_CLIP_BYTES) {
      setError("That clip is too big to save. Record a shorter one.");
      return;
    }
    setPhase("saving");
    setError("");
    const source = player.source || {};
    const index = Array.isArray(source.playerIndexes) ? source.playerIndexes[0] : source.index;
    const playerName = source.type === "pair" ? "" : String(player.label || "").replace(/\s+\(you\)$/i, "");
    const query = new URLSearchParams({
      hole: String(props.hole),
      highlight: highlight ? "1" : "0",
      moment: moment || (highlight ? "manual" : ""),
      playerIndex: String(index),
      playerName,
    });
    const { path, token } = withGuest(props.listPath + "?" + query.toString());
    try {
      const response = await fetch(props.api + path, {
        body: blob,
        headers: { ...authHeaders(token), "Content-Type": blob.type || "application/octet-stream" },
        method: "POST",
      });
      const data = await readJson(response);
      if (!response.ok) {
        const reason = data && data.error === "clip_limit"
          ? "This round already has enough clips."
          : data && data.error === "clip_too_large"
            ? "That clip is too big to save. Record a shorter one."
            : data && data.error === "round_not_live"
              ? "The round isn't live, so the clip wasn't saved."
              : "The clip didn't save. Try again.";
        setError(reason);
        setPhase("review");
        return;
      }
      window.dispatchEvent(new CustomEvent(CLIPS_EVENT));
      props.onClose();
    } catch {
      setError("Network hiccup. The clip is still on this phone until you close this.");
      setPhase("review");
    }
  }

  const title = props.putting
    ? "Film the putt. Star it if it's a highlight."
    : moment === "ace"
    ? "That's an ace. Save it as a highlight?"
    : moment === "birdie"
      ? "Birdie. Star it as a highlight?"
      : "Film the throw. Star it if it's a highlight.";

  return createPortal(h("div", {
    className: "overlay",
    "data-a11y-overlay": "true",
    ref: dialog.overlayRef,
    role: "presentation",
  }, h("div", {
    "aria-label": props.putting ? "Film a putt" : "Film a throw",
    "aria-labelledby": "throw-film-title",
    "aria-modal": dialog.isolated ? "true" : undefined,
    className: "sheet throw-film-sheet " + (landscape ? "is-landscape" : "is-portrait"),
    ref: dialog.panelRef,
    role: "dialog",
    tabIndex: -1,
  }, [
    h("div", { className: "grab", key: "grab" }),
    h("div", { className: "throw-film-head", key: "head" }, [
      h("h2", { className: "section", id: "throw-film-title", key: "title" }, props.placeLabel || ("Hole " + props.hole + " throw")),
      h("button", {
        "aria-label": "Close",
        className: "iconbtn",
        key: "close",
        onClick: props.onClose,
        type: "button",
      }, icon(X)),
    ]),
    h("p", { className: "muted", key: "hint" }, title),
    h("label", { className: "lbl", key: "who" }, [
      "Player",
      h("select", {
        key: "select",
        onChange: (event) => setPlayerKey(event.target.value),
        value: String(player.key),
      }, rows.map((row) => h("option", { key: row.key, value: String(row.key) }, row.label))),
    ]),
    phase === "review"
      ? h("video", appleVideoAttrs({ autoPlay: true, className: "throw-film-preview", controls: true, key: "play", onLoadedMetadata: markClipFrame, ref: playRef, src: clipUrl }))
      : h("video", appleVideoAttrs({ autoPlay: true, className: "throw-film-preview", key: "live", muted: true, ref: liveRef })),
    phase === "recording" ? h("p", { className: "throw-film-timer", key: "timer" }, "Recording " + seconds + "s / " + MAX_SECONDS + "s") : null,
    error ? h("p", { className: "throw-film-error", key: "error", role: "alert" }, error) : null,
    h("label", { className: "throw-film-star", key: "star" }, [
      h("input", {
        checked: highlight,
        key: "check",
        onChange: (event) => setHighlight(event.target.checked),
        type: "checkbox",
      }),
      "Round highlight",
    ]),
    h("div", { className: "throw-film-actions", key: "actions" }, [
      phase !== "review" && phase !== "saving" && (phase === "idle" || lightReady || torchOn)
        ? h("button", {
          "aria-pressed": torchOn ? "true" : "false",
          className: "btn secondary throw-film-light" + (torchOn ? " on" : ""),
          key: "light",
          onClick: () => { void toggleLight(); },
          type: "button",
        }, torchOn ? "Light on" : "Light")
        : null,
      phase === "recording"
        ? h("button", { className: "btn primary", key: "stop", onClick: stop, type: "button" }, "Stop")
        : phase === "review" || phase === "saving"
          ? h("button", { className: "btn primary", disabled: phase === "saving", key: "save", onClick: () => { void save(); }, type: "button" }, phase === "saving" ? "Saving" : "Save to round")
          : h("button", { className: "btn primary", key: "start", onClick: () => { void start(); }, type: "button" }, "Record"),
      phase === "review"
        ? h("button", { className: "btn secondary", key: "retake", onClick: () => { setPhase("idle"); setBlob(null); if (clipUrl) URL.revokeObjectURL(clipUrl); setClipUrl(""); }, type: "button" }, "Retake")
        : null,
    ]),
    phase === "recording" || phase === "review"
      ? h("button", {
        className: "btn danger",
        key: "discard",
        onClick: discard,
        type: "button",
      }, "Discard")
      : null,
    h("p", { className: "muted throw-film-note", key: "note" }, "A cardmate films it. The clip stays with this round. Highlights are the ones you star."),
  ])), document.body);
}
