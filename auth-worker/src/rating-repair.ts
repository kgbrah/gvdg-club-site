import type { D1Like } from "./db-types.js";
import { roundRatingForScoreWithWeather, type RatingMethod, type RatingStream } from "./rating-engine.js";
import { calibrateRatingField } from "./ratings-recompute-core.js";
import { getRevisionRatingBaseline, priorRatingAnchors, ratingReadGuards, writeRatingBatch, type RatingBaselineInput, type RoundRatingInput } from "./rating-store.js";
import { pdgaBaselineForPlayed, playedHolesFromShape } from "./pdga-baseline-store.js";
import type { PdgaBaseline } from "./pdga-baselines.js";

import { MAX_RATING_ROUND_RESULTS, RATING_SOURCE_ROWS, ratingFieldFingerprint, ratingSourceGroups, type EligibleRatingSource } from "./rating-source.js";

export const RATING_EVIDENCE = {
  anchors: "not-enough-prior-anchors",
  baseline: "no-prior-layout-baseline",
  layout: "unverified-layout-revision",
} as const;

type GroupContext = {
  ssa: number; ppt: number; count: number; anchors: number; method: RatingMethod; baselineEventId: number | null;
};

function computeRating(row: EligibleRatingSource, context: GroupContext | null, anchors: number, reason: string | null,
  pdga: PdgaBaseline | null): RoundRatingInput {
  // A borrowed baseline (club field or PDGA) gets the round's own gust adjustment; a field's
  // day-of solve already reflects the conditions everyone played in.
  const rated = context ? roundRatingForScoreWithWeather({
    score: row.total, ssa: context.ssa, ppt: context.ppt,
    weather: context.method === "layout" || context.method === "pdga" ? { windGustMph: row.windGustMph } : null,
  }) : null;
  return {
    ...row, roundRating: rated?.roundRating ?? null, ssa: rated?.ssa ?? null, ppt: rated?.ppt ?? null,
    weatherAdjustment: rated?.weatherAdjustment ?? 0, propagatorCount: context?.count ?? 0,
    anchorCount: context?.anchors ?? anchors, baselineEventId: context?.baselineEventId ?? null,
    ratingMethod: context?.method ?? "unrated", unratedReason: reason,
    pdgaBaselineSsa: pdga?.ssa ?? null, pdgaBaselineRounds: pdga?.rounds ?? null,
  };
}

function pdgaContext(pdga: PdgaBaseline, anchors: number): GroupContext {
  return { ssa: pdga.ssa, ppt: pdga.ppt, count: 0, anchors, method: "pdga", baselineEventId: null };
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
    // Earlier PDGA rounds on a layout matching the as-played geometry (none from the same day or later).
    const pdga = await pdgaBaselineForPlayed(db, sample.actualLayoutId, playedHolesFromShape(sample.shape), earliest, guards);
    if (stream === "casual") {
      // PDGA's SSAs come from far larger rated fields than a club round, so they take precedence.
      const baseline = pdga ? null : await getRevisionRatingBaseline(db, sample.layoutRevision, earliest, guards);
      const reason = pdga || baseline ? null : sample.layoutRevision ? RATING_EVIDENCE.baseline : RATING_EVIDENCE.layout;
      waiting ||= reason === RATING_EVIDENCE.baseline;
      const context: GroupContext | null = pdga ? pdgaContext(pdga, 0) : baseline ? {
        ...baseline, count: baseline.propagatorCount, anchors: baseline.propagatorCount, method: "layout", baselineEventId: baseline.eventId,
      } : null;
      for (const row of group) ratings.push(computeRating(row, context, 0, reason, pdga));
      continue;
    }

    const anchors = await priorRatingAnchors(db, group.map((row) => row.memberId), earliest, guards);
    const { solved, anchorCount } = calibrateRatingField(group, anchors);
    // A field that can solve its own SSA keeps it, exactly as PDGA does; the PDGA baseline is kept
    // beside it for comparison. Too few rated players to solve: fall back to the PDGA baseline.
    const context: GroupContext | null = solved ? {
      ...solved, count: solved.propagatorCount, anchors: anchorCount, method: solved.status, baselineEventId: null,
    } : pdga ? pdgaContext(pdga, anchorCount) : null;
    const reason = context ? null : RATING_EVIDENCE.anchors;
    waiting ||= reason != null;
    for (const row of group) ratings.push(computeRating(row, context, anchorCount, reason, pdga));
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
