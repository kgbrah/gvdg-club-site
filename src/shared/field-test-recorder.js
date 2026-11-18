// Field test recorder. Loaded only while field test mode is on (see field-test-gate.js), it writes
// timestamped events to the on-device ring buffer: score-entry feedback, sync acknowledgements,
// connectivity, live-update delay, round results, clips, battery, errors and volunteer notes.
//
// Keep this module free of imports from the app entry bundles: in the scorer it is a lazy chunk, and a
// chunk importing the entry would load a second copy of the app. Only the store and privacy filter, which
// nothing in the entries uses, may be imported here.
import { fieldLogStore } from "./field-test-store.js";
import { sanitizeFieldEvent } from "./field-test-privacy.js";

export const FIELD_BATTERY_MS = 5 * 60 * 1000;
const TAP_TIMEOUT_MS = 3000;
// Write on the next task: events from one tap share a write, and closing the app right after loses nothing.
const FLUSH_MS = 0;
const MAX_UNSAVED = 600;
const TOKEN_KEY = "gvdg_member_token";
const DEVICE_KEY = "gvdg_field_device";
const AUTH_EVENT = "gvdg:score-auth";
const PAGE_PARAMS = ["round", "event", "watch", "offline", "start", "preview"];

// What a tap can change: the score buttons, the pad, the wrist layout and hole navigation.
const TAP_TARGETS = [
  ["minus", ".stepper .minus, .wrist-minus"],
  ["plus", ".stepper .plus, .wrist-plus"],
  ["value", ".stepper .val, .wrist-val"],
  ["pad", ".score-pad-key, .score-pad-shortcuts button"],
  ["conflict-pick", ".conflict-picks button"],
  ["hole-nav", ".hole-head .navbtn, .wrist-nav-btn"],
  ["hole-grid", ".score-holestrip .holegrid button"],
];
const TAP_SELECTOR = TAP_TARGETS.map(([, selector]) => selector).join(", ");
const SCREEN_PARTS = ".score-glove-scores, .hole-head, .wrist-score";

function shortId() {
  try { return globalThis.crypto.randomUUID().slice(0, 8); } catch { return Math.random().toString(36).slice(2, 10); }
}

function jwtSubject(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4));
    const sub = JSON.parse(json)?.sub;
    return sub == null ? null : String(sub);
  } catch {
    return null;
  }
}

function errorSource(filename, line, column) {
  if (!filename) return "";
  let file = String(filename);
  try { const url = new URL(file); file = url.pathname; } catch { /* already a path */ }
  return file + (line ? ":" + line + (column ? ":" + column : "") : "");
}

function stackSource(stack) {
  const match = /(?:https?:\/\/[^/\s)]+)?(\/[^\s):]+):(\d+):(\d+)/.exec(String(stack || ""));
  return match ? match[1] + ":" + match[2] + ":" + match[3] : "";
}

/** Score totals and per-hole mismatches between this phone's entries and the server's final card. */
export function compareRoundCard(events, server) {
  const roundId = server && server.roundId;
  const discarded = new Set(events.filter((row) => row.type === "sync.discard").map((row) => row.id));
  const local = new Map();
  for (const row of events) {
    if (row.type !== "sync.queue" || row.kind !== "score" || row.roundId !== roundId || discarded.has(row.id)) continue;
    if (row.key == null || !Number.isInteger(row.hole)) continue;
    local.set(row.key + "|" + row.hole, { key: row.key, hole: row.hole, strokes: Number.isFinite(row.strokes) ? row.strokes : null });
  }
  const saves = new Map();
  for (const row of events) {
    if (row.type === "sync.ack" && row.roundId === roundId && row.state === "saved" && row.id) saves.set(row.id, (saves.get(row.id) || 0) + 1);
  }
  const duplicates = [...saves.values()].filter((count) => count > 1).length;
  const holesByKey = new Map((Array.isArray(server?.rows) ? server.rows : []).map((row) => [row.key, row.holes || {}]));
  const mismatches = [];
  const totals = new Map();
  for (const entry of local.values()) {
    const holes = holesByKey.get(entry.key);
    const raw = holes ? holes[entry.hole] ?? holes[String(entry.hole)] : undefined;
    const serverValue = Number.isFinite(raw) ? raw : null;
    const total = totals.get(entry.key) || { key: entry.key, holes: 0, localTotal: 0, serverTotal: 0 };
    total.holes += 1;
    total.localTotal += entry.strokes || 0;
    total.serverTotal += serverValue || 0;
    totals.set(entry.key, total);
    if (!holes) mismatches.push({ key: entry.key, hole: entry.hole, local: entry.strokes, server: null, missingRow: true });
    else if (serverValue !== entry.strokes) mismatches.push({ key: entry.key, hole: entry.hole, local: entry.strokes, server: serverValue });
  }
  const verdict = !local.size ? "no local scores" : mismatches.length || duplicates ? "lost/duplicate suspected" : "match";
  return { roundId, verdict, checked: local.size, duplicates, mismatches: mismatches.slice(0, 60), rows: [...totals.values()] };
}

/** Start recording for this page. Returns the recorder API the gate forwards to. */
export function startFieldRecorder({ app = "app", early = [], store = fieldLogStore(), win = globalThis } = {}) {
  const doc = win.document;
  const nav = win.navigator || {};
  const sid = shortId();
  const cleanups = [];
  let names = [];
  let unsaved = [];
  let flushTimer = null;
  let flushing = null;
  let stopped = false;
  let batteryTimer = null;
  let offlineAt = nav.onLine === false ? Date.now() : null;
  let memberId = readMemberId();
  const lastClose = new Map();
  const lastRev = new Map();
  let tap = null;
  let observer = null;
  let storageFailures = 0;

  function readMemberId() {
    try { return jwtSubject(win.localStorage?.getItem(TOKEN_KEY)); } catch { return null; }
  }
  function now() {
    return typeof win.performance?.now === "function" ? win.performance.now() : 0;
  }
  function listen(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  function scheduleFlush() {
    if (flushTimer || stopped) return;
    flushTimer = win.setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_MS);
  }
  function flush() {
    if (flushTimer) { win.clearTimeout(flushTimer); flushTimer = null; }
    if (flushing) return flushing.then(() => (unsaved.length ? flush() : undefined));
    if (!unsaved.length) return Promise.resolve();
    const batch = unsaved;
    unsaved = [];
    flushing = store.append(batch).then(() => { storageFailures = 0; }, () => {
      // Storage refused the write (low storage, private mode): keep the newest events in memory to retry.
      storageFailures += 1;
      unsaved = batch.concat(unsaved).slice(-MAX_UNSAVED);
      if (!stopped && storageFailures < 20) win.setTimeout(() => { void flush(); }, 5000);
    }).finally(() => { flushing = null; });
    return flushing;
  }

  function write(type, data, at = Date.now(), t = now()) {
    const connection = nav.connection;
    const event = sanitizeFieldEvent({
      ...(data && typeof data === "object" ? data : {}),
      at, t: Math.round(t), sid, app, type,
      net: nav.onLine === false ? "off" : "on",
      ...(connection && connection.effectiveType ? { eff: connection.effectiveType } : {}),
    }, { names });
    unsaved.push(event);
    if (unsaved.length > MAX_UNSAVED) unsaved = unsaved.slice(-MAX_UNSAVED);
    scheduleFlush();
    return event;
  }

  function log(type, data, at = Date.now(), t = now()) {
    if (stopped) return null;
    if (type === "__redact") { names = Array.isArray(data) ? data.slice(0, 200) : []; return null; }
    if (type === "round.server") { void checkRound(data, at); return null; }
    if (type === "ws.close" && data?.role) lastClose.set(data.role, at);
    if (type === "ws.open" && data?.role && lastClose.has(data.role)) {
      data = { ...data, recoverMs: Math.max(0, at - lastClose.get(data.role)) };
      lastClose.delete(data.role);
    }
    if (type === "live.update") {
      const role = data?.role || "live";
      const rev = Number.isFinite(data?.rev) ? data.rev : null;
      const previous = lastRev.get(role);
      // Same-revision rebroadcasts (weather, locations) are not new score changes.
      if (rev != null && previous && rev <= previous.rev) return null;
      const changedAt = data?.updatedAt ? Date.parse(data.updatedAt) : NaN;
      const next = { role, rev, status: data?.status || null, first: !previous };
      if (previous) {
        next.gapMs = Math.max(0, at - previous.at);
        if (rev != null) next.revStep = rev - previous.rev;
        if (Number.isFinite(changedAt)) next.delayMs = Math.round(at - changedAt);
      }
      if (rev != null) lastRev.set(role, { rev, at });
      data = next;
    }
    return write(type, data, at, t);
  }

  async function checkRound(server, at) {
    try {
      await flush();
      const result = compareRoundCard(await store.all(), server);
      write("round.check", { ...result, reason: server?.reason || "final", status: server?.status || null }, at);
    } catch {
      write("round.check", { roundId: server?.roundId || null, verdict: "check failed" }, at);
    }
  }

  // ----- context -----
  function pageRef() {
    try {
      const url = new URL(win.location.href);
      const kept = new URLSearchParams();
      for (const key of PAGE_PARAMS) if (url.searchParams.has(key)) kept.set(key, url.searchParams.get(key));
      return url.pathname + (kept.size ? "?" + kept : "") + (url.hash && url.hash.length < 40 ? url.hash.replace(/\?.*$/, "") : "");
    } catch { return ""; }
  }
  function standalone() {
    try { return Boolean(win.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true); } catch { return false; }
  }
  function navigationTiming() {
    try {
      const entry = win.performance?.getEntriesByType?.("navigation")?.[0];
      if (!entry) return {};
      return { navType: entry.type || null, domReadyMs: Math.round(entry.domContentLoadedEventEnd || 0) || null };
    } catch { return {}; }
  }
  function sessionContext() {
    const connection = nav.connection;
    const screen = win.screen || {};
    let deviceLabel = "";
    try { deviceLabel = String(win.localStorage?.getItem(DEVICE_KEY) || "").slice(0, 60); } catch { /* no storage */ }
    return {
      page: pageRef(),
      build: doc?.querySelector?.('meta[name="gvdg-build"]')?.getAttribute("content") || null,
      memberId,
      deviceLabel,
      ua: String(nav.userAgent || "").slice(0, 300),
      platform: nav.userAgentData?.platform || nav.platform || "",
      mobile: nav.userAgentData ? nav.userAgentData.mobile === true : /Mobi|Android|iPhone/i.test(nav.userAgent || ""),
      screen: (screen.width || 0) + "x" + (screen.height || 0),
      viewport: (win.innerWidth || 0) + "x" + (win.innerHeight || 0),
      dpr: win.devicePixelRatio || 1,
      standalone: standalone(),
      online: nav.onLine !== false,
      connType: connection?.type || null,
      effType: connection?.effectiveType || null,
      downlink: connection?.downlink ?? null,
      rtt: connection?.rtt ?? null,
      saveData: connection?.saveData === true,
      batteryApi: typeof nav.getBattery === "function",
      cores: nav.hardwareConcurrency || null,
      memoryGb: nav.deviceMemory || null,
      lang: nav.language || "",
      tzOffset: new Date().getTimezoneOffset(),
      ...navigationTiming(),
    };
  }
  async function buildContext() {
    const out = {};
    try {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? win.setTimeout(() => controller.abort(), 4000) : null;
      const response = await win.fetch("version.json?t=" + Date.now(), { cache: "no-store", signal: controller?.signal });
      win.clearTimeout(timer);
      const data = response.ok ? await response.json() : null;
      out.commit = typeof data?.commit === "string" ? data.commit : null;
      out.deployedAt = typeof data?.deployedAt === "string" ? data.deployedAt : null;
    } catch { out.commit = null; }
    try {
      const keys = win.caches ? await win.caches.keys() : [];
      out.swCache = keys.filter((key) => /^gvdg-club-v\d+$/.test(key)).sort().join(",") || null;
    } catch { out.swCache = null; }
    out.swControlled = Boolean(nav.serviceWorker?.controller);
    try {
      if (nav.storage?.estimate) {
        const estimate = await nav.storage.estimate();
        out.storageUsageMb = Math.round((estimate.usage || 0) / 1e5) / 10;
        out.storageQuotaMb = Math.round((estimate.quota || 0) / 1e5) / 10;
      }
      if (nav.storage?.persisted) out.storagePersisted = await nav.storage.persisted();
    } catch { /* not supported */ }
    return out;
  }

  // ----- score-entry feedback: tap to the next painted frame that shows the change -----
  function visibleScoreText() {
    let text = "";
    for (const node of doc.querySelectorAll(SCREEN_PARTS)) text += node.textContent + "\u0001";
    return text + (doc.querySelector(".score-pad-sheet") ? "pad" : "");
  }
  function endTap() {
    if (!tap) return;
    win.clearTimeout(tap.timer);
    observer?.disconnect();
    tap = null;
  }
  function painted(current) {
    // requestAnimationFrame runs just before the frame is painted; a message posted from it is
    // delivered right after that paint.
    const deliver = () => {
      if (tap !== current) return;
      const paintedAt = now();
      const ms = Math.max(0, Math.round(paintedAt - current.downAt));
      write("tap.feedback", {
        target: current.kind,
        ms,
        clickMs: current.clickAt ? Math.max(0, Math.round(paintedAt - current.clickAt)) : null,
      }, Date.now(), paintedAt);
      endTap();
    };
    win.requestAnimationFrame(() => {
      if (typeof win.MessageChannel === "function") {
        const channel = new win.MessageChannel();
        channel.port1.onmessage = deliver;
        channel.port2.postMessage(0);
      } else win.setTimeout(deliver, 0);
    });
  }
  function onMutation() {
    if (!tap || tap.changed) return;
    if (visibleScoreText() === tap.before) return;
    tap.changed = true;
    painted(tap);
  }
  function onPointerDown(event) {
    const element = event.target && typeof event.target.closest === "function" ? event.target.closest(TAP_SELECTOR) : null;
    if (!element || element.disabled) return;
    const kind = (TAP_TARGETS.find(([, selector]) => element.matches(selector)) || ["tap"])[0];
    endTap();
    const current = now();
    const stamp = Number(event.timeStamp);
    // event.timeStamp shares performance.now()'s clock in current browsers; fall back if it looks wrong.
    const downAt = Number.isFinite(stamp) && stamp > 0 && stamp <= current && current - stamp < 5000 ? stamp : current;
    tap = { kind, downAt, clickAt: 0, before: visibleScoreText(), changed: false, timer: 0 };
    const pending = tap;
    tap.timer = win.setTimeout(() => {
      if (tap !== pending || pending.changed) return;
      write("tap.nochange", { target: pending.kind });
      endTap();
    }, TAP_TIMEOUT_MS);
    if (!observer && typeof win.MutationObserver === "function") observer = new win.MutationObserver(onMutation);
    observer?.observe(doc.body, { subtree: true, childList: true, characterData: true });
  }
  function onClick(event) {
    if (!tap || tap.clickAt) return;
    const stamp = Number(event.timeStamp);
    tap.clickAt = Number.isFinite(stamp) && stamp >= tap.downAt ? stamp : now();
  }

  // ----- battery -----
  function startBattery() {
    if (typeof nav.getBattery !== "function") {
      write("battery.unavailable", { reason: "no battery API in this browser; note battery % by hand" });
      return;
    }
    nav.getBattery().then((battery) => {
      if (stopped || !battery) return;
      const sample = (reason) => write("battery", { level: Math.round(Number(battery.level) * 100), charging: battery.charging === true, reason });
      sample("start");
      batteryTimer = win.setInterval(() => sample("interval"), FIELD_BATTERY_MS);
      listen(battery, "levelchange", () => sample("level"));
      listen(battery, "chargingchange", () => sample("charging"));
    }, () => write("battery.unavailable", { reason: "battery API refused; note battery % by hand" }));
  }

  // ----- start -----
  write("session.start", sessionContext());
  for (const item of early) {
    if (item && item.type) log(item.type, item.data, item.at, item.t);
  }
  buildContext().then((context) => { if (!stopped) write("session.build", context); });
  try { nav.storage?.persist?.().catch?.(() => {}); } catch { /* best effort: keep the log under storage pressure */ }

  listen(win, "online", () => {
    const offlineMs = offlineAt ? Date.now() - offlineAt : null;
    offlineAt = null;
    write("net.online", { offlineMs });
  });
  listen(win, "offline", () => {
    offlineAt = Date.now();
    write("net.offline", {});
    void flush();
  });
  const connection = nav.connection;
  listen(connection, "change", () => write("net.change", {
    connType: connection.type || null, effType: connection.effectiveType || null,
    downlink: connection.downlink ?? null, rtt: connection.rtt ?? null,
  }));
  listen(doc, "visibilitychange", () => {
    write("session.visibility", { state: doc.visibilityState });
    if (doc.visibilityState === "hidden") void flush();
  });
  listen(win, "pagehide", (event) => {
    write("session.pagehide", { persisted: event.persisted === true });
    void flush();
  });
  listen(win, "error", (event) => {
    if (!event || event.target !== win && event.target != null && event.target !== doc) return;
    write("error", { kind: "error", message: String(event.message || "Script error").slice(0, 300),
      source: errorSource(event.filename, event.lineno, event.colno) });
  });
  listen(win, "unhandledrejection", (event) => {
    const reason = event && event.reason;
    write("error", { kind: "rejection", message: String(reason?.message || reason || "Unhandled rejection").slice(0, 300),
      source: stackSource(reason?.stack) });
  });
  const authChanged = () => {
    const next = readMemberId();
    if (next === memberId) return;
    memberId = next;
    write("auth.change", { memberId: next });
  };
  listen(win, AUTH_EVENT, authChanged);
  listen(win, "storage", (event) => { if (!event || event.key === TOKEN_KEY || event.key == null) authChanged(); });
  if (doc) {
    listen(doc, "pointerdown", onPointerDown, { capture: true, passive: true });
    listen(doc, "click", onClick, { capture: true, passive: true });
  }
  startBattery();

  return {
    app,
    sid,
    log,
    flush,
    store,
    setRedactions(list) { names = Array.isArray(list) ? list.slice(0, 200) : []; },
    stop() {
      if (stopped) return Promise.resolve();
      endTap();
      observer = null;
      for (const cleanup of cleanups.splice(0)) cleanup();
      if (batteryTimer) win.clearInterval(batteryTimer);
      batteryTimer = null;
      const done = flush();
      stopped = true;
      return done;
    },
  };
}
