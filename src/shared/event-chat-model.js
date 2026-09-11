export const EVENT_CHAT_BODY_MAX = 280;
export const EVENT_CHAT_NAME_MAX = 32;

export function cleanChatText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeChatMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const body = cleanChatText(raw.body, EVENT_CHAT_BODY_MAX);
  if (!body) return null;
  const author = cleanChatText(raw.author_name ?? raw.authorName, EVENT_CHAT_NAME_MAX) || "Fan";
  return {
    authorName: author,
    body,
    createdAt: raw.created_at ?? raw.createdAt ?? "",
    id: raw.id == null ? "" : String(raw.id),
  };
}

export function mergeChatMessages(current, incoming) {
  const byId = new Map();
  for (const row of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const message = row && row.body ? row : normalizeChatMessage(row);
    if (!message) continue;
    const key = message.id || message.createdAt + ":" + message.authorName + ":" + message.body;
    byId.set(key, message);
  }
  return [...byId.values()];
}
