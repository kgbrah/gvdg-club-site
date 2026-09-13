import { CLUB_TIME_ZONE, clubCivilInstant, parseEventDate } from "../shared/events-model.js";

export function dollars(cents) {
  const value = Number(cents || 0);
  const abs = Math.abs(value);
  return `${value < 0 ? "-" : ""}$${(abs / 100).toLocaleString(undefined, { minimumFractionDigits: abs % 100 ? 2 : 0 })}`;
}

export function formatEventDay(value) {
  if (!value) return "";
  const raw = String(value).trim();
  const date = clubCivilInstant(raw) || parseEventDate(raw);
  if (!date) return raw;
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: CLUB_TIME_ZONE,
  });
}

export function formatRatingDate(value) {
  const raw = String(value || "");
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function shortDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  });
}

export function formatToPar(value) {
  const score = value || 0;
  return score === 0 ? "E" : score > 0 ? `+${score}` : String(score);
}

export function plural(count, one, many) {
  return count === 1 ? one : many;
}
