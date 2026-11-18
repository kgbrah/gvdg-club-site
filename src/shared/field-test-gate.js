// Field test mode: the on/off switch and the calls the apps make at their hook points.
//
// This module ships in the scorer and member entry bundles, so it stays tiny and does nothing while the
// mode is off: every export returns after one boolean check, and it adds no listeners, timers or storage
// writes. The recorder (event listeners, IndexedDB, battery sampling) lives in field-test-recorder.js and
// is only imported once the mode is on. It must not import this module back: in the scorer it is a lazy
// chunk, and a chunk that imports from the entry would load a second copy of the app.

export const FIELD_TEST_KEY = "gvdg_field_test";
export const FIELD_TEST_DEVICE_KEY = "gvdg_field_device";
// Set the first time the mode is turned on, so Account keeps a path to the log after it is turned off.
export const FIELD_TEST_USED_KEY = "gvdg_field_used";
export const FIELD_LOG_HREF = "gvdg-members.html#field-test";
export const FIELD_GUIDE_HREF = "field-test.html";
export const FIELD_NOTE_CHIPS = Object.freeze([
  "Airplane mode on",
  "Airplane mode off",
  "App closed",
  "Phone restarted",
  "Switched account",
  "Low storage",
  "Weak signal",
]);

const MAX_EARLY = 400;
let enabled = readEnabled();
let app = "";
let recorder = null;
let loading = null;
let early = [];
const subscribers = new Set();

function readEnabled() {
  try { return globalThis.localStorage?.getItem(FIELD_TEST_KEY) === "1"; } catch { return false; }
}

function clock() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : 0;
}

function notify() {
  for (const callback of subscribers) {
    try { callback(enabled); } catch { /* a subscriber's error must not stop the others */ }
  }
}

/** True while field test mode is on for this browser. */
export function fieldTestOn() {
  return enabled;
}

/** In-memory subscription for UI that shows the mode; it adds no DOM listener. */
export function subscribeFieldTest(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

/** Record one event. Before the recorder has loaded, events wait in a short in-memory queue. */
export function fieldLog(type, data) {
  if (!enabled) return;
  if (recorder) {
    recorder.log(type, data);
    return;
  }
  if (early.length < MAX_EARLY) early.push({ type, data, at: Date.now(), t: clock() });
}

/** A monotonic start mark for a duration, or 0 while the mode is off. */
export function fieldMark() {
  return enabled ? clock() || 1e-6 : 0;
}

/** Milliseconds since a fieldMark(), rounded. */
export function fieldSince(mark) {
  return mark ? Math.max(0, Math.round(clock() - mark)) : null;
}

/** Follow a WebSocket's open and close. Returns the socket either way. */
export function fieldWatchSocket(socket, role) {
  if (!enabled || !socket || typeof socket.addEventListener !== "function") return socket;
  const startedAt = clock();
  socket.addEventListener("open", () => fieldLog("ws.open", { role, connectMs: Math.round(clock() - startedAt) }));
  socket.addEventListener("close", (event) => fieldLog("ws.close", { role, code: event.code, clean: event.wasClean === true }));
  return socket;
}

/** A live snapshot arrived. Only the revision and the server's change time are kept. */
export function fieldLiveUpdate(role, snapshot) {
  if (!enabled || !snapshot) return;
  fieldLog("live.update", {
    role,
    rev: Number.isFinite(Number(snapshot.rev)) ? Number(snapshot.rev) : null,
    updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : null,
    status: typeof snapshot.status === "string" ? snapshot.status : null,
  });
}

/** How an upload attempt ended, with the same retry rules as the round recovery queue. */
export function fieldResultState(result) {
  if (!result) return "skipped";
  if (result.ok) return result.data && result.data.id == null && result.data.clientId == null ? "pending" : "saved";
  const status = Number(result.status);
  if (!status || status === 408 || status === 425 || status === 429 || status >= 500) return "pending";
  if (status === 401 || status === 403) return "auth";
  return "error";
}

/** Time one clip upload attempt: start, then saved / pending (will retry) / auth / error, with sizes. */
export function fieldTrackClip(sent, record, mode) {
  if (!enabled || !sent) return sent;
  const startedAt = clock();
  const bytes = Number(record?.blob?.size) || 0;
  const base = { id: record?.id ?? null, bytes, attempt: Number(record?.attempt) || 0, mode };
  fieldLog("clip.start", base);
  return Promise.resolve(sent).then((result) => {
    fieldLog("clip.result", {
      ...base, ms: Math.round(clock() - startedAt), state: fieldResultState(result),
      status: result ? result.status ?? null : null, error: result?.data?.error || null,
    });
    return result;
  }, (error) => {
    fieldLog("clip.result", { ...base, ms: Math.round(clock() - startedAt), state: "error", error: "exception" });
    throw error;
  });
}

/** Names to scrub from free text (notes, error messages). They are never written to the log. */
export function fieldRedactNames(names) {
  if (!enabled) return;
  const list = (Array.isArray(names) ? names : []).filter((name) => typeof name === "string" && name.trim());
  if (recorder) recorder.setRedactions(list);
  else early.push({ type: "__redact", data: list, at: Date.now(), t: clock() });
}

/** A volunteer's note: a quick chip, free text, or a battery reading. */
export function fieldNote(note) {
  if (!enabled || !note) return;
  const text = typeof note.text === "string" ? note.text.trim().slice(0, 280) : "";
  const chip = typeof note.chip === "string" ? note.chip : "";
  const battery = Number(note.battery);
  const entry = {};
  if (chip) entry.chip = chip;
  if (text) entry.text = text;
  if (Number.isFinite(battery) && battery >= 0 && battery <= 100) entry.battery = Math.round(battery);
  if (!entry.chip && !entry.text && entry.battery == null) return;
  fieldLog("note", entry);
}

function loadRecorder() {
  return import("./field-test-recorder.js");
}

/** Start the recorder for this page when the mode is on. Safe to call more than once. */
export function startFieldTest(appName) {
  if (!enabled) return Promise.resolve(null);
  if (appName) app = appName;
  if (recorder) return Promise.resolve(recorder);
  if (!loading) {
    loading = loadRecorder().then((module) => {
      if (!enabled) return null;
      const queued = early;
      early = [];
      recorder = module.startFieldRecorder({ app: app || "app", early: queued });
      return recorder;
    }).catch(() => null).finally(() => { loading = null; });
  }
  return loading;
}

/** Turn the mode on or off for this browser (every app on this site reads the same switch). */
export function setFieldTestEnabled(on, appName) {
  const next = Boolean(on);
  if (next === enabled) return next ? startFieldTest(appName) : Promise.resolve(null);
  try {
    if (next) {
      globalThis.localStorage?.setItem(FIELD_TEST_KEY, "1");
      globalThis.localStorage?.setItem(FIELD_TEST_USED_KEY, "1");
    } else globalThis.localStorage?.removeItem(FIELD_TEST_KEY);
  } catch { /* private mode: the switch lasts for this page only */ }
  if (next) {
    enabled = true;
    fieldLog("field.on", {});
    notify();
    return startFieldTest(appName);
  }
  fieldLog("field.off", {});
  const active = recorder;
  recorder = null;
  early = [];
  enabled = false;
  notify();
  return active ? active.stop().then(() => null, () => null) : Promise.resolve(null);
}

/** True once field test mode has been on in this browser (the log may hold events to export). */
export function fieldTestUsed() {
  if (enabled) return true;
  try { return globalThis.localStorage?.getItem(FIELD_TEST_USED_KEY) === "1"; } catch { return false; }
}

/** The recorder for this page, if it is running (the field log screen uses it to flush first). */
export function activeFieldRecorder() {
  return recorder;
}
