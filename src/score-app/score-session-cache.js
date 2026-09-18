export function mineCacheKey(roundCode, eventId) {
  const id = String(roundCode || eventId || "").trim();
  return id ? "gvdg_score_mine:" + id : "";
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

export function readMineCache(key, storage = globalThis.localStorage) {
  if (!key) return null;
  try {
    const parsed = JSON.parse(storage.getItem(key) || "");
    const data = parsed && parsed.data;
    if (!data || data.cardId == null) return null;
    if (!Array.isArray(data.cardmates) || !data.cardmates.length) return null;
    if (!Array.isArray(data.holes) || !data.holes.length) return null;
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
