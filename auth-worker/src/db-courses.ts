import type { D1Like } from "./db-types.js";
import { fallbackCourse, fallbackCourses, fallbackLayout, fallbackLayoutNames, fallbackLayouts } from "./course-catalog-fallback.js";
import { readD1OrFallback } from "./d1-retry.js";

export interface CourseInput {
  name: string;
  location?: string | null;
  udisc_url?: string | null;
  udisc_course_id?: string | null;
  lat?: number | null;
  lng?: number | null;
  is_default?: number | boolean | null;
  created_by?: string | null;
}

async function listed<T>(
  operation: () => Promise<{ results: T[] }>,
  fallback: () => T[],
): Promise<{ results: T[]; cacheable: boolean }> {
  let cacheable = true;
  const results = (await readD1OrFallback(operation, () => {
    cacheable = false;
    return { results: fallback(), success: true };
  })).results;
  return { results, cacheable };
}

export async function listCoursesCatalog(db: D1Like) {
  const catalog = await listed(
    () => db.prepare("SELECT * FROM courses ORDER BY is_default DESC, name").all(),
    fallbackCourses,
  );
  const layouts = (await readD1OrFallback(
    () => db.prepare("SELECT id, course_id, holes FROM course_layouts").all(),
    () => ({ results: [], success: true }),
  )).results as { id?: unknown; course_id?: unknown; holes?: unknown }[];
  const consensus = (await readD1OrFallback(
    () => db.prepare("SELECT layout_id, hole, kind, published FROM course_map_consensus WHERE published = 1").all(),
    () => ({ results: [], success: true }),
  )).results as { layout_id?: unknown; hole?: unknown; kind?: unknown; published?: unknown }[];
  return {
    results: withCourseMapFlags(catalog.results, mappedCourseIdsFromSources(layouts, consensus)),
    cacheable: catalog.cacheable,
  };
}

export async function listCourses(db: D1Like) {
  return (await listCoursesCatalog(db)).results;
}

export async function getCourse(db: D1Like, id: number) {
  return readD1OrFallback(
    () => db.prepare("SELECT * FROM courses WHERE id = ?").bind(id).first(),
    () => fallbackCourse(id),
  );
}

export async function createCourse(db: D1Like, c: CourseInput) {
  return db
    .prepare(
      "INSERT INTO courses (name, location, udisc_url, udisc_course_id, lat, lng, is_default, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(
      c.name,
      c.location ?? null,
      c.udisc_url ?? null,
      c.udisc_course_id ?? null,
      c.lat ?? null,
      c.lng ?? null,
      c.is_default ? 1 : 0,
      c.created_by ?? null,
    )
    .first();
}

export async function createCourseIfNew(db: D1Like, c: CourseInput) {
  return db
    .prepare(
      "INSERT OR IGNORE INTO courses (name, location, udisc_url, udisc_course_id, lat, lng, is_default, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(
      c.name,
      c.location ?? null,
      c.udisc_url ?? null,
      c.udisc_course_id ?? null,
      c.lat ?? null,
      c.lng ?? null,
      c.is_default ? 1 : 0,
      c.created_by ?? null,
    )
    .first();
}

export type CoursePatch = { name?: string | null; location?: string | null; udisc_url?: string | null; udisc_course_id?: string | null; lat?: number | null; lng?: number | null };

export async function updateCourse(db: D1Like, id: number, c: CoursePatch) {
  return db
    .prepare(
      "UPDATE courses SET name=COALESCE(?,name), location=COALESCE(?,location), udisc_url=COALESCE(?,udisc_url), udisc_course_id=COALESCE(?,udisc_course_id), lat=COALESCE(?,lat), lng=COALESCE(?,lng) WHERE id=? RETURNING *",
    )
    .bind(c.name ?? null, c.location ?? null, c.udisc_url ?? null, c.udisc_course_id ?? null, c.lat ?? null, c.lng ?? null, id)
    .first();
}

export async function deleteCourse(db: D1Like, id: number) {
  await db.prepare("DELETE FROM courses WHERE id = ?").bind(id).run();
}

export async function listLayoutsCatalog(db: D1Like, courseId: number) {
  return listed(
    () => db.prepare("SELECT * FROM course_layouts WHERE course_id = ? ORDER BY id").bind(courseId).all(),
    () => fallbackLayouts(courseId),
  );
}

export async function listLayouts(db: D1Like, courseId: number) {
  return (await listLayoutsCatalog(db, courseId)).results;
}

export async function createLayout(
  db: D1Like,
  l: { course_id: number; name?: string; holes: unknown; total_par?: number | null },
) {
  const holesJson = JSON.stringify(l.holes ?? []);
  return db
    .prepare("INSERT INTO course_layouts (course_id, name, holes, total_par) VALUES (?, ?, ?, ?) RETURNING *")
    .bind(l.course_id, l.name ?? "Main", holesJson, l.total_par ?? null)
    .first();
}

export async function getLayout(db: D1Like, id: number) {
  return readD1OrFallback(
    () => db.prepare("SELECT * FROM course_layouts WHERE id = ?").bind(id).first(),
    () => fallbackLayout(id),
  );
}

export interface HoleMarker {
  label: string | null;
  lat: number | null;
  lng: number | null;
}

export interface ScorableHole {
  hole: number;
  par: number;
  distance_ft: number | null;
  tee_sign_id: number | null;
  tee: HoleMarker | null;
  target: HoleMarker | null;
}

function finiteCoord(value: unknown): number | null {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function holeMarker(value: unknown): HoleMarker | null {
  if (!value || typeof value !== "object") return null;
  const source = value as { label?: unknown; lat?: unknown; lng?: unknown };
  const label = typeof source.label === "string" && source.label.trim() ? source.label.trim() : null;
  const lat = finiteCoord(source.lat);
  const lng = finiteCoord(source.lng);
  if (!label && lat == null && lng == null) return null;
  return { label, lat, lng };
}

export function parseScorableHoles(holesJson: string | unknown): ScorableHole[] {
  let rows: unknown = holesJson;
  if (typeof holesJson === "string") {
    try {
      rows = JSON.parse(holesJson || "[]");
    } catch {
      return [];
    }
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === "object")
    .map((row) => {
      const hole = row as {
        hole?: unknown;
        par?: unknown;
        distance_ft?: unknown;
        verified?: { tee_sign_id?: number | null } | null;
        tee_sign_id?: number | null;
        tee?: unknown;
        target?: unknown;
      };
      return {
        hole: Number(hole.hole),
        par: Number(hole.par),
        distance_ft: hole.distance_ft == null ? null : Number(hole.distance_ft),
        tee_sign_id: hole.verified?.tee_sign_id ?? hole.tee_sign_id ?? null,
        tee: holeMarker(hole.tee),
        target: holeMarker(hole.target),
      };
    })
    .filter((hole) => Number.isFinite(hole.hole) && Number.isFinite(hole.par));
}

export function layoutHasSatelliteMap(holesJson: unknown): boolean {
  return parseScorableHoles(holesJson).some(
    (hole) =>
      hole.tee?.lat != null &&
      hole.tee?.lng != null &&
      hole.target?.lat != null &&
      hole.target?.lng != null,
  );
}

export function mappedCourseIdsFromSources(
  layouts: { id?: unknown; course_id?: unknown; holes?: unknown }[],
  consensus: { layout_id?: unknown; hole?: unknown; kind?: unknown; published?: unknown }[] = [],
): Set<number> {
  const mapped = new Set<number>();
  const layoutCourse = new Map<number, number>();
  for (const layout of layouts) {
    const courseId = Number(layout.course_id);
    const layoutId = Number(layout.id);
    if (Number.isInteger(courseId) && Number.isInteger(layoutId)) layoutCourse.set(layoutId, courseId);
    if (Number.isInteger(courseId) && layoutHasSatelliteMap(layout.holes)) mapped.add(courseId);
  }
  const published = new Map<string, Set<string>>();
  for (const row of consensus) {
    if (Number(row.published) !== 1 && row.published !== true) continue;
    const kind = row.kind === "tee" || row.kind === "target" ? row.kind : null;
    const layoutId = Number(row.layout_id);
    const hole = Number(row.hole);
    if (!kind || !Number.isInteger(layoutId) || !Number.isInteger(hole)) continue;
    const key = `${layoutId}:${hole}`;
    const kinds = published.get(key) ?? new Set<string>();
    kinds.add(kind);
    published.set(key, kinds);
  }
  for (const [key, kinds] of published) {
    if (!kinds.has("tee") || !kinds.has("target")) continue;
    const layoutId = Number(key.split(":")[0]);
    const courseId = layoutCourse.get(layoutId);
    if (courseId != null) mapped.add(courseId);
  }
  return mapped;
}

export function withCourseMapFlags<T extends { id?: unknown }>(courses: T[], mappedIds: Set<number>): T[] {
  return courses.map((course) => ({
    ...course,
    mapped: mappedIds.has(Number(course.id)) ? 1 : 0,
  })) as T[];
}

export async function getLayoutHoles(db: D1Like, layoutId: number | null | undefined): Promise<ScorableHole[]> {
  if (!layoutId) return [];
  const layout = (await getLayout(db, Number(layoutId))) as { holes?: string } | null;
  return parseScorableHoles(layout?.holes ?? "[]");
}

export async function updateLayout(
  db: D1Like,
  id: number,
  l: { name?: string | null; holes?: unknown; total_par?: number | null },
) {
  const holesJson = l.holes === undefined ? null : JSON.stringify(l.holes ?? []);
  return db
    .prepare(
      "UPDATE course_layouts SET name=COALESCE(?,name), holes=COALESCE(?,holes), total_par=COALESCE(?,total_par) WHERE id=? RETURNING *",
    )
    .bind(l.name ?? null, holesJson, l.total_par ?? null, id)
    .first();
}

export async function deleteLayout(db: D1Like, id: number) {
  await db.prepare("DELETE FROM course_layouts WHERE id = ?").bind(id).run();
}

export const POSITION_KINDS = ["tee", "target"] as const;
export type PositionKind = (typeof POSITION_KINDS)[number];

export interface PositionInput {
  course_id: number;
  kind: PositionKind;
  label: string;
  lat?: number | null;
  lng?: number | null;
  color?: string | null;
}

export async function listPositionsCatalog(db: D1Like, courseId: number, kind?: PositionKind) {
  let sql = "SELECT * FROM course_positions WHERE course_id = ?";
  const binds: unknown[] = [courseId];
  if (kind) { sql += " AND kind = ?"; binds.push(kind); }
  sql += " ORDER BY kind, id";
  return listed(
    () => db.prepare(sql).bind(...binds).all(),
    () => [],
  );
}

export async function listPositions(db: D1Like, courseId: number, kind?: PositionKind) {
  return (await listPositionsCatalog(db, courseId, kind)).results;
}

export async function createPosition(db: D1Like, p: PositionInput) {
  return db
    .prepare("INSERT INTO course_positions (course_id, kind, label, lat, lng, color) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(p.course_id, p.kind, p.label, p.lat ?? null, p.lng ?? null, p.color ?? null)
    .first();
}

export async function deletePosition(db: D1Like, courseId: number, id: number) {
  await db.prepare("DELETE FROM course_positions WHERE id = ? AND course_id = ?").bind(id, courseId).run();
}

export async function replacePositions(db: D1Like, courseId: number, positions: PositionInput[]) {
  await db.prepare("DELETE FROM course_positions WHERE course_id = ?").bind(courseId).run();
  for (const p of positions) {
    await db
      .prepare("INSERT INTO course_positions (course_id, kind, label, lat, lng) VALUES (?, ?, ?, ?, ?)")
      .bind(courseId, p.kind, p.label, p.lat ?? null, p.lng ?? null)
      .run();
  }
  return listPositions(db, courseId);
}

export function normalizeLayoutLabel(label: unknown): string {
  return String(label ?? "").toLowerCase().replace(/\b(tees?|layout|pads?)\b/g, "").replace(/\s+/g, " ").trim();
}

export function defaultLayoutName(label: unknown): string {
  const n = normalizeLayoutLabel(label);
  if (n === "long") return "Long";
  if (n === "short") return "Short";
  if (!n) return "Main";
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export async function listLayoutNames(db: D1Like, courseId: number): Promise<{ id: number; name: string }[]> {
  return (await readD1OrFallback(
    () => db.prepare("SELECT id, name FROM course_layouts WHERE course_id = ?").bind(courseId).all<{ id: number; name: string }>(),
    () => ({ results: fallbackLayoutNames(courseId), success: true }),
  )).results;
}

export function matchLayoutIn(rows: { id: number; name: string }[], label: unknown): { id: number; name: string } | null {
  const want = normalizeLayoutLabel(label) || normalizeLayoutLabel(defaultLayoutName(label));
  for (const r of rows) if (normalizeLayoutLabel(r.name) === want) return { id: r.id, name: r.name };
  return null;
}

export async function matchLayout(db: D1Like, courseId: number, label: unknown): Promise<{ id: number; name: string } | null> {
  return matchLayoutIn(await listLayoutNames(db, courseId), label);
}

export async function ensureDefaultLayouts(db: D1Like, courseId: number) {
  for (const name of ["Long", "Short"]) {
    if (!(await matchLayout(db, courseId, name))) {
      await createLayout(db, { course_id: courseId, name, holes: [], total_par: null });
    }
  }
}
