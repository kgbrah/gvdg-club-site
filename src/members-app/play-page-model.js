import { liveWatchHref } from "../shared/live-watch.js";

function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function roundRatingOf(row) {
  if (!row || row.stroke === false) return null;
  const match = row.match_result;
  if (match != null && String(match).trim() && String(match).trim() !== "null") return null;
  const stored = numberOrNull(row.round_rating);
  if (stored != null) return Math.round(stored);
  const rating = numberOrNull(row.rating);
  return rating == null ? null : Math.round(rating);
}

export function relClass(delta) {
  if (delta == null) return "";
  return delta < 0 ? "under" : delta > 0 ? "over" : "even";
}

function mixSummary(raw) {
  let row = raw && raw.breakdown;
  if (typeof row === "string") {
    try { row = JSON.parse(row); } catch { row = null; }
  }
  if (!row || typeof row !== "object") return "";
  const bits = [
    ["aces", "ace"],
    ["eagles", "eagle"],
    ["birdies", "birdie"],
    ["pars", "par"],
    ["bogeys", "bogey"],
    ["doubles_plus", "dbl+"],
  ];
  return bits.flatMap(([key, label]) => {
    const n = Number(row[key]);
    if (!Number.isFinite(n) || n <= 0) return [];
    const word = n === 1 || label === "dbl+" ? label : label + "s";
    return [n + " " + word];
  }).join(" · ");
}

export function publicCasualRound(row) {
  const code = String(row?.round_code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) return null;
  const title = String(row.course_name || "").trim() || ("Casual round " + code);
  return {
    kind: "casual",
    code,
    title,
    layout: String(row.layout_name || "").trim(),
    when: row.finalized_at || row.created_at || "",
    total: numberOrNull(row.total),
    toPar: numberOrNull(row.to_par),
    place: numberOrNull(row.place),
    rating: roundRatingOf(row),
    href: liveWatchHref({ roundCode: code }),
    mix: mixSummary(row),
    sort: Date.parse(row.finalized_at || row.created_at || "") || 0,
  };
}

export function recentPlayRounds(casual, limit = 8) {
  const seen = new Set();
  const rows = [];
  for (const raw of Array.isArray(casual) ? casual : []) {
    const row = publicCasualRound(raw);
    if (!row || seen.has(row.code)) continue;
    seen.add(row.code);
    rows.push(row);
  }
  return rows.sort((a, b) => (b.sort || 0) - (a.sort || 0)).slice(0, limit);
}

const UDISC_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const UDISC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatUdiscWhen(playedAt) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(playedAt || ""));
  if (!match) return "";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return "";
  const day = UDISC_WEEKDAYS[date.getDay()] + ", " + UDISC_MONTHS[date.getMonth()] + " " + date.getDate() + ", " + match[1];
  if (match[4] === "00" && match[5] === "00") return day;
  const hour = Number(match[4]);
  const minute = match[5];
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 || 12;
  return day + " · " + h12 + ":" + minute + " " + suffix;
}

export function latestHomeRound(results, casual) {
  const events = (Array.isArray(results) ? results : []).slice().sort((left, right) =>
    String(right && right.event_date || "").localeCompare(String(left && left.event_date || "")),
  );
  const event = events[0] || null;
  const play = recentPlayRounds(casual, 1)[0] || null;
  const eventTime = event ? Date.parse(event.event_date || "") || 0 : 0;
  const playTime = play ? play.sort || 0 : 0;
  if (play && (!event || playTime >= eventTime)) {
    return {
      kind: "casual",
      title: play.title,
      when: play.when,
      layout: play.layout,
      href: play.href,
      toPar: play.toPar,
      total: play.total,
      place: play.place,
      rating: play.rating,
      mix: play.mix,
    };
  }
  if (!event) return null;
  const eventId = event.event_id;
  return {
    kind: "event",
    title: event.event_name || "Club event",
    when: event.event_date || "",
    layout: "",
    href: eventId != null ? `events.html#event/${encodeURIComponent(eventId)}` : "events.html",
    toPar: numberOrNull(event.to_par),
    total: numberOrNull(event.total),
    place: numberOrNull(event.place),
    rating: roundRatingOf(event),
    mix: "",
  };
}
