import { describe, expect, it } from "vitest";
import {
  isPdgaEventCron,
  locatePdgaEvent,
  newPdgaEventNames,
  placePdgaEvents,
} from "../src/pdga-events.js";

const COURSES = [
  { name: "West Meadowbrook Park", location: "Greenville, NC", lat: 35.6264, lng: -77.375 },
  { name: "Other Greenville", location: "Greenville, NC", lat: 35.6, lng: -77.4 },
  { name: "Kentwood Park", location: "Raleigh, NC", lat: 35.82, lng: -78.65 },
];

describe("PDGA events within 100 miles", () => {
  it("places an event on its course and lists the soonest date first", () => {
    const origin = { lat: 35.63, lng: -77.37 };
    expect(locatePdgaEvent({ course: "West Meadowbrook Park", place: "Greenville, NC" }, COURSES)).toEqual({
      lat: 35.6264,
      lng: -77.375,
    });
    const placed = placePdgaEvents([
      { name: "Raleigh Open", date: "Oct 3, 2026", tier: "B-tier", course: "Kentwood", place: "Raleigh, NC", url: "https://www.pdga.com/tour/event/2" },
      { name: "GVDG Fall Flex #1", date: "Sep 25, 2026", tier: "C-tier", course: "West Meadowbrook Park", place: "Greenville, NC", url: "https://www.pdga.com/tour/event/1" },
    ], COURSES, origin);
    expect(placed.map((event) => event.name)).toEqual(["GVDG Fall Flex #1", "Raleigh Open"]);
    expect(placed[0]!.miles).toBeLessThan(placed[1]!.miles!);
    const fartherButSooner = placePdgaEvents([
      { name: "Late Home", date: "Oct 10, 2026", tier: "C-tier", course: "West Meadowbrook Park", place: "Greenville, NC", url: "https://www.pdga.com/tour/event/3" },
      { name: "Early Away", date: "Oct 1, 2026", tier: "B-tier", course: "Kentwood", place: "Raleigh, NC", url: "https://www.pdga.com/tour/event/4" },
    ], COURSES, origin);
    expect(fartherButSooner.map((event) => event.name)).toEqual(["Early Away", "Late Home"]);
    expect(fartherButSooner[0]!.miles).toBeGreaterThan(fartherButSooner[1]!.miles!);
    const sameCourse = placePdgaEvents([
      { name: "Hangover", date: "Jan 1, 2027", tier: "", course: "West Meadowbrook Park", place: "Greenville, NC", url: "https://www.pdga.com/tour/event/5" },
      { name: "Fall Flex", date: "Sep 25, 2026", tier: "C-tier", course: "West Meadowbrook Park", place: "Greenville, NC", url: "https://www.pdga.com/tour/event/6" },
    ], COURSES, origin);
    expect(sameCourse.map((event) => event.name)).toEqual(["Fall Flex", "Hangover"]);
  });

  it("treats only brand-new event urls as added on the PDGA cron", () => {
    expect(isPdgaEventCron("7 * * * *")).toBe(true);
    expect(isPdgaEventCron("*/15 * * * *")).toBe(false);
    const previous = [{ url: "https://www.pdga.com/tour/event/1" }];
    expect(newPdgaEventNames([], [{ url: "https://www.pdga.com/tour/event/1", name: "Fall Flex" }])).toEqual([]);
    expect(newPdgaEventNames(previous, [
      { url: "https://www.pdga.com/tour/event/1", name: "Fall Flex" },
      { url: "https://www.pdga.com/tour/event/2", name: "New One" },
    ])).toEqual(["New One"]);
  });
});
