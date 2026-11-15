import { solveSsa } from "./rating-engine.js";
import { ratingTimestamp } from "./rating-layout.js";

export type ScoredMember = { memberId: string; total: number };

export function calibrateRatingField(rows: readonly ScoredMember[], anchors: ReadonlyMap<string, number>) {
  const propagators = rows.flatMap(({ memberId, total }) => {
    const rating = anchors.get(memberId);
    return rating == null ? [] : [{ score: total, rating }];
  });
  return { solved: solveSsa(propagators), anchorCount: propagators.length };
}

export type ValidationAnchor = { memberId: string; rating: number; observedAt: string; effectiveAt: string };
export type ValidationField = {
  eventId: number; layoutRevision: string; playedAt: string; availableAt: string; results: ScoredMember[];
};
export type ValidationRound = {
  memberId: string; layoutRevision: string; playedAt: string; total: number;
};
export type RatingValidationInput = {
  cutoff: string;
  anchors: ValidationAnchor[];
  calibrationFields: ValidationField[];
  heldOutRounds: ValidationRound[];
};

const MIN_HOLDOUT = 30;
const MIN_HOLDOUT_PLAYERS = 10;
const MIN_HOLDOUT_LAYOUTS = 2;
const MAX_ANCHOR_AGE_MS = 365 * 86_400_000;

function strictDate(value: unknown) {
  const timestamp = ratingTimestamp(value);
  return timestamp == null ? null : Date.parse(timestamp);
}

function priorAnchors(anchors: readonly ValidationAnchor[], asOf: number): Map<string, number> {
  const recent = anchors.flatMap((anchor) => {
    const observed = strictDate(anchor.observedAt);
    const effective = strictDate(anchor.effectiveAt);
    return observed == null || effective == null || effective > observed || observed >= asOf ||
      asOf - effective > MAX_ANCHOR_AGE_MS || !Number.isFinite(anchor.rating) || anchor.rating < 700 || anchor.rating > 1300
      ? [] : [{ ...anchor, observed, effective }];
  }).sort((a, b) => b.effective - a.effective || b.observed - a.observed);
  const values = new Map<string, number>();
  for (const row of recent) if (!values.has(row.memberId)) values.set(row.memberId, row.rating);
  return values;
}

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^geometry-v1:[0-9a-f]{64}$/.test(value);
}

/**
 * Freeze the training data at the cutoff. Competition fields can establish a baseline
 * only from anchors already available before their own start. Holdout scores never fit
 * a player anchor or a baseline. The target is observed strokes, independent of this model.
 */
export function evaluateHeldOutRatings(input: RatingValidationInput) {
  const cutoff = strictDate(input.cutoff);
  if (cutoff == null) throw new Error("A valid chronological cutoff is required");
  const latest = new Map<string, { played: number; eventId: number; ssa: number; ppt: number; comparison: number }>();
  for (const field of input.calibrationFields) {
    const played = strictDate(field.playedAt);
    const available = strictDate(field.availableAt);
    if (played == null || available == null || played > available || available >= cutoff || !isRevision(field.layoutRevision)) continue;
    const prior = latest.get(field.layoutRevision);
    if (prior && (prior.played > played || (prior.played === played && prior.eventId >= field.eventId))) continue;
    const scores = field.results.filter((row) => validScore(row.total) && row.memberId);
    if (new Set(scores.map((row) => row.memberId)).size !== scores.length) continue;
    const { solved } = calibrateRatingField(scores, priorAnchors(input.anchors, played));
    if (!solved) continue;
    latest.set(field.layoutRevision, { ...solved, played, eventId: field.eventId,
      comparison: scores.reduce((sum, row) => sum + row.total, 0) / scores.length });
  }
  const anchorsAtCutoff = priorAnchors(input.anchors, cutoff);
  const players = new Set<string>();
  const layouts = new Set<string>();
  const excluded = { invalidOrBeforeCutoff: 0, noLayoutBaseline: 0, noPlayerAnchor: 0 };
  const predictions: { predicted: number; actual: number; comparison: number }[] = [];
  for (const row of input.heldOutRounds) {
    const playedAt = strictDate(row.playedAt);
    if (playedAt == null || playedAt < cutoff || !validScore(row.total) || !row.memberId || !isRevision(row.layoutRevision)) {
      excluded.invalidOrBeforeCutoff += 1;
      continue;
    }
    const baseline = latest.get(row.layoutRevision);
    if (!baseline) {
      excluded.noLayoutBaseline += 1;
      continue;
    }
    const anchor = anchorsAtCutoff.get(row.memberId);
    if (anchor == null) {
      excluded.noPlayerAnchor += 1;
      continue;
    }
    players.add(row.memberId);
    layouts.add(row.layoutRevision);
    predictions.push({ predicted: baseline.ssa - (anchor - 1_000) / baseline.ppt, actual: row.total, comparison: baseline.comparison });
  }

  const eligible = predictions.length >= MIN_HOLDOUT && players.size >= MIN_HOLDOUT_PLAYERS && layouts.size >= MIN_HOLDOUT_LAYOUTS;
  function mean(metric: (row: typeof predictions[number]) => number) {
    return Math.round(100 * predictions.reduce((sum, row) => sum + metric(row), 0) / predictions.length) / 100;
  }
  return {
    status: input.heldOutRounds.length === 0 ? "no-data" : eligible ? "measured" : "insufficient-sample",
    cutoff: input.cutoff,
    candidateRounds: input.heldOutRounds.length,
    evaluatedRounds: predictions.length,
    evaluatedPlayers: players.size,
    evaluatedLayoutRevisions: layouts.size,
    excluded,
    minimum: { rounds: MIN_HOLDOUT, players: MIN_HOLDOUT_PLAYERS, layouts: MIN_HOLDOUT_LAYOUTS },
    meanAbsoluteErrorStrokes: eligible ? mean((row) => Math.abs(row.predicted - row.actual)) : null,
    meanBiasStrokes: eligible ? mean((row) => row.predicted - row.actual) : null,
    layoutMeanErrorStrokes: eligible ? mean((row) => Math.abs(row.comparison - row.actual)) : null,
  };
}
