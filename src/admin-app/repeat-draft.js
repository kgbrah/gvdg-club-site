const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value) {
  return String(value).padStart(2, "0");
}

export function addCalendarDays(dateStr, days) {
  const match = DATE.exec(String(dateStr || ""));
  if (!match) return "";
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export function calendarDaysBetween(from, to) {
  if (!DATE.test(String(from || "")) || !DATE.test(String(to || ""))) return 0;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86400000);
}

export function nextWeeklyDate(dateStr, today) {
  if (!DATE.test(String(dateStr || "")) || !DATE.test(String(today || ""))) return "";
  let days = 7;
  let next = addCalendarDays(dateStr, days);
  while (next && next <= today) {
    days += 7;
    next = addCalendarDays(dateStr, days);
    if (days > 370) return "";
  }
  return next;
}

export function shiftWallByDays(value, days) {
  const text = String(value || "");
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(.*)$/);
  if (!match || !days) return text;
  return addCalendarDays(match[1], days) + match[2];
}

export function minusWallMinutes(wall, minutes) {
  const match = String(wall || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return "";
  const next = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]) - minutes,
  ));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T${pad(next.getUTCHours())}:${pad(next.getUTCMinutes())}`;
}

function eventDay(event) {
  return String(event && event.date || "").slice(0, 10);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_DAY = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(\.?)(\s+)(\d{1,2})(st|nd|rd|th)?(,?\s+\d{4})?\b/gi;
const NUMERIC_DAY = /\b(\d{1,2})\/(\d{1,2})(\/(?:\d{4}|\d{2}))?\b/g;

function ordinal(day) {
  if (day % 100 >= 11 && day % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][day % 10] || "th";
}

function monthIndex(token) {
  const lower = token.toLowerCase();
  return MONTHS.findIndex((month) => month.startsWith(lower.slice(0, 3)));
}

/** Write a month the way the original was written: "Nov", "November", "NOV", "nov". */
function sameStyleMonth(original, index) {
  const full = MONTHS[index];
  const word = original.length > 3 && !/^sept$/i.test(original) ? full : full === "september" && /^sept$/i.test(original) ? "sept" : full.slice(0, 3);
  if (original === original.toUpperCase()) return word.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

/**
 * An event name that names its own date ("Sunday Baggers Nov 15th", "League night 11/15") renamed for the new date
 * ("Sunday Baggers Nov 22nd", "League night 11/22"), written the same way. Names without that date are unchanged.
 */
export function renameForDate(name, fromDate, toDate) {
  const text = String(name || "");
  const from = DATE.exec(String(fromDate || ""));
  const to = DATE.exec(String(toDate || ""));
  if (!from || !to || fromDate === toDate) return text;
  const [fromMonth, fromDay] = [Number(from[2]) - 1, Number(from[3])];
  const [toYear, toMonth, toDay] = [to[1], Number(to[2]) - 1, Number(to[3])];
  let renamed = text.replace(MONTH_DAY, (all, month, dot, gap, day, suffix, year) => {
    if (monthIndex(month) !== fromMonth || Number(day) !== fromDay) return all;
    const yearPart = year ? year.replace(/\d{4}/, toYear) : "";
    return sameStyleMonth(month, toMonth) + dot + gap + toDay + (suffix ? ordinal(toDay) : "") + yearPart;
  });
  if (renamed !== text) return renamed;
  renamed = text.replace(NUMERIC_DAY, (all, month, day, year) => {
    if (Number(month) - 1 !== fromMonth || Number(day) !== fromDay) return all;
    const yearPart = year ? "/" + (year.length === 5 ? toYear : toYear.slice(2)) : "";
    return `${toMonth + 1}/${toDay}${yearPart}`;
  });
  return renamed;
}

/** "Sunday Baggers" for "Sunday Baggers - Sunday Baggers Nov 15th": the name without its date (and a doubled name). */
export function seriesName(name) {
  const stripped = String(name || "").replace(MONTH_DAY, " ").replace(NUMERIC_DAY, " ")
    .replace(/\s+/g, " ").replace(/^[\s\-–—:,|#]+|[\s\-–—:,|#]+$/g, "").trim();
  const halves = stripped.split(/\s+[-–—]\s+/);
  return halves.length === 2 && halves[0].toLowerCase() === halves[1].toLowerCase() ? halves[0] : stripped;
}

/** Rounds of the same weekly league: its league, else the same name once the dates are taken out. */
function seriesKey(event) {
  if (event && event.league_id != null && event.league_id !== "") return "league:" + event.league_id;
  return "name:" + seriesName(event && event.name).toLowerCase();
}

function weekdayLabel(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC", weekday: "short" });
}

export function pickRepeatEvent(events, today) {
  const rows = (Array.isArray(events) ? events : []).filter((event) => {
    if (!event || event.status === "cancelled") return false;
    return DATE.test(eventDay(event));
  });
  const past = rows
    .filter((event) => eventDay(event) <= today)
    .sort((left, right) => eventDay(right).localeCompare(eventDay(left)) || String(right.starts_at || "").localeCompare(String(left.starts_at || "")));
  const future = rows
    .filter((event) => eventDay(event) > today)
    .sort((left, right) => eventDay(left).localeCompare(eventDay(right)));
  const pool = past.length ? past : future;
  return pool.find((event) => event.type === "league_round") || pool[0] || null;
}

export function repeatLabel(event, nextDate) {
  const name = event && event.name ? String(event.name) : "last event";
  if (!DATE.test(String(nextDate || ""))) return `Same as ${name}`;
  const when = new Date(`${nextDate}T12:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return `Same as ${name} · ${when}`;
}

function isWeeklyLeague(event) {
  if (!event || event.type !== "league_round" || event.status === "cancelled") return false;
  const name = String(event.name || "").trim();
  if (!name || /\bvs\.?\b/i.test(name) || /^#?\d+\b/.test(name)) return false;
  return DATE.test(eventDay(event));
}

/**
 * "Schedule Sunday Baggers for Sun, Nov 22": offered on Today when a weekly league's latest round has been played and
 * nothing of that league is on the calendar after today. One tap saves next week's round (its name carries the new
 * date). A league already scheduled ahead (even with a week skipped) is left alone.
 */
export function nextWeekOffer(events, today) {
  const all = (Array.isArray(events) ? events : []).filter((event) => event && event.status !== "cancelled");
  const source = pickRepeatEvent(all.filter(isWeeklyLeague), today);
  const day = source ? eventDay(source) : "";
  if (!source || !DATE.test(day) || day > String(today || "")) return null;
  const key = seriesKey(source);
  if (all.some((event) => seriesKey(event) === key && eventDay(event) > String(today || ""))) return null;
  const nextDate = nextWeeklyDate(day, today);
  if (!nextDate) return null;
  return { label: `Schedule ${seriesName(source.name) || source.name} for ${weekdayLabel(nextDate)}`, nextDate, source };
}
