import { describe, expect, it } from "vitest";
import {
  attachUdiscUrlsFromCatalog,
  isPlaceholderLayout,
  isUdiscLayoutCron,
  mergePositions,
  pickNextUdiscImportCourse,
  pickUdiscSearchMatch,
  planUdiscLayoutApply,
  UDISC_LAYOUT_IMPORT_CRON,
} from "../src/udisc-layout-import.js";
import { normalizeUdiscCourseUrl, parseUdiscCourseUrls, udiscSlugName } from "../src/imports/udisc.js";

describe("isUdiscLayoutCron", () => {
  it("matches the 15-minute trigger and ignores the ratings cron", () => {
    expect(isUdiscLayoutCron(UDISC_LAYOUT_IMPORT_CRON)).toBe(true);
    expect(isUdiscLayoutCron("*/15 * * * *")).toBe(true);
    expect(isUdiscLayoutCron("17 8 * * *")).toBe(false);
  });
});

describe("normalizeUdiscCourseUrl / parseUdiscCourseUrls", () => {
  it("canonicalizes http/www UDisc course links and ignores directory pages", () => {
    expect(normalizeUdiscCourseUrl("http://www.udisc.com/courses/west-meadowbrook-park-40Aw?ref=1")).toBe(
      "https://udisc.com/courses/west-meadowbrook-park-40Aw",
    );
    expect(normalizeUdiscCourseUrl("https://udisc.com/courses")).toBeNull();
    expect(normalizeUdiscCourseUrl("https://evil.example/courses/west-meadowbrook-park-40Aw")).toBeNull();
    expect(parseUdiscCourseUrls(`
      <a href="/courses/west-meadowbrook-park-40Aw">West</a>
      <a href="https://udisc.com/courses/ayden-park-HoPq">Ayden</a>
      <a href="/courses/west-meadowbrook-park-40Aw">dup</a>
    `)).toEqual([
      "https://udisc.com/courses/west-meadowbrook-park-40Aw",
      "https://udisc.com/courses/ayden-park-HoPq",
    ]);
    expect(udiscSlugName("https://udisc.com/courses/west-meadowbrook-park-40Aw")).toBe("west meadowbrook park");
  });
});

describe("pickUdiscSearchMatch", () => {
  it("picks the unique name match and refuses a close tie", () => {
    const urls = [
      "https://udisc.com/courses/west-meadowbrook-park-40Aw",
      "https://udisc.com/courses/east-meadowbrook-park-zzzz",
    ];
    expect(pickUdiscSearchMatch({ name: "West Meadowbrook Park", location: "Greenville, NC" }, urls)).toBe(
      "https://udisc.com/courses/west-meadowbrook-park-40Aw",
    );
    expect(
      pickUdiscSearchMatch(
        { name: "Meadowbrook Park" },
        ["https://udisc.com/courses/west-meadowbrook-park-40Aw", "https://udisc.com/courses/east-meadowbrook-park-zzzz"],
      ),
    ).toBeNull();
  });
});

describe("pickNextUdiscImportCourse", () => {
  const courses = [
    { id: 1, name: "Far Unmapped", lat: 36.2, lng: -77.8, mapped: 0 },
    { id: 2, name: "Near Mapped", lat: 35.61, lng: -77.36, mapped: 1, udisc_url: "https://udisc.com/courses/x-AAAA" },
    { id: 3, name: "Near With Url", lat: 35.62, lng: -77.37, mapped: 0, udisc_url: "https://udisc.com/courses/near-bbbb" },
    { id: 4, name: "Near No Url", lat: 35.63, lng: -77.38, mapped: 0 },
    { id: 5, name: "Failed Exhausted", lat: 35.61, lng: -77.36, mapped: 0, udisc_url: "https://udisc.com/courses/fail-cccc" },
  ];

  it("prefers an already-imported mapped course that still lacks a UDisc id", () => {
    expect(pickNextUdiscImportCourse(courses, [{ course_id: 5, status: "failed", attempts: 3 }])?.id).toBe(2);
  });

  it("skips imported rows and mapped courses that already have a UDisc id", () => {
    const withId = courses.map((c) => (c.id === 2 ? { ...c, udisc_course_id: "99" } : c));
    expect(
      pickNextUdiscImportCourse(withId, [
        { course_id: 3, status: "imported", attempts: 1 },
        { course_id: 5, status: "failed", attempts: 3 },
      ])?.id,
    ).toBe(4);
  });
});
