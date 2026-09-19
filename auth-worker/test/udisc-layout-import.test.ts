import { describe, expect, it, vi } from "vitest";
import {
  attachUdiscUrlsFromIndex,
  isPlaceholderLayout,
  isUdiscLayoutCron,
  mergePositions,
  pickNextUdiscImportCourse,
  pickUdiscSearchMatch,
  planUdiscLayoutApply,
  UDISC_LAYOUT_IMPORT_CRON,
} from "../src/udisc-layout-import.js";
import { COURSE_CATALOG_CACHE_NAME, bustCourseCatalogCache } from "../src/course-catalog-cache.js";
import { normalizeUdiscCourseUrl, parseUdiscCourseUrls, udiscIndexUrl, udiscSlugName } from "../src/imports/udisc.js";

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

  it("prefers an unmapped course that already has a UDisc URL", () => {
    expect(pickNextUdiscImportCourse(courses, [{ course_id: 5, status: "failed", attempts: 3 }])?.id).toBe(3);
  });

  it("skips imported rows and already-mapped courses while unmapped remain", () => {
    expect(
      pickNextUdiscImportCourse(courses, [
        { course_id: 3, status: "imported", attempts: 1 },
        { course_id: 5, status: "failed", attempts: 3 },
      ])?.id,
    ).toBe(4);
  });
});

describe("planUdiscLayoutApply", () => {
  const layout = {
    name: "White",
    udisc_url: "https://udisc.com/courses/x-AAAA",
    udisc_course_id: "1",
    note: "",
    holes: [
      {
        hole: 1,
        par: 3,
        tee: { label: "Hole 1 tee", lat: 35.6, lng: -77.37 },
        target: { label: "Hole 1 basket", lat: 35.601, lng: -77.37 },
      },
    ],
    positions: [
      { kind: "tee" as const, label: "Hole 1 tee", lat: 35.6, lng: -77.37 },
      { kind: "target" as const, label: "Hole 1 basket", lat: 35.601, lng: -77.37 },
    ],
  };

  it("replaces the default par-3 placeholder and keeps existing GPS layouts", () => {
    const plan = planUdiscLayoutApply({
      existingLayouts: [
        { id: 10, name: "Default (par 3s)", holes: JSON.stringify([{ hole: 1, par: 3 }]) },
        {
          id: 11,
          name: "Gold",
          holes: JSON.stringify([{ hole: 1, par: 3, tee: { lat: 1, lng: 2 }, target: { lat: 3, lng: 4 } }]),
        },
      ],
      existingPositions: [],
      layouts: [layout, { ...layout, name: "Gold", holes: layout.holes, positions: layout.positions }],
    });
    expect(plan.layouts).toEqual([
      expect.objectContaining({ action: "update", layoutId: 10, name: "White" }),
    ]);
    expect(plan.mapped).toBe(true);
    expect(plan.positions).toHaveLength(2);
  });
});

describe("mergePositions / isPlaceholderLayout / attachUdiscUrlsFromIndex", () => {
  it("fills missing coords without clobbering existing pins", () => {
    const merged = mergePositions(
      [{ kind: "tee", label: "Hole 1 tee", lat: 35.6, lng: null }],
      [{ kind: "tee", label: "Hole 1 tee", lat: 99, lng: -77.37 }, { kind: "target", label: "Hole 1 basket", lat: 35.6, lng: -77.37 }],
    );
    expect(merged.find((p) => p.kind === "tee")).toMatchObject({ lat: 35.6, lng: -77.37 });
    expect(merged).toHaveLength(2);
  });

  it("treats Default (par 3s) as a placeholder and GPS layouts as real", () => {
    expect(isPlaceholderLayout({ name: "Default (par 3s)", holes: JSON.stringify([{ hole: 1, par: 3 }]) })).toBe(true);
    expect(
      isPlaceholderLayout({
        name: "White",
        holes: JSON.stringify([{ hole: 1, par: 3, tee: { lat: 1, lng: 2 }, target: { lat: 3, lng: 4 } }]),
      }),
    ).toBe(false);
  });

  it("attaches current UDisc index slugs onto unmatched catalog rows", () => {
    const attached = attachUdiscUrlsFromIndex(
      [
        { id: 1, name: "Washington High School", lat: 35.5577, lng: -77.0136 },
        { id: 2, name: "Farmington Park DGC", lat: 35.946, lng: -77.838, udisc_url: "https://udisc.com/courses/farmington-park-dgc-xQw3" },
        { id: 3, name: "West Meadowbrook Park", lat: 35.6264, lng: -77.375 },
      ],
      [
        "https://udisc.com/courses/washington-high-school-ntm5",
        "https://udisc.com/courses/farmington-park-dgc-KTyd",
        "https://udisc.com/courses/west-meadowbrook-park-40Aw",
      ],
    );
    expect(attached).toEqual([
      { id: 1, udisc_url: "https://udisc.com/courses/washington-high-school-ntm5" },
      { id: 3, udisc_url: "https://udisc.com/courses/west-meadowbrook-park-40Aw" },
    ]);
  });
});

describe("udiscIndexUrl", () => {
  it("builds a paginated bounding-box search around the club", () => {
    const url = udiscIndexUrl({ lat: 35.6127, lng: -77.3664 }, 150, 2);
    expect(url).toContain("https://udisc.com/courses?");
    expect(url).toContain("neLat=");
    expect(url).toContain("swLng=");
    expect(url).toContain("page=2");
  });
});

describe("bustCourseCatalogCache", () => {
  it("deletes the course catalog cache after a mapped import", async () => {
    const deleted: string[] = [];
    vi.stubGlobal("caches", { delete: async (name: string) => { deleted.push(name); return true; } });
    await expect(bustCourseCatalogCache()).resolves.toBe(true);
    expect(deleted).toEqual([COURSE_CATALOG_CACHE_NAME]);
    vi.unstubAllGlobals();
  });
});
