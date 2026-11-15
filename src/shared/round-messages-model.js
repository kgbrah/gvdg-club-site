export const ROUND_MESSAGE_MAX = 280;

export function normalizeRoundMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  const authorName = typeof (raw.authorName || raw.author_name) === "string" ? String(raw.authorName || raw.author_name).trim() : "";
  if (!body || !authorName) return null;
  const toName = typeof (raw.toName || raw.to_name) === "string" ? String(raw.toName || raw.to_name).trim() : "";
  return {
    authorName,
    body,
    createdAt: raw.createdAt || raw.created_at || "",
    id: raw.id == null ? "" : String(raw.id),
    side: raw.side === "card" ? "card" : "watch",
    toName,
  };
}

export function messageSortId(message) {
  const id = Number(message && message.id);
  return Number.isFinite(id) ? id : 0;
}

/** Messages the other side sent that this viewer has not opened. Card viewers only see watcher messages. */
export function unseenRoundMessages(messages, seenId, viewer) {
  const seen = Number(seenId) || 0;
  const want = viewer === "watch" ? "card" : "watch";
  return (Array.isArray(messages) ? messages : []).filter((message) => {
    if (!message || message.side !== want) return false;
    return messageSortId(message) > seen;
  });
}

export function roundMessageNotice(message) {
  if (!message) return null;
  const who = String(message.authorName || "").trim() || "Someone";
  const aimed = message.toName ? " to " + message.toName : "";
  return { title: who + aimed, body: String(message.body || "") };
}

export function mergeRoundMessages(current, incoming) {
  const byId = new Map();
  for (const row of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const message = normalizeRoundMessage(row);
    if (!message) continue;
    byId.set(message.id || message.createdAt + ":" + message.authorName + ":" + message.body, message);
  }
  return [...byId.values()];
}
