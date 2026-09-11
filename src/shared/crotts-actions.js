const ALLOWED_PAGES = new Set([
  "events.html",
  "gvdg-members.html",
  "index.html",
  "pro-shop.html",
  "ryder-cup.html",
  "score.html",
]);

const CLUB_MAIL = "mailto:greenvillediscgolf@gmail.com";

function eventId(value) {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

export function sanitizeCrottsHref(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.toLowerCase() === CLUB_MAIL) return CLUB_MAIL;
  if (/^[a-z]+:/i.test(raw) || raw.startsWith("//") || raw.includes("\\") || raw.includes("..")) return "";

  const hashIndex = raw.indexOf("#");
  const queryIndex = raw.indexOf("?");
  const pathEnd = [hashIndex, queryIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? raw.length;
  const path = raw.slice(0, pathEnd);
  if (!ALLOWED_PAGES.has(path)) return "";

  const query = queryIndex >= 0 ? raw.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined) : "";
  const hash = hashIndex >= 0 ? raw.slice(hashIndex + 1) : "";

  if (path === "score.html") {
    if (!query) return "score.html";
    const params = new URLSearchParams(query);
    const keys = [...params.keys()];
    if (keys.some((key) => key !== "event" && key !== "watch")) return "";
    const event = eventId(params.get("event"));
    const watch = String(params.get("watch") || "");
    if (params.has("event") && !event) return "";
    if (params.has("watch") && watch !== "1") return "";
    if (event && watch === "1") return `score.html?event=${event}&watch=1`;
    if (event) return `score.html?event=${event}`;
    return "score.html";
  }

  if (path === "events.html") {
    const match = hash.match(/^event\/(\d+)$/);
    return match ? `events.html#event/${match[1]}` : "events.html";
  }

  if (path === "gvdg-members.html") {
    return hash.toLowerCase() === "apply" ? "gvdg-members.html#apply" : "gvdg-members.html";
  }

  if (query || hash) return "";
  return path;
}

export function sanitizeCrottsActions(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  const seen = new Set();
  for (const row of actions) {
    if (!row || typeof row !== "object") continue;
    const href = sanitizeCrottsHref(row.href);
    const label = String(row.label ?? "").trim().slice(0, 80);
    const id = String(row.id ?? "").trim().slice(0, 40);
    if (!href || !label || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, id: id || href, label });
    if (out.length >= 4) break;
  }
  return out;
}
