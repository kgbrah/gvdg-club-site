// Course search and "where am I" for the Lost & Found forms: rank courses by a typed search and by distance, find
// the course and the hole a player is standing on (the hole whose tee-to-basket line is closest), and pick a course
// named in a voice transcript. The player's position never leaves the phone: everything here runs on the page
// against the public course list. Pure: node-tested in tests/course-geo.test.mjs.

const EARTH_M = 6_371_000;
/** Close enough to say you're at the course (course pins sit at the parking lot or the first tee). */
export const AT_COURSE_M = 2_000;
/** Close enough to a hole's tee-to-basket line to call it that hole (discs end up in the rough). */
export const ON_HOLE_M = 150;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function point(value) {
  const lat = finite(value?.lat);
  const lng = finite(value?.lng);
  return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0) ? { lat, lng } : null;
}

export function distanceMeters(a, b) {
  const from = point(a);
  const to = point(b);
  if (!from || !to) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (to.lat - from.lat) * rad;
  const dLng = (to.lng - from.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Metres from p to the segment a–b (flat-earth: fine at hole scale). */
export function distanceToSegment(p, a, b) {
  const here = point(p);
  const start = point(a);
  const end = point(b);
  if (!here) return Infinity;
  if (!start || !end) return Math.min(distanceMeters(here, start), distanceMeters(here, end));
  const rad = Math.PI / 180;
  const kx = Math.cos(here.lat * rad) * rad * EARTH_M;
  const ky = rad * EARTH_M;
  const ax = (start.lng - here.lng) * kx, ay = (start.lat - here.lat) * ky;
  const bx = (end.lng - here.lng) * kx, by = (end.lat - here.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** "0.3 mi", "12 mi", or "Here" when you're at it. */
export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "";
  if (meters < 400) return "Here";
  const miles = meters / 1609.344;
  return (miles < 10 ? miles.toFixed(1) : String(Math.round(miles))) + " mi";
}

export function nearestCourse(courses, here, within = AT_COURSE_M) {
  let best = null;
  for (const course of courses || []) {
    const meters = distanceMeters(here, course);
    if (meters <= within && (!best || meters < best.meters)) best = { course, meters };
  }
  return best;
}

/** Every hole with its tee and basket, across a course's layouts (from /courses/:id/layouts). */
export function layoutHoles(layouts) {
  const out = [];
  for (const layout of Array.isArray(layouts) ? layouts : []) {
    let holes = layout?.holes;
    if (typeof holes === "string") {
      try { holes = JSON.parse(holes); } catch { holes = []; }
    }
    if (!Array.isArray(holes)) continue;
    for (const row of holes) {
      const hole = Number(row?.hole);
      if (Number.isInteger(hole) && hole >= 1 && hole <= 40) out.push({ hole, tee: point(row.tee), target: point(row.target) });
    }
  }
  return out;
}

export function holeCount(layouts) {
  const holes = layoutHoles(layouts);
  return holes.length ? Math.max(...holes.map((row) => row.hole)) : 0;
}

/** The hole whose tee-to-basket line is closest to you, when you're within ON_HOLE_M of it. */
export function nearestHole(holes, here, within = ON_HOLE_M) {
  let best = null;
  for (const row of holes || []) {
    if (!row.tee && !row.target) continue;
    const meters = distanceToSegment(here, row.tee, row.target);
    if (meters <= within && (!best || meters < best.meters)) best = { hole: row.hole, meters };
  }
  return best;
}

// ---- Search ----

const STOP = new Set(["disc", "golf", "course", "dgc", "dg", "park", "the", "at", "of", "and", "recreation", "rec", "complex", "center", "centre",
  "area", "club", "county", "city", "state", "community", "sports", "field", "fields"]);

export function words(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()
    .split(" ").filter(Boolean);
}

/**
 * Courses for a typed search, best first: name starts with it, then every word matches the start of a name or town
 * word; ties go to the nearest (when `here` is known), then A–Z. An empty search lists the nearest courses.
 */
export function searchCourses(courses, query, here = null, limit = 8) {
  const terms = words(query);
  const rows = [];
  for (const course of courses || []) {
    const meters = here ? distanceMeters(here, course) : Infinity;
    if (!terms.length) {
      if (Number.isFinite(meters)) rows.push({ course, meters, score: 0 });
      continue;
    }
    const nameWords = words(course.name);
    const placeWords = words(course.location);
    const name = nameWords.join(" ");
    const all = [...nameWords, ...placeWords];
    let score = 0;
    if (name.startsWith(terms.join(" "))) score = 3;
    else if (terms.every((term) => nameWords.some((word) => word.startsWith(term)))) score = 2;
    else if (terms.every((term) => all.some((word) => word.startsWith(term)))) score = 1;
    if (score) rows.push({ course, meters, score });
  }
  rows.sort((a, b) => b.score - a.score || a.meters - b.meters || String(a.course.name).localeCompare(String(b.course.name)));
  return rows.slice(0, limit);
}

// ---- Voice ----

/**
 * The course named in a voice transcript ("…found it on hole 7 at Elm Street"), or null. A course matches when its
 * whole name is said, or every distinctive word of it (two or more), or its one distinctive word right after "at".
 * Several equally good matches: the nearest one when `here` is known, else none (better blank than wrong).
 */
export function matchSpokenCourse(transcript, courses, here = null) {
  const said = words(transcript);
  if (!said.length) return null;
  const text = " " + said.join(" ") + " ";
  let best = [];
  let bestScore = 0;
  for (const course of courses || []) {
    const nameWords = words(course.name).filter((word, index) => !(index === 0 && word === "the"));
    if (!nameWords.length) continue;
    const distinct = nameWords.filter((word) => !STOP.has(word) && word.length >= 3);
    let score = 0;
    if (text.includes(" " + nameWords.join(" ") + " ") && (distinct.length || nameWords.length >= 2)) score = 10 + nameWords.length;
    else if (distinct.length >= 2 && distinct.every((word) => said.includes(word))) score = 5 + distinct.length;
    else if (distinct.length === 1 && distinct[0].length >= 4 && text.includes(" at " + distinct[0] + " ")) score = 4;
    if (!score) continue;
    if (score > bestScore) { best = [course]; bestScore = score; } else if (score === bestScore) best.push(course);
  }
  if (best.length === 1) return best[0];
  if (best.length > 1 && here) {
    const ranked = best.map((course) => ({ course, meters: distanceMeters(here, course) })).sort((a, b) => a.meters - b.meters);
    if (Number.isFinite(ranked[0].meters) && ranked[0].meters < (ranked[1]?.meters ?? Infinity)) return ranked[0].course;
  }
  return null;
}
