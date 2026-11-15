export const RANGE_LOCK_TAG = "gvdg-range";
export const RANGE_LOCK_MOVE_FT = 8;
export const RANGE_LOCK_KEY = "gvdg.rangeLock";

export function rangeLockNote({ hud, hole, par, courseName } = {}) {
  if (!hud || hud.mode !== "remaining" || !Number.isFinite(hud.ft)) return null;
  const title = hud.ft + " ft";
  const bits = [];
  if (hud.circle) bits.push(hud.circle);
  else bits.push("to basket");
  if (Number.isInteger(hole) && hole > 0) {
    bits.push("Hole " + hole + (Number.isFinite(par) && par > 0 ? " · par " + par : ""));
  }
  const course = String(courseName || "").trim();
  if (course) bits.push(course);
  return { title, body: bits.join(" · "), tag: RANGE_LOCK_TAG, ft: hud.ft, hole: hole || null, circle: hud.circle || null };
}

export function rangeLockChanged(prev, next) {
  if (!next) return Boolean(prev);
  if (!prev) return true;
  if (prev.hole !== next.hole || prev.circle !== next.circle) return true;
  if (!Number.isFinite(prev.ft) || !Number.isFinite(next.ft)) return prev.title !== next.title;
  return Math.abs(prev.ft - next.ft) >= RANGE_LOCK_MOVE_FT;
}

export function readRangeLockEnabled(storage) {
  try {
    return Boolean(storage && storage.getItem(RANGE_LOCK_KEY) === "1");
  } catch {
    return false;
  }
}

export function writeRangeLockEnabled(storage, on) {
  try {
    if (storage) storage.setItem(RANGE_LOCK_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

export async function postRangeLock(note) {
  if (!note || typeof navigator === "undefined" || !navigator.serviceWorker) return;
  const reg = await navigator.serviceWorker.ready;
  if (!reg || typeof reg.showNotification !== "function") return;
  const origin = (typeof location !== "undefined" && location.origin) || "";
  await reg.showNotification(note.title, {
    body: note.body,
    tag: note.tag || RANGE_LOCK_TAG,
    silent: true,
    renotify: false,
    icon: origin + "/img/icons/app-icon-192.png",
    badge: origin + "/img/icons/notification-badge.png",
    data: { kind: "range", url: "/score.html" },
  });
}

export async function closeRangeLock() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  const reg = await navigator.serviceWorker.ready;
  if (!reg || typeof reg.getNotifications !== "function") return;
  const notes = await reg.getNotifications({ tag: RANGE_LOCK_TAG });
  for (const note of notes) note.close();
}
