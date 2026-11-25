import { describe, expect, it } from "vitest";
import {
  CLUB_ORIGIN,
  DAY_TRIP_MILES,
  dedupeNearbyCandidates,
  defaultPar3Holes,
  discGolfApiRegionUrl,
  discGolfApiUrl,
  isDuplicateCourse,
  normalizeCourseName,
  parseDiscGolfApiCourses,
  planNearbyCourseImport,
  regionsNearPoint,
  uniqueCourseName,
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
    expect(defaultPar3Holes(9)).toEqual(Array.from({ length: 9 }, (_, i) => ({ hole: i + 1, par: 3, par_source: "placeholder" })));
  });
});

describe("haversineMiles club origin", () => {
  it("places West Meadowbrook inside the 100-mile nearby ring", () => {
    const miles = haversineMiles(CLUB_ORIGIN, { lat: 35.6264, lng: -77.375 });
    expect(miles).toBeGreaterThan(0);
    expect(miles).toBeLessThan(5);
  });
});

describe("discGolfApiRegionUrl and regionsNearPoint", () => {
  it("builds a region URL without country=US so border courses filed under CA still appear", () => {
    expect(discGolfApiRegionUrl("pa")).toBe("https://io.discgolfapi.com/v1/courses?region=PA&limit=250&offset=0");
  });

  it("maps Pennsylvania, North Carolina, and ocean coordinates to expected regions", () => {
    const philly = regionsNearPoint({ lat: 39.9526, lng: -75.1652 }, 25);
    expect(philly).toContain("PA");
    expect(philly).toContain("NJ");
    expect(philly).toContain("DE");

    const pgh = regionsNearPoint({ lat: 40.4406, lng: -79.9959 }, 35);
    expect(pgh).toContain("PA");
    expect(pgh).toContain("OH");
    expect(pgh).toContain("WV");

    expect(regionsNearPoint({ lat: 40.2732, lng: -76.8867 }, 25)).toContain("PA");
    expect(regionsNearPoint({ lat: 42.1292, lng: -80.0851 }, 25)).toContain("PA");
    expect(regionsNearPoint(CLUB_ORIGIN, 25)).toEqual(["NC"]);
    expect(regionsNearPoint({ lat: 30, lng: -45 }, 50)).toEqual([]);
  });
});

describe("dedupeNearbyCandidates and uniqueCourseName", () => {
  it("keeps the higher-confidence DiscGolfAPI duplicate and drops bogus rows", () => {
    const parsed = parseDiscGolfApiCourses({
      courses: [
        { id: "crs_tyler_low", name: "Tyler State Park - West", lat: 40.231, lon: -74.953, locality: "Newtown", region_code: "PA", holes: 18, confidence_score: 0.75, existence_status: "existing", operational_status: "open" },
        { id: "crs_tyler_high", name: "Tyler State Park - West", lat: 40.231, lon: -74.959, locality: "Newtown", region_code: "PA", holes: 36, confidence_score: 0.85, existence_status: "existing", operational_status: "open" },
        { id: "crs_popup", name: "Summer Pop-Up Course", lat: 40.2, lon: -75.1, locality: "Doylestown", region_code: "PA", holes: 9, confidence_score: 0.9, existence_status: "existing", operational_status: "open" },
      ],
    });
    const deduped = dedupeNearbyCandidates(parsed);
    expect(deduped.map((c) => c.source_id)).toEqual(["crs_tyler_high"]);
  });

  it("disambiguates matching names in different cities or states", () => {
    const taken = new Set(["Creekside Park", "Creekside Park, Springfield"]);
    expect(uniqueCourseName("Creekside Park", "Springfield, PA", taken)).toBe("Creekside Park, Springfield, PA");
    expect(uniqueCourseName("Pinchot Park", "Lewisberry, PA", taken)).toBe("Pinchot Park");
    expect(
      isDuplicateCourse(
        { name: "Pinchot Park", location: "Lewisberry, PA", lat: 40.07, lng: -76.89, holes: 18, miles: 0, region: "PA", source_id: "x", website: null },
        { name: "Pinchot Park", location: "Lewisberry, NC", lat: 35.5, lng: -77.3 },
      ),
    ).toBe(false);
  });
});
