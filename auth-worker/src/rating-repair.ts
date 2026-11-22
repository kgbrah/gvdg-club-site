import type { D1Like } from "./db-types.js";
import { roundRatingForScoreWithWeather, type RatingMethod, type RatingStream } from "./rating-engine.js";
import { calibrateRatingField } from "./ratings-recompute-core.js";
import { getRevisionRatingBaseline, priorRatingAnchors, ratingReadGuards, writeRatingBatch, type RatingBaselineInput, type RoundRatingInput } from "./rating-store.js";

import { MAX_RATING_ROUND_RESULTS, RATING_SOURCE_ROWS, ratingFieldScoresFingerprint, ratingSourceGroups, type EligibleRatingSource } from "./rating-source.js";

export const RATING_EVIDENCE = {
  anchors: "not-enough-prior-anchors",
  baseline: "no-prior-layout-baseline",
  layout: "unverified-layout-revision",
} as const;

type GroupContext = {
  ssa: number; ppt: number; count: number; anchors: number; method: RatingMethod; baselineEventId: number | null;
};

function computeRating(row: EligibleRatingSource, context: GroupContext | null, anchors: number, reason: string | null): RoundRatingInput {
  // A borrowed club-field baseline gets the round's own gust adjustment; a field's day-of solve already reflects the
  // conditions everyone played in. (PDGA layout baselines are gone: PDGA's API license allows temporary caching only,
  // so the club no longer keeps PDGA rounds to build them from.)
  const rated = context ? roundRatingForScoreWithWeather({
    score: row.total, ssa: context.ssa, ppt: context.ppt,
    weather: context.method === "layout" ? { windGustMph: row.windGustMph } : null,
  }) : null;
  return {
    ...row, roundRating: rated?.roundRating ?? null, ssa: rated?.ssa ?? null, ppt: rated?.ppt ?? null,
    weatherAdjustment: rated?.weatherAdjustment ?? 0, propagatorCount: context?.count ?? 0,
    anchorCount: context?.anchors ?? anchors, baselineEventId: context?.baselineEventId ?? null,
    ratingMethod: context?.method ?? "unrated", unratedReason: reason,
    pdgaBaselineSsa: null, pdgaBaselineRounds: null,
  };
}

/**
 * True when every rateable round of this source was played before `before` and already has a stored rating made from
 * exactly its current scores: nothing about the round itself changed since it was rated.
 */
async function storedRatingsCurrent(db: D1Like, stream: RatingStream, groups: readonly EligibleRatingSource[][], before: string): Promise<boolean> {
  const rows = groups.flat();
  if (!rows.length || rows.some((row) => !(row.roundDate < before))) return false;
  const stored = new Map<number, Record<string, unknown>>();
  for (let offset = 0; offset < rows.length; offset += 90) {
    const group = rows.slice(offset, offset + 90);
    const result = await db.prepare(`SELECT source_result_id, source_fingerprint, total, to_par, layout_revision FROM round_ratings
        WHERE stream = ? AND source_result_id IN (${group.map(() => "?").join(", ")})`)
      .bind(stream, ...group.map((row) => row.sourceResultId)).all<Record<string, unknown>>();
    if (!result.success) return false;
    for (const row of result.results) stored.set(Number(row.source_result_id), row);
  }
  return rows.every((row) => {
    const saved = stored.get(Number(row.sourceResultId));
    return saved != null && saved.source_fingerprint === row.sourceFingerprint && saved.total === row.total &&
      saved.to_par === row.toPar && saved.layout_revision === row.layoutRevision;
  });
}

/**
 * Re-rate one finished event or casual round from its current scores. With `keepRatedBefore`, a source whose rounds
 * were all played before that time and whose stored ratings still match its scores is left as rated: the PDGA ratings
 * its field was calibrated with are kept only a few days (PDGA's API license: temporary caching only), so re-solving
 * an old field would lose them and needlessly change ratings nobody's scores changed.
 */
export async function repairRatingSource(db: D1Like, stream: RatingStream, sourceId: number, currentGust: number | null = null,
  options: { keepRatedBefore?: string } = {}) {
  const args = [sourceId, MAX_RATING_ROUND_RESULTS + 1];
  const result = await db.prepare(RATING_SOURCE_ROWS[stream]).bind(...args).all();
  if (!result.success) throw new Error("Rating source read failed");
  if (result.results.length > MAX_RATING_ROUND_RESULTS) throw new Error("Rating source exceeds round size limit");
  const guards = ratingReadGuards(db, RATING_SOURCE_ROWS[stream], args, result.results);
  const groups = await ratingSourceGroups(result.results, stream, currentGust);
  if (options.keepRatedBefore && await storedRatingsCurrent(db, stream, groups, options.keepRatedBefore)) {
    return { rows: 0, layoutBaselines: 0, waiting: false, kept: true };
  }

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
    // The field's own day-of solve: stable with 3+ rated players, provisional with 2.
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
        playedAt: earliest, availableAt: last.availableAt, fieldFingerprint: await ratingFieldScoresFingerprint(group) });
    }
  }
  await writeRatingBatch(db, ratings, baselines, guards);
  return { rows: ratings.length, layoutBaselines: baselines.length, waiting };
}
