export const RATING_STREAMS = ["competition", "casual"] as const;
export type RatingStream = (typeof RATING_STREAMS)[number];

export const RATING_METHODS = ["stable", "provisional", "layout", "unrated"] as const;
export type RatingMethod = (typeof RATING_METHODS)[number];

export type Propagator = {
  readonly score: number;
  readonly rating: number;
};

export type SsaSolve = {
  readonly ssa: number;
  readonly ppt: number;
  readonly status: "stable" | "provisional";
  readonly propagatorCount: number;
  readonly droppedCount: number;
};

export type RatingRound = {
  readonly roundDate: string;
  readonly roundRating: number | null;
};

type EligibleRound = {
  readonly dateMs: number;
  readonly rating: number;
};

export type PlayerRatingSummary = {
  readonly rating: number | null;
  readonly ratedRounds: number;
  readonly weightedRounds: number;
};

const HIGH_SSA_BREAKPOINT = 50.3289725;
const MIN_PROPAGATOR_RATING = 700;
const LOW_PROPAGATOR_ROUND_GAP = 60;
const MIN_PROPAGATORS = 2;
const STABLE_PROPAGATORS = 3;
const MIN_OVERALL_ROUNDS = 8;
const RECENT_WEIGHT_ROUNDS = 9;
const RATING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

export function pointsPerThrow(ssa: number): number {
  return ssa > HIGH_SSA_BREAKPOINT ? -0.225067 * ssa + 21.3858 : -0.487095 * ssa + 34.5734;
}

export function roundRatingForScore(score: number, ssa: number, ppt: number): number {
  return Math.round(1000 + (ssa - score) * ppt);
}

export function solveSsa(propagators: readonly Propagator[]): SsaSolve | null {
  let active = propagators.filter((p) => Number.isFinite(p.score) && Number.isFinite(p.rating) && p.rating >= MIN_PROPAGATOR_RATING);
  let droppedCount = 0;
  for (let pass = 0; pass < 8; pass++) {
    if (active.length < MIN_PROPAGATORS) return null;
    const estimate = estimateSsa(active);
    const kept = active.filter((p) => roundRatingForScore(p.score, estimate.ssa, estimate.ppt) >= p.rating - LOW_PROPAGATOR_ROUND_GAP);
    const newlyDropped = active.length - kept.length;
    if (newlyDropped === 0) {
      return {
        ...estimate,
        status: active.length >= STABLE_PROPAGATORS ? "stable" : "provisional",
        propagatorCount: active.length,
        droppedCount,
      };
    }
    droppedCount += newlyDropped;
    active = kept;
  }
  return null;
}

export function aggregatePlayerRating(input: { readonly rounds: readonly RatingRound[]; readonly now: string }): PlayerRatingSummary {
  const nowMs = Date.parse(input.now);
  const usableNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const eligible = input.rounds
    .map((round) => normalizedRound(round, usableNow))
    .filter((round) => round != null)
    .sort((a, b) => b.dateMs - a.dateMs);
  const filtered = eligible.length >= 7 ? dropLowOutliers(eligible) : eligible;
  if (filtered.length < MIN_OVERALL_ROUNDS) {
    return { rating: null, ratedRounds: filtered.length, weightedRounds: filtered.length };
  }
  const weightedRatings = filtered.map((round) => round.rating);
  if (filtered.length >= RECENT_WEIGHT_ROUNDS) {
    const recentCount = Math.ceil(filtered.length * 0.25);
    for (let i = 0; i < recentCount; i++) {
      const round = filtered[i];
      if (round) weightedRatings.push(round.rating);
    }
  }
  return {
    rating: Math.round(mean(weightedRatings)),
    ratedRounds: filtered.length,
    weightedRounds: weightedRatings.length,
  };
}

function estimateSsa(propagators: readonly Propagator[]): Pick<SsaSolve, "ssa" | "ppt"> {
  const averageScore = mean(propagators.map((p) => p.score));
  const averageRating = mean(propagators.map((p) => p.rating));
  let ssa = averageScore;
  for (let i = 0; i < 20; i++) {
    const ppt = pointsPerThrow(ssa);
    if (!Number.isFinite(ppt) || ppt <= 0) break;
    const nextSsa = averageScore + (averageRating - 1000) / ppt;
    if (Math.abs(nextSsa - ssa) < 0.0001) {
      ssa = nextSsa;
      break;
    }
    ssa = nextSsa;
  }
  return { ssa, ppt: pointsPerThrow(ssa) };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizedRound(round: RatingRound, nowMs: number): EligibleRound | null {
  if (round.roundRating == null || !Number.isFinite(round.roundRating)) return null;
  const dateMs = Date.parse(round.roundDate);
  if (!Number.isFinite(dateMs) || dateMs > nowMs || nowMs - dateMs > RATING_WINDOW_MS) return null;
  return { dateMs, rating: round.roundRating };
}

function dropLowOutliers(rounds: readonly EligibleRound[]): readonly EligibleRound[] {
  const ratings = rounds.map((round) => round.rating);
  const average = mean(ratings);
  const variance = mean(ratings.map((rating) => (rating - average) ** 2));
  const sd = Math.sqrt(variance);
  return rounds.filter((round) => round.rating >= average - 100 && (sd === 0 || round.rating >= average - 2.5 * sd));
}
