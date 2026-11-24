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
  // "Sep 13 – Dec 20, 2026" or "Dec 31, 2026 – Jan 1, 2027": a span across months (a PDGA league).
  const span = String(date || "").match(/\b([A-Za-z]{3})\s+(\d{1,2})(?:,\s+(\d{4}))?\s+[–-]\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\b/);
  if (span) {
    const startMonth = MONTHS[span[1].toLowerCase()];
    const endMonth = MONTHS[span[4].toLowerCase()];
    const endYear = Number(span[6]);
    const startYear = span[3] ? Number(span[3]) : endYear;
    if (!startMonth || !endMonth) return null;
    const start = ymd(startYear, startMonth, Number(span[2]));
    const last = ymd(endYear, endMonth, Number(span[5]));
    return start <= last ? { start, end: addDays(last, 1) } : null;
  }
  const match = String(date || "").match(/\b([A-Za-z]{3})\s+(\d{1,2})(?:[–-](\d{1,2}))?,\s+(\d{4})\b/);
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

/** A PDGA event a club member is registered for (from /pdga-registrations: ISO start / end dates). */
export function calendarEventFromPdgaRegistration(event) {
  const start = String(event?.start || "");
  const end = String(event?.end || start);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !event?.name) return null;
  const url = String(event.url || "");
  return allDayItem({
    uid: `gvdg-pdga-${slug(String(event.eventId || event.name))}@gvdgclub.com`,
    summary: event.name,
    location: event.location || "",
    description: [event.division ? "Division: " + event.division : "", url ? "PDGA: " + url : ""].filter(Boolean).join("\n"),
    url,
    start: start.replace(/-/g, ""),
    end: addDays(end.replace(/-/g, ""), 1),
  });
}

/** Add-to-calendar item for an announced club workday. */
export function calendarEventFromWorkday(workday) {
  const start = String(workday?.workdayDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !workday?.title) return null;
  const stamp = start.replace(/-/g, "");
  return allDayItem({
    uid: `gvdg-workday-${workday.id || slug(workday.title)}@gvdgclub.com`,
    summary: workday.title,
    location: workday.locationName || "",
    description: [
      workday.startTime ? `Start: ${workday.startTime}` : "",
      workday.karmaReward ? `Reward: +${workday.karmaReward} karma` : "",
      workday.description || "",
    ].filter(Boolean).join("\n"),
    url: "https://gvdgclub.com/gvdg-members.html#home",
    start: stamp,
    end: addDays(stamp, 1),
  });
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 21, 2026", "Nov 21–22, 2026", "Sep 13 – Nov 29, 2026", "Dec 30, 2026 – Jan 2, 2027" from ISO dates. */
export function dateRangeText(start, end = start) {
  const read = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
  };
  const a = read(start);
  const b = read(end) || a;
  if (!a) return "";
  const month = (date) => SHORT_MONTHS[date.month - 1] || "";
  if (a.year !== b.year) return `${month(a)} ${a.day}, ${a.year} – ${month(b)} ${b.day}, ${b.year}`;
  if (a.month !== b.month) return `${month(a)} ${a.day} – ${month(b)} ${b.day}, ${b.year}`;
  if (a.day !== b.day) return `${month(a)} ${a.day}–${b.day}, ${a.year}`;
  return `${month(a)} ${a.day}, ${a.year}`;
}

/** Google Calendar's "add event" page, filled in (opens the Calendar app on Android phones that have it). */
export function googleCalendarUrl(item) {
  if (!item) return "";
  const params = new URLSearchParams({ action: "TEMPLATE", text: item.summary, dates: `${item.start}/${item.end}` });
  if (item.description) params.set("details", item.description);
  if (item.location) params.set("location", item.location);
  return "https://calendar.google.com/calendar/render?" + params.toString();
}

function outlookTime(stamp, allDay) {
  if (allDay) return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
}

/** Outlook.com's "new event" page, filled in. */
export function outlookCalendarUrl(item) {
  if (!item) return "";
  const params = new URLSearchParams({
    path: "/calendar/action/compose", rru: "addevent", subject: item.summary,
    startdt: outlookTime(item.start, item.allDay), enddt: outlookTime(item.end, item.allDay),
  });
  if (item.allDay) params.set("allday", "true");
  if (item.location) params.set("location", item.location);
  if (item.description) params.set("body", item.description);
  return "https://outlook.live.com/calendar/0/deeplink/compose?" + params.toString();
}

/** Which calendar to offer first: Apple's on iPhone / iPad / Mac, Google's everywhere else. */
export function preferredCalendar(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent) {
  return /iPhone|iPad|iPod|Macintosh/.test(String(userAgent)) ? "apple" : "google";
}
