import { eventClubCalendarDay, parseClubInstant } from "./events-model.js";

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function ymd(year, month, day) {
  return `${year}${pad(month)}${pad(day)}`;
}

function addDays(stamp, days) {
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function icsEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function icsStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function slug(value) {
  return String(value || "event")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "event";
}

function sceneRange(date) {
  const match = String(date || "").match(/\b([A-Za-z]{3})\s+(\d{1,2})(?:-(\d{1,2}))?,\s+(\d{4})\b/);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const startDay = Number(match[2]);
  const endDay = match[3] ? Number(match[3]) : startDay;
  const year = Number(match[4]);
  if (!month || startDay < 1 || endDay < startDay || endDay > 31) return null;
  const start = ymd(year, month, startDay);
  return { start, end: addDays(ymd(year, month, endDay), 1) };
}

function allDayItem({ uid, summary, location, description, url, start, end }) {
  if (!start || !end || !summary) return null;
  return {
    uid,
    summary,
    location: location || "",
    description: description || "",
    url: url || "",
    start,
    end,
    allDay: true,
    filename: `${slug(summary)}.ics`,
  };
}

export function calendarEventFromPdga(event) {
  const range = sceneRange(event && event.date);
  if (!range || !event?.name) return null;
  const where = [event.course, event.place].filter(Boolean).join(", ");
  const url = String(event.url || "");
  return allDayItem({
    uid: `gvdg-pdga-${slug(url || event.name)}@gvdgclub.com`,
    summary: event.name,
    location: where,
    description: url ? `Register: ${url}` : "",
    url,
    start: range.start,
    end: range.end,
  });
}

export function calendarEventFromClub(event) {
  if (!event || !event.name) return null;
  const day = eventClubCalendarDay(event);
  if (!day) return null;
  const start = day.replace(/-/g, "");
  const where = [event.course_name, event.layout_name].filter(Boolean).join(" · ");
  const startsAt = event.starts_at || event.event_starts_at || "";
  const timed = startsAt && !/^\d{4}-\d{2}-\d{2}$/.test(String(startsAt)) ? parseClubInstant(startsAt) : null;
  if (timed && !Number.isNaN(timed.getTime())) {
    const end = new Date(timed.getTime() + 4 * 60 * 60 * 1000);
    return {
      uid: `gvdg-club-${slug(event.id || event.name)}@gvdgclub.com`,
      summary: event.name,
      location: where,
      description: "GVDG club event",
      url: "",
      start: icsStamp(timed),
      end: icsStamp(end),
      allDay: false,
      filename: `${slug(event.name)}.ics`,
    };
  }
  return allDayItem({
    uid: `gvdg-club-${slug(event.id || event.name)}@gvdgclub.com`,
    summary: event.name,
    location: where,
    description: "GVDG club event",
    url: "",
    start,
    end: addDays(start, 1),
  });
}

export function eventCalendarIcs(item, now = new Date()) {
  if (!item) return "";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GVDG//Club//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsEscape(item.uid)}`,
    `DTSTAMP:${icsStamp(now)}`,
    item.allDay ? `DTSTART;VALUE=DATE:${item.start}` : `DTSTART:${item.start}`,
    item.allDay ? `DTEND;VALUE=DATE:${item.end}` : `DTEND:${item.end}`,
    `SUMMARY:${icsEscape(item.summary)}`,
  ];
  if (item.location) lines.push(`LOCATION:${icsEscape(item.location)}`);
  if (item.description) lines.push(`DESCRIPTION:${icsEscape(item.description)}`);
  if (item.url) lines.push(`URL:${icsEscape(item.url)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

export function downloadCalendarFile(item) {
  if (!item || typeof document === "undefined") return;
  const blob = new Blob([eventCalendarIcs(item)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = item.filename || "event.ics";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
