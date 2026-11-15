import type { D1Like, D1StatementLike } from "./db-types.js";
import { aggregatePlayerRating, type RatingMethod, type RatingStream } from "./rating-engine.js";
import { readArchivedRatingHoles, ratingLayoutRevision, ratingNumber, ratingTimestamp } from "./rating-layout.js";

export type LayoutRatingBaseline = {
  ssa: number;
  ppt: number;
  propagatorCount: number;
  eventId: number;
  availableAt: string;
};

export type RoundRatingInput = {
  memberId: string;
  playerName: string;
  stream: RatingStream;
  eventId: number | null;
  casualRoundCode: string | null;
  courseId: number | null;
  layoutId: number | null;
  layoutRevision: string | null;
  sourceResultId: number;
  sourceScorecard: string;
  roundDate: string;
  total: number;
  toPar: number;
  roundRating: number | null;
  ssa: number | null;
  ppt: number | null;
  windGustMph: number | null;
  weatherAdjustment: number;
  propagatorCount: number;
  anchorCount: number;
  baselineEventId: number | null;
  ratingMethod: RatingMethod;
  unratedReason: string | null;
};

export type RatingBaselineInput = LayoutRatingBaseline & {
  layoutId: number;
  layoutRevision: string;
  playedAt: string;
  sourceResultId: number;
  sourceScorecard: string;
};

export async function getRevisionRatingBaseline(db: D1Like, revision: string | null, before: string): Promise<LayoutRatingBaseline | null> {
  if (!revision) return null;
  const row = await db.prepare(
    `SELECT event_id, ssa, ppt, propagator_count, available_at FROM layout_rating_baselines
       WHERE layout_revision = ? AND available_at < ? AND played_at < ?
       ORDER BY played_at DESC, available_at DESC, event_id DESC LIMIT 1`,
  ).bind(revision, before, before).first<{
    event_id: number; ssa: number; ppt: number; propagator_count: number; available_at: string;
  }>();
  if (!row || !(row.ssa > 0) || !(row.ppt > 0)) return null;
  return { ssa: row.ssa, ppt: row.ppt, propagatorCount: row.propagator_count, eventId: row.event_id, availableAt: row.available_at };
}

export async function getLayoutRatingBaseline(db: D1Like, layoutId: number | null, holes?: readonly unknown[], startedAt?: string): Promise<LayoutRatingBaseline | null> {
  if (layoutId == null) return null;
  const started = ratingTimestamp(startedAt);
  if (holes && !started) return null;
  const current = holes ?? (await db.prepare("SELECT holes FROM course_layouts WHERE id = ?").bind(layoutId).first<{ holes: string }>())?.holes;
  const snapshot = readArchivedRatingHoles(current);
  const before = started ?? new Date().toISOString();
  return snapshot ? getRevisionRatingBaseline(db, await ratingLayoutRevision(layoutId, snapshot), before) : null;
}

function roundRatingStatement(db: D1Like, row: RoundRatingInput): D1StatementLike {
  const results = row.stream === "competition" ? "results" : "casual_results";
  return db.prepare(
    `INSERT INTO round_ratings (
       member_id, player_name, stream, event_id, casual_round_code, course_id, layout_id,
       round_date, total, to_par, round_rating, ssa, ppt, wind_gust_mph, weather_adjustment,
       propagator_count, rating_method, source_result_id, layout_revision, baseline_event_id,
       anchor_count, unrated_reason
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM ${results} WHERE id = ? AND member_id = ? AND total = ? AND to_par = ? AND scorecard = ?)
       ON CONFLICT DO UPDATE SET
         player_name = excluded.player_name, stream = excluded.stream, course_id = excluded.course_id,
         layout_id = excluded.layout_id, round_date = excluded.round_date, total = excluded.total,
         to_par = excluded.to_par, round_rating = excluded.round_rating, ssa = excluded.ssa,
         ppt = excluded.ppt, wind_gust_mph = COALESCE(excluded.wind_gust_mph, round_ratings.wind_gust_mph),
         weather_adjustment = excluded.weather_adjustment, propagator_count = excluded.propagator_count,
         rating_method = excluded.rating_method, source_result_id = excluded.source_result_id,
         layout_revision = excluded.layout_revision, baseline_event_id = excluded.baseline_event_id,
         anchor_count = excluded.anchor_count, unrated_reason = excluded.unrated_reason
       WHERE excluded.round_rating IS NOT NULL OR round_ratings.round_rating IS NULL OR
         (round_ratings.source_result_id IS NOT NULL AND round_ratings.source_result_id != excluded.source_result_id)`,
  ).bind(
    row.memberId, row.playerName, row.stream, row.eventId, row.casualRoundCode, row.courseId, row.layoutId,
    row.roundDate, row.total, row.toPar, row.roundRating, row.ssa, row.ppt, row.windGustMph,
    row.weatherAdjustment, row.propagatorCount, row.ratingMethod, row.sourceResultId, row.layoutRevision,
    row.baselineEventId, row.anchorCount, row.unratedReason, row.sourceResultId, row.memberId, row.total, row.toPar, row.sourceScorecard,
  );
}

function baselineStatement(db: D1Like, row: RatingBaselineInput): D1StatementLike {
  return db.prepare(
    `INSERT INTO layout_rating_baselines (layout_revision, layout_id, event_id, played_at, available_at, ssa, ppt, propagator_count)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM results WHERE id = ? AND event_id = ? AND scorecard = ?)
      ON CONFLICT(layout_revision, event_id) DO UPDATE SET
        played_at = excluded.played_at, available_at = excluded.available_at,
        ssa = excluded.ssa, ppt = excluded.ppt, propagator_count = excluded.propagator_count`,
  ).bind(row.layoutRevision, row.layoutId, row.eventId, row.playedAt, row.availableAt, row.ssa, row.ppt, row.propagatorCount,
    row.sourceResultId, row.eventId, row.sourceScorecard);
}

// No clear-before-create. Old values and baseline rows survive a failed batch.
export async function writeRatingBatch(db: D1Like, rows: readonly RoundRatingInput[], baselines: readonly RatingBaselineInput[]): Promise<void> {
  const statements = rows.flatMap((row) => {
    const writes = [roundRatingStatement(db, row)];
    if (row.stream === "competition" && row.roundRating != null) {
      writes.push(db.prepare("UPDATE results SET rating = ? WHERE id = ? AND member_id = ? AND total = ? AND to_par = ? AND scorecard = ?")
        .bind(row.roundRating, row.sourceResultId, row.memberId, row.total, row.toPar, row.sourceScorecard));
    }
    return writes;
  });
  statements.push(...baselines.map((row) => baselineStatement(db, row)));
  if (!statements.length) return;
  if (!db.batch) throw new Error("Rating persistence requires a transactional batch");
  const results = await db.batch(statements);
  if (results.some((entry) => !entry.success)) throw new Error("Rating batch failed");
}

export async function queueRatingRepair(db: D1Like, stream: RatingStream, sourceId: number, now = new Date().toISOString()): Promise<void> {
  await db.prepare(
    `INSERT INTO rating_repair_issues (stream, source_id, attempts, last_code, checked_at, retry_at)
     VALUES (?, ?, 1, 'finalize-write-failed', ?, ?)
     ON CONFLICT(stream, source_id) DO UPDATE SET last_code = excluded.last_code,
       checked_at = excluded.checked_at, retry_at = MIN(rating_repair_issues.retry_at, excluded.retry_at)`,
  ).bind(stream, sourceId, now, now).run();
}

type AnchorRow = { member_id: string; rating: number };
type PriorRow = { member_id: string; round_rating: number; round_date: string };

export async function priorRatingAnchors(db: D1Like, ids: readonly string[], before: string): Promise<Map<string, number>> {
  const anchors = new Map<string, number>();
  const since = new Date(Date.parse(before) - (365 * 24 * 60 * 60 * 1000)).toISOString();
  for (let offset = 0; offset < ids.length; offset += 75) {
    const group = ids.slice(offset, offset + 75);
    const slots = group.map(() => "?").join(", ");
    const [official, local] = await Promise.all([
      db.prepare(
        `SELECT member_id, rating FROM (
           SELECT member_id, rating, ROW_NUMBER() OVER (PARTITION BY member_id ORDER BY effective_at DESC, observed_at DESC) AS rank
           FROM rating_anchor_snapshots
           WHERE member_id IN (${slots}) AND observed_at < ? AND effective_at < ? AND effective_at >= ?
         ) WHERE rank = 1`,
      ).bind(...group, before, before, since).all<AnchorRow>(),
      db.prepare(
        `SELECT rr.member_id, rr.round_rating, rr.round_date FROM round_ratings rr
         JOIN results res ON res.id = rr.source_result_id AND res.member_id = rr.member_id
         WHERE rr.member_id IN (${slots}) AND rr.stream = 'competition' AND rr.rating_method = 'stable'
         AND rr.layout_revision IS NOT NULL AND rr.round_date < ? AND rr.round_date >= ?
         AND strftime('%Y-%m-%dT%H:%M:%fZ', res.created_at) < ?`,
      ).bind(...group, before, since, before).all<PriorRow>(),
    ]);
    if (!official.success || !local.success) throw new Error("Historical rating anchors unavailable");
    for (const row of official.results) if (row.rating >= 700) anchors.set(row.member_id, row.rating);
    const byMember = new Map<string, PriorRow[]>();
    for (const row of local.results) {
      const list = byMember.get(row.member_id) ?? [];
      list.push(row);
      byMember.set(row.member_id, list);
    }
    for (const [memberId, rows] of byMember) {
      if (anchors.has(memberId)) continue;
      const summary = aggregatePlayerRating({
        now: before, rounds: rows.map((row) => ({ roundDate: row.round_date, roundRating: ratingNumber(row.round_rating) })),
      });
      if (summary.rating != null && summary.rating >= 700) anchors.set(memberId, summary.rating);
    }
  }
  return anchors;
}
