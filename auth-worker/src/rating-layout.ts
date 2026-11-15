import { mapCoordinates, mappedHole } from "../../src/shared/course-quality.js";

type UnknownRow = Record<string, unknown>;
export type ArchivedRatingHole = {
  hole: number; par: number; strokes?: number; tee?: unknown; target?: unknown; distanceFt: number | null;
  hasSnapshot: boolean; layoutId: number | null; courseId: number | null; startedAt: string | null;
};

export function ratingRecord(raw: unknown): UnknownRow {
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { return {}; }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UnknownRow : {};
}

export function ratingNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export function ratingTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  const calendarDay = raw.slice(0, 10);
  const day = new Date(calendarDay + "T00:00:00Z");
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== calendarDay) return null;
  const wall = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw);
  const parsed = new Date(wall ? raw.replace(" ", "T") + "Z" : raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function readArchivedRatingHoles(raw: unknown, requireScores = false): ArchivedRatingHole[] | null {
  let source = raw;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { return null; }
  }
  if (!Array.isArray(source) || !source.length || source.length > 36) return null;
  const order = new Set<number>();
  const holes: ArchivedRatingHole[] = [];
  for (const rawHole of source) {
    const row = ratingRecord(rawHole);
    const hole = ratingNumber(row.hole);
    const par = ratingNumber(row.par);
    const strokes = ratingNumber(row.strokes);
    if (hole == null || !Number.isInteger(hole) || hole < 1 || hole > 36 || order.has(hole) ||
        par == null || !Number.isInteger(par) || par < 1 || par > 15 ||
        (requireScores && (strokes == null || !Number.isInteger(strokes) || strokes < 1))) return null;
    const archive = ratingRecord(row.layoutAtPlay);
    const hasSnapshot = Object.keys(archive).length > 0;
    const sourceOfGeometry = hasSnapshot ? archive : row;
    order.add(hole);
    holes.push({
      hole, par, ...(strokes == null ? {} : { strokes }), hasSnapshot,
      tee: sourceOfGeometry.tee, target: sourceOfGeometry.target,
      distanceFt: ratingNumber(sourceOfGeometry.distance_ft),
      layoutId: ratingNumber(archive.layoutId), courseId: ratingNumber(archive.courseId), startedAt: ratingTimestamp(archive.roundStartedAt),
    });
  }
  return holes;
}

/** A newly measured pin, tee or par forms a distinct rating population, even on the same layout ID. */
export async function ratingLayoutRevision(layoutId: number | null, holes: readonly ArchivedRatingHole[]): Promise<string | null> {
  if (layoutId == null || !Number.isSafeInteger(layoutId) || layoutId <= 0 || !holes.length || holes.some((hole) => !mappedHole(hole))) return null;
  const serialized = JSON.stringify([layoutId, ratingGeometrySnapshot(holes)]);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return "geometry-v1:" + [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ratingGeometrySnapshot(holes: readonly ArchivedRatingHole[]) {
  return JSON.stringify([...holes].sort((a, b) => a.hole - b.hole).map((hole) => [
    hole.hole, hole.par, hole.distanceFt, mapCoordinates(hole.tee), mapCoordinates(hole.target),
  ]));
}
