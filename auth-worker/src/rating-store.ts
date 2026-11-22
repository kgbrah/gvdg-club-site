import type { D1Like, D1StatementLike } from "./db-types.js";
import { aggregatePlayerRating, type RatingMethod, type RatingStream } from "./rating-engine.js";
import { calibrateRatingField } from "./ratings-recompute-core.js";
import { readArchivedRatingHoles, ratingLayoutRevision, ratingNumber, ratingTimestamp } from "./rating-layout.js";
import { CURRENT_RESULT_FIELDS, MAX_RATING_ROUND_RESULTS, RATING_SOURCE_ROWS, STORED_EVIDENCE_FIELDS, competitionSourceRowsSql,
  matchesStoredRatingEvidence, ratingFieldFingerprint, ratingFieldScoresFingerprint, ratingSourceGroups } from "./rating-source.js";

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
  sourceFingerprint: string;
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
  /** The PDGA layout baseline available for this round: the one used ('pdga') or a comparison. */
  pdgaBaselineSsa: number | null;
  pdgaBaselineRounds: number | null;
};

export type RatingBaselineInput = LayoutRatingBaseline & {
  layoutId: number;
  layoutRevision: string;
  playedAt: string;
  sourceResultId: number;
  sourceScorecard: string;
  fieldFingerprint: string;
};

type VersionedBaseline = {
  event_id: number; ssa: number; ppt: number; propagator_count: number;
  available_at: string; played_at: string; field_fingerprint: string | null;
};

const BASELINE_FIELDS = "event_id, ssa, ppt, propagator_count, available_at, played_at, field_fingerprint";

type FieldEvidence = { row: VersionedBaseline; evidence: Awaited<ReturnType<typeof ratingSourceGroups>>[number]; earliest: string };

/** A stored calibration's field as its event's results give it now (null when they no longer give that field). */
async function baselineFieldEvidence(revision: string, row: VersionedBaseline, sourceRows: readonly Record<string, unknown>[]): Promise<FieldEvidence | null> {
  if (sourceRows.length > MAX_RATING_ROUND_RESULTS) return null;
  const evidence = (await ratingSourceGroups(sourceRows as Record<string, unknown>[], "competition", null)).find((group) => group[0]?.layoutRevision === revision);
  if (!evidence?.length) return null;
  const earliest = evidence.reduce((time, entry) => entry.roundDate < time ? entry.roundDate : time, evidence[0]!.roundDate);
  const available = evidence.reduce((time, entry) => entry.availableAt > time ? entry.availableAt : time, earliest);
  if (earliest !== row.played_at || available !== row.available_at) return null;
  return { row, evidence, earliest };
}

type LegacyStoredRatingRow = {
  event_id: number;
  source_result_id: number;
  source_fingerprint: string | null;
  layout_revision: string | null;
  ssa: number | null;
  ppt: number | null;
  propagator_count: number | null;
};

function matchesLegacyStoredRounds(revision: string, { row, evidence }: FieldEvidence, storedRows: readonly LegacyStoredRatingRow[]): boolean {
  const byId = new Map(storedRows.map((entry) => [Number(entry.source_result_id), entry]));
  if (byId.size !== evidence.length) return false;
  return evidence.every((entry) => {
    const saved = byId.get(entry.sourceResultId);
    return saved != null
      && saved.source_fingerprint === entry.sourceFingerprint
      && saved.layout_revision === revision
      && saved.ssa === row.ssa
      && saved.ppt === row.ppt
      && Number(saved.propagator_count) === Number(row.propagator_count);
  });
}

async function verifyLegacyRoundRatings(db: D1Like, revision: string, field: FieldEvidence): Promise<boolean> {
  const res = await db.prepare(
    `SELECT event_id, source_result_id, source_fingerprint, layout_revision, ssa, ppt, propagator_count
       FROM round_ratings WHERE stream = 'competition' AND event_id = ?`,
  ).bind(field.row.event_id).all<LegacyStoredRatingRow>();
  if (!res.success) return false;
  return matchesLegacyStoredRounds(revision, field, res.results ?? []);
}

/**
 * The calibration, if that event's field still matches what was stored.
 * Fields stored with `field:` are verified directly against current competition result scores so
 * casual `layout` ratings survive the 7-day purge of PDGA rating anchors.
 */
async function baselineFromField(field: FieldEvidence, anchors: ReadonlyMap<string, number> | null): Promise<LayoutRatingBaseline | null> {
  const { row, evidence } = field;
  if (row.field_fingerprint?.startsWith("field:")) {
    if (await ratingFieldScoresFingerprint(evidence) !== row.field_fingerprint) return null;
    return { ssa: row.ssa, ppt: row.ppt, propagatorCount: row.propagator_count, eventId: row.event_id, availableAt: row.available_at };
  }
  if (!anchors || await ratingFieldFingerprint(evidence, anchors) !== row.field_fingerprint) return null;
  const { solved } = calibrateRatingField(evidence, anchors);
  if (!solved || solved.ssa !== row.ssa || solved.ppt !== row.ppt || solved.propagatorCount !== row.propagator_count) return null;
  return { ssa: row.ssa, ppt: row.ppt, propagatorCount: row.propagator_count, eventId: row.event_id, availableAt: row.available_at };
}

const storedBaselineUsable = (row: VersionedBaseline) => Boolean(row.field_fingerprint) && row.ssa > 0 && row.ppt > 0;

async function verifyBaselineField(db: D1Like, revision: string, row: VersionedBaseline, guards?: D1StatementLike[]): Promise<LayoutRatingBaseline | null> {
  if (!storedBaselineUsable(row)) return null;
  const sourceSql = RATING_SOURCE_ROWS.competition;
  const sourceArgs = [row.event_id, MAX_RATING_ROUND_RESULTS + 1];
  const source = await db.prepare(sourceSql).bind(...sourceArgs).all();
  if (!source.success) throw new Error("Calibration field unavailable");
  if (guards) guards.push(...ratingReadGuards(db, sourceSql, sourceArgs, source.results));
  const field = await baselineFieldEvidence(revision, row, source.results as Record<string, unknown>[]);
  if (!field) return null;
  if (row.field_fingerprint?.startsWith("field:")) return baselineFromField(field, null);
  const anchors = await priorRatingAnchors(db, field.evidence.map((entry) => entry.memberId), field.earliest, guards);
  const exact = await baselineFromField(field, anchors);
  if (exact) return exact;
  return (await verifyLegacyRoundRatings(db, revision, field))
    ? { ssa: row.ssa, ppt: row.ppt, propagatorCount: row.propagator_count, eventId: row.event_id, availableAt: row.available_at }
    : null;
}

export type SourceBaselineKey = { revision: string; eventId: number };

/**
 * The stored club calibrations casual estimates were made from, each only if its event's field still matches it
 * (as verifyBaselineField checks one). Showing a member's ratings checks every one: the calibrations, their fields and
 * any legacy prior anchors are each read in one pass.
 */
export async function getSourceRatingBaselines(db: D1Like, keys: readonly SourceBaselineKey[]): Promise<(LayoutRatingBaseline | null)[]> {
  const events = [...new Set(keys.map((key) => key.eventId))];
  const stored = new Map<string, VersionedBaseline>();
  for (let offset = 0; offset < events.length; offset += 90) {
    const group = events.slice(offset, offset + 90);
    const result = await db.prepare(`SELECT layout_revision, ${BASELINE_FIELDS} FROM layout_rating_baselines WHERE event_id IN (${group.map(() => "?").join(", ")})`)
      .bind(...group).all<VersionedBaseline & { layout_revision: string }>();
    if (!result.success) throw new Error("Layout baselines unavailable");
    for (const row of result.results) stored.set(row.layout_revision + ":" + row.event_id, row);
  }
  const rows = keys.map((key) => {
    const row = stored.get(key.revision + ":" + key.eventId);
    return row && storedBaselineUsable(row) ? row : null;
  });
  const fieldEvents = [...new Set(rows.flatMap((row) => row ? [row.event_id] : []))];
  const sources = new Map<number, Record<string, unknown>[]>();
  for (let offset = 0; offset < fieldEvents.length; offset += 90) {
    const group = fieldEvents.slice(offset, offset + 90);
    const result = await db.prepare(competitionSourceRowsSql(group.length)).bind(...group).all<Record<string, unknown>>();
    if (!result.success) throw new Error("Calibration field unavailable");
    for (const row of result.results) {
      const list = sources.get(Number(row.event_id)) ?? [];
      // The per-event query reads one past the cap, to tell an oversized field from a full one.
      if (list.length <= MAX_RATING_ROUND_RESULTS) list.push(row);
      sources.set(Number(row.event_id), list);
    }
  }
  const fields = await Promise.all(rows.map((row, index) => row ? baselineFieldEvidence(keys[index]!.revision, row, sources.get(row.event_id) ?? []) : null));
  const needAnchors = fields.map((field) => field && !field.row.field_fingerprint?.startsWith("field:")
    ? { ids: field.evidence.map((entry) => entry.memberId), before: field.earliest }
    : null);
  const anchors = await priorRatingAnchorsMany(db, needAnchors);
  const initial = await Promise.all(fields.map((field, index) => field ? baselineFromField(field, anchors[index] ?? null) : null));
  const legacyEventIds = [...new Set(fields.flatMap((field, index) => (field && !initial[index] && !field.row.field_fingerprint?.startsWith("field:")) ? [field.row.event_id] : []))];
  if (!legacyEventIds.length) return initial;
  const legacyStored = new Map<number, LegacyStoredRatingRow[]>();
  for (let offset = 0; offset < legacyEventIds.length; offset += 90) {
    const group = legacyEventIds.slice(offset, offset + 90);
    const res = await db.prepare(
      `SELECT event_id, source_result_id, source_fingerprint, layout_revision, ssa, ppt, propagator_count
         FROM round_ratings WHERE stream = 'competition' AND event_id IN (${group.map(() => "?").join(", ")})`,
    ).bind(...group).all<LegacyStoredRatingRow>();
    if (!res.success) continue;
    for (const row of res.results ?? []) {
      const id = Number(row.event_id);
      const list = legacyStored.get(id) ?? [];
      list.push(row);
      legacyStored.set(id, list);
    }
  }
  return initial.map((baseline, index) => {
    if (baseline) return baseline;
    const field = fields[index];
    if (!field || field.row.field_fingerprint?.startsWith("field:")) return null;
    const storedForEvent = legacyStored.get(field.row.event_id) ?? [];
    return matchesLegacyStoredRounds(keys[index]!.revision, field, storedForEvent)
      ? { ssa: field.row.ssa, ppt: field.row.ppt, propagatorCount: field.row.propagator_count, eventId: field.row.event_id, availableAt: field.row.available_at }
      : null;
  });
}

export async function getRevisionRatingBaseline(db: D1Like, revision: string | null, before: string, guards?: D1StatementLike[]): Promise<LayoutRatingBaseline | null> {
  if (!revision) return null;
  const sql = `SELECT ${BASELINE_FIELDS} FROM layout_rating_baselines
       WHERE layout_revision = ? AND available_at < ? AND played_at < ?
       ORDER BY played_at DESC, available_at DESC, event_id DESC LIMIT 4`;
  const args = [revision, before, before];
  const result = await db.prepare(sql).bind(...args).all<VersionedBaseline>();
  if (!result.success) throw new Error("Historical layout baseline unavailable");
  if (guards) guards.push(...ratingReadGuards(db, sql, args, result.results));
  for (const row of result.results) {
    const baseline = await verifyBaselineField(db, revision, row, guards);
    if (baseline) return baseline;
  }
  return null;
}

export function ratingReadGuards(db: D1Like, sql: string, args: readonly unknown[], rows: readonly object[]): D1StatementLike[] {
  // D1 batches run in one transaction. This assertion inserts no row when the read still
  // matches. On a mismatch the deliberately invalid stream violates the checkpoint table's
  // CHECK constraint and aborts the whole batch before any rating, mirror or baseline write.
  const assertion = `INSERT INTO rating_repair_checkpoints (stream, after_id, checked_at)
    SELECT 'rating-source-changed', 0, datetime('now') WHERE `;
  const checks = [db.prepare(assertion + `((SELECT COUNT(*) FROM (${sql})) != ?)`).bind(...args, rows.length)];
  if (!rows.length) return checks;
  const columns = Object.keys(rows[0]!);
  if (!columns.length || columns.some((column) => !/^[a-z_][a-z0-9_]*$/.test(column))) throw new Error("Unexpected rating source columns");
  const expected = columns.map((column) => `json_extract(value, '$.${column}')`).join(", ");
  // Every source row has a unique selected key (result id, rating id, or member id).
  // Chunk the expected data so large scorecards don't create one giant bound value.
  for (let offset = 0; offset < rows.length; offset += 24) {
    const batch = rows.slice(offset, offset + 24);
    checks.push(db.prepare(assertion + `EXISTS (
      SELECT ${expected} FROM json_each(?)
      EXCEPT SELECT ${columns.join(", ")} FROM (${sql})
    )`).bind(JSON.stringify(batch), ...args));
  }
  return checks;
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
       anchor_count, unrated_reason, source_fingerprint, pdga_baseline_ssa, pdga_baseline_rounds, rated_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE EXISTS (SELECT 1 FROM ${results} WHERE id = ? AND member_id = ? AND total = ? AND to_par = ? AND scorecard = ?)
       ON CONFLICT DO UPDATE SET
         player_name = excluded.player_name, stream = excluded.stream, course_id = excluded.course_id,
         layout_id = excluded.layout_id, round_date = excluded.round_date, total = excluded.total,
         to_par = excluded.to_par, round_rating = excluded.round_rating, ssa = excluded.ssa,
         ppt = excluded.ppt, wind_gust_mph = COALESCE(excluded.wind_gust_mph, round_ratings.wind_gust_mph),
         weather_adjustment = excluded.weather_adjustment, propagator_count = excluded.propagator_count,
         rating_method = excluded.rating_method, source_result_id = excluded.source_result_id,
         layout_revision = excluded.layout_revision, baseline_event_id = excluded.baseline_event_id,
         anchor_count = excluded.anchor_count, unrated_reason = excluded.unrated_reason,
         source_fingerprint = excluded.source_fingerprint, pdga_baseline_ssa = excluded.pdga_baseline_ssa,
         pdga_baseline_rounds = excluded.pdga_baseline_rounds, rated_at = excluded.rated_at
       WHERE excluded.round_rating IS NOT NULL OR round_ratings.round_rating IS NULL OR round_ratings.source_result_id IS NOT NULL`,
  ).bind(
    row.memberId, row.playerName, row.stream, row.eventId, row.casualRoundCode, row.courseId, row.layoutId,
    row.roundDate, row.total, row.toPar, row.roundRating, row.ssa, row.ppt, row.windGustMph,
    row.weatherAdjustment, row.propagatorCount, row.ratingMethod, row.sourceResultId, row.layoutRevision,
    row.baselineEventId, row.anchorCount, row.unratedReason, row.sourceFingerprint, row.pdgaBaselineSsa, row.pdgaBaselineRounds,
    row.sourceResultId, row.memberId, row.total, row.toPar, row.sourceScorecard,
  );
}

function baselineStatement(db: D1Like, row: RatingBaselineInput): D1StatementLike {
  return db.prepare(
    `INSERT INTO layout_rating_baselines (layout_revision, layout_id, event_id, played_at, available_at, ssa, ppt, propagator_count, field_fingerprint)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM results WHERE id = ? AND event_id = ? AND scorecard = ?)
      ON CONFLICT(layout_revision, event_id) DO UPDATE SET
        played_at = excluded.played_at, available_at = excluded.available_at,
        ssa = excluded.ssa, ppt = excluded.ppt, propagator_count = excluded.propagator_count, field_fingerprint = excluded.field_fingerprint`,
  ).bind(row.layoutRevision, row.layoutId, row.eventId, row.playedAt, row.availableAt, row.ssa, row.ppt, row.propagatorCount,
    row.fieldFingerprint, row.sourceResultId, row.eventId, row.sourceScorecard);
}

// No clear-before-create. Old values and baseline rows survive a failed batch.
export async function writeRatingBatch(db: D1Like, rows: readonly RoundRatingInput[], baselines: readonly RatingBaselineInput[], guards: readonly D1StatementLike[]): Promise<void> {
  const statements = rows.flatMap((row) => {
    const writes = [roundRatingStatement(db, row)];
    if (row.stream === "competition") {
      writes.push(db.prepare(`UPDATE results SET rating = ? WHERE id = ? AND member_id = ? AND total = ? AND to_par = ? AND scorecard = ?
          AND EXISTS (SELECT 1 FROM round_ratings WHERE source_result_id = results.id AND member_id = results.member_id
            AND stream = 'competition' AND source_fingerprint = ? AND round_rating IS ?)`)
        .bind(row.roundRating, row.sourceResultId, row.memberId, row.total, row.toPar, row.sourceScorecard, row.sourceFingerprint, row.roundRating));
    }
    return writes;
  });
  statements.push(...baselines.map((row) => baselineStatement(db, row)));
  if (!statements.length) return;
  if (!db.batch) throw new Error("Rating persistence requires a transactional batch");
  const results = await db.batch([...guards, ...statements]);
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
type PriorRow = Record<string, unknown> & { member_id: string; round_rating: number; round_date: string };

const anchorWindowStart = (before: string) => new Date(Date.parse(before) - (365 * 24 * 60 * 60 * 1000)).toISOString();

/** Members without an official anchor take their own prior stable club rating, when it is an established one. */
function addLocalAnchors(anchors: Map<string, number>, eligible: readonly (PriorRow | null)[], before: string) {
  const byMember = new Map<string, PriorRow[]>();
  for (const row of eligible) {
    if (!row) continue;
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

const localAnchorSql = (slots: string, extra = "") => `SELECT ${CURRENT_RESULT_FIELDS.competition}, ${STORED_EVIDENCE_FIELDS}, rr.round_rating, rr.round_date${extra} FROM round_ratings rr
         JOIN results res ON res.id = rr.source_result_id AND res.member_id = rr.member_id
         JOIN events e ON e.id = res.event_id LEFT JOIN event_config ec ON ec.event_id = e.id
         WHERE rr.member_id IN (${slots}) AND rr.stream = 'competition' AND rr.rating_method = 'stable'
         AND rr.layout_revision IS NOT NULL AND rr.round_date < ? AND rr.round_date >= ?
         AND strftime('%Y-%m-%dT%H:%M:%fZ', res.created_at) < ?`;

/**
 * priorRatingAnchors for many (field, date) pairs: each member's snapshots and stable ratings are read once over the
 * span of every window, and each pair selects from them what its own queries would return.
 */
async function priorRatingAnchorsMany(db: D1Like, requests: readonly ({ ids: readonly string[]; before: string } | null)[]): Promise<(Map<string, number> | null)[]> {
  const live = requests.filter((request): request is { ids: readonly string[]; before: string } => request != null);
  if (!live.length) return requests.map(() => null);
  const ids = [...new Set(live.flatMap((request) => request.ids))];
  const latest = live.reduce((time, request) => request.before > time ? request.before : time, live[0]!.before);
  const earliest = live.reduce((time, request) => anchorWindowStart(request.before) < time ? anchorWindowStart(request.before) : time, anchorWindowStart(live[0]!.before));
  type Snapshot = AnchorRow & { effective_at: string; observed_at: string };
  const snapshots = new Map<string, Snapshot[]>();
  const priors = new Map<string, (PriorRow & { anchor_result_created_at: string | null })[]>();
  for (let offset = 0; offset < ids.length; offset += 75) {
    const group = ids.slice(offset, offset + 75);
    const slots = group.map(() => "?").join(", ");
    const [official, local] = await Promise.all([
      db.prepare(`SELECT member_id, rating, effective_at, observed_at FROM rating_anchor_snapshots
           WHERE member_id IN (${slots}) AND observed_at < ? AND effective_at < ? AND effective_at >= ?`)
        .bind(...group, latest, latest, earliest).all<Snapshot>(),
      db.prepare(localAnchorSql(slots, ", strftime('%Y-%m-%dT%H:%M:%fZ', res.created_at) AS anchor_result_created_at"))
        .bind(...group, latest, earliest, latest).all<PriorRow & { anchor_result_created_at: string | null }>(),
    ]);
    if (!official.success || !local.success) throw new Error("Historical rating anchors unavailable");
    for (const row of official.results) snapshots.set(row.member_id, [...snapshots.get(row.member_id) ?? [], row]);
    for (const row of local.results) priors.set(row.member_id, [...priors.get(row.member_id) ?? [], row]);
  }
  const evidence = new Map<Record<string, unknown>, Promise<boolean>>();
  const eligible = (row: PriorRow) => {
    if (!evidence.has(row)) evidence.set(row, matchesStoredRatingEvidence(row, "competition"));
    return evidence.get(row)!;
  };
  return Promise.all(requests.map(async (request) => {
    if (!request) return null;
    const { before } = request;
    const since = anchorWindowStart(before);
    const anchors = new Map<string, number>();
    for (const id of request.ids) {
      // The newest snapshot effective (then observed) before the field, as ROW_NUMBER() rank 1 in priorRatingAnchors.
      let top: Snapshot | null = null;
      for (const row of snapshots.get(id) ?? []) {
        if (!(row.observed_at < before && row.effective_at < before && row.effective_at >= since)) continue;
        if (!top || row.effective_at > top.effective_at || (row.effective_at === top.effective_at && row.observed_at > top.observed_at)) top = row;
      }
      if (top && top.rating >= 700) anchors.set(id, top.rating);
    }
    const local = request.ids.flatMap((id) => (priors.get(id) ?? []).filter((row) => row.round_date < before && row.round_date >= since
      && row.anchor_result_created_at != null && row.anchor_result_created_at < before));
    addLocalAnchors(anchors, await Promise.all(local.map(async (row) => await eligible(row) ? row : null)), before);
    return anchors;
  }));
}

export async function priorRatingAnchors(db: D1Like, ids: readonly string[], before: string, guards?: D1StatementLike[]): Promise<Map<string, number>> {
  const anchors = new Map<string, number>();
  const since = anchorWindowStart(before);
  for (let offset = 0; offset < ids.length; offset += 75) {
    const group = ids.slice(offset, offset + 75);
    const slots = group.map(() => "?").join(", ");
    const officialSql = `SELECT member_id, rating FROM (
           SELECT member_id, rating, ROW_NUMBER() OVER (PARTITION BY member_id ORDER BY effective_at DESC, observed_at DESC) AS rank
           FROM rating_anchor_snapshots
           WHERE member_id IN (${slots}) AND observed_at < ? AND effective_at < ? AND effective_at >= ?
         ) WHERE rank = 1`;
    const localSql = localAnchorSql(slots);
    const officialArgs = [...group, before, before, since];
    const localArgs = [...group, before, since, before];
    const [official, local] = await Promise.all([
      db.prepare(officialSql).bind(...officialArgs).all<AnchorRow>(),
      db.prepare(localSql).bind(...localArgs).all<PriorRow>(),
    ]);
    if (!official.success || !local.success) throw new Error("Historical rating anchors unavailable");
    if (guards) guards.push(...ratingReadGuards(db, officialSql, officialArgs, official.results), ...ratingReadGuards(db, localSql, localArgs, local.results));
    for (const row of official.results) if (row.rating >= 700) anchors.set(row.member_id, row.rating);
    addLocalAnchors(anchors, await Promise.all(local.results.map(async (row) => (await matchesStoredRatingEvidence(row, "competition")) ? row : null)), before);
  }
  return anchors;
}
