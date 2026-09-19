import type { D1Like } from "./db-types.js";
import { getLayoutHoles, type ScorableHole } from "./db-courses.js";
import { applyMapConsensus, computeMapConsensus, type MapConsensus, type MapMarkKind, type MapMarkSample } from "./course-map-marks.js";
import { readD1OrFallback } from "./d1-retry.js";

export interface CourseMapMarkInput {
  course_id: number;
  layout_id: number;
  hole: number;
  kind: MapMarkKind;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  member_id: string;
  round_code?: string | null;
}

function asConsensus(row: Record<string, unknown> | null): MapConsensus | null {
  if (!row) return null;
  const hole = Number(row.hole);
  const kind = row.kind === "tee" || row.kind === "target" ? row.kind : null;
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  if (!Number.isInteger(hole) || !kind || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    hole,
    kind,
    lat,
    lng,
    samples: Number(row.samples) || 0,
    members: Number(row.members) || 0,
    spread_m: row.spread_m == null ? null : Number(row.spread_m),
    published: Number(row.published) === 1,
  };
}

export async function upsertCourseMapMark(db: D1Like, input: CourseMapMarkInput) {
  return db
    .prepare(
      `INSERT INTO course_map_marks (course_id, layout_id, hole, kind, lat, lng, accuracy_m, member_id, round_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(layout_id, hole, kind, member_id) DO UPDATE SET
         lat = excluded.lat,
         lng = excluded.lng,
         accuracy_m = excluded.accuracy_m,
         round_code = excluded.round_code,
         created_at = datetime('now')
       RETURNING *`,
    )
    .bind(
      input.course_id,
      input.layout_id,
      input.hole,
      input.kind,
      input.lat,
      input.lng,
      input.accuracy_m,
      input.member_id,
      input.round_code ?? null,
    )
    .first();
}

export async function listCourseMapMarks(db: D1Like, layoutId: number, hole: number, kind: MapMarkKind): Promise<MapMarkSample[]> {
  const rows = (await readD1OrFallback(
    () =>
      db
        .prepare(
          `SELECT member_id, lat, lng, accuracy_m
             FROM course_map_marks
            WHERE layout_id = ? AND hole = ? AND kind = ?`,
        )
        .bind(layoutId, hole, kind)
        .all(),
    () => ({ results: [], success: true }),
  )).results as Record<string, unknown>[];
  return rows.map((row) => ({
    member_id: String(row.member_id || ""),
    lat: Number(row.lat),
    lng: Number(row.lng),
    accuracy_m: row.accuracy_m == null ? null : Number(row.accuracy_m),
  })).filter((row) => row.member_id && Number.isFinite(row.lat) && Number.isFinite(row.lng));
}

export async function saveCourseMapConsensus(db: D1Like, row: MapConsensus, layoutId: number) {
  return db
    .prepare(
      `INSERT INTO course_map_consensus (layout_id, hole, kind, lat, lng, samples, members, spread_m, published, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(layout_id, hole, kind) DO UPDATE SET
         lat = excluded.lat,
         lng = excluded.lng,
         samples = excluded.samples,
         members = excluded.members,
         spread_m = excluded.spread_m,
         published = excluded.published,
         updated_at = datetime('now')`,
    )
    .bind(layoutId, row.hole, row.kind, row.lat, row.lng, row.samples, row.members, row.spread_m, row.published ? 1 : 0)
    .run();
}

export async function recomputeCourseMapConsensus(db: D1Like, layoutId: number, hole: number, kind: MapMarkKind): Promise<MapConsensus> {
  const samples = await listCourseMapMarks(db, layoutId, hole, kind);
  const consensus = computeMapConsensus(hole, kind, samples);
  if (samples.length) await saveCourseMapConsensus(db, consensus, layoutId);
  return consensus;
}

export async function listPublishedConsensus(db: D1Like, layoutId: number): Promise<MapConsensus[]> {
  const rows = (await readD1OrFallback(
    () =>
      db
        .prepare(
          `SELECT hole, kind, lat, lng, samples, members, spread_m, published
             FROM course_map_consensus
            WHERE layout_id = ? AND published = 1`,
        )
        .bind(layoutId)
        .all(),
    () => ({ results: [], success: true }),
  )).results as Record<string, unknown>[];
  return rows.map((row) => asConsensus(row)).filter((row): row is MapConsensus => Boolean(row));
}

export async function layoutHolesWithCrowdMap(db: D1Like, layoutId: number | null | undefined): Promise<ScorableHole[]> {
  const holes = await getLayoutHoles(db, layoutId);
  if (!layoutId || !holes.length) return holes;
  const consensus = await listPublishedConsensus(db, Number(layoutId));
  return applyMapConsensus(holes, consensus);
}
