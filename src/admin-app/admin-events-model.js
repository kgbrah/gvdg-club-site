import {
  clubToday,
  displayEventTitle,
  eventClubCalendarDay,
  formatClubClock,
  formatEventDate,
  isPastClubCalendarEvent,
} from "../shared/events-model.js";

export { displayEventTitle };

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
    type: typeof source.type === "string" ? source.type : "",
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

export function eventBucket(type) {
  if (type === "fundraiser") return "fundraiser";
  if (type === "meeting") return "meeting";
  return "rounds";
}

function dated(value) {
  return String(value || "").slice(0, 10);
}

export function calendarEntries(events, extras = {}, today = "") {
  const rows = (Array.isArray(events) ? events : []).map((event) => ({
    ...event,
    bucket: eventBucket(event.type),
    kind: "event",
  }));
  for (const fundraiser of Array.isArray(extras.fundraisers) ? extras.fundraisers : []) {
    const day = dated(fundraiser.starts_at || fundraiser.startsAt);
    const active = fundraiser.status == null || fundraiser.status === "active";
    rows.push({
      bucket: "fundraiser",
      courseName: "",
      date: day,
      id: `campaign-${fundraiser.id}`,
      kind: "campaign",
      layoutName: "",
      name: fundraiser.title || "Fundraiser",
      source: { ...fundraiser, date: day, status: active ? "scheduled" : "final" },
      startsAt: fundraiser.starts_at || "",
      status: active ? "scheduled" : "final",
      type: "fundraiser",
    });
  }
  for (const meeting of Array.isArray(extras.meetings) ? extras.meetings : []) {
    const day = dated(meeting.date);
    const past = Boolean(day && today && day < today);
    rows.push({
      bucket: "meeting",
      courseName: "",
      date: day,
      id: `minutes-${meeting.id}`,
      kind: "minutes",
      layoutName: "",
      name: meeting.title || "Meeting",
      source: { ...meeting, status: past ? "final" : "scheduled" },
      startsAt: "",
      status: past ? "final" : "scheduled",
      type: "meeting",
    });
  }
  return rows;
}
