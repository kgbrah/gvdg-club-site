import {
  clubToday,
  eventClubCalendarDay,
  formatClubClock,
  formatEventDate,
  isPastClubCalendarEvent,
} from "../shared/events-model.js";

export function normalizeAdminEvent(event) {
  const source = event && typeof event === "object" ? event : {};
  const status = typeof source.status === "string" && source.status ? source.status : "scheduled";
  return {
    source,
    courseName: typeof source.course_name === "string" ? source.course_name : "",
    date: typeof source.date === "string" ? source.date : "",
    id: source.id == null ? "" : String(source.id),
    layoutName: typeof source.layout_name === "string" ? source.layout_name : "",
    name: typeof source.name === "string" && source.name ? source.name : "Untitled event",
    startsAt: source.starts_at == null ? "" : String(source.starts_at),
    status,
  };
}

function byClubDay(left, right) {
  const dayA = eventClubCalendarDay(left.source) || left.date || "";
  const dayB = eventClubCalendarDay(right.source) || right.date || "";
  if (dayA !== dayB) return dayA.localeCompare(dayB);
  return String(left.startsAt || "").localeCompare(String(right.startsAt || ""));
}

export function bucketAdminEvents(events) {
  const live = [];
  const upcoming = [];
  const past = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event.status === "live") live.push(event);
    else if (event.status === "final" || event.status === "cancelled" || isPastClubCalendarEvent(event.source)) past.push(event);
    else upcoming.push(event);
  }
  live.sort(byClubDay);
  upcoming.sort(byClubDay);
  past.sort((left, right) => byClubDay(right, left));
  return { live, upcoming, past };
}

function onClubDay(event, day) {
  return eventClubCalendarDay(event.source) === day;
}

export function pickTodayEvent(events, now = new Date()) {
  const { live, upcoming } = bucketAdminEvents(events);
  const today = clubToday(now);
  return live.find((event) => onClubDay(event, today))
    || live[0]
    || upcoming.find((event) => onClubDay(event, today))
    || upcoming[0]
    || null;
}

export function formatAdminEventWhen(event) {
  const day = formatEventDate(event?.date);
  const clock = formatClubClock(event?.startsAt);
  if (clock && day && day !== "Date TBD") return `${day} · ${clock}`;
  return clock || day || "";
}

export function formatAdminEventPlace(event) {
  return [event?.courseName, event?.layoutName].filter(Boolean).join(" · ");
}
