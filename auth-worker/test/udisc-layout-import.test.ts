import { describe, expect, it, vi } from "vitest";
import {
  attachUdiscUrlsFromIndex,
  inheritMappedUdiscUrl,
  isPlaceholderLayout,
  isUdiscLayoutCron,
  knownUdiscUrl,
  mergePositions,
  pickNextUdiscImportCourse,
  pickUdiscSearchMatch,
  planUdiscLayoutApply,
  UDISC_LAYOUT_IMPORT_CRON,
} from "../src/udisc-layout-import.js";
import { COURSE_CATALOG_CACHE_NAME, bustCourseCatalogCache } from "../src/course-catalog-cache.js";
import { normalizeUdiscCourseUrl, parseUdiscCourseUrls, udiscIndexUrl, udiscNcIndexUrl, udiscSlugName } from "../src/imports/udisc.js";

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

  it("matches NC Wesleyan aliases and ignores a Virginia slug", () => {
    const urls = [
      "https://udisc.com/courses/north-carolina-wesleyan-university-Xw47",
      "https://udisc.com/courses/virginia-wesleyan-university-abcd",
      "https://udisc.com/courses/haywood-community-college-mG4h",
    ];
    expect(
      pickUdiscSearchMatch(
        { name: "Wesleyan College Disc Golf Course", location: "Rocky Mount, NC" },
        urls,
      ),
    ).toBe("https://udisc.com/courses/north-carolina-wesleyan-university-Xw47");
    expect(
      pickUdiscSearchMatch(
        { name: "NC Wesleyan University", location: "Rocky Mount, NC" },
        urls,
      ),
    ).toBe("https://udisc.com/courses/north-carolina-wesleyan-university-Xw47");
    expect(
      pickUdiscSearchMatch(
        { name: "Virginia Wesleyan College", location: "Virginia Beach, VA" },
        urls,
      ),
    ).toBe("https://udisc.com/courses/virginia-wesleyan-university-abcd");
  });

  it("does not attach generic community-college or community-park slugs", () => {
    expect(
      pickUdiscSearchMatch(
        { name: "Nash Community College DGC", location: "Rocky Mount, NC" },
        ["https://udisc.com/courses/haywood-community-college-mG4h"],
      ),
    ).toBeNull();
    expect(
      pickUdiscSearchMatch(
        { name: "Hildebran Community Park Disc Golf Course", location: "Hildebran, NC" },
        ["https://udisc.com/courses/zebulon-community-park-ZxWn"],
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

  it("jumps Ashe County Park ahead of nearer unmapped courses", () => {
    const next = pickNextUdiscImportCourse(
      [
        ...courses,
        { id: 9, name: "Ashe County Park", lat: 36.435, lng: -81.469, mapped: 0 },
      ],
      [{ course_id: 5, status: "failed", attempts: 3 }],
    );
    expect(next?.id).toBe(9);
  });

  it("retries no_url after a UDisc URL is attached", () => {
    expect(
      pickNextUdiscImportCourse(
        [{
          id: 144,
          name: "Wesleyan College Disc Golf Course",
          mapped: 0,
          lat: 35.955,
          lng: -77.813,
        }],
        [{ course_id: 144, status: "no_url", attempts: 3 }],
      )?.id,
    ).toBe(144);
    expect(
      pickNextUdiscImportCourse(
        [{
          id: 26,
          name: "Englewood Park",
          mapped: 0,
          udisc_url: "https://udisc.com/courses/englewood-park-abcd",
          lat: 35.953,
          lng: -77.829,
        }],
        [{ course_id: 26, status: "no_url", attempts: 3 }],
      )?.id,
    ).toBe(26);
  });

  it("keeps no_url exhausted when still missing a URL", () => {
    expect(
      pickNextUdiscImportCourse(
        [{ id: 26, name: "Englewood Park", mapped: 0, lat: 35.953, lng: -77.829 }],
        [{ course_id: 26, status: "no_url", attempts: 3 }],
      ),
    ).toBeNull();
  });
});

describe("knownUdiscUrl", () => {
  it("attaches the Ashe County Park UDisc URL without waiting on the index", () => {
    expect(knownUdiscUrl({ name: "Ashe County Park" })).toBe("https://udisc.com/courses/ashe-county-park-wllg");
    expect(
      attachUdiscUrlsFromIndex(
        [{ id: 9, name: "Ashe County Park", mapped: 0 }],
        [],
      ),
    ).toEqual([{ id: 9, udisc_url: "https://udisc.com/courses/ashe-county-park-wllg" }]);
  });

  it("attaches the Rocky Mount Wesleyan UDisc URL under both catalog names", () => {
    expect(knownUdiscUrl({ name: "NC Wesleyan University" })).toBe(
      "https://udisc.com/courses/north-carolina-wesleyan-university-Xw47",
    );
    expect(knownUdiscUrl({ name: "Wesleyan College Disc Golf Course" })).toBe(
      "https://udisc.com/courses/north-carolina-wesleyan-university-Xw47",
    );
    expect(knownUdiscUrl({ name: "Virginia Wesleyan College" })).toBeNull();
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

  it("inherits a mapped sibling's UDisc URL when names and location line up", () => {
    const catalog = [
      {
        id: 21,
        name: "Farmington Park DGC",
        location: "Rocky Mount, NC",
        lat: 35.946,
        lng: -77.838,
        mapped: 1,
        udisc_url: "https://udisc.com/courses/farmington-park-dgc-KTyd",
      },
      {
        id: 210,
        name: "Farmington Park Disc Golf Course",
        location: "Rocky Mount, NC",
        lat: 35.947,
        lng: -77.839,
        mapped: 0,
      },
    ];
    expect(inheritMappedUdiscUrl(catalog[1]!, catalog)).toBe(
      "https://udisc.com/courses/farmington-park-dgc-KTyd",
    );
    expect(attachUdiscUrlsFromIndex(catalog, [])).toEqual([
      { id: 210, udisc_url: "https://udisc.com/courses/farmington-park-dgc-KTyd" },
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

  it("covers the whole NC bounding box so western courses can hydrate", () => {
    const url = udiscNcIndexUrl();
    expect(url).toContain("neLng=-75.4000");
    expect(url).toContain("swLng=-84.3200");
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
