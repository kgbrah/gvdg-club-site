export function courseTrafficMatch(courses, course) {
  const rows = Array.isArray(courses) ? courses : [];
  const id = course && course.id != null ? String(course.id) : "";
  if (id) {
    const byId = rows.find((row) => row && row.courseId != null && String(row.courseId) === id);
    if (byId) return byId;
  }
  const name = String((course && course.name) || "").trim().toLowerCase();
  if (!name) return null;
  return rows.find((row) => String((row && row.name) || "").trim().toLowerCase() === name) || null;
}

export function trafficSummary(row) {
  if (!row || !row.groups) return "";
  const groups = row.groups === 1 ? "1 group" : row.groups + " groups";
  const players = row.players === 1 ? "1 player" : row.players + " players";
  const holes = Array.isArray(row.holes) ? row.holes : [];
  const busiest = holes.slice().sort((a, b) => (b.groups - a.groups) || (a.hole - b.hole))[0];
  const where = busiest && busiest.groups ? " · hole " + busiest.hole : "";
  return groups + " · " + players + where;
}

export function trafficHoleLine(row) {
  const holes = Array.isArray(row && row.holes) ? row.holes.slice() : [];
  holes.sort((a, b) => a.hole - b.hole);
  return holes.map((hole) => {
    if (!hole) return "";
    if (hole.groups) return "H" + hole.hole + " · " + (hole.groups === 1 ? "1 group" : hole.groups + " groups");
    const players = Number(hole.players) || 0;
    if (!players) return "";
    return "H" + hole.hole + " · " + (players === 1 ? "1 player" : players + " players");
  }).filter(Boolean).join("   ");
}
