import * as db from "./db.js";
import type { D1Like } from "./db-types.js";
import { normalizeLiveScoringConfig } from "./live-format.js";

export function shouldUseCasualArchive(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object") return true;
  const status = String((snapshot as { status?: unknown }).status || "");
  return status !== "live" && status !== "final";
}

function parseJson(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseHoles(raw: unknown): { hole: number; par: number; distance_ft?: number | null }[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const hole = Number((item as { hole?: unknown }).hole);
    const par = Number((item as { par?: unknown }).par);
    if (!Number.isInteger(hole) || !Number.isInteger(par)) return [];
    const distance = (item as { distance_ft?: unknown }).distance_ft;
    const distanceFt = typeof distance === "number" && Number.isFinite(distance) ? distance : null;
    return [{ ...(item as Record<string, unknown>), hole, par, distance_ft: distanceFt }];
  });
}

function parseScorecard(raw: unknown): { hole: number; par: number; strokes: number }[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const hole = Number((item as { hole?: unknown }).hole);
    const par = Number((item as { par?: unknown }).par);
    const strokes = Number((item as { strokes?: unknown }).strokes);
    if (!Number.isInteger(hole) || !Number.isInteger(par) || !Number.isInteger(strokes)) return [];
    return [{ hole, par, strokes }];
  });
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function roundConfigFrom(raw: unknown) {
  try {
    return normalizeLiveScoringConfig(parseJson(raw));
  } catch {
    return normalizeLiveScoringConfig(null);
  }
}

/** Rebuild a public live snapshot from durable casual results after the DO is gone. */
export async function buildCasualArchiveSnapshot(database: D1Like, roundCode: string) {
  const data = await db.listCasualRoundResults(database, roundCode);
  if (!data?.round) return null;
  const round = data.round as Record<string, unknown>;
  const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
  const layoutId = asInt(round.layout_id);
  const courseId = asInt(round.course_id);
  const layoutHoles = layoutId != null ? await db.getLayoutHoles(database, layoutId) : [];
  const storedHoles = parseHoles(round.holes);
  const holes = layoutHoles.length ? layoutHoles : storedHoles;
  const course = courseId != null
    ? ((await db.getCourse(database, courseId)) as { udisc_course_id?: string | null } | null)
    : null;

  const players = results.map((row, index) => {
    const scorecard = parseScorecard(row.scorecard);
    const scores: Record<number, number> = {};
    for (const hole of scorecard) scores[hole.hole] = hole.strokes;
    return {
      index,
      cardId: "h1",
      name: String(row.name || "Player"),
      division: row.division == null ? null : String(row.division),
      team: null,
      startingHole: null,
      scores,
      scorecards: {},
    };
  });

  const holeCount = holes.length;
  const standings = results.map((row, index) => {
    const scorecard = parseScorecard(row.scorecard);
    const total = asInt(row.total);
    const toPar = asInt(row.to_par);
    const thru = scorecard.length || (total != null && holeCount ? holeCount : 0);
    return {
      name: String(row.name || "Player"),
      division: row.division == null ? null : String(row.division),
      thru,
      total: total ?? 0,
      toPar: toPar ?? 0,
      targetId: "p" + index,
      targetType: "player",
      playerIndexes: [index],
      members: [String(row.name || "Player")],
      scoringGroup: parseJson(row.scoring_group),
      match: parseJson(row.match_result),
    };
  });

  return {
    status: "final",
    rev: 0,
    eventId: null,
    roundConfig: roundConfigFrom(round.scoring_config),
    scoreTargets: players.map((player) => ({
      type: "player",
      id: "p" + player.index,
      label: player.name,
      playerIndexes: [player.index],
      members: [player.name],
    })),
    scoreTargetError: null,
    scoreTargetErrors: [],
    courseName: round.course_name == null ? null : String(round.course_name),
    layoutName: round.layout_name == null ? null : String(round.layout_name),
    udiscCourseId: course?.udisc_course_id ?? null,
    weather: null,
    holes,
    players,
    conflicts: [],
    missing: [],
    standings,
    liveCtps: {},
    playerLocations: [],
    lockedCardIds: [],
    cardAttestations: {},
    updatedAt: round.finalized_at ?? round.started_at ?? null,
    archived: true,
  };
}

export function publicMemberCasualResult(row: Record<string, unknown>) {
  return {
    id: row.id ?? null,
    round_code: row.round_code ?? null,
    course_name: row.course_name ?? null,
    layout_name: row.layout_name ?? null,
    layout_id: row.layout_id ?? null,
    finalized_at: row.finalized_at ?? null,
    total: row.total ?? null,
    to_par: row.to_par ?? null,
    place: row.place ?? null,
    udisc_course_id: row.udisc_course_id ?? null,
    scorecard: row.scorecard ?? null,
    breakdown: row.breakdown ?? null,
  };
}
