import type { D1Like, D1StatementLike } from "./db-types.js";
import type { RatingStream } from "./rating-engine.js";
import { COMPETITION_FIELD_REVISION, singlesStrokeEvidence } from "./rating-source.js";
import { makeRatingValidator, RATING_EVIDENCE_FIELDS } from "./ratings.js";

async function validateListedResultRatings(db: D1Like, stream: RatingStream, rows: Record<string, unknown>[]) {
  const checked = rows.filter((row) => singlesStrokeEvidence(row, "competition") && row.source_result_id != null);
  const verdicts = await makeRatingValidator(db)(checked, stream);
  const stillValid = new Map(checked.map((row, index) => [row, verdicts[index]]));
  return rows.map((row) => {
    const { source_result_id, source_fingerprint, rating_total, rating_to_par, layout_revision, rating_method, anchor_count,
      propagator_count, baseline_event_id, unrated_reason, round_date, wind_gust_mph, event_status, starts_at,
      format, play_format, scoring_config, started_at, layout_holes, field_revision, pdga_baseline_ssa, pdga_baseline_rounds, rated_at,
      ...result } = row;
    if (!singlesStrokeEvidence(row, "competition") || (source_result_id != null && !stillValid.get(row))) {
      result.round_rating = null;
      if (stream === "competition") result.rating = null;
    } else if (stream === "competition" && source_result_id != null) {
      result.rating = result.round_rating;
    }
    return result;
  });
}

/** Run statements as ONE atomic D1 transaction when the binding supports batch() (real D1 does); otherwise
 *  fall back to sequential execution (the d1kv fallback and test stubs don't implement batch). Used to make
 *  a finalize write all-or-nothing so a mid-write failure can't leave a partial leaderboard. */
export async function runBatch(db: D1Like, statements: D1StatementLike[]): Promise<void> {
  if (statements.length === 0) return;
  if (typeof db.batch === "function") {
    await db.batch(statements);
    return;
  }
  for (const s of statements) await s.run();
}

export interface ResultInput {
  event_id: number;
  member_id?: string | null;
  name: string;
  place?: number | null;
  total?: number | null;
  to_par?: number | null;
  rating?: number | null;
  breakdown?: string | null;
  scorecard?: string | null;
  scoring_group?: string | null;
  match_result?: string | null;
}

export async function createResult(db: D1Like, r: ResultInput) {
  return db
    .prepare(
      "INSERT INTO results (event_id, member_id, name, place, total, to_par, rating, breakdown, scorecard, scoring_group, match_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(r.event_id, r.member_id ?? null, r.name, r.place ?? null, r.total ?? null, r.to_par ?? null, r.rating ?? null, r.breakdown ?? null, r.scorecard ?? null, r.scoring_group ?? null, r.match_result ?? null)
    .first();
}

export async function clearResults(db: D1Like, eventId: number) {
  await clearResultsStmt(db, eventId).run();
}

// Statement builders (no RETURNING, not executed) so a finalize can write clear + all inserts in one
// atomic db.batch() — see runBatch.
export function clearResultsStmt(db: D1Like, eventId: number): D1StatementLike {
  return db.prepare("DELETE FROM results WHERE event_id = ?").bind(eventId);
}

export function createResultStmt(db: D1Like, r: ResultInput): D1StatementLike {
  return db
    .prepare("INSERT INTO results (event_id, member_id, name, place, total, to_par, rating, breakdown, scorecard, scoring_group, match_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(r.event_id, r.member_id ?? null, r.name, r.place ?? null, r.total ?? null, r.to_par ?? null, r.rating ?? null, r.breakdown ?? null, r.scorecard ?? null, r.scoring_group ?? null, r.match_result ?? null);
}

const COMPETITION_RATING_FIELDS = `e.status AS event_status, e.starts_at, e.format, ec.play_format,
  ec.live_scoring_config AS scoring_config, ${COMPETITION_FIELD_REVISION}, ${RATING_EVIDENCE_FIELDS}`;
const COMPETITION_RATING_JOINS = `LEFT JOIN event_config ec ON ec.event_id = e.id
  LEFT JOIN round_ratings rr ON rr.event_id = res.event_id AND rr.member_id = res.member_id AND rr.stream = 'competition'`;

export async function listResults(db: D1Like, eventId: number) {
  const { results } = await db.prepare(
    `SELECT res.*, e.date AS event_date, ${COMPETITION_RATING_FIELDS}
     FROM results res JOIN events e ON e.id = res.event_id ${COMPETITION_RATING_JOINS}
     WHERE res.event_id = ? ORDER BY res.place, res.total`,
  ).bind(eventId).all();
  const checked = await validateListedResultRatings(db, "competition", results);
  return checked.map(({ round_rating, event_date, ...result }) => result);
}

export async function listMemberResults(db: D1Like, memberId: string, opts: { limit?: number | null; offset?: number | null } = {}) {
  const binds: unknown[] = [memberId];
  const limit = Number.isInteger(opts.limit) && opts.limit != null ? opts.limit : null;
  const rawOffset = opts.offset;
  const offset = typeof rawOffset === "number" && Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  let sql =
    `SELECT res.*, e.name AS event_name, e.date AS event_date, e.type AS event_type,
                e.layout_id AS layout_id, c.name AS course_name, l.name AS layout_name,
                c.udisc_course_id AS udisc_course_id, c.udisc_url AS udisc_url,
                CASE
                  WHEN res.match_result IS NOT NULL AND TRIM(res.match_result) != '' AND res.match_result != 'null' THEN 0
                  WHEN json_extract(res.scoring_group, '$.targetType') = 'pair' THEN 0
                  WHEN LOWER(COALESCE(e.format, '')) LIKE '%matchplay%' OR LOWER(COALESCE(e.format, '')) LIKE '%doubles%' OR LOWER(COALESCE(e.format, '')) LIKE '%putting%' THEN 0
                  WHEN LOWER(COALESCE(ec.play_format, '')) IN ('doubles', 'teams') THEN 0
                  WHEN json_extract(ec.live_scoring_config, '$.scoringStyle') IN ('matchplay', 'putting') THEN 0
                  WHEN json_extract(ec.live_scoring_config, '$.groupFormat') = 'doubles' THEN 0
                  ELSE 1
                END AS stroke_singles,
                ${COMPETITION_RATING_FIELDS}
         FROM results res JOIN events e ON e.id = res.event_id ${COMPETITION_RATING_JOINS}
         LEFT JOIN courses c ON c.id = e.course_id
         LEFT JOIN course_layouts l ON l.id = e.layout_id
         WHERE res.member_id = ?
         ORDER BY COALESCE(e.date, res.created_at) DESC, res.created_at DESC, res.id DESC`;
  if (limit != null) {
    sql += " LIMIT ?";
    binds.push(limit);
    if (offset > 0) {
      sql += " OFFSET ?";
      binds.push(offset);
    }
  }
  return validateListedResultRatings(db, "competition", (await db.prepare(sql).bind(...binds).all()).results);
}

export interface CasualRoundInput {
  round_code: string;
  course_id?: number | null;
  layout_id?: number | null;
  course_name?: string | null;
  layout_name?: string | null;
  holes?: string | null;
  scoring_config?: string | null;
  created_by?: string | null;
  started_at?: string | null;
  live_generation?: string | null;
}

export async function clearCasualRound(db: D1Like, roundCode: string) {
  await db.prepare("DELETE FROM casual_rounds WHERE round_code = ?").bind(roundCode).run();
}

export async function createCasualRound(db: D1Like, r: CasualRoundInput) {
  return db
    .prepare(
      "INSERT INTO casual_rounds (round_code, course_id, layout_id, course_name, layout_name, holes, created_by, started_at, scoring_config, live_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(r.round_code, r.course_id ?? null, r.layout_id ?? null, r.course_name ?? null, r.layout_name ?? null, r.holes ?? null, r.created_by ?? null, r.started_at ?? null, r.scoring_config ?? null, r.live_generation ?? null)
    .first();
}

export interface CasualResultInput {
  casual_round_id: number;
  member_id?: string | null;
  name: string;
  division?: string | null;
  place?: number | null;
  total?: number | null;
  to_par?: number | null;
  breakdown?: string | null;
  scorecard?: string | null;
  scoring_group?: string | null;
  match_result?: string | null;
  live_player_index?: number | null;
}

export async function createCasualResult(db: D1Like, r: CasualResultInput) {
  return db
    .prepare(
      "INSERT INTO casual_results (casual_round_id, member_id, name, division, place, total, to_par, breakdown, scorecard, scoring_group, match_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(r.casual_round_id, r.member_id ?? null, r.name, r.division ?? null, r.place ?? null, r.total ?? null, r.to_par ?? null, r.breakdown ?? null, r.scorecard ?? null, r.scoring_group ?? null, r.match_result ?? null)
    .first();
}

export function createCasualResultStmt(db: D1Like, r: CasualResultInput): D1StatementLike {
  return db
    .prepare(
      "INSERT INTO casual_results (casual_round_id, member_id, name, division, place, total, to_par, breakdown, scorecard, scoring_group, match_result, live_player_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(r.casual_round_id, r.member_id ?? null, r.name, r.division ?? null, r.place ?? null, r.total ?? null, r.to_par ?? null, r.breakdown ?? null, r.scorecard ?? null, r.scoring_group ?? null, r.match_result ?? null, r.live_player_index ?? null);
}

export async function listCasualRoundResults(db: D1Like, roundCode: string) {
  const round = (await db.prepare("SELECT * FROM casual_rounds WHERE round_code = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1").bind(roundCode).first()) as { id?: number } | null;
  if (!round?.id) return null;
  const results = (await db.prepare("SELECT * FROM casual_results WHERE casual_round_id = ? ORDER BY place IS NULL, place, total").bind(round.id).all()).results;
  return { round, results };
}

export async function listMemberCasualResults(db: D1Like, memberId: string, opts: { limit?: number | null; offset?: number | null } = {}) {
  const binds: unknown[] = [memberId];
  const limit = Number.isInteger(opts.limit) && opts.limit != null ? opts.limit : null;
  const rawOffset = opts.offset;
  const offset = typeof rawOffset === "number" && Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  let sql =
    `SELECT cr.*, r.round_code, r.course_name, r.layout_name, r.layout_id, r.finalized_at, r.holes AS round_holes,
                c.udisc_course_id AS udisc_course_id,
                r.started_at, r.scoring_config, r.holes AS layout_holes, ${RATING_EVIDENCE_FIELDS},
                CASE
                  WHEN cr.match_result IS NOT NULL AND TRIM(cr.match_result) != '' AND cr.match_result != 'null' THEN 0
                  WHEN json_extract(r.scoring_config, '$.scoringStyle') IN ('matchplay', 'putting') THEN 0
                  WHEN json_extract(cr.scoring_group, '$.targetType') = 'pair' THEN 0
                  WHEN json_extract(r.scoring_config, '$.groupFormat') = 'doubles' THEN 0
                  ELSE 1
                END AS stroke_singles
         FROM casual_results cr JOIN casual_rounds r ON r.id = cr.casual_round_id
         LEFT JOIN courses c ON c.id = r.course_id
         LEFT JOIN round_ratings rr
           ON rr.casual_round_code = r.round_code AND rr.member_id = cr.member_id AND rr.stream = 'casual'
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
  return validateListedResultRatings(db, "casual", (await db.prepare(sql).bind(...binds).all()).results);
}

export async function listSeasonPlayRows(db: D1Like, year: number) {
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  const events = (
    await db
      .prepare(
        `SELECT r.member_id AS member_id, r.name AS name, r.breakdown AS breakdown, 'competitive' AS kind,
                CASE
                  WHEN json_extract(r.scoring_group, '$.targetType') = 'pair' THEN 'doubles'
                  WHEN json_extract(ec.live_scoring_config, '$.groupFormat') = 'doubles' THEN 'doubles'
                  WHEN ec.play_format = 'doubles' THEN 'doubles'
                  WHEN e.format = 'doubles' THEN 'doubles'
                  ELSE 'singles'
                END AS group_format,
                CASE
                  WHEN r.match_result IS NOT NULL AND TRIM(r.match_result) != '' AND r.match_result != 'null' THEN 'matchplay'
                  WHEN json_extract(ec.live_scoring_config, '$.scoringStyle') = 'matchplay' THEN 'matchplay'
                  WHEN e.format = 'matchplay' THEN 'matchplay'
                  WHEN json_extract(ec.live_scoring_config, '$.scoringStyle') = 'putting' THEN 'putting'
                  WHEN e.format = 'putting' THEN 'putting'
                  ELSE 'stroke'
                END AS scoring_style
         FROM results r JOIN events e ON e.id = r.event_id
         LEFT JOIN event_config ec ON ec.event_id = e.id
         WHERE r.member_id IS NOT NULL
           AND r.member_id NOT LIKE 'g_%'
           AND r.member_id NOT LIKE 'op_%'
           AND COALESCE(e.date, r.created_at) >= ?
           AND COALESCE(e.date, r.created_at) < ?`,
      )
      .bind(start, end)
      .all()
  ).results;
  const casual = (
    await db
      .prepare(
        `SELECT cr.member_id AS member_id, cr.name AS name, cr.breakdown AS breakdown, 'casual' AS kind,
                CASE
                  WHEN json_extract(cr.scoring_group, '$.targetType') = 'pair' THEN 'doubles'
                  WHEN json_extract(r.scoring_config, '$.groupFormat') = 'doubles' THEN 'doubles'
                  ELSE 'singles'
                END AS group_format,
                CASE
                  WHEN cr.match_result IS NOT NULL AND TRIM(cr.match_result) != '' AND cr.match_result != 'null' THEN 'matchplay'
                  WHEN json_extract(r.scoring_config, '$.scoringStyle') = 'matchplay' THEN 'matchplay'
                  WHEN json_extract(r.scoring_config, '$.scoringStyle') = 'putting' THEN 'putting'
                  ELSE 'stroke'
                END AS scoring_style
         FROM casual_results cr JOIN casual_rounds r ON r.id = cr.casual_round_id
         WHERE cr.member_id IS NOT NULL
           AND cr.member_id NOT LIKE 'g_%'
           AND cr.member_id NOT LIKE 'op_%'
           AND COALESCE(r.finalized_at, cr.created_at) >= ?
           AND COALESCE(r.finalized_at, cr.created_at) < ?`,
      )
      .bind(start, end)
      .all()
  ).results;
  return [...(Array.isArray(events) ? events : []), ...(Array.isArray(casual) ? casual : [])];
}

export async function listLayoutHandicapRounds(db: D1Like, layoutId: number, cutoffDate: string) {
  return (
    await db
      .prepare(
        `SELECT member_id, name, to_par, played_at FROM (
           SELECT cr.member_id AS member_id, cr.name AS name, cr.to_par AS to_par,
                  COALESCE(r.finalized_at, cr.created_at) AS played_at
           FROM casual_results cr
           JOIN casual_rounds r ON r.id = cr.casual_round_id
           WHERE r.layout_id = ?
             AND cr.member_id IS NOT NULL
             AND cr.member_id NOT LIKE 'g_%'
             AND cr.member_id NOT LIKE 'op_%'
             AND cr.place IS NOT NULL
             AND cr.to_par IS NOT NULL
             AND (cr.match_result IS NULL OR TRIM(cr.match_result) = '' OR cr.match_result = 'null')
             AND (json_extract(r.scoring_config, '$.scoringStyle') IS NULL OR (json_extract(r.scoring_config, '$.scoringStyle') != 'matchplay' AND json_extract(r.scoring_config, '$.scoringStyle') != 'putting'))
             AND (json_extract(r.scoring_config, '$.groupFormat') IS NULL OR json_extract(r.scoring_config, '$.groupFormat') != 'doubles')
             AND (json_extract(cr.scoring_group, '$.targetType') IS NULL OR json_extract(cr.scoring_group, '$.targetType') != 'pair')
             AND COALESCE(r.finalized_at, cr.created_at) >= ?
           UNION ALL
           SELECT res.member_id AS member_id, res.name AS name, res.to_par AS to_par,
                  COALESCE(e.date, res.created_at) AS played_at
           FROM results res
           JOIN events e ON e.id = res.event_id
           LEFT JOIN event_config ec ON ec.event_id = e.id
           WHERE e.layout_id = ?
             AND res.member_id IS NOT NULL
             AND res.member_id NOT LIKE 'g_%'
             AND res.member_id NOT LIKE 'op_%'
             AND res.place IS NOT NULL
             AND res.to_par IS NOT NULL
             AND (res.match_result IS NULL OR TRIM(res.match_result) = '' OR res.match_result = 'null')
             AND LOWER(COALESCE(e.format, '')) NOT LIKE '%matchplay%'
             AND LOWER(COALESCE(e.format, '')) NOT LIKE '%doubles%'
             AND LOWER(COALESCE(e.format, '')) NOT LIKE '%putting%'
             AND (ec.play_format IS NULL OR LOWER(ec.play_format) NOT IN ('doubles', 'teams'))
             AND (json_extract(ec.live_scoring_config, '$.scoringStyle') IS NULL OR json_extract(ec.live_scoring_config, '$.scoringStyle') NOT IN ('matchplay', 'putting'))
             AND (json_extract(ec.live_scoring_config, '$.groupFormat') IS NULL OR LOWER(json_extract(ec.live_scoring_config, '$.groupFormat')) != 'doubles')
             AND (json_extract(res.scoring_group, '$.targetType') IS NULL OR json_extract(res.scoring_group, '$.targetType') != 'pair')
             AND COALESCE(e.date, res.created_at) >= ?
         )`,
      )
      .bind(layoutId, cutoffDate, layoutId, cutoffDate)
      .all()
  ).results;
}
