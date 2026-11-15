import type { D1Like } from "./db-types.js";
import { roundRatingForScoreWithWeather, type RatingMethod, type RatingStream } from "./rating-engine.js";
import { calibrateRatingField } from "./ratings-recompute-core.js";
import { getRevisionRatingBaseline, priorRatingAnchors, ratingReadGuards, writeRatingBatch, type RatingBaselineInput, type RoundRatingInput } from "./rating-store.js";

import { MAX_RATING_ROUND_RESULTS, RATING_SOURCE_ROWS, ratingFieldFingerprint, ratingSourceGroups, type EligibleRatingSource } from "./rating-source.js";

export const RATING_EVIDENCE = {
  anchors: "not-enough-prior-anchors",
  baseline: "no-prior-layout-baseline",
  layout: "unverified-layout-revision",
} as const;

type GroupContext = {
  ssa: number; ppt: number; count: number; anchors: number; method: RatingMethod; baselineEventId: number | null;
};

function computeRating(row: EligibleRatingSource, context: GroupContext | null, anchors: number, reason: string | null): RoundRatingInput {
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
  const result = await db.prepare(RATING_SOURCE_ROWS[stream]).bind(...args).all();
  if (!result.success) throw new Error("Rating source read failed");
  if (result.results.length > MAX_RATING_ROUND_RESULTS) throw new Error("Rating source exceeds round size limit");
  const guards = ratingReadGuards(db, RATING_SOURCE_ROWS[stream], args, result.results);
  const groups = await ratingSourceGroups(result.results, stream, currentGust);

  const ratings: RoundRatingInput[] = [];
  const baselines: RatingBaselineInput[] = [];
  let waiting = false;
  for (const group of groups) {
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
        playedAt: earliest, availableAt: last.availableAt, fieldFingerprint: await ratingFieldFingerprint(group, anchors) });
    }
  }
  await writeRatingBatch(db, ratings, baselines, guards);
  return { rows: ratings.length, layoutBaselines: baselines.length, waiting };
}
