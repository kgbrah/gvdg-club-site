import React from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, Video, X } from "lucide-react";

import { useAccessibleDialog } from "../shared/a11y.js";
import { resolveApiBase } from "../shared/api-base.js";
import { liveRoundCodeFromSearch } from "../shared/live-watch.js";
import { spectatorHeaders, watchKeyFromLocation } from "../shared/spectator-link.js";
import { readMemberToken } from "../shared/member-session.js";
import { readOpenPlayToken } from "./open-play-session.js";
import { createClipStore, drainClipDrafts } from "./clip-recovery.js";

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
  if (watchKeyFromLocation(loc || {})) return { key: "watch-link", listPath: "/watch-round/clips" };
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

function authHeaders(token, guest) {
  return token ? { Authorization: "Bearer " + token } : guest ? { Authorization: "Guest " + guest } : {};
}

function withGuest(path) {
  const token = readMemberToken() || readOpenPlayToken() || "";
  const gt = token ? "" : guestToken();
  return { path, token, guest: gt };
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

function spectatorClipRequest(listPath, spectator) {
  const key = spectator ? watchKeyFromLocation(window.location) : null;
  const endpoint = listPath + (spectator ? "?viewer=1" : "");
  const { path, token, guest } = key ? { path: endpoint, token: "" } : withGuest(endpoint);
  return { path, headers: key ? spectatorHeaders(key) : authHeaders(token, guest), identity: key || token || guest || path };
}

export function useThrowClips(options = {}) {
  const { enabled = true, refresh = true, spectator = false, generation = null } = options;
  const scope = React.useMemo(() => clipScopeFromLocation(window.location), []);
  const api = React.useMemo(() => resolveApiBase({ datasetKeys: ["apiBase"] }), []);
  const list = scope ? spectatorClipRequest(scope.listPath, spectator) : null;
  const owner = list?.identity || null;
  const [feed, setFeed] = React.useState(null);
  const [, refreshAuth] = React.useReducer((state) => state + 1, 0);

  React.useEffect(() => {
    const change = () => { refreshAuth(); };
    window.addEventListener("storage", change);
    return () => window.removeEventListener("storage", change);
  }, []);

  React.useEffect(() => {
    if (!scope || !enabled) {
      setFeed(null);
      return undefined;
    }
    const controller = new AbortController();
    let ticket = 0;
    async function load() {
      if (document.hidden) return;
      const current = ++ticket;
      const { path, headers, identity } = spectatorClipRequest(scope.listPath, spectator);
      if (identity !== owner) { refreshAuth(); return; }
      try {
        const response = await fetch(api + path, { cache: "no-store", headers, signal: controller.signal });
        const data = response.ok ? await response.json() : null;
        if (controller.signal.aborted || current !== ticket || spectatorClipRequest(scope.listPath, spectator).identity !== owner) return;
        if (Array.isArray(data?.clips)) setFeed({ owner, spectator, clips: data.clips });
        else if (response.status === 401 || response.status === 403 || response.status === 404) setFeed(null);
      } catch {
        /* Keep the last authorized list during a transient outage. */
      }
    }
    void load();
    window.addEventListener(CLIPS_EVENT, load);
    const timer = refresh ? window.setInterval(load, CLIP_POLL_MS) : null;
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      window.removeEventListener(CLIPS_EVENT, load);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [api, enabled, owner, refresh, scope, spectator]);

  const clips = enabled && feed?.owner === owner && feed?.spectator === spectator ? feed.clips.filter((clip) => generation == null || clip.generation == null || clip.generation === generation) : [];
  return { api, clips, scope };
}

function momentLabel(moment) {
  if (moment === "ace") return "Ace";
  if (moment === "birdie") return "Birdie";
  return "Highlight";
}

function clipStationLabel(clip, holes, putting) {
  if (!putting) return "Hole " + clip.hole;
  const hole = (Array.isArray(holes) ? holes : []).find((row) => row && Number(row.hole) === Number(clip.hole));
  const distance = hole ? Number(hole.distance_ft != null ? hole.distance_ft : hole.distanceFt) : NaN;
  if (Number.isFinite(distance) && distance > 0) return distance + " ft";
  return "Station " + clip.hole;
}

function clipCaption(clip, holes, putting) {
  const place = clipStationLabel(clip, holes, putting);
  if (!clip.highlight) return place;
  if (putting) return "Highlight · " + place;
  return momentLabel(clip.moment) + " · " + place;
}

export function clipsForStanding(clips, standing, generation) {
  const names = new Set();
  function add(value) {
    const name = String(value || "").trim().toLowerCase().replace(/\s+\(you\)$/i, "");
    if (name) names.add(name);
  }
  add(standing && standing.name);
  add(standing && standing.label);
  const members = standing && Array.isArray(standing.members) ? standing.members : [];
  members.forEach(add);
  const playerIndexes = standing?.clipPlayerIndexes ?? standing?.playerIndexes ?? [];
  const indexes = new Set(playerIndexes.map(Number));
  return (Array.isArray(clips) ? clips : []).filter((clip) => {
    if (!clip || !clip.mediaPath) return false;
    if (clip.generation) {
      return clip.generation === generation && clip.playerIndex != null && indexes.has(Number(clip.playerIndex));
    }
    if (Array.isArray(standing?.clipPlayerIndexes)) return false;
    const name = String(clip.playerName || "").trim().toLowerCase();
    if (clip.playerIndex != null && indexes.size && !indexes.has(Number(clip.playerIndex))) return false;
    return Boolean(name) && names.has(name);
  });
}

function ClipPlayer({ api, clip, label }) {
  const [asset, setAsset] = React.useState(null);
  const [attempt, setAttempt] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const abort = React.useRef(null);
  const video = React.useRef(null);
  const playButton = React.useRef(null);
  const focusPlayer = React.useRef(false);
  const key = watchKeyFromLocation(window.location);
  const credential = withGuest(clip.mediaPath);
  const identity = credential.token || credential.guest || credential.path;
  const source = clip.requiresAuth
    ? (asset?.identity === identity ? asset.url : "")
    : api + clip.mediaPath + (key ? "?wl=" + encodeURIComponent(key) : "");
  React.useEffect(() => () => abort.current?.abort(), [identity, clip.requiresAuth]);
  React.useEffect(() => () => { if (asset) URL.revokeObjectURL(asset.url); }, [asset]);

  async function load() {
    focusPlayer.current = document.activeElement === playButton.current;
    setError("");
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const response = await fetch(api + credential.path, { cache: "no-store", headers: authHeaders(credential.token, credential.guest), signal: controller.signal });
      if (!response.ok) throw new Error("video_unavailable");
      const blob = await response.blob();
      if (!controller.signal.aborted) setAsset({ identity, url: URL.createObjectURL(blob) });
    } catch {
      if (!controller.signal.aborted) {
        setError("Couldn’t load this clip. Check your connection or access and try again.");
        window.dispatchEvent(new CustomEvent(CLIPS_EVENT));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  React.useEffect(() => {
    if (clip.requiresAuth && source && focusPlayer.current) {
      video.current?.focus();
      focusPlayer.current = false;
    }
  }, [source, clip.requiresAuth]);

  return h(React.Fragment, null,
    source ? h("video", appleVideoAttrs({
      key: attempt,
      "aria-label": label,
      controls: true,
      onError: () => setError("Couldn’t play this clip. Check your connection and access."),
      onLoadedMetadata: markClipFrame,
      preload: "metadata",
      ref: video,
      src: source,
      tabIndex: 0,
    })) : h("button", { type: "button", className: "btn secondary", ref: playButton, "aria-label": "Load " + label, disabled: busy, onClick: () => { void load(); } }, busy ? "Loading clip…" : "Load clip"),
    error ? h("p", { className: "muted", role: "status" }, error) : null,
    source && error ? h("button", { type: "button", className: "btn secondary", onClick: () => {
      setError("");
      if (clip.requiresAuth) { setAsset(null); void load(); }
      else setAttempt((value) => value + 1);
    } }, "Retry clip") : null);
}

export function HighlightClipList(props) {
  const clips = Array.isArray(props.clips) ? props.clips : [];
  if (!clips.length || !props.api) return null;
  const putting = props.putting === true;
  const holes = Array.isArray(props.holes) ? props.holes : [];
  return h("div", { className: "throw-highlights-row lb-clips" }, clips.map((clip) =>
    h("figure", { className: "throw-highlight", key: clip.id }, [
      h(ClipPlayer, { api: props.api, clip, label: clip.playerName + " · " + clipCaption(clip, holes, putting), key: "video" }),
      h("figcaption", { key: "cap" }, clipCaption(clip, holes, putting)),
    ]),
  ));
}

function filmPlaceLabel(hole, putting) {
  if (!putting) return "Hole " + (hole && hole.hole) + " throw";
  const distance = Number(hole && (hole.distance_ft != null ? hole.distance_ft : hole.distanceFt));
  if (Number.isFinite(distance) && distance > 0) return distance + " ft putt";
  return "Station " + (hole && hole.hole) + " putt";
}

export function RoundHighlights(props) {
  return props.film ? h(ClipGallery, props) : h(ManagedClipGallery, props);
}

function ManagedClipGallery(props) {
  const film = useThrowClips({ generation: props.generation });
  return h(ClipGallery, { ...props, film, allowCardStar: props.canStar });
}

function ClipGallery(props) {
  const { api, clips } = props.film;
  const landscape = usePhoneLandscape();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(null);
  const [note, setNote] = React.useState("");
  const bodyId = React.useId();
  const rows = clips.filter((clip) => clip && clip.mediaPath);
  if (!rows.length) return null;
  const canStar = props.canStar === true;
  const putting = props.putting === true;
  const videosLabel = putting ? "Putt videos" : "Throw videos";
  const countLabel = rows.length === 1 ? "1 clip" : rows.length + " clips";
  async function update(clip, field) {
    const sharing = field === "visibility";
    const value = sharing ? (clip.visibility === "private" ? "round" : "private") : !clip.highlight;
    const { path, token, guest } = withGuest(clip.mediaPath.replace(/\/media$/, "/" + field));
    setBusy(clip.id);
    setNote("");
    try {
      const response = await fetch(api + path, {
        body: JSON.stringify({ [field]: value }),
        headers: { ...authHeaders(token, guest), "Content-Type": "application/json" },
        method: sharing ? "PUT" : "POST",
      });
      if (!response.ok) throw new Error("clip_update_failed");
      setNote(sharing ? (value === "private" ? "Clip is private." : "Clip shared with round viewers.") : (value ? "Highlight starred." : "Highlight unstarred."));
      window.dispatchEvent(new CustomEvent(CLIPS_EVENT));
    } catch {
      setNote("Couldn’t update this clip. Try again.");
    } finally {
      setBusy(null);
    }
  }
  return h("section", {
    className: "throw-highlights" + (open ? " open" : "") + (landscape ? " is-landscape" : " is-portrait"),
    "data-react-throw-highlights": open ? "open" : "collapsed",
  }, [
    h("button", {
      "aria-controls": bodyId,
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
    open ? h("div", { className: "throw-highlights-row", id: bodyId, key: "row" }, rows.map((clip) =>
      h("figure", { className: "throw-highlight", key: clip.id }, [
        h(ClipPlayer, { api, clip, label: clip.playerName + " · " + clipCaption(clip, props.holes, putting), key: "video" }),
        h("figcaption", { key: "cap" }, [
          clipCaption(clip, props.holes, putting),
          clip.playerName ? " · " + clip.playerName : "",
          clip.canManage ? (clip.visibility === "private" ? " · Private" : " · Round viewers") : "",
        ]),
        canStar && (clip.canManage || props.allowCardStar) ? h("button", {
          className: "throw-highlight-star",
          key: "star",
          disabled: busy !== null,
          "aria-pressed": clip.highlight,
          onClick: () => { void update(clip, "highlight"); },
          type: "button",
        }, clip.highlight ? "Unstar" : "Star highlight") : null,
        clip.canManage ? h("button", {
          className: "throw-highlight-star",
          key: "visibility",
          disabled: busy !== null,
          onClick: () => { void update(clip, "visibility"); },
          type: "button",
        }, clip.visibility === "private" ? "Share with round viewers" : "Make clip private") : null,
      ]),
    )) : null,
    note ? h("p", { className: "muted", key: "note", role: "status" }, note) : null,
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

const clipStore = createClipStore(globalThis.indexedDB);

export function useClipRecovery(context) {
  const scopeKey = context?.scopeKey;
  const upload = context?.upload;
  const [state, setState] = React.useState({ scopeKey: null, drafts: [], error: false });
  const helpers = React.useMemo(() => {
    if (!scopeKey || !upload) return null;
    let active = true;
    let timer;
    let running;
    let wake = false;

    async function refresh() {
      try {
        const drafts = await clipStore.list(scopeKey);
        drafts.sort((a, b) => b.createdAt - a.createdAt);
        if (active) setState({ scopeKey, drafts, error: false });
        return drafts;
      } catch {
        if (active) setState((previous) => ({
          scopeKey, drafts: previous.scopeKey === scopeKey ? previous.drafts : [], error: true,
        }));
        return [];
      }
    }
    function schedule(at) {
      if (active && at) timer = setTimeout(() => {
        timer = null;
        void sync();
      }, Math.max(100, at - Date.now()));
    }
    async function sync(reconnect = false) {
      if (!active || !navigator.onLine) return;
      if (reconnect) wake = true;
      if (running) return running;
      clearTimeout(timer);
      timer = null;
      const perform = async () => {
        if (!active) return;
        if (wake) {
          wake = false;
          for (const row of await refresh()) {
            if (row.state === "auth" || (row.state === "pending" && row.nextAt)) {
              await clipStore.put({ ...row, state: "pending", nextAt: 0 });
            }
          }
        }
        const next = await drainClipDrafts(clipStore, scopeKey, upload, {
          active: () => active,
          online: () => navigator.onLine,
          onResult(_row, status) {
            if (status === "saved") window.dispatchEvent(new CustomEvent(CLIPS_EVENT));
            void refresh();
          },
        });
        schedule(next);
      };
      running = (async () => {
        try {
          if (navigator.locks && navigator.locks.request) {
            await navigator.locks.request("gvdg:clips:" + scopeKey, { ifAvailable: true }, (lock) => {
              if (lock) return perform();
              schedule(Date.now() + 1000);
            });
          } else await perform();
        } catch {
          if (active) setState((previous) => ({
            scopeKey, drafts: previous.scopeKey === scopeKey ? previous.drafts : [], error: true,
          }));
          schedule(Date.now() + 5000);
        }
      })();
      try { await running; }
      finally {
        running = null;
        if (wake && !timer) void sync();
      }
    }
    return {
      start() {
        active = true;
        void refresh();
        void sync(true);
      },
      stop() {
        active = false;
        clearTimeout(timer);
        timer = null;
      },
      sync,
      async put(record) {
        await clipStore.put({ ...record, scopeKey });
        void refresh();
        if (record.state === "pending") void sync();
      },
      async remove(id) {
        await clipStore.remove(id);
        void refresh();
      },
    };
  }, [scopeKey, upload]);

  React.useEffect(() => {
    if (!helpers) return undefined;
    helpers.start();
    const online = () => { void helpers.sync(true); };
    const visible = () => { if (!document.hidden) void helpers.sync(); };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      helpers.stop();
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [helpers]);

  if (!helpers) return null;
  return {
    ...helpers,
    scopeKey,
    drafts: state.scopeKey === scopeKey ? state.drafts : [],
    storageError: state.scopeKey === scopeKey && state.error,
  };
}

export function ThrowFilm(props) {
  const [open, setOpen] = React.useState(null);
  const rows = props.offlineRows || (Array.isArray(props.rows) ? props.rows : []);
  const hole = props.hole && props.hole.hole;
  const putting = props.putting === true;
  const recovery = props.recovery;
  if (!recovery || !rows.length || !hole) return null;
  const filmLabel = putting ? "Film a putt" : "Film a throw";
  const count = recovery.drafts.length;
  return h(React.Fragment, null, [
    h("button", {
      "aria-label": count ? filmLabel + ", " + count + " clips on this phone" : filmLabel,
      className: "score-glove-tool",
      key: "film",
      title: filmLabel,
      type: "button",
      onClick: () => setOpen({
        scopeKey: recovery.scopeKey, hole, putting, rows, par: props.hole.par,
        placeLabel: filmPlaceLabel(props.hole, putting),
      }),
    }, [icon(Video), h("span", { key: "label" }, count ? "Film (" + count + ")" : "Film")]),
    open?.scopeKey === recovery.scopeKey ? h(ThrowFilmSheet, {
      ...open,
      key: "sheet",
      recovery,
      offline: props.offline,
      onClose: () => setOpen(null),
    }) : null,
  ]);
}

function clipMetadata(player, hole, putting, par, highlight) {
  const source = player.source || {};
  return {
    hole,
    playerIndex: Array.isArray(source.playerIndexes) ? source.playerIndexes[0] : source.index,
    playerName: source.type === "pair" ? "" : String(player.label || "").replace(/\s+\(you\)$/i, ""),
    highlight,
    moment: (putting ? null : suggestedMoment(player.currentScore, par)) || (highlight ? "manual" : ""),
  };
}

function clipDraftStatus(draft) {
  if (draft.state === "draft") return "Draft saved on this phone";
  if (draft.state === "pending") return "Saved on this phone, upload pending";
  if (draft.state === "auth") return "Sign in to this card to upload";
  if (draft.error === "clip_limit") return "This round already has enough clips";
  if (draft.error === "clip_too_large") return "This clip is too large to upload";
  if (draft.error === "round_not_live" || draft.error === "recovery_scope_changed") return "This clip’s original card is unavailable";
  return "Upload needs attention";
}

function ThrowFilmSheet(props) {
  const dialog = useAccessibleDialog({
    open: true,
    onClose: requestClose,
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
  const [draft, setDraft] = React.useState(null);
  const [stored, setStored] = React.useState(false);
  const [playerEdited, setPlayerEdited] = React.useState(false);
  const closingRef = React.useRef(false);
  const metadataRef = React.useRef(null);
  metadataRef.current = clipMetadata(player, props.hole, props.putting, props.par, highlight);
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
    if (props.putting || draft) return;
    setHighlight(Boolean(suggestedMoment(player.currentScore, props.par)));
  }, [draft, player.key, player.currentScore, props.par, props.putting]);

  React.useEffect(() => () => {
    if (clipUrl) URL.revokeObjectURL(clipUrl);
  }, [clipUrl]);
  React.useEffect(() => () => {
    window.clearInterval(timerRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop());
  }, []);

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
        const draft = {
          ...metadataRef.current, blob: next, id: crypto.randomUUID(), createdAt: Date.now(),
          state: "draft", attempt: 0, nextAt: 0,
        };
        setDraft(draft);
        setStored(false);
        setClipUrl(URL.createObjectURL(next));
        setPhase("persisting");
        void props.recovery.put(draft).then(() => {
          setStored(true);
          setPhase("review");
          if (closingRef.current) props.onClose();
        }).catch(() => {
          closingRef.current = false;
          setError("This phone couldn’t store the draft. Keep this window open and download a copy.");
          setPhase("review");
        });
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

  function requestClose() {
    if (phase === "persisting" || phase === "saving") return;
    if (phase === "recording") {
      closingRef.current = true;
      stop();
      return;
    }
    if (draft && !stored) {
      setError("Download a copy or discard this recording before closing.");
      return;
    }
    props.onClose();
  }

  async function discard() {
    if (phase === "saving" || phase === "persisting" || draft?.state === "pending") return;
    dropRef.current = true;
    window.clearInterval(timerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.stop();
      return;
    }
    try {
      if (stored && draft) await props.recovery.remove(draft.id);
      stopStream();
      props.onClose();
    } catch {
      setError("Couldn’t delete the clip from this phone.");
    }
  }

  function stop() {
    window.clearInterval(timerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") recorder.stop();
    else stopStream();
  }

  function review(record) {
    stopStream();
    setDraft(record);
    setStored(true);
    setPlayerEdited(false);
    const original = rows.find((row) => clipMetadata(row, record.hole, props.putting, props.par, false).playerIndex === record.playerIndex);
    if (original) setPlayerKey(String(original.key));
    setHighlight(record.highlight);
    setClipUrl(URL.createObjectURL(record.blob));
    setError("");
    setPhase("review");
  }

  function retake() {
    setDraft(null);
    setStored(false);
    setClipUrl("");
    setError("");
    setPhase("idle");
  }

  async function save() {
    if (!draft || phase !== "review" || draft.state === "pending") return;
    if (draft.blob.size > MAX_CLIP_BYTES) {
      setError("That clip is too big to upload. You can download a copy.");
      return;
    }
    setPhase("saving");
    setError("");
    const metadata = draft.attempt || draft.hole !== props.hole ? {}
      : playerEdited ? metadataRef.current : { highlight, moment: draft.moment || (highlight ? "manual" : "") };
    try {
      await props.recovery.put({ ...draft, ...metadata, state: "pending", nextAt: 0, error: null });
      props.onClose();
    } catch {
      setError("This phone couldn’t save the upload. Try again or download a copy.");
      setPhase("review");
    }
  }

  const draftOnPhone = props.recovery.drafts.find((row) => row.id === draft?.id);
  const reviewing = phase === "review" || phase === "saving" || phase === "persisting";
  const canEdit = !draft || (draft.state === "draft" && draft.hole === props.hole);
  const activeDraft = draftOnPhone || draft;
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
        onClick: requestClose,
        type: "button",
      }, icon(X)),
    ]),
    h("p", { className: "muted", key: "hint" }, reviewing && activeDraft
      ? ((props.putting ? "Station " : "Hole ") + activeDraft.hole + " · " + (activeDraft.playerName || "Card player"))
      : title),
    props.recovery.storageError ? h("p", { className: "throw-film-error", key: "storage", role: "alert" }, "This phone’s clip storage is unavailable.") : null,
    !reviewing && phase !== "recording" && props.recovery.drafts.length ? h("ul", { key: "drafts" },
      props.recovery.drafts.map((record) => h("li", { key: record.id }, h("button", {
        className: "btn secondary", type: "button", onClick: () => review(record),
      }, (props.putting ? "Station " : "Hole ") + record.hole + " · " + clipDraftStatus(record)))),
    ) : null,
    canEdit ? h("label", { className: "lbl", key: "who" }, [
      "Player",
      h("select", {
        key: "select",
        disabled: phase === "recording" || phase === "persisting" || phase === "saving",
        onChange: (event) => { setPlayerKey(event.target.value); setPlayerEdited(Boolean(draft)); },
        value: String(player.key),
      }, rows.map((row) => h("option", { key: row.key, value: String(row.key) }, row.label))),
    ]) : null,
    reviewing
      ? h("video", appleVideoAttrs({ autoPlay: true, className: "throw-film-preview", controls: true, key: "play", onLoadedMetadata: markClipFrame, ref: playRef, src: clipUrl }))
      : h("video", appleVideoAttrs({ autoPlay: true, className: "throw-film-preview", key: "live", muted: true, ref: liveRef })),
    phase === "recording" ? h("p", { className: "throw-film-timer", key: "timer" }, "Recording " + seconds + "s / " + MAX_SECONDS + "s") : null,
    error ? h("p", { className: "throw-film-error", key: "error", role: "alert" }, error) : null,
    phase === "persisting" ? h("p", { className: "muted", key: "persisting", role: "status" }, "Saving draft on this phone…")
      : activeDraft && stored ? h("p", { className: "muted", key: "draft-status", role: "status" },
        !draftOnPhone && draft.state === "pending" ? "Check Round clips for this upload." : clipDraftStatus(activeDraft)) : null,
    canEdit ? h("label", { className: "throw-film-star", key: "star" }, [
      h("input", {
        checked: highlight,
        disabled: phase === "persisting" || phase === "saving",
        key: "check",
        onChange: (event) => setHighlight(event.target.checked),
        type: "checkbox",
      }),
      "Round highlight",
    ]) : null,
    h("div", { className: "throw-film-actions", key: "actions" }, [
      !reviewing && (phase === "idle" || lightReady || torchOn)
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
        : reviewing
          ? activeDraft?.state === "pending" ? null : h("button", {
            className: "btn primary", disabled: phase !== "review", key: "save", onClick: () => { void save(); }, type: "button",
          }, phase === "saving" ? "Saving" : props.offline ? "Queue for upload after the round" : activeDraft?.attempt ? "Retry upload" : "Upload private clip")
          : h("button", { className: "btn primary", key: "start", onClick: () => { void start(); }, type: "button" }, "Record"),
      phase === "review" && stored ? h("button", { className: "btn secondary", key: "retake", onClick: retake, type: "button" }, "New clip") : null,
      phase === "review" && draft ? h("a", {
        className: "btn secondary", download: "hole-" + draft.hole + (draft.blob.type === "video/mp4" ? ".mp4" : ".webm"),
        href: clipUrl, key: "download",
      }, "Download clip") : null,
    ]),
    phase === "recording" || (phase === "review" && activeDraft?.state !== "pending")
      ? h("button", {
        className: "btn danger",
        key: "discard",
        onClick: discard,
        type: "button",
      }, "Discard")
      : null,

  ])), document.body);
}
