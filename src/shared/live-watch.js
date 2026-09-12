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

function watchSearchParams(search) {
  return search instanceof URLSearchParams
    ? search
    : new URLSearchParams(String(search || "").replace(/^\?/, ""));
}

function sanitizedRoundCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isWatchFlag(value) {
  const flag = String(value || "").toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function isLiveWatchRequest(search) {
  const params = watchSearchParams(search);
  const raw = params.get("watch") || "";
  if (isWatchFlag(raw)) return true;
  // `?watch=6CDNME` (no round=) is a spectator link — casual codes are 4–12 chars.
  const watchCode = sanitizedRoundCode(raw);
  const round = sanitizedRoundCode(params.get("round"));
  return !round && watchCode.length >= 4;
}

export function liveRoundCodeFromSearch(search) {
  const params = watchSearchParams(search);
  const round = sanitizedRoundCode(params.get("round"));
  if (round) return round;
  const raw = params.get("watch") || "";
  if (isWatchFlag(raw)) return "";
  const watchCode = sanitizedRoundCode(raw);
  return watchCode.length >= 4 ? watchCode : "";
}
