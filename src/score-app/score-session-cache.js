const MINE_TTL_MS = 24 * 60 * 60 * 1000;

function tokenTag(token) {
  const value = String(token || "").trim();
  return value ? value.slice(-16) : "";
}

export function mineCacheKey(roundCode, eventId, token) {
  const id = String(roundCode || eventId || "").trim();
  if (!id) return "";
  const who = tokenTag(token);
  return who ? "gvdg_score_mine:" + id + ":" + who : "gvdg_score_mine:" + id;
}

export function writeMineCache(key, data, storage = globalThis.localStorage) {
  if (!key || !data || data.cardId == null) return false;
  if (!Array.isArray(data.cardmates) || !data.cardmates.length) return false;
  if (!Array.isArray(data.holes) || !data.holes.length) return false;
  try {
    storage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
    return true;
  } catch {
    return false;
  }
}

export function readMineCache(key, storage = globalThis.localStorage, now = Date.now()) {
  if (!key) return null;
  try {
    const parsed = JSON.parse(storage.getItem(key) || "");
    const data = parsed && parsed.data;
    if (!data || data.cardId == null) return null;
    if (!Array.isArray(data.cardmates) || !data.cardmates.length) return null;
    if (!Array.isArray(data.holes) || !data.holes.length) return null;
    const savedAt = Number(parsed.savedAt);
    if (!Number.isFinite(savedAt) || now - savedAt > MINE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

export function isTransientMineFailure(result) {
  if (!result) return true;
  if (result.neterr) return true;
  const status = Number(result.status);
  return status === 0 || status >= 500;
}
