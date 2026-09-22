import { describe, expect, it } from "vitest";
import {
  discGolfSceneSearchUrl,
  locatePdgaEvent,
  parseDiscGolfSceneSearch,
  placePdgaEvents,
} from "../src/pdga-events.js";

const CARD = `
<div class="tournament-list list-record ">
<a href="https://www.discgolfscene.com/tournaments/GVDG_Fall_Flex_1_2026">
  <span class="name"><i></i> GVDG Fall Flex #1 </span>
  <span class="info">PDGA Flex C-tier &middot; Fri, Sep 25, 2026</span>
  <b>West Meadowbrook Park</b>
  <b>Greenville, NC</b>
  <span class="list-tier"><img src="/pdga.svg" /><br />C-tier</span>
</a>
</div>
<div class="tournament-list list-record ">
<a href="https://www.discgolfscene.com/tournaments/Raleigh_Open_2026">
  <span class="name">Raleigh Open</span>
  <span class="info">PDGA B-tier &middot; Sat, Oct 3, 2026</span>
  <b>Kentwood</b>
  <b>Raleigh, NC</b>
  <span class="list-tier"><br />B-tier</span>
</a>
</div>
<div class="tournament-list list-record ">
<a href="https://www.discgolfscene.com/tournaments/Old_Flex">
  <span class="name">Old Flex</span>
  <span class="info">PDGA C-tier &middot; Mon, Sep 1, 2026</span>
  <b>Somewhere</b>
  <b>Wilson, NC</b>
</a>
</div>
<div class="tournament-list list-record ">
<a href="https://www.discgolfscene.com/tournaments/NC">
  <span class="name">Not an event</span>
</a>
</div>`;

const COURSES = [
  { name: "West Meadowbrook Park", location: "Greenville, NC", lat: 35.6264, lng: -77.375 },
  { name: "Other Greenville", location: "Greenville, NC", lat: 35.6, lng: -77.4 },
  { name: "Kentwood Park", location: "Raleigh, NC", lat: 35.82, lng: -78.65 },
];

describe("PDGA events within 100 miles", () => {
  const now = Date.parse("2026-09-22T16:00:00Z");

  it("reads DiscGolfScene cards and drops past events", () => {
    const events = parseDiscGolfSceneSearch(CARD, now);
    expect(events.map((event) => event.name)).toEqual(["GVDG Fall Flex #1", "Raleigh Open"]);
    expect(events[0]).toMatchObject({
      course: "West Meadowbrook Park",
      place: "Greenville, NC",
      tier: "C-tier",
      url: "https://www.discgolfscene.com/tournaments/GVDG_Fall_Flex_1_2026",
    });
  });

  it("places an event on its course and sorts closest to the player first", () => {
    const origin = { lat: 35.63, lng: -77.37 };
    expect(locatePdgaEvent({ course: "West Meadowbrook Park", place: "Greenville, NC" }, COURSES)).toEqual({
      lat: 35.6264,
      lng: -77.375,
    });
    const placed = placePdgaEvents(parseDiscGolfSceneSearch(CARD, now), COURSES, origin);
    expect(placed.map((event) => event.name)).toEqual(["GVDG Fall Flex #1", "Raleigh Open"]);
    expect(placed[0]!.miles).toBeLessThan(placed[1]!.miles!);
    expect(placed[0]!.url).toContain("discgolfscene.com/tournaments/");
    const sameCourse = placePdgaEvents([
      { name: "Hangover", date: "Jan 1, 2027", tier: "", course: "West Meadowbrook Park", place: "Greenville, NC", url: "https://www.discgolfscene.com/tournaments/Hangover" },
      { name: "Fall Flex", date: "Sep 25, 2026", tier: "C-tier", course: "West Meadowbrook Park", place: "Greenville, NC", url: "https://www.discgolfscene.com/tournaments/Fall_Flex" },
    ], COURSES, origin);
    expect(sameCourse.map((event) => event.name)).toEqual(["Fall Flex", "Hangover"]);
  });

  it("searches DiscGolfScene for a 100-mile box around the player", () => {
    const url = new URL(discGolfSceneSearchUrl(35.61, -77.37));
    expect(url.hostname).toBe("www.discgolfscene.com");
    expect(url.searchParams.get("filter[location][distance]")).toBe("100");
    expect(url.searchParams.get("filter[location][latitude]")).toBe("35.6100");
  });
});
