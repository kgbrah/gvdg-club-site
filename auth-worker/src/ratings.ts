import type { D1Like } from "./db.js";

import { aggregatePlayerRating, MIN_OVERALL_ROUNDS, type RatingMethod, type RatingRound as EngineRound, type RatingStream } from "./rating-engine.js";
import { singlesStrokeEvidence } from "./rating-repair.js";

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
  if (row.rating_method === "stable" || row.rating_method === "provisional" || row.rating_method === "layout") return row.rating_method;
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

const RATING_EVIDENCE_FIELDS = `rr.source_result_id, rr.rating_method, rr.anchor_count, rr.propagator_count,
   rr.baseline_event_id, rr.layout_revision, rr.unrated_reason`;

async function eligibleRatingHistory(db: D1Like, memberId: string, stream: RatingStream, now: string): Promise<EngineRound[]> {
  const source = stream === "competition" ? "results" : "casual_results";
  const since = new Date(Date.parse(now) - 365 * 86_400_000).toISOString();
  const rows = await db.prepare(
    `SELECT rr.round_rating, rr.round_date FROM round_ratings rr
       JOIN ${source} res ON res.id = rr.source_result_id AND res.member_id = rr.member_id
       WHERE rr.member_id = ? AND rr.stream = ? AND rr.round_rating IS NOT NULL
       AND rr.round_date >= ? AND rr.round_date <= ?`,
  ).bind(memberId, stream, since, now).all<{ round_rating: number; round_date: string }>();
  return rows.results.map(({ round_rating, round_date }) => ({ roundRating: round_rating, roundDate: round_date }));
}

async function competitiveRows(
  db: D1Like,
  memberId: string,
  opts: { limit?: number | null; offset?: number | null } = {},
): Promise<readonly Record<string, unknown>[]> {
  const binds: unknown[] = [memberId];
  const limit = Number.isInteger(opts.limit) && opts.limit != null ? opts.limit : null;
  const rawOffset = opts.offset;
  const offset = typeof rawOffset === "number" && Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  let sql =
    `SELECT r.id, r.event_id, r.member_id, r.name, r.place, r.total, r.to_par,
            COALESCE(rr.round_rating, r.rating) AS rating, r.breakdown, r.scorecard,
            r.created_at, r.scoring_group, r.match_result, e.name AS event_name, e.date AS event_date,
            e.type AS event_type, c.name AS course_name, c.udisc_course_id AS udisc_course_id, l.name AS layout_name,
            e.format, ec.play_format, ec.live_scoring_config AS scoring_config, ${RATING_EVIDENCE_FIELDS}
     FROM results r
     JOIN events e ON e.id = r.event_id
     LEFT JOIN event_config ec ON ec.event_id = e.id
     LEFT JOIN courses c ON c.id = e.course_id
     LEFT JOIN course_layouts l ON l.id = e.layout_id
     LEFT JOIN round_ratings rr
       ON rr.event_id = r.event_id AND rr.member_id = r.member_id AND rr.stream = 'competition'
       AND (rr.source_result_id IS NULL OR rr.source_result_id = r.id)
     WHERE r.member_id = ?
     ORDER BY COALESCE(e.date, r.created_at) DESC, r.created_at DESC, r.id DESC`;
  if (limit != null) {
    sql += " LIMIT ?";
    binds.push(limit);
    if (offset > 0) {
      sql += " OFFSET ?";
      binds.push(offset);
    }
  }
  return (await db.prepare(sql).bind(...binds).all()).results;
}

async function casualRows(
  db: D1Like,
  memberId: string,
  opts: { limit?: number | null; offset?: number | null } = {},
): Promise<readonly Record<string, unknown>[]> {
  const binds: unknown[] = [memberId];
  const limit = Number.isInteger(opts.limit) && opts.limit != null ? opts.limit : null;
  const rawOffset = opts.offset;
  const offset = typeof rawOffset === "number" && Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  let sql =
    `SELECT cr.*, r.round_code, r.course_name, r.layout_name, r.layout_id, r.finalized_at,
            c.udisc_course_id AS udisc_course_id, rr.round_rating AS rating, r.scoring_config, ${RATING_EVIDENCE_FIELDS}
     FROM casual_results cr
     JOIN casual_rounds r ON r.id = cr.casual_round_id
     LEFT JOIN courses c ON c.id = r.course_id
     LEFT JOIN round_ratings rr
       ON rr.casual_round_code = r.round_code AND rr.member_id = cr.member_id AND rr.stream = 'casual'
       AND (rr.source_result_id IS NULL OR rr.source_result_id = cr.id)
     WHERE cr.member_id = ?
     ORDER BY r.finalized_at DESC, cr.created_at DESC, cr.id DESC`;
  if (limit != null) {
    sql += " LIMIT ?";
    binds.push(limit);
    if (offset > 0) {
      sql += " OFFSET ?";
      binds.push(offset);
    }
  }
  return (await db.prepare(sql).bind(...binds).all()).results;
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
  const [competitive, casual, competitiveEvidence, casualEvidence] = await Promise.all([
    competitiveRows(db, memberId, { limit: opts.competitiveLimit ?? null, offset: opts.competitiveOffset ?? null }),
    casualRows(db, memberId, { limit: opts.casualLimit ?? null, offset: opts.casualOffset ?? null }),
    eligibleRatingHistory(db, memberId, "competition", now),
    eligibleRatingHistory(db, memberId, "casual", now),
  ]);
  return {
    competitive: summarizeRatingRows("competitive", competitive, competitiveEvidence, now),
    casual: summarizeRatingRows("casual", casual, casualEvidence, now),
  };
}
