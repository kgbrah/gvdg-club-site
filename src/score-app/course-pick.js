import { COVERAGE_ORDER, courseCoverage, layoutQuality, layoutRows, mapCoordinates, mappedHole } from "../shared/course-quality.js";

export const CLUB_ORIGIN = { lat: 35.6127, lng: -77.3664 };
export const COURSE_RANGES = [
  { value: "all", label: "All courses", miles: Infinity },
  { value: "10", label: "Within 10 miles", miles: 10 },
  { value: "25", label: "Within 25 miles", miles: 25 },
  { value: "50", label: "Within 50 miles", miles: 50 },
  { value: "100", label: "Within 100 miles", miles: 100 },
  { value: "250", label: "Within 250 miles", miles: 250 },
];
export const COURSE_RANGE_DEFAULT = "25";
export const BROWSE_MAPPED_LIMIT = 12;
export const LAST_COURSE_KEY = "gvdg.lastCourse";

export function milesFromClub(course, origin = CLUB_ORIGIN) {
  return milesFromOrigin(course, origin);
}

export function milesFromOrigin(course, origin) {
  const coordinates = mapCoordinates(course);
  const from = mapCoordinates(origin);
  if (!coordinates || !from) return null;
  const { lat, lng } = coordinates;
  const { lat: fromLat, lng: fromLng } = from;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat - fromLat);
  const dLng = toRad(lng - fromLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(fromLat)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function layoutHoles(layout) {
  return layoutRows(layout).flatMap((row) => {
    const hole = Number(row?.hole ?? row?.number);
    return Number.isInteger(hole) && hole >= 1 && hole <= 36 ? [{ ...row, hole }] : [];
  });
}

export function layoutHasMap(layout) {
  return layoutHoles(layout).some(mappedHole);
}

export function courseMapHref(name) {
  const label = String(name || "").trim();
  return label ? "score.html?course=" + encodeURIComponent(label) : "score.html";
}

export function matchCourseByName(courses, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return null;
  const rows = Array.isArray(courses) ? courses : [];
  return rows.find((course) => String(course && course.name || "").trim().toLowerCase() === needle)
    || rows.find((course) => String(course && course.name || "").toLowerCase().includes(needle))
    || null;
}

export function courseHasMap(course) {
  return COVERAGE_ORDER[courseCoverage(course)] >= COVERAGE_ORDER.partial;
}

function compareNames(a, b) {
  return String((a && a.name) || "").localeCompare(String((b && b.name) || ""));
}

function searchable(value) {
  return String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase();
}

export function filterCoursesForPick(courses, query, range, origin, options = {}) {
  const q = searchable(query);
  const maxMiles = (COURSE_RANGES.find((option) => option.value === range) || COURSE_RANGES[0]).miles;
  const rows = (Array.isArray(courses) ? courses : []).map((course) => ({
    course,
    miles: milesFromOrigin(course, origin),
    coverage: courseCoverage(course),
  }));
  const matched = rows.filter(({ course, miles, coverage }) => {
    if (options.coverage && options.coverage !== coverage) return false;
    if (options.favoritesOnly && !options.favoriteIds?.has(String(course.id))) return false;
    if (options.savedOnly && !options.savedIds?.has(String(course.id))) return false;
    if (q) {
      const layouts = Array.isArray(course.layouts) ? course.layouts.map((layout) => layout.name).join(" ") : "";
      const hay = searchable([course.name, course.location, layouts].join(" "));
      if (!q.split(/\s+/).every((token) => hay.includes(token))) return false;
    }
    if (maxMiles === Infinity || !origin) return true;
    return miles != null && miles <= maxMiles;
  });
  matched.sort((a, b) => {
    if (a.coverage !== b.coverage) return COVERAGE_ORDER[b.coverage] - COVERAGE_ORDER[a.coverage];
    if (a.miles == null && b.miles == null) return compareNames(a.course, b.course);
    if (a.miles == null) return 1;
    if (b.miles == null) return -1;
    if (a.miles !== b.miles) return a.miles - b.miles;
    return compareNames(a.course, b.course);
  });
  return matched.map((row) => row.course);
}

export function courseSub(course, origin) {
  const miles = milesFromOrigin(course, origin);
  const loc = course && course.location ? String(course.location) : "";
  if (miles == null) return loc;
  const label = miles < 10 ? miles.toFixed(1) : String(Math.round(miles));
  return loc ? `${label} mi · ${loc}` : `${label} mi`;
}

export function googleMapsDirectionsUrl(course, origin) {
  const coordinates = mapCoordinates(course);
  const name = String(course?.name || "").trim();
  const loc = String(course?.location || "").trim();
  const destination = coordinates ? `${coordinates.lat},${coordinates.lng}` : [name, loc].filter(Boolean).join(", ");
  if (!destination) return "";
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", destination);
  url.searchParams.set("travelmode", "driving");
  const from = mapCoordinates(origin);
  if (from) url.searchParams.set("origin", `${from.lat},${from.lng}`);
  return url.href;
}

export function rememberLastCourse(course, storage) {
  const store = storage || (typeof localStorage === "undefined" ? null : localStorage);
  if (!store || !course || course.id == null) return;
  try {
    store.setItem(LAST_COURSE_KEY, JSON.stringify({ id: course.id, name: String(course.name || "") }));
  } catch {
    /* private mode */
  }
}

export function readLastCourse(storage) {
  const store = storage || (typeof localStorage === "undefined" ? null : localStorage);
  if (!store) return null;
  try {
    const raw = JSON.parse(store.getItem(LAST_COURSE_KEY) || "null");
    if (!raw || raw.id == null) return null;
    return { id: raw.id, name: String(raw.name || "") };
  } catch {
    return null;
  }
}

export function teeSignCaptureHref(course) {
  const id = course && course.id != null ? String(course.id) : "";
  return id ? `gvdg-members.html?course=${encodeURIComponent(id)}#tee` : "gvdg-members.html#tee";
}

/** Idle list is the nearest mapped courses. Typing, or choosing All, opens the catalog. */
export function coursesForPickScreen(courses, query, range, origin, options = {}) {
  const browsing = !String(query || "").trim();
  const rows = filterCoursesForPick(courses, query, range, origin, options);
  let visible = rows;
  if (browsing && range !== "all" && !options.coverage && !options.favoritesOnly && !options.savedOnly) {
    const mapped = rows.filter((course) => courseHasMap(course));
    visible = (mapped.length ? mapped : rows).slice(0, BROWSE_MAPPED_LIMIT);
    const lastId = options.lastCourseId;
    if (lastId != null) {
      const last = (Array.isArray(courses) ? courses : []).find((course) => String(course.id) === String(lastId));
      if (last) visible = [last, ...visible.filter((course) => String(course.id) !== String(last.id))];
    }
  }
  return visible;
}

export function sortLayoutsForPick(layouts) {
  const rows = Array.isArray(layouts) ? layouts.slice() : [];
  rows.sort((a, b) => COVERAGE_ORDER[layoutQuality(b).status] - COVERAGE_ORDER[layoutQuality(a).status] || compareNames(a, b));
  return rows;
}
