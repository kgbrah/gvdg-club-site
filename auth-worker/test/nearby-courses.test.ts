import { describe, expect, it } from "vitest";
import {
  CLUB_ORIGIN,
  DAY_TRIP_MILES,
  defaultPar3Holes,
  discGolfApiUrl,
  normalizeCourseName,
  parseDiscGolfApiCourses,
  planNearbyCourseImport,
} from "../src/imports/nearby-courses.js";
import { haversineMiles } from "../src/distance.js";

const SEED = [
  { name: "ECU North Rec Complex", location: "Greenville, NC", lat: 35.631092, lng: -77.319923 },
  { name: "West Meadowbrook Park", location: "Greenville, NC", lat: 35.6264, lng: -77.375 },
  { name: "Covenant Church", location: "Winterville, NC", lat: 35.55785, lng: -77.360886 },
  { name: "Beaufort County CC", location: "Washington, NC", lat: 35.5549, lng: -77.0152 },
  { name: "Creekside Park", location: "New Bern, NC", lat: 35.061508, lng: -77.044464 },
  { name: "Sunset Park DGC", location: "Rocky Mount, NC", lat: 35.953166, lng: -77.81338 },
];

describe("normalizeCourseName", () => {
  it("treats CC as community college so seeded shorts match DiscGolfAPI titles", () => {
    expect(normalizeCourseName("Beaufort County CC")).toBe(
      normalizeCourseName("Beaufort County Community College Disc Golf Course"),
    );
  });
});

describe("parseDiscGolfApiCourses", () => {
  it("drops closed, hole-less, and unmapped listings", () => {
    const parsed = parseDiscGolfApiCourses({
      courses: [
        { name: "Lake Wilson DGC", lat: 35.79, lon: -77.92, locality: "Wilson", region_code: "NC", holes: 18, existence_status: "existing", operational_status: "open" },
        { name: "Gone", lat: 35.6, lon: -77.3, holes: 18, existence_status: "removed" },
        { name: "No GPS", locality: "Wilson", holes: 18 },
        { name: "Putt park", lat: 35.6, lon: -77.3, holes: 2 },
      ],
    });
    expect(parsed.map((c) => c.name)).toEqual(["Lake Wilson DGC"]);
    expect(parsed[0]).toMatchObject({ location: "Wilson, NC", holes: 18 });
  });
});

describe("planNearbyCourseImport", () => {
  it("keeps every NC course and 250-mile nearby courses, skipping seeded GPS/name matches", () => {
    const catalog = parseDiscGolfApiCourses({
      courses: [
        { name: "The Meadow at West Meadowbrook Park", lat: 35.6274259, lon: -77.3770867, locality: "Greenville", region_code: "NC", holes: 18, existence_status: "existing", operational_status: "open" },
        { name: "Beaufort County Community College Disc Golf Course", lat: 35.5337105, lon: -76.9652678, locality: "Washington", region_code: "NC", holes: 18, existence_status: "existing", operational_status: "open" },
        { name: "Creekside Park", lat: 35.8961593, lon: -79.9343726, locality: "Archdale", region_code: "NC", holes: 22, existence_status: "existing", operational_status: "open" },
        { name: "Lake Wilson DGC", lat: 35.7929925, lon: -77.9246014, locality: "Wilson", region_code: "NC", holes: 18, existence_status: "existing", operational_status: "open" },
        { name: "Western Carolina University", lat: 35.6068806, lon: -77.3665364, locality: "Greenville", region_code: "NC", holes: 18, existence_status: "existing", operational_status: "open" },
        { name: "Washington High School", lat: 35.5577149, lon: -77.0136058, locality: "Washington", region_code: "NC", holes: 9, existence_status: "existing", operational_status: "open" },
        { name: "Asheville far", lat: 35.595, lon: -82.551, locality: "Asheville", region_code: "NC", holes: 18, existence_status: "existing", operational_status: "open" },
        { name: "Far Virginia", lat: 38.03, lon: -78.48, locality: "Charlottesville", region_code: "VA", holes: 18, existence_status: "existing", operational_status: "open" },
      ],
    });
    const plan = planNearbyCourseImport(catalog, SEED, { maxMiles: DAY_TRIP_MILES });
    const names = plan.insert.map((c) => c.name);
    expect(names).toContain("Lake Wilson DGC");
    expect(names).toContain("Washington High School");
    expect(names).toContain("Creekside Park, Archdale");
    expect(names).toContain("Asheville far");
    expect(names).toContain("Far Virginia");
    expect(names).not.toContain("The Meadow at West Meadowbrook Park");
    expect(names).not.toContain("Western Carolina University");
    expect(plan.insert.find((c) => c.name === "Lake Wilson DGC")?.miles).toBeGreaterThan(30);
    expect(plan.insert.find((c) => c.name === "Lake Wilson DGC")?.miles).toBeLessThan(40);
    expect(plan.insert.find((c) => c.name === "Asheville far")?.miles).toBeGreaterThan(150);
    expect(plan.insert.find((c) => c.name === "Far Virginia")?.miles).toBeGreaterThan(150);
    expect(plan.insert.find((c) => c.name === "Far Virginia")?.miles).toBeLessThan(250);
  });

  it("treats DiscGolfAPI Wesleyan College as the seeded NC Wesleyan campus", () => {
    const catalog = parseDiscGolfApiCourses({
      courses: [
        {
          name: "Wesleyan College Disc Golf Course",
          lat: 35.9550285,
          lon: -77.8131027,
          locality: "Rocky Mount",
          region_code: "NC",
          holes: 18,
          existence_status: "existing",
          operational_status: "open",
        },
      ],
    });
    const plan = planNearbyCourseImport(catalog, [
      { name: "NC Wesleyan University", location: "Rocky Mount, NC", lat: 35.936, lng: -77.833 },
    ]);
    expect(plan.insert).toEqual([]);
    expect(plan.skipped).toBe(1);
  });
});

describe("discGolfApiUrl", () => {
  it("pages region results with offset", () => {
    expect(discGolfApiUrl("NC")).toBe("https://io.discgolfapi.com/v1/courses?country=US&region=NC&limit=250&offset=0");
    expect(discGolfApiUrl("NC", 250, 250)).toContain("offset=250");
  });
});

describe("defaultPar3Holes", () => {
  it("builds exclusive par-3 holes for a card-ready layout", () => {
    expect(defaultPar3Holes(9)).toEqual(Array.from({ length: 9 }, (_, i) => ({ hole: i + 1, par: 3 })));
  });
});

describe("haversineMiles club origin", () => {
  it("places West Meadowbrook inside the 100-mile nearby ring", () => {
    const miles = haversineMiles(CLUB_ORIGIN, { lat: 35.6264, lng: -77.375 });
    expect(miles).toBeGreaterThan(0);
    expect(miles).toBeLessThan(5);
  });
});
