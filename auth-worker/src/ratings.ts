import type { D1Like } from "./db-types.js";

import { aggregatePlayerRating, roundRatingForScoreWithWeather, MIN_OVERALL_ROUNDS, type RatingMethod, type RatingRound as EngineRound, type RatingStream } from "./rating-engine.js";
import { CURRENT_RESULT_FIELDS, STORED_EVIDENCE_FIELDS, matchesStoredRatingEvidence, singlesStrokeEvidence } from "./rating-source.js";
import { getSourceRatingBaselines, type LayoutRatingBaseline, type SourceBaselineKey } from "./rating-store.js";
import { pdgaBaselinesForPlayed, pdgaEvidenceUnchanged, playedHolesFromShape, type PlayedBaselineRequest } from "./pdga-baseline-store.js";
import { clubCalendarDay, type PdgaBaseline } from "./pdga-baselines.js";
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
  rr.baseline_event_id, rr.unrated_reason, rr.round_date, rr.round_rating, rr.wind_gust_mph, rr.pdga_baseline_ssa, rr.pdga_baseline_rounds,
  rr.rated_at`;
const JOINS = {
  competition: `JOIN events e ON e.id = res.event_id LEFT JOIN event_config ec ON ec.event_id = e.id`,
  casual: `JOIN casual_rounds cround ON cround.id = res.casual_round_id`,
} as const;

type RatingRow = Record<string, unknown>;
/** Checks a batch of stored ratings against their current sources (one verdict per row, in order). */
type ValidRatings = (rows: readonly RatingRow[], stream: RatingStream) => Promise<boolean[]>;
type PdgaCheck = { layoutId: number; roundDate: string; total: number; holes: NonNullable<ReturnType<typeof readArchivedRatingHoles>> };
type PdgaRederive = PlayedBaselineRequest & { key: string };

/** What a PDGA-based rating's baseline is read from: its as-played layout and club day (and, to re-derive it, hole shape). */
function pdgaCheckFor(row: RatingRow): PdgaCheck | null {
  const holes = readArchivedRatingHoles(row.scorecard, true);
  const layoutId = holes?.[0]?.layoutId ?? null;
  const roundDate = stringOrNull(row.round_date);
  const total = intOrNull(row.total);
  if (!holes || layoutId == null || !roundDate || total == null) return null;
  return { layoutId, roundDate, total, holes };
}

function pdgaRederive(check: PdgaCheck): PdgaRederive {
  const shape = ratingGeometrySnapshot(check.holes);
  return { key: check.layoutId + ":" + (clubCalendarDay(check.roundDate) ?? check.roundDate) + ":" + shape,
    layoutId: check.layoutId, played: playedHolesFromShape(shape), roundDate: check.roundDate };
}

// Columns only the ratings list shows; the check never reads them.
const DISPLAY_ONLY_FIELDS = new Set(["rating", "event_name", "course_name", "layout_name", "udisc_course_id"]);

/** Rows equal in every column the check can read get the same verdict (recent rounds are both listed and rated on). */
function verdictKey(row: RatingRow, stream: RatingStream): string {
  return stream + JSON.stringify(Object.keys(row).filter((key) => !DISPLAY_ONLY_FIELDS.has(key)).sort().map((key) => [key, row[key]]));
}

/** The club calibration a casual estimate was made from, when its row names one. */
function layoutBaselineKey(row: RatingRow): (SourceBaselineKey & { key: string }) | null {
  if (row.rating_method !== "layout" || row.round_rating == null) return null;
  const revision = stringOrNull(row.layout_revision);
  const eventId = intOrNull(row.baseline_event_id);
  return revision && eventId != null && intOrNull(row.total) != null ? { key: revision + ":" + eventId, revision, eventId } : null;
}

/** A PDGA-based rating must still match the baseline the current PDGA evidence gives that round. */
function pdgaRatingMatches(row: RatingRow, check: PdgaCheck, baseline: PdgaBaseline | null): boolean {
  if (!baseline || baseline.ssa !== numberOrNull(row.pdga_baseline_ssa) || baseline.rounds !== intOrNull(row.pdga_baseline_rounds)) return false;
  const predicted = roundRatingForScoreWithWeather({
    score: check.total, ssa: baseline.ssa, ppt: baseline.ppt, weather: { windGustMph: numberOrNull(row.wind_gust_mph) },
  });
  return predicted.roundRating === row.round_rating;
}

export function makeRatingValidator(db: D1Like): ValidRatings {
  const baselines = new Map<string, Promise<LayoutRatingBaseline | null>>();
  const pdgaBaselines = new Map<string, Promise<PdgaBaseline | null>>();
  const evidenceChanges: NonNullable<Parameters<typeof pdgaEvidenceUnchanged>[2]> = new Map();
  const verdicts = new Map<string, Promise<boolean>>();
  return (rows, stream) => {
    const keys = rows.map((row) => verdictKey(row, stream));
    const fresh = new Map<string, RatingRow>();
    keys.forEach((key, index) => { if (!verdicts.has(key) && !fresh.has(key)) fresh.set(key, rows[index]!); });
    if (fresh.size) {
      const checked = checkRows([...fresh.values()], stream);
      [...fresh.keys()].forEach((key, index) => verdicts.set(key, checked.then((found) => found[index] === true)));
    }
    return Promise.all(keys.map((key) => verdicts.get(key)!));
  };
  async function checkRows(rows: readonly RatingRow[], stream: RatingStream): Promise<boolean[]> {
    const evidence = await Promise.all(rows.map((row) => matchesStoredRatingEvidence(row, stream)));
    const pdga = rows.map((row, index) => evidence[index] && row.rating_method === "pdga" && row.round_rating != null ? pdgaCheckFor(row) : null);
    // A PDGA rating written after the last change to the evidence its baseline reads is still right (checked when written).
    const unchanged = await pdgaEvidenceUnchanged(db, pdga.map((check, index) => check
      ? { layoutId: check.layoutId, roundDate: check.roundDate, ratedAt: stringOrNull(rows[index]!.rated_at) } : null), evidenceChanges);
    // The rest are re-derived from the current evidence, every baseline still needed read together.
    const rederive = pdga.map((check, index) => check && !unchanged[index] ? pdgaRederive(check) : null);
    const needed = [...new Map(rederive.flatMap((request) => request && !pdgaBaselines.has(request.key)
      ? [[request.key, request] as const] : [])).values()];
    if (needed.length) {
      const batch = pdgaBaselinesForPlayed(db, needed);
      needed.forEach((request, index) => pdgaBaselines.set(request.key, batch.then((found) => found[index] ?? null)));
    }
    // Every club calibration still to verify, verified together.
    const calibrations = [...new Map(rows.flatMap((row, index) => {
      const source = evidence[index] ? layoutBaselineKey(row) : null;
      return source && !baselines.has(source.key) ? [[source.key, source] as const] : [];
    })).values()];
    if (calibrations.length) {
      const batch = getSourceRatingBaselines(db, calibrations);
      calibrations.forEach((source, index) => baselines.set(source.key, batch.then((found) => found[index] ?? null)));
    }
    return Promise.all(rows.map((row, index) => evidence[index]
      ? validStoredRating(row, pdga[index] ?? null, unchanged[index] === true, rederive[index] ?? null) : false));
  }
  async function validStoredRating(row: RatingRow, check: PdgaCheck | null, unchanged: boolean, rederive: PdgaRederive | null): Promise<boolean> {
    if (row.rating_method === "pdga" && row.round_rating != null) {
      if (!check) return false;
      return unchanged || (rederive != null && pdgaRatingMatches(row, check, await pdgaBaselines.get(rederive.key)!));
    }
    // A casual estimate must still agree with its source event's current valid calibration.
    if (row.rating_method !== "layout" || row.round_rating == null) return true;
    const source = layoutBaselineKey(row);
    const total = intOrNull(row.total);
    if (!source || total == null) return false;
    const baseline = await baselines.get(source.key)!;
    if (!baseline || baseline.availableAt >= String(row.round_date ?? "")) return false;
    const predicted = roundRatingForScoreWithWeather({
      score: total, ssa: baseline.ssa, ppt: baseline.ppt, weather: { windGustMph: numberOrNull(row.wind_gust_mph) },
    });
    return predicted.roundRating === row.round_rating && baseline.propagatorCount === row.propagator_count;
  }
}

async function eligibleRatingHistory(db: D1Like, memberId: string, stream: RatingStream, now: string, valid: ValidRatings): Promise<EngineRound[]> {
  const source = stream === "competition" ? "results" : "casual_results";
  const since = new Date(Date.parse(now) - 365 * 86_400_000).toISOString();
  const rows = await db.prepare(
    `SELECT ${CURRENT_RESULT_FIELDS[stream]}, ${RATING_EVIDENCE_FIELDS}
       FROM round_ratings rr JOIN ${source} res ON res.id = rr.source_result_id AND res.member_id = rr.member_id
       ${JOINS[stream]}
       WHERE rr.member_id = ? AND rr.stream = ? AND rr.round_rating IS NOT NULL
       AND rr.round_date >= ? AND rr.round_date <= ?`,
  ).bind(memberId, stream, since, now).all<RatingRow>();
  const verdicts = await valid(rows.results, stream);
  return rows.results.flatMap((row, index) => verdicts[index]
    ? [{ roundRating: intOrNull(row.round_rating), roundDate: String(row.round_date) } as EngineRound] : []);
}

async function ratingDisplayRows(
  db: D1Like,
  memberId: string,
  stream: RatingStream,
  opts: { limit?: number | null; offset?: number | null },
  valid: ValidRatings,
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
  const sourced = results.filter((row) => row.source_result_id != null);
  const verdicts = await valid(sourced, stream);
  const stillValid = new Map(sourced.map((row, index) => [row, verdicts[index]]));
  return results.map((row) => {
    if (row.source_result_id == null || stillValid.get(row)) return row;
    return { ...row, rating: null, anchor_count: 0, propagator_count: 0, baseline_event_id: null, pdga_baseline_rounds: null,
      pdga_baseline_ssa: null, unrated_reason: "rating-source-changed" };
  });
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
