import assert from "node:assert/strict";
import test from "node:test";

import { calendarEventFromClub, calendarEventFromPdga, calendarEventFromPdgaRegistration, eventCalendarIcs } from "../src/shared/event-calendar.js";

test("a PDGA event becomes an all-day calendar span", () => {
  const item = calendarEventFromPdga({
    name: "Raleigh Open",
    date: "Sat, Oct 3-4, 2026",
    course: "Kentwood",
    place: "Raleigh, NC",
    url: "https://www.discgolfscene.com/tournaments/Raleigh_Open",
  });
  assert.equal(item.allDay, true);
  assert.equal(item.start, "20261003");
  assert.equal(item.end, "20261005");
  const ics = eventCalendarIcs(item, new Date("2026-10-01T12:00:00Z"));
  assert.match(ics, /DTSTART;VALUE=DATE:20261003/);
  assert.match(ics, /DTEND;VALUE=DATE:20261005/);
  assert.match(ics, /SUMMARY:Raleigh Open/);
  assert.match(ics, /LOCATION:Kentwood\\, Raleigh\\, NC/);
  assert.match(ics, /Register: https:\/\/www.discgolfscene.com\/tournaments\/Raleigh_Open/);
});

test("a club event with a start time is a timed calendar entry", () => {
  const timed = calendarEventFromClub({
    id: 12,
    name: "Week 3",
    date: "2026-10-28",
    starts_at: "2026-10-28T22:00:00.000Z",
    course_name: "West Meadowbrook",
  });
  assert.equal(timed.allDay, false);
  assert.match(eventCalendarIcs(timed), /DTSTART:20261028T220000Z/);
  const day = calendarEventFromClub({ id: 4, name: "Flex", date: "2026-10-28" });
  assert.equal(day.allDay, true);
  assert.equal(day.start, "20261028");
  assert.equal(day.end, "20261029");
});

test("Add to calendar links: Google and Outlook pages filled in, Apple first on Apple devices", async () => {
  const model = await import("../src/shared/event-calendar.js");
  const allDay = model.calendarEventFromPdga({ name: "Greenville Open", date: "Nov 21-22, 2026", place: "Greenville, North Carolina", url: "https://www.pdga.com/tour/event/501" });
  assert.deepEqual({ start: allDay.start, end: allDay.end, allDay: allDay.allDay }, { start: "20261121", end: "20261123", allDay: true });
  const google = new URL(model.googleCalendarUrl(allDay));
  assert.equal(google.origin + google.pathname, "https://calendar.google.com/calendar/render");
  assert.deepEqual(Object.fromEntries(google.searchParams), {
    action: "TEMPLATE", text: "Greenville Open", dates: "20261121/20261123", details: allDay.description, location: allDay.location,
  });
  const outlook = new URL(model.outlookCalendarUrl(allDay));
  assert.equal(outlook.origin + outlook.pathname, "https://outlook.live.com/calendar/0/deeplink/compose");
  assert.deepEqual([outlook.searchParams.get("startdt"), outlook.searchParams.get("enddt"), outlook.searchParams.get("allday")], ["2026-11-21", "2026-11-23", "true"]);
  const timed = { summary: "Sunday Baggers", start: "20261122T190000Z", end: "20261122T230000Z", allDay: false };
  assert.equal(new URL(model.googleCalendarUrl(timed)).searchParams.get("dates"), "20261122T190000Z/20261122T230000Z");
  assert.equal(new URL(model.outlookCalendarUrl(timed)).searchParams.get("startdt"), "2026-11-22T19:00:00Z");

  assert.equal(model.preferredCalendar("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "apple");
  assert.equal(model.preferredCalendar("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"), "apple");
  assert.equal(model.preferredCalendar("Mozilla/5.0 (Linux; Android 15; Pixel 9)"), "google");

  assert.equal(model.dateRangeText("2026-11-21"), "Nov 21, 2026");
  assert.equal(model.dateRangeText("2026-11-21", "2026-11-22"), "Nov 21–22, 2026");
  assert.equal(model.dateRangeText("2026-09-13", "2026-11-29"), "Sep 13 – Nov 29, 2026");
  assert.equal(model.dateRangeText("2026-12-30", "2027-01-02"), "Dec 30, 2026 – Jan 2, 2027");
  assert.equal(model.dateRangeText(""), "");
});

test("a PDGA event spanning months (a league) goes on the calendar for its whole span", () => {
  const league = calendarEventFromPdga({ name: "Fall Sunday Singles", date: "Sep 13 – Dec 20, 2026", url: "https://www.pdga.com/tour/event/107952" });
  assert.equal(league.start, "20260913");
  assert.equal(league.end, "20261221");
  const newYear = calendarEventFromPdga({ name: "Ice Bowl", date: "Dec 31, 2026 – Jan 1, 2027", url: "https://www.pdga.com/tour/event/1" });
  assert.deepEqual([newYear.start, newYear.end], ["20261231", "20270102"]);
  assert.equal(calendarEventFromPdga({ name: "Two days", date: "Nov 22-23, 2026", url: "x" }).end, "20261124");
});

test("a PDGA registration event becomes an all-day calendar item with division and URL", () => {
  const item = calendarEventFromPdgaRegistration({
    eventId: 96414,
    name: "Greenville Winter Classic",
    start: "2026-12-12",
    end: "2026-12-13",
    location: "Greenville, NC",
    division: "MA1",
    url: "https://www.pdga.com/tour/event/96414",
  });
  assert.equal(item.allDay, true);
  assert.equal(item.start, "20261212");
  assert.equal(item.end, "20261214");
  assert.match(item.description, /Division: MA1/);
  assert.match(item.description, /PDGA: https:\/\/www\.pdga\.com\/tour\/event\/96414/);
  assert.equal(calendarEventFromPdgaRegistration({ name: "Bad", start: "12/12/2026" }), null);
});
