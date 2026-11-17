import type { D1Like } from "./db-types.js";

import { aggregatePlayerRating, roundRatingForScoreWithWeather, MIN_OVERALL_ROUNDS, type RatingMethod, type RatingRound as EngineRound, type RatingStream } from "./rating-engine.js";
import { CURRENT_RESULT_FIELDS, STORED_EVIDENCE_FIELDS, matchesStoredRatingEvidence, singlesStrokeEvidence } from "./rating-source.js";
import { getSourceRatingBaseline, type LayoutRatingBaseline } from "./rating-store.js";
import { pdgaBaselineForPlayed, playedHolesFromShape } from "./pdga-baseline-store.js";
import type { PdgaBaseline } from "./pdga-baselines.js";
import { readArchivedRatingHoles, ratingGeometrySnapshot } from "./rating-layout.js";

export type RatingKind = "competitive" | "casual";
export type RatingSource = "stored" | "unrated";

export interface RatingRound {
  readonly kind: RatingKind;
  readonly id: number | null;
  readonly label: string;
  readonly date: string | null;
  readonly course_name: string | null;
  readonly layout_name: string | null;
  readonly round_code: string | null;
  readonly place: number | null;
  readonly total: number | null;
  readonly to_par: number | null;
  readonly rating: number | null;
  readonly rating_source: RatingSource;
  readonly rating_method: RatingMethod | "archived";
  readonly anchor_count: number;
  readonly propagator_count: number;
  readonly baseline_event_id: number | null;
  /** PDGA rated rounds behind the layout baseline (the method 'pdga' basis, or a comparison). */
  readonly pdga_baseline_rounds: number | null;
  readonly pdga_baseline_ssa: number | null;
  readonly layout_revision: string | null;
  readonly unrated_reason: string | null;
  readonly match_result: string | null;
  readonly scoring_group: string | null;
  readonly scorecard: string | null;
  readonly udisc_course_id: string | null;
}

export interface RatingGroup {
  readonly live_rating: number | null;
  readonly rated_rounds: number;
  readonly eligible_rated_rounds: number;
  readonly minimum_rated_rounds: number;
  readonly rounds_count: number;
  readonly rounds: readonly RatingRound[];
}

export interface MemberRatings {
  readonly competitive: RatingGroup;
  readonly casual: RatingGroup;
}

interface RatingValue {
  readonly rating: number | null;
  readonly source: RatingSource;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function intOrNull(value: unknown): number | null {
  const n = numberOrNull(value);
  return n == null ? null : Math.round(n);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function ratingForRound(row: Record<string, unknown>): RatingValue {
  if (!singlesStrokeEvidence(row, "competition") || (intOrNull(row.place) ?? 0) <= 0 || (intOrNull(row.total) ?? 0) <= 0) {
    return { rating: null, source: "unrated" };
  }
  const stored = intOrNull(row.rating);
  return stored == null ? { rating: null, source: "unrated" } : { rating: stored, source: "stored" };
}

function displayRatingMethod(row: Record<string, unknown>, rating: RatingValue): RatingMethod | "archived" {
  if (rating.rating == null) return "unrated";
  if (intOrNull(row.source_result_id) == null) return "archived";
  if (row.rating_method === "stable" || row.rating_method === "provisional" || row.rating_method === "layout" ||
    row.rating_method === "pdga") return row.rating_method;
  return "archived";
}

function competitiveLabel(row: Record<string, unknown>): string {
  return stringOrNull(row.event_name) ?? "GVDG competitive round";
}

function casualLabel(row: Record<string, unknown>): string {
  const course = stringOrNull(row.course_name);
  const layout = stringOrNull(row.layout_name);
  if (course && layout) return course + " · " + layout;
  return course ?? layout ?? "Casual round";
}

function ratingRound(kind: RatingKind, row: Record<string, unknown>): RatingRound {
  // A matchplay round (identified by a stored match_result) has no stroke rating — surface the match
  // result instead and leave it unrated, so it never contributes to the member's live rating.
  const matchResult = stringOrNull(row.match_result);
  const rating = ratingForRound(row);
  return {
    kind,
    id: intOrNull(row.id),
    label: kind === "competitive" ? competitiveLabel(row) : casualLabel(row),
    date: kind === "competitive" ? stringOrNull(row.event_date) : stringOrNull(row.finalized_at),
    course_name: stringOrNull(row.course_name),
    layout_name: stringOrNull(row.layout_name),
    round_code: stringOrNull(row.round_code),
    place: intOrNull(row.place),
    total: intOrNull(row.total),
    to_par: intOrNull(row.to_par),
    rating: rating.rating,
    rating_source: rating.source,
    rating_method: displayRatingMethod(row, rating),
    anchor_count: intOrNull(row.anchor_count) ?? 0,
    propagator_count: intOrNull(row.propagator_count) ?? 0,
    baseline_event_id: intOrNull(row.baseline_event_id),
    pdga_baseline_rounds: rating.rating == null ? null : intOrNull(row.pdga_baseline_rounds),
    pdga_baseline_ssa: rating.rating == null ? null : numberOrNull(row.pdga_baseline_ssa),
    layout_revision: stringOrNull(row.layout_revision),
    unrated_reason: rating.rating != null ? null : !singlesStrokeEvidence(row, "competition") ? "not-singles-stroke" :
      (intOrNull(row.place) ?? 0) <= 0 || (intOrNull(row.total) ?? 0) <= 0 ? "incomplete-result" :
        stringOrNull(row.unrated_reason) || "missing-rating-evidence",
    match_result: matchResult,
    scoring_group: stringOrNull(row.scoring_group),
    scorecard: stringOrNull(row.scorecard),
    udisc_course_id: stringOrNull(row.udisc_course_id),
  };
}

export function summarizeRatingRows(
  kind: RatingKind,
  rows: readonly Record<string, unknown>[],
  eligible: readonly EngineRound[] = [],
  now = new Date().toISOString(),
): RatingGroup {
  const rounds = rows.map((row) => ratingRound(kind, row));
  const summary = aggregatePlayerRating({ now, rounds: eligible });
  return {
    live_rating: summary.rating,
    eligible_rated_rounds: summary.ratedRounds,
    minimum_rated_rounds: MIN_OVERALL_ROUNDS,
    rated_rounds: rounds.filter((round) => round.rating != null).length,
    rounds_count: rounds.length,
    rounds,
  };
}

export const RATING_EVIDENCE_FIELDS = `${STORED_EVIDENCE_FIELDS}, rr.rating_method, rr.anchor_count, rr.propagator_count,
  rr.baseline_event_id, rr.unrated_reason, rr.round_date, rr.round_rating, rr.wind_gust_mph, rr.pdga_baseline_ssa, rr.pdga_baseline_rounds`;
const JOINS = {
  competition: `JOIN events e ON e.id = res.event_id LEFT JOIN event_config ec ON ec.event_id = e.id`,
  casual: `JOIN casual_rounds cround ON cround.id = res.casual_round_id`,
} as const;

type RatingRow = Record<string, unknown>;
type ValidRating = (row: RatingRow, stream: RatingStream) => Promise<boolean>;

/** A PDGA-based rating must still match the baseline the current PDGA evidence gives that round. */
async function validPdgaRating(row: RatingRow, pdgaBaselines: Map<string, Promise<PdgaBaseline | null>>, db: D1Like): Promise<boolean> {
  const holes = readArchivedRatingHoles(row.scorecard, true);
  const layoutId = holes?.[0]?.layoutId ?? null;
  const roundDate = stringOrNull(row.round_date);
  const total = intOrNull(row.total);
  if (!holes || layoutId == null || !roundDate || total == null) return false;
  const shape = ratingGeometrySnapshot(holes);
  const key = layoutId + ":" + roundDate.slice(0, 10) + ":" + shape;
  const retrieved = pdgaBaselines.get(key) ?? pdgaBaselineForPlayed(db, layoutId, playedHolesFromShape(shape), roundDate);
  pdgaBaselines.set(key, retrieved);
  const baseline = await retrieved;
  if (!baseline || baseline.ssa !== numberOrNull(row.pdga_baseline_ssa) || baseline.rounds !== intOrNull(row.pdga_baseline_rounds)) return false;
  const predicted = roundRatingForScoreWithWeather({
    score: total, ssa: baseline.ssa, ppt: baseline.ppt, weather: { windGustMph: numberOrNull(row.wind_gust_mph) },
  });
  return predicted.roundRating === row.round_rating;
}

export function makeRatingValidator(db: D1Like): ValidRating {
  const baselines = new Map<string, Promise<LayoutRatingBaseline | null>>();
  const pdgaBaselines = new Map<string, Promise<PdgaBaseline | null>>();
  return async (row, stream) => {
    if (!await matchesStoredRatingEvidence(row, stream)) return false;
    if (row.rating_method === "pdga" && row.round_rating != null) return validPdgaRating(row, pdgaBaselines, db);
    // A casual estimate must still agree with its source event's current valid calibration.
    if (row.rating_method !== "layout" || row.round_rating == null) return true;
    const revision = stringOrNull(row.layout_revision);
    const baselineId = intOrNull(row.baseline_event_id);
    const total = intOrNull(row.total);
    if (!revision || baselineId == null || total == null) return false;
    const key = revision + ":" + baselineId;
    const retrieved = baselines.get(key) ?? getSourceRatingBaseline(db, revision, baselineId);
    baselines.set(key, retrieved);
    const baseline = await retrieved;
    if (!baseline || baseline.availableAt >= String(row.round_date ?? "")) return false;
    const predicted = roundRatingForScoreWithWeather({
      score: total, ssa: baseline.ssa, ppt: baseline.ppt, weather: { windGustMph: numberOrNull(row.wind_gust_mph) },
    });
    return predicted.roundRating === row.round_rating && baseline.propagatorCount === row.propagator_count;
  };
}

async function eligibleRatingHistory(db: D1Like, memberId: string, stream: RatingStream, now: string, valid: ValidRating): Promise<EngineRound[]> {
  const source = stream === "competition" ? "results" : "casual_results";
  const since = new Date(Date.parse(now) - 365 * 86_400_000).toISOString();
  const rows = await db.prepare(
    `SELECT ${CURRENT_RESULT_FIELDS[stream]}, ${RATING_EVIDENCE_FIELDS}
       FROM round_ratings rr JOIN ${source} res ON res.id = rr.source_result_id AND res.member_id = rr.member_id
       ${JOINS[stream]}
       WHERE rr.member_id = ? AND rr.stream = ? AND rr.round_rating IS NOT NULL
       AND rr.round_date >= ? AND rr.round_date <= ?`,
  ).bind(memberId, stream, since, now).all<RatingRow>();
  const validated = await Promise.all(rows.results.map(async (row) => await valid(row, stream)
    ? { roundRating: intOrNull(row.round_rating), roundDate: String(row.round_date) } : null));
  return validated.filter((row): row is EngineRound => row != null);
}

async function ratingDisplayRows(
  db: D1Like,
  memberId: string,
  stream: RatingStream,
  opts: { limit?: number | null; offset?: number | null },
  valid: ValidRating,
): Promise<RatingRow[]> {
  const binds: unknown[] = [memberId];
  const limit = Number.isInteger(opts.limit) && opts.limit != null ? opts.limit : null;
  const offset = typeof opts.offset === "number" && Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;
  const sharedFields = `${CURRENT_RESULT_FIELDS[stream]}, ${RATING_EVIDENCE_FIELDS}`;
  let sql = stream === "competition"
    ? `SELECT ${sharedFields}, CASE WHEN rr.source_result_id IS NOT NULL THEN rr.round_rating
          ELSE COALESCE(rr.round_rating, res.rating) END AS rating,
          e.name AS event_name, c.name AS course_name, c.udisc_course_id, l.name AS layout_name
       FROM results res ${JOINS.competition}
       LEFT JOIN courses c ON c.id = e.course_id
       LEFT JOIN course_layouts l ON l.id = e.layout_id
       LEFT JOIN round_ratings rr ON rr.event_id = res.event_id AND rr.member_id = res.member_id AND rr.stream = 'competition'
         AND (rr.source_result_id IS NULL OR rr.source_result_id = res.id)
       WHERE res.member_id = ? ORDER BY COALESCE(e.date, res.created_at) DESC, res.created_at DESC, res.id DESC`
    : `SELECT ${sharedFields}, rr.round_rating AS rating, cround.course_name, cround.layout_name, c.udisc_course_id
       FROM casual_results res ${JOINS.casual}
       LEFT JOIN courses c ON c.id = cround.course_id
       LEFT JOIN round_ratings rr ON rr.casual_round_code = cround.round_code AND rr.member_id = res.member_id AND rr.stream = 'casual'
         AND (rr.source_result_id IS NULL OR rr.source_result_id = res.id)
       WHERE res.member_id = ? ORDER BY cround.finalized_at DESC, res.created_at DESC, res.id DESC`;
  if (limit != null) {
    sql += " LIMIT ?";
    binds.push(limit);
    if (offset) { sql += " OFFSET ?"; binds.push(offset); }
  }
  const { results } = await db.prepare(sql).bind(...binds).all<RatingRow>();
  return Promise.all(results.map(async (row) => {
    if (row.source_result_id == null || await valid(row, stream)) return row;
    return { ...row, rating: null, anchor_count: 0, propagator_count: 0, baseline_event_id: null, pdga_baseline_rounds: null,
      pdga_baseline_ssa: null, unrated_reason: "rating-source-changed" };
  }));
}

export async function getMemberRatings(
  db: D1Like,
  memberId: string,
  opts: {
    competitiveLimit?: number | null;
    competitiveOffset?: number | null;
    casualLimit?: number | null;
    casualOffset?: number | null;
  } = {},
): Promise<MemberRatings> {
  const now = new Date().toISOString();
  const valid = makeRatingValidator(db);
  const [competitive, casual, competitiveEvidence, casualEvidence] = await Promise.all([
    ratingDisplayRows(db, memberId, "competition", { limit: opts.competitiveLimit, offset: opts.competitiveOffset }, valid),
    ratingDisplayRows(db, memberId, "casual", { limit: opts.casualLimit, offset: opts.casualOffset }, valid),
    eligibleRatingHistory(db, memberId, "competition", now, valid),
    eligibleRatingHistory(db, memberId, "casual", now, valid),
  ]);
  return {
    competitive: summarizeRatingRows("competitive", competitive, competitiveEvidence, now),
    casual: summarizeRatingRows("casual", casual, casualEvidence, now),
  };
}
