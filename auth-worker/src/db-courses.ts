import type { D1Like } from "./db-types.js";
import { fallbackCourse, fallbackCourses, fallbackLayout, fallbackLayoutNames, fallbackLayouts } from "./course-catalog-fallback.js";
import { readD1OrFallback } from "./d1-retry.js";
import { bustCourseCatalogCache } from "./course-catalog-cache.js";
import { COVERAGE_ORDER, layoutQuality, layoutRevision, layoutRows, mapCoordinates, type Coverage, type Quality } from "../../src/shared/course-quality.js";

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
  timeoutMs?: number,
): Promise<{ results: T[]; cacheable: boolean }> {
  let cacheable = true;
  const results = (await readD1OrFallback(operation, () => {
    cacheable = false;
    return { results: fallback(), success: true };
  }, timeoutMs)).results;
  return { results, cacheable };
}

/** The whole catalog is three bulk reads; give them more room than a single-row read before falling back. */
const CATALOG_READ_TIMEOUT_MS = 4_000;

/** Course, layout and published-map writes change GET /courses: drop the edge copy (best effort). */
function recordCourseId(row: unknown): number | null {
  if (!row || typeof row !== "object") return null;
  const id = Number((row as { id?: unknown }).id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function layoutCourseId(row: unknown): number | null {
  if (!row || typeof row !== "object") return null;
  const cid = Number((row as { course_id?: unknown }).course_id);
  return Number.isInteger(cid) && cid > 0 ? cid : null;
}

async function afterCatalogWrite<T>(
  write: Promise<T>,
  courseId?: number | null | ((result: T) => number | null),
): Promise<T> {
  const result = await write;
  const cid = typeof courseId === "function" ? courseId(result) : courseId;
  try { await bustCourseCatalogCache(cid); } catch { /* the 60s freshness window still bounds staleness */ }
  return result;
}

type DirectoryCourse = Record<string, unknown> & { id: number; name: string };

export async function listCoursesCatalog(db: D1Like) {
  const catalog = await listed(
    () => db.prepare("SELECT * FROM courses ORDER BY is_default DESC, name").all<DirectoryCourse>(),
    fallbackCourses,
    CATALOG_READ_TIMEOUT_MS,
  );
  // A catalog is only cacheable when every read was real: a layouts or map-marks fallback used to be cached
  // (every course with empty layouts / looking unmapped) and then served as if it were good.
  let complete = catalog.cacheable;
  const layouts = (await readD1OrFallback(
    () => db.prepare("SELECT * FROM course_layouts").all(),
    () => {
      complete = false;
      return { results: catalog.results.flatMap((course) => fallbackLayouts(Number(course.id))), success: true };
    },
    CATALOG_READ_TIMEOUT_MS,
  )).results;
  const consensus = await publishedCatalogMapMarks(db, undefined, () => { complete = false; }, CATALOG_READ_TIMEOUT_MS);
  const summaries = courseCoverageSummaries(layouts, consensus);
  return {
    results: catalog.results.map((course) => {
      const summary = summaries.get(Number(course.id));
      return {
        ...course,
        // Existing importer metrics use mapped to mean at least one usable tee/basket pair.
        mapped: summary?.mappedHoles ? 1 : 0,
        coverage: summary?.coverage ?? "listed",
        layouts: summary?.layouts ?? [],
      };
    }),
    cacheable: complete,
  };
}

type CatalogRow = Record<string, unknown>;
type PublicCatalogLayout = CatalogRow & { quality: Quality; revision: string; map_updated_at: string | null; map_holes?: unknown[] };

async function publishedCatalogMapMarks(db: D1Like, courseId?: number, onFallback?: () => void, timeoutMs?: number): Promise<CatalogRow[]> {
  const sql = `SELECT cm.layout_id, cm.hole, cm.kind, cm.lat, cm.lng, cm.updated_at
      FROM course_map_consensus cm JOIN course_layouts l ON l.id = cm.layout_id
      WHERE cm.published = 1` + (courseId == null ? "" : " AND l.course_id = ?");
  return (await readD1OrFallback(
    () => db.prepare(sql).bind(...(courseId == null ? [] : [courseId])).all(),
    () => {
      onFallback?.();
      return { results: [], success: true };
    },
    timeoutMs,
  )).results;
}

function marksByLayout(rows: CatalogRow[]) {
  const layouts = new Map<number, Map<string, CatalogRow>>();
  for (const row of rows) {
    if (!mapCoordinates(row) || (row.kind !== "tee" && row.kind !== "target")) continue;
    const id = Number(row.layout_id);
    const holes = layouts.get(id) ?? new Map<string, CatalogRow>();
    holes.set(String(row.hole) + ":" + String(row.kind), row);
    layouts.set(id, holes);
  }
  return layouts;
}

function catalogLayout(layout: CatalogRow, marks: Map<string, CatalogRow> | undefined): PublicCatalogLayout {
  let mapUpdatedAt: string | null = null;
  const mapHoles = marks?.size ? layoutRows(layout).map((row) => {
    if (!row || typeof row !== "object") return row;
    const hole = row as CatalogRow;
    const updated = { ...hole };
    for (const kind of ["tee", "target"] as const) {
      const mark = marks.get(String(hole.hole) + ":" + kind);
      const coordinates = mapCoordinates(mark);
      if (!mark || !coordinates) continue;
      const stored = holeMarker(hole[kind]);
      updated[kind] = { ...coordinates, label: stored?.label ?? (kind === "tee" ? "Tee" : "Basket"), source: "community" };
      if (typeof mark.updated_at === "string" && (!mapUpdatedAt || mark.updated_at > mapUpdatedAt)) mapUpdatedAt = mark.updated_at;
    }
    return updated;
  }) : null;
  // Keep the unmodified holes field for existing editors and expose the public map separately.
  const effective = mapHoles ? { ...layout, map_holes: mapHoles } : layout;
  return { ...effective, quality: layoutQuality(effective), revision: layoutRevision(effective), map_updated_at: mapUpdatedAt };
}

export function courseCoverageSummaries(layouts: CatalogRow[], marks: CatalogRow[]) {
  type Summary = { coverage: Coverage; mappedHoles: number; layouts: {
    id: unknown; name: unknown; coverage: Coverage; updated_at: string | null; expected_holes: number | null;
  }[] };
  const courses = new Map<number, Summary>();
  const byLayout = marksByLayout(marks);
  for (const layout of layouts) {
    const courseId = Number(layout.course_id);
    if (!Number.isSafeInteger(courseId) || courseId <= 0) continue;
    const { quality, map_updated_at } = catalogLayout(layout, byLayout.get(Number(layout.id)));
    const current = courses.get(courseId) ?? { coverage: "listed", mappedHoles: 0, layouts: [] };
    if (COVERAGE_ORDER[quality.status] > COVERAGE_ORDER[current.coverage]) current.coverage = quality.status;
    current.mappedHoles += quality.mappedCount;
    const updated = [layout.updated_at, map_updated_at].filter((value): value is string => typeof value === "string").sort().at(-1);
    current.layouts.push({ id: layout.id, name: layout.name, coverage: quality.status, updated_at: updated ?? null,
      expected_holes: typeof layout.expected_holes === "number" ? layout.expected_holes : null });
    courses.set(courseId, current);
  }
  return courses;
}

export async function listPublicLayoutsCatalog(db: D1Like, courseId: number) {
  const [catalog, marks] = await Promise.all([listLayoutsCatalog(db, courseId), publishedCatalogMapMarks(db, courseId)]);
  const byLayout = marksByLayout(marks);
  return {
    ...catalog,
    results: catalog.results.map((layout) => catalogLayout(layout, byLayout.get(Number(layout.id)))),
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
  return afterCatalogWrite(db
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
    .first(), recordCourseId);
}

export async function createCourseIfNew(db: D1Like, c: CourseInput) {
  return afterCatalogWrite(db
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
    .first(), recordCourseId);
}

export type CoursePatch = { name?: string | null; location?: string | null; udisc_url?: string | null; udisc_course_id?: string | null; lat?: number | null; lng?: number | null };

export async function updateCourse(db: D1Like, id: number, c: CoursePatch) {
  return afterCatalogWrite(db
    .prepare(
      "UPDATE courses SET name=COALESCE(?,name), location=COALESCE(?,location), udisc_url=COALESCE(?,udisc_url), udisc_course_id=COALESCE(?,udisc_course_id), lat=COALESCE(?,lat), lng=COALESCE(?,lng) WHERE id=? RETURNING *",
    )
    .bind(c.name ?? null, c.location ?? null, c.udisc_url ?? null, c.udisc_course_id ?? null, c.lat ?? null, c.lng ?? null, id)
    .first(), id);
}

export async function updateCourseUdiscUrls(db: D1Like, rows: readonly { id: number; udisc_url: string }[]): Promise<void> {
  if (!rows.length) return;
  const stmts = rows.map((row) => db.prepare("UPDATE courses SET udisc_url = ? WHERE id = ?").bind(row.udisc_url, row.id));
  await afterCatalogWrite((async () => {
    for (let i = 0; i < stmts.length; i += 45) {
      const chunk = stmts.slice(i, i + 45);
      if (typeof db.batch === "function") await db.batch(chunk);
      else for (const stmt of chunk) await stmt.run();
    }
  })());
}

export async function deleteCourse(db: D1Like, id: number) {
  await afterCatalogWrite(db.prepare("DELETE FROM courses WHERE id = ?").bind(id).run(), id);
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
  l: { course_id: number; name?: string; holes: unknown; total_par?: number | null; expected_holes?: number },
) {
  const holesJson = JSON.stringify(l.holes ?? []);
  if (l.expected_holes != null) {
    return afterCatalogWrite(db.prepare("INSERT INTO course_layouts (course_id, name, holes, total_par, expected_holes) VALUES (?, ?, ?, ?, ?) RETURNING *")
      .bind(l.course_id, l.name ?? "Main", holesJson, l.total_par ?? null, l.expected_holes)
      .first(), l.course_id);
  }
  return afterCatalogWrite(db
    .prepare("INSERT INTO course_layouts (course_id, name, holes, total_par) VALUES (?, ?, ?, ?) RETURNING *")
    .bind(l.course_id, l.name ?? "Main", holesJson, l.total_par ?? null)
    .first(), l.course_id);
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
  source?: string | null;
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
  const markerObj = value as { label?: unknown; lat?: unknown; lng?: unknown; source?: unknown };
  const label = typeof markerObj.label === "string" && markerObj.label.trim() ? markerObj.label.trim() : null;
  const lat = finiteCoord(markerObj.lat);
  const lng = finiteCoord(markerObj.lng);
  if (!label && lat == null && lng == null) return null;
  const source = typeof markerObj.source === "string" && markerObj.source.trim() ? markerObj.source.trim() : null;
  return source ? { label, lat, lng, source } : { label, lat, lng };
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
  l: { name?: string | null; holes?: unknown; total_par?: number | null; expected_holes?: number | null },
) {
  const holesJson = l.holes === undefined ? null : JSON.stringify(l.holes ?? []);
  if (l.expected_holes !== undefined) {
    return afterCatalogWrite(db.prepare(
      "UPDATE course_layouts SET name=COALESCE(?,name), holes=COALESCE(?,holes), total_par=COALESCE(?,total_par), expected_holes=? WHERE id=? RETURNING *",
    ).bind(l.name ?? null, holesJson, l.total_par ?? null, l.expected_holes, id).first(), layoutCourseId);
  }
  return afterCatalogWrite(db
    .prepare(
      "UPDATE course_layouts SET name=COALESCE(?,name), holes=COALESCE(?,holes), total_par=COALESCE(?,total_par) WHERE id=? RETURNING *",
    )
    .bind(l.name ?? null, holesJson, l.total_par ?? null, id)
    .first(), layoutCourseId);
}

export async function deleteLayout(db: D1Like, id: number) {
  await afterCatalogWrite(db.prepare("DELETE FROM course_layouts WHERE id = ?").bind(id).run());
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
  return afterCatalogWrite(
    db
      .prepare("INSERT INTO course_positions (course_id, kind, label, lat, lng, color) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
      .bind(p.course_id, p.kind, p.label, p.lat ?? null, p.lng ?? null, p.color ?? null)
      .first(),
    p.course_id,
  );
}

export async function deletePosition(db: D1Like, courseId: number, id: number) {
  await afterCatalogWrite(db.prepare("DELETE FROM course_positions WHERE id = ? AND course_id = ?").bind(id, courseId).run(), courseId);
}

export async function replacePositions(db: D1Like, courseId: number, positions: PositionInput[]) {
  const statements = [db.prepare("DELETE FROM course_positions WHERE course_id = ?").bind(courseId)];
  for (let i = 0; i < positions.length; i += 18) {
    const chunk = positions.slice(i, i + 18);
    statements.push(
      db.prepare(
        `INSERT INTO course_positions (course_id, kind, label, lat, lng) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      ).bind(...chunk.flatMap((p) => [courseId, p.kind, p.label, p.lat ?? null, p.lng ?? null])),
    );
  }
  await afterCatalogWrite((async () => {
    for (let i = 0; i < statements.length; i += 45) {
      const chunk = statements.slice(i, i + 45);
      if (typeof db.batch === "function") await db.batch(chunk);
      else for (const stmt of chunk) await stmt.run();
    }
  })(), courseId);
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
