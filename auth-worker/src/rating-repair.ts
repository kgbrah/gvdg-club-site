import type { D1Like } from "./db-types.js";
import { roundRatingForScoreWithWeather, type RatingMethod, type RatingStream } from "./rating-engine.js";
import { readArchivedRatingHoles, ratingGeometrySnapshot, ratingLayoutRevision, ratingNumber, ratingRecord, ratingTimestamp } from "./rating-layout.js";
import { calibrateRatingField } from "./ratings-recompute-core.js";
import { getRevisionRatingBaseline, priorRatingAnchors, ratingReadGuards, writeRatingBatch, type RatingBaselineInput, type RoundRatingInput } from "./rating-store.js";

export const MAX_RATING_ROUND_RESULTS = 240;

export const RATING_EVIDENCE = {
  anchors: "not-enough-prior-anchors",
  baseline: "no-prior-layout-baseline",
  layout: "unverified-layout-revision",
} as const;

type Row = Record<string, unknown>;

const ROUND_ROWS = {
  competition: `SELECT res.id, res.member_id, res.name, res.place, res.total, res.to_par, res.scorecard,
      res.created_at, res.scoring_group, res.match_result, e.id AS event_id, e.starts_at,
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

type Eligible = Pick<RoundRatingInput, "memberId" | "playerName" | "stream" | "eventId" | "casualRoundCode" | "courseId" | "sourceResultId" | "sourceScorecard" |
  "layoutId" | "layoutRevision" | "roundDate" | "total" | "toPar" | "windGustMph"> &
  { availableAt: string; shape: string; actualLayoutId: number | null };

async function eligibleInput(row: Row, stream: RatingStream, currentGust: number | null): Promise<Eligible | null> {
  const id = ratingNumber(row.id);
  const memberId = typeof row.member_id === "string" ? row.member_id : "";
  const place = ratingNumber(row.place);
  const total = ratingNumber(row.total);
  const toPar = ratingNumber(row.to_par);
  if (id == null || !/^m_[A-Za-z0-9_:-]+$/.test(memberId) || place == null || place <= 0 ||
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
  return {
    stream, sourceResultId: id, sourceScorecard: row.scorecard, memberId, playerName: String(row.name || "Player"),
    eventId: ratingNumber(row.event_id), casualRoundCode: typeof row.round_code === "string" ? row.round_code : null,
    courseId: courseId === actualCourseId ? courseId : null, layoutId: layoutId === actualLayoutId ? layoutId : null,
    layoutRevision, actualLayoutId, roundDate, availableAt, total, toPar,
    shape: ratingGeometrySnapshot(archived), windGustMph: currentGust ?? ratingNumber(row.wind_gust_mph),
  };
}

type GroupContext = {
  ssa: number; ppt: number; count: number; anchors: number; method: RatingMethod; baselineEventId: number | null;
};

function computeRating(row: Eligible, context: GroupContext | null, anchors: number, reason: string | null): RoundRatingInput {
  const rated = context ? roundRatingForScoreWithWeather({
    score: row.total, ssa: context.ssa, ppt: context.ppt,
    weather: context.method === "layout" ? { windGustMph: row.windGustMph } : null,
  }) : null;
  return {
    ...row, roundRating: rated?.roundRating ?? null, ssa: rated?.ssa ?? null, ppt: rated?.ppt ?? null,
    weatherAdjustment: rated?.weatherAdjustment ?? 0, propagatorCount: context?.count ?? 0,
    anchorCount: context?.anchors ?? anchors, baselineEventId: context?.baselineEventId ?? null,
    ratingMethod: context?.method ?? "unrated", unratedReason: reason,
  };
}

export async function repairRatingSource(db: D1Like, stream: RatingStream, sourceId: number, currentGust: number | null = null) {
  const args = [sourceId, MAX_RATING_ROUND_RESULTS + 1];
  const result = await db.prepare(ROUND_ROWS[stream]).bind(...args).all();
  if (!result.success) throw new Error("Rating source read failed");
  if (result.results.length > MAX_RATING_ROUND_RESULTS) throw new Error("Rating source exceeds round size limit");
  const guards = ratingReadGuards(db, ROUND_ROWS[stream], args, result.results);
  const candidates = (await Promise.all(result.results.map((row) => eligibleInput(row, stream, currentGust)))).filter((row): row is Eligible => row != null);
  const occurrences = new Map<string, number>();
  for (const row of candidates) occurrences.set(row.memberId, (occurrences.get(row.memberId) ?? 0) + 1);
  const groups = new Map<string, Eligible[]>();
  for (const row of candidates) {
    if (occurrences.get(row.memberId) !== 1) continue;
    const key = JSON.stringify([row.actualLayoutId, row.layoutRevision, row.shape]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const ratings: RoundRatingInput[] = [];
  const baselines: RatingBaselineInput[] = [];
  let waiting = false;
  for (const group of groups.values()) {
    const earliest = group.reduce((date, row) => row.roundDate < date ? row.roundDate : date, group[0]!.roundDate);
    const sample = group[0]!;
    if (stream === "casual") {
      const baseline = await getRevisionRatingBaseline(db, sample.layoutRevision, earliest, guards);
      const reason = baseline ? null : sample.layoutRevision ? RATING_EVIDENCE.baseline : RATING_EVIDENCE.layout;
      waiting ||= reason === RATING_EVIDENCE.baseline;
      const context: GroupContext | null = baseline ? {
        ...baseline, count: baseline.propagatorCount, anchors: baseline.propagatorCount, method: "layout", baselineEventId: baseline.eventId,
      } : null;
      for (const row of group) ratings.push(computeRating(row, context, 0, reason));
      continue;
    }

    const anchors = await priorRatingAnchors(db, group.map((row) => row.memberId), earliest, guards);
    const { solved, anchorCount } = calibrateRatingField(group, anchors);
    const context: GroupContext | null = solved ? {
      ...solved, count: solved.propagatorCount, anchors: anchorCount, method: solved.status, baselineEventId: null,
    } : null;
    const reason = context ? null : RATING_EVIDENCE.anchors;
    waiting ||= reason != null;
    for (const row of group) ratings.push(computeRating(row, context, anchorCount, reason));
    if (solved && sample.layoutRevision && sample.actualLayoutId != null) {
      const last = group.reduce((latest, row) => row.availableAt > latest.availableAt ? row : latest, sample);
      baselines.push({ ...solved, eventId: sourceId, layoutRevision: sample.layoutRevision,
        layoutId: sample.actualLayoutId, sourceResultId: last.sourceResultId, sourceScorecard: last.sourceScorecard,
        playedAt: earliest, availableAt: last.availableAt });
    }
  }
  await writeRatingBatch(db, ratings, baselines, guards);
  return { rows: ratings.length, layoutBaselines: baselines.length, waiting };
}
