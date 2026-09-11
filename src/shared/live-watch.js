export function liveWatchHref({ eventId, roundCode } = {}) {
  const round = String(roundCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (round) return `score.html?round=${encodeURIComponent(round)}&watch=1`;
  const event = String(eventId == null ? "" : eventId).replace(/[^0-9]/g, "");
  if (event) return `score.html?event=${encodeURIComponent(event)}&watch=1`;
  return "";
}

export function liveScoreHref({ eventId, roundCode, guestToken } = {}) {
  const round = String(roundCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (round) return `score.html?round=${encodeURIComponent(round)}`;
  const event = String(eventId == null ? "" : eventId).replace(/[^0-9]/g, "");
  if (!event) return "";
  let href = `score.html?event=${encodeURIComponent(event)}`;
  const token = String(guestToken || "").trim();
  if (token) href += `&gt=${encodeURIComponent(token)}`;
  return href;
}

export function isLiveWatchRequest(search) {
  const params = search instanceof URLSearchParams
    ? search
    : new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const flag = String(params.get("watch") || "").toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}
