import type { RatingStream } from "./rating-engine.js";
import type { RoundRatingInput } from "./rating-store.js";
import { readArchivedRatingHoles, ratingGeometrySnapshot, ratingLayoutRevision, ratingNumber, ratingRecord, ratingTimestamp } from "./rating-layout.js";

type Row = Record<string, unknown>;
export const MAX_RATING_ROUND_RESULTS = 240;

export const CURRENT_RESULT_FIELDS = {
  competition: `res.id, res.member_id, res.place, res.total, res.to_par, res.scorecard, res.created_at,
    res.scoring_group, res.match_result, e.id AS event_id, e.status AS event_status, e.starts_at,
    e.date AS event_date, e.format, ec.play_format, ec.live_scoring_config AS scoring_config`,
  casual: `res.id, res.member_id, res.place, res.total, res.to_par, res.scorecard, res.created_at,
    res.scoring_group, res.match_result, cround.round_code, cround.started_at, cround.finalized_at,
    cround.holes AS layout_holes, cround.scoring_config`,
} as const;

export const STORED_EVIDENCE_FIELDS = `rr.source_result_id, rr.source_fingerprint, rr.total AS rating_total,
  rr.to_par AS rating_to_par, rr.layout_revision`;

export async function ratingFingerprint(input: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const RATING_SOURCE_ROWS = {
  competition: `SELECT res.id, res.member_id, res.name, res.place, res.total, res.to_par, res.scorecard,
      res.created_at, res.scoring_group, res.match_result, e.id AS event_id, e.status AS event_status, e.starts_at,
      e.date AS event_date, e.format, ec.play_format, ec.live_scoring_config AS scoring_config,
      c.id AS course_id, l.id AS layout_id, rr.wind_gust_mph
    FROM results res JOIN events e ON e.id = res.event_id
    LEFT JOIN event_config ec ON ec.event_id = e.id
    LEFT JOIN courses c ON c.id = e.course_id LEFT JOIN course_layouts l ON l.id = e.layout_id
    LEFT JOIN round_ratings rr ON rr.event_id = e.id AND rr.member_id = res.member_id
    WHERE e.id = ? AND e.status = 'final' AND res.member_id IS NOT NULL
    ORDER BY res.id LIMIT ?`,
  casual: `SELECT res.id, res.member_id, res.name, res.place, res.total, res.to_par, res.scorecard,
      res.created_at, res.scoring_group, res.match_result, r.finalized_at, r.started_at, r.round_code,
      r.holes AS layout_holes, r.scoring_config, c.id AS course_id, l.id AS layout_id, rr.wind_gust_mph
    FROM casual_results res JOIN casual_rounds r ON r.id = res.casual_round_id
    LEFT JOIN courses c ON c.id = r.course_id LEFT JOIN course_layouts l ON l.id = r.layout_id
    LEFT JOIN round_ratings rr ON rr.casual_round_code = r.round_code AND rr.member_id = res.member_id
    WHERE r.id = ? AND res.member_id IS NOT NULL
    ORDER BY res.id LIMIT ?`,
} as const;

function hasValue(value: unknown): boolean {
  return typeof value === "string" ? !["", "null", "{}"].includes(value.trim()) : Boolean(value);
}

export function singlesStrokeEvidence(row: Row, stream: RatingStream): boolean {
  if (hasValue(row.match_result)) return false;
  const group = ratingRecord(row.scoring_group);
  if (group.targetType && group.targetType !== "player") return false;
  if (hasValue(row.scoring_group) && !group.targetType) return false;
  const config = ratingRecord(row.scoring_config);
  if (hasValue(row.scoring_config) && !config.groupFormat && !config.scoringStyle) return false;
  if (config.groupFormat != null && config.groupFormat !== "singles") return false;
  if (config.scoringStyle != null && config.scoringStyle !== "stroke") return false;
  if (row.format != null && !["", "stroke", "singles"].includes(String(row.format))) return false;
  if (row.play_format != null && !["", "stroke", "singles"].includes(String(row.play_format))) return false;
  // The casual archive always has a format record for reliable singles/stroke identification.
  return stream === "competition" || (config.scoringStyle === "stroke" && config.groupFormat === "singles");
}

export type EligibleRatingSource = Pick<RoundRatingInput, "memberId" | "playerName" | "stream" | "eventId" | "casualRoundCode" | "courseId" | "sourceResultId" | "sourceScorecard" |
  "layoutId" | "layoutRevision" | "sourceFingerprint" | "roundDate" | "total" | "toPar" | "windGustMph"> &
  { availableAt: string; shape: string; actualLayoutId: number | null };

export async function eligibleRatingSource(row: Row, stream: RatingStream, currentGust: number | null): Promise<EligibleRatingSource | null> {
  const id = ratingNumber(row.id);
  const memberId = typeof row.member_id === "string" ? row.member_id : "";
  const place = ratingNumber(row.place);
  const total = ratingNumber(row.total);
  const toPar = ratingNumber(row.to_par);
  if ((stream === "competition" && row.event_status !== "final") || id == null || !/^m_[A-Za-z0-9_:-]+$/.test(memberId) || place == null || place <= 0 ||
    total == null || toPar == null || typeof row.scorecard !== "string" || !singlesStrokeEvidence(row, stream)) return null;
  const scoreboard = readArchivedRatingHoles(row.scorecard, true);
  // Legacy aggregates and scorecards lacking an as-played snapshot remain visible as archived data.
  if (!scoreboard || !scoreboard.every((hole) => hole.hasSnapshot)) return null;
  const strokes = scoreboard.reduce((sum, hole) => sum + hole.strokes!, 0);
  const par = scoreboard.reduce((sum, hole) => sum + hole.par, 0);
  if (strokes !== total || strokes - par !== toPar) return null;
  const archived = stream === "casual" ? readArchivedRatingHoles(row.layout_holes) : scoreboard;
  if (!archived || ratingGeometrySnapshot(archived) !== ratingGeometrySnapshot(scoreboard)) return null;

  const sourceDate = stream === "competition" ? ratingTimestamp(row.starts_at) ?? ratingTimestamp(row.event_date) : ratingTimestamp(row.started_at);
  const availableAt = ratingTimestamp(row.finalized_at) ?? ratingTimestamp(row.created_at);
  const archivedStarts = new Set(scoreboard.flatMap((hole) => hole.startedAt ? [hole.startedAt] : []));
  if (archivedStarts.size > 1) return null;
  const roundDate = archivedStarts.values().next().value ?? sourceDate;
  if (!roundDate || !availableAt || availableAt < roundDate) return null;
  const actualLayoutIds = new Set<number>();
  const actualCourseIds = new Set<number>();
  // Both pars and positions must follow the archived layout and not a current course record.
  for (const score of scoreboard) {
    if (score.layoutId != null) actualLayoutIds.add(score.layoutId);
    if (score.courseId != null) actualCourseIds.add(score.courseId);
  }
  if (actualLayoutIds.size > 1 || actualCourseIds.size > 1) return null;
  const actualLayoutId = actualLayoutIds.values().next().value ?? null;
  const actualCourseId = actualCourseIds.values().next().value ?? null;
  const layoutId = ratingNumber(row.layout_id);
  const courseId = ratingNumber(row.course_id);
  const layoutRevision = await ratingLayoutRevision(actualLayoutId, archived);
  const sourceFingerprint = await ratingFingerprint([
    stream, id, memberId, place, roundDate, availableAt, total, toPar, actualCourseId, actualLayoutId,
    row.scorecard, ratingGeometrySnapshot(archived),
  ]);
  return {
    stream, sourceResultId: id, sourceScorecard: row.scorecard, memberId, playerName: String(row.name || "Player"),
    eventId: ratingNumber(row.event_id), casualRoundCode: typeof row.round_code === "string" ? row.round_code : null,
    courseId: courseId === actualCourseId ? courseId : null, layoutId: layoutId === actualLayoutId ? layoutId : null,
    layoutRevision, sourceFingerprint, actualLayoutId, roundDate, availableAt, total, toPar,
    shape: ratingGeometrySnapshot(archived), windGustMph: currentGust ?? ratingNumber(row.wind_gust_mph),
  };
}

export async function matchesStoredRatingEvidence(row: Row, stream: RatingStream): Promise<boolean> {
  if (typeof row.source_fingerprint !== "string" || row.source_result_id !== row.id) return false;
  const source = await eligibleRatingSource(row, stream, null);
  return source != null && source.sourceFingerprint === row.source_fingerprint &&
    source.total === row.rating_total && source.toPar === row.rating_to_par && source.layoutRevision === row.layout_revision;
}

export async function ratingFieldFingerprint(field: readonly EligibleRatingSource[], anchors: ReadonlyMap<string, number>) {
  return ratingFingerprint(field.map((row) => [row.sourceResultId, row.sourceFingerprint, anchors.get(row.memberId) ?? null])
    .sort((a, b) => Number(a[0]) - Number(b[0])));
}

export async function ratingSourceGroups(rows: readonly Row[], stream: RatingStream, currentGust: number | null) {
  const candidates = (await Promise.all(rows.map((row) => eligibleRatingSource(row, stream, currentGust))))
    .filter((row): row is EligibleRatingSource => row != null);
  const occurrences = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.member_id === "string") occurrences.set(row.member_id, (occurrences.get(row.member_id) ?? 0) + 1);
  }
  const groups = new Map<string, EligibleRatingSource[]>();
  for (const row of candidates) {
    if (occurrences.get(row.memberId) !== 1) continue;
    const key = JSON.stringify([row.actualLayoutId, row.layoutRevision, row.shape]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}
