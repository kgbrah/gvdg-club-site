// Presentation-only helpers for the public events pages (pure, unit-tested).
import { clubCalendarDay, clubToday, eventClubCalendarDay, formatClubClock, parseClubInstant } from "./events-model.js";

const DAY_MS = 86400000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function civilMs(day) {
  const match = String(day || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function clubClock(raw) {
  if (!raw || /^\d{4}-\d{2}-\d{2}$/.test(String(raw).trim())) return "";
  const date = parseClubInstant(raw);
  if (!date) return "";
  const text = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  return text.replace(":00", "");
}

/** "Today · 3 PM", "Tomorrow", "This Sunday · 3 PM", "Next Saturday", else "" (caller shows the date). */
export function relativeEventWhen(event, now = new Date()) {
  const target = civilMs(eventClubCalendarDay(event));
  const base = civilMs(clubToday(now));
  if (target == null || base == null) return "";
  const diff = Math.round((target - base) / DAY_MS);
  const weekday = WEEKDAYS[new Date(target).getUTCDay()];
  let label = "";
  if (diff === 0) label = "Today";
  else if (diff === 1) label = "Tomorrow";
  else if (diff > 1 && diff < 7) label = `This ${weekday}`;
  else if (diff >= 7 && diff < 14) label = `Next ${weekday}`;
  else return "";
  const clock = clubClock(event && event.starts_at);
  return clock ? `${label} · ${clock}` : label;
}

/** Countdown parts to the event start (or noon of its club day). Null when past/unknown. */
export function countdownParts(event, now = new Date()) {
  const raw = event && event.starts_at;
  let target = raw ? (parseClubInstant(raw)?.getTime() ?? NaN) : NaN;
  if (Number.isNaN(target)) {
    const day = civilMs(eventClubCalendarDay(event));
    if (day == null) return null;
    target = day + 17 * 3600000;
  }
  const ms = target - now.getTime();
  if (!(ms > 0)) return null;
  const minutes = Math.floor(ms / 60000);
  return { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60), minutes: minutes % 60 };
}

export function countdownLabel(parts) {
  if (!parts) return "";
  if (parts.days >= 1) return `${parts.days} day${parts.days === 1 ? "" : "s"}`;
  if (parts.hours >= 1) return `${parts.hours} h ${parts.minutes} min`;
  return `${Math.max(1, parts.minutes)} min`;
}

/** Date-block parts for a card: { month: "NOV", day: "15", weekday: "Sun" }. */
export function dateBlock(event) {
  const target = civilMs(eventClubCalendarDay(event));
  if (target == null) return null;
  const date = new Date(target);
  return {
    month: date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase(),
    day: String(date.getUTCDate()),
    weekday: date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
  };
}

/** Deep link to one event page, for sharing. */
export function eventShareUrl(origin, pathname, id) {
  return `${origin}${pathname}#event/${encodeURIComponent(String(id))}`;
}

/** One human date for every card and row: "Sun, Nov 22" (this year) or "Oct 12, 2026".
 *  `year: true` forces the year form (minutes, archives). Never returns a raw ISO date. */
export function humanDate(raw, { year = false, now = new Date() } = {}) {
  const day = clubCalendarDay(raw);
  const ms = civilMs(day);
  if (ms == null) return "";
  const date = new Date(ms);
  const sameYear = day.slice(0, 4) === clubToday(now).slice(0, 4);
  if (year || !sameYear) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Single "when" line for a card: relative label with time when near, else human date + clock. */
export function whenLine(event, now = new Date()) {
  const relative = relativeEventWhen(event, now);
  if (relative) return relative;
  const day = humanDate(eventClubCalendarDay(event), { now });
  if (!day) return "Date TBD";
  const clock = formatClubClock(event && event.starts_at);
  return clock ? `${day} \u00b7 ${clock}` : day;
}
