export const CLUB_ORIGIN = { lat: 35.6127, lng: -77.3664 };
export const COURSE_RANGES = [
  { value: "nearby", label: "100 mi", miles: 100 },
  { value: "daytrip", label: "150 mi", miles: 150 },
  { value: "all", label: "All", miles: Infinity },
];

function courseCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function finiteCoord(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function milesFromClub(course, origin = CLUB_ORIGIN) {
  return milesFromOrigin(course, origin);
}

export function milesFromOrigin(course, origin) {
  if (!origin) return null;
  const lat = courseCoord(course && course.lat);
  const lng = courseCoord(course && course.lng);
  const fromLat = courseCoord(origin.lat);
  const fromLng = courseCoord(origin.lng);
  if (lat == null || lng == null || fromLat == null || fromLng == null) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat - fromLat);
  const dLng = toRad(lng - fromLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(fromLat)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function layoutHasMap(layout) {
  let holes = layout && layout.holes;
  if (typeof holes === "string") {
    try {
      holes = JSON.parse(holes);
    } catch {
      holes = [];
    }
  }
  if (!Array.isArray(holes)) return false;
  return holes.some((hole) => {
    const tee = hole && hole.tee;
    const target = hole && hole.target;
    return (
      finiteCoord(tee && tee.lat) != null &&
      finiteCoord(tee && tee.lng) != null &&
      finiteCoord(target && target.lat) != null &&
      finiteCoord(target && target.lng) != null
    );
  });
}

export function courseHasMap(course) {
  if (!course) return false;
  if (course.mapped === true || course.mapped === 1 || course.mapped === "1") return true;
  if (course.has_map === true || course.has_map === 1) return true;
  if (Array.isArray(course.layouts) && course.layouts.some(layoutHasMap)) return true;
  return layoutHasMap(course);
}

function compareNames(a, b) {
  return String((a && a.name) || "").localeCompare(String((b && b.name) || ""));
}

export function filterCoursesForPick(courses, query, range, origin) {
  const q = String(query || "").trim().toLowerCase();
  const maxMiles = (COURSE_RANGES.find((option) => option.value === range) || COURSE_RANGES[0]).miles;
  const rows = (Array.isArray(courses) ? courses : []).map((course) => ({
    course,
    miles: milesFromOrigin(course, origin),
    mapped: courseHasMap(course),
  }));
  const matched = rows.filter(({ course, miles }) => {
    if (q) {
      const hay = `${course.name || ""} ${course.location || ""}`.toLowerCase();
      return hay.includes(q);
    }
    if (maxMiles === Infinity || !origin) return true;
    return miles != null && miles <= maxMiles;
  });
  matched.sort((a, b) => {
    if (a.mapped !== b.mapped) return a.mapped ? -1 : 1;
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
  const lat = courseCoord(course && course.lat);
  const lng = courseCoord(course && course.lng);
  const name = String((course && course.name) || "").trim();
  const loc = String((course && course.location) || "").trim();
  const destination = lat != null && lng != null ? `${lat},${lng}` : [name, loc].filter(Boolean).join(", ");
  if (!destination) return "";
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", destination);
  url.searchParams.set("travelmode", "driving");
  const fromLat = origin && courseCoord(origin.lat);
  const fromLng = origin && courseCoord(origin.lng);
  if (fromLat != null && fromLng != null) url.searchParams.set("origin", `${fromLat},${fromLng}`);
  return url.href;
}

export function sortLayoutsForPick(layouts) {
  const rows = Array.isArray(layouts) ? layouts.slice() : [];
  rows.sort((a, b) => {
    const mapA = layoutHasMap(a);
    const mapB = layoutHasMap(b);
    if (mapA !== mapB) return mapA ? -1 : 1;
    return compareNames(a, b);
  });
  return rows;
}
