// D1 access for PDGA layout baselines: the chronological baseline the rating engine reads, layout
// matches (automatic and admin-reviewed), repair queueing, and the admin report. All SQL is bound.

import type { D1Like, D1StatementLike } from "./db-types.js";
import {
  baselineProvenance, candidateCourses, clubCalendarDay, publishedRatingsSsa, compareLayoutGeometry, evaluatePdgaBaselines, matchPdgaLayout, ourLayoutHoles,
  pdgaBaselineFor, type BaselineRound, type LayoutMatch, type MatchCandidate, type OurCourse, type OurHole,
  type PdgaBaseline, type PdgaHole, type ScorePair, type ValidationPdgaRound,
} from "./pdga-baselines.js";
import { cityState } from "./pdga-events.js";
import { mapCoordinates } from "../../src/shared/course-quality.js";
import { readArchivedRatingHoles, ratingLayoutRevision } from "./rating-layout.js";
import { getLayoutRatingBaseline, ratingReadGuards } from "./rating-store.js";

type Row = Record<string, unknown>;
const MAX_BASELINE_ROUNDS = 500;
const MAX_REPAIR_SOURCES = 200;
export const PDGA_REPAIR_CODE = "pdga-baseline-changed";

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function holesFrom(raw: unknown): PdgaHole[] {
  const holes = parseJson<unknown>(raw, []);
  return Array.isArray(holes) ? holes.flatMap((hole) => {
    const row = hole && typeof hole === "object" ? hole as Row : {};
    const par = Number(row.par);
    const lengthFt = row.lengthFt == null ? null : Number(row.lengthFt);
    return Number.isInteger(par) ? [{ hole: Number(row.hole), par, lengthFt: Number.isFinite(lengthFt) ? lengthFt : null }] : [];
  }) : [];
}

// The SSA PDGA's published ratings imply when known, else the live per-round SSARdN.
const EFFECTIVE_SSA = "COALESCE(r.ratings_ssa, r.official_ssa)";

const BASELINE_ROUNDS_SQL = `SELECT r.tourn_id, r.round_number, r.pdga_layout_id, r.round_date, ${EFFECTIVE_SSA} AS ssa, r.ratings_status,
    r.holes_json, m.review_status
  FROM pdga_rated_rounds r JOIN pdga_layout_matches m ON m.pdga_layout_id = r.pdga_layout_id
  WHERE m.layout_id = ? AND m.review_status IN ('auto', 'confirmed') AND ${EFFECTIVE_SSA} IS NOT NULL AND r.round_date < ?
  ORDER BY r.round_date, r.tourn_id, r.round_number, r.pdga_layout_id LIMIT ${MAX_BASELINE_ROUNDS}`;

function baselineRound(row: Row): BaselineRound {
  return {
    tournId: Number(row.tourn_id), roundNumber: Number(row.round_number), pdgaLayoutId: Number(row.pdga_layout_id),
    roundDate: String(row.round_date), ssa: row.ssa == null ? null : Number(row.ssa),
    ratingsStatus: row.ratings_status === "official" ? "official" : "unconfirmed",
    reviewStatus: row.review_status === "confirmed" ? "confirmed" : "auto", holes: holesFrom(row.holes_json),
  };
}

/** Matched PDGA rounds on one of our layouts played before `beforeDay` (YYYY-MM-DD, club calendar). */
export async function loadMatchedPdgaRounds(db: D1Like, layoutId: number, beforeDay: string, guards?: D1StatementLike[]): Promise<BaselineRound[]> {
  const args = [layoutId, beforeDay];
  const result = await db.prepare(BASELINE_ROUNDS_SQL).bind(...args).all<Row>();
  if (!result.success) throw new Error("PDGA baseline rounds unavailable");
  if (guards) guards.push(...ratingReadGuards(db, BASELINE_ROUNDS_SQL, args, result.results));
  return result.results.map(baselineRound);
}

/**
 * As-played holes for the PDGA geometry check. An archived distance counts only when the hole's tee
 * and basket were mapped: the archive does not say whether an unmapped distance was a par estimate.
 */
function playedHole(hole: unknown, par: unknown, distance: unknown, tee: unknown, target: unknown): OurHole | null {
  if (!Number.isInteger(hole) || !Number.isInteger(par)) return null;
  const measured = typeof distance === "number" && Number.isFinite(distance) && distance > 0 && mapCoordinates(tee) && mapCoordinates(target);
  return { hole: hole as number, par: par as number, distanceFt: measured ? distance : null };
}

/** Holes as stored in a rating group's geometry snapshot ([hole, par, distanceFt, tee, target]). */
export function playedHolesFromShape(shape: string): OurHole[] | null {
  const rows = parseJson<unknown>(shape, null);
  if (!Array.isArray(rows) || !rows.length) return null;
  const holes = rows.map((row) => Array.isArray(row) ? playedHole(row[0], row[1], row[2], row[3], row[4]) : null);
  return holes.every((hole) => hole != null) ? holes as OurHole[] : null;
}

/** The PDGA baseline for a round of ours on `layoutId`, as played, using only earlier PDGA rounds. */
export async function pdgaBaselineForPlayed(
  db: D1Like, layoutId: number | null, played: readonly OurHole[] | null, roundDate: string, guards?: D1StatementLike[],
): Promise<PdgaBaseline | null> {
  const day = clubCalendarDay(roundDate);
  if (layoutId == null || !Number.isSafeInteger(layoutId) || layoutId <= 0 || !day || !played?.length) return null;
  return pdgaBaselineFor(await loadMatchedPdgaRounds(db, layoutId, day, guards), played, day);
}

/** Live projected ratings use the same precedence as casual finalize: PDGA baseline, then club field. */
export async function getLiveRatingBaseline(db: D1Like, layoutId: number | null, holes: readonly unknown[] | undefined, startedAt: string | undefined) {
  if (layoutId == null) return null;
  const archived = holes ? readArchivedRatingHoles(holes) : null;
  if (archived && startedAt) {
    const played = archived.map((hole) => playedHole(hole.hole, hole.par, hole.distanceFt, hole.tee, hole.target)!);
    const pdga = await pdgaBaselineForPlayed(db, layoutId, played, startedAt).catch(() => null);
    if (pdga) return { ssa: pdga.ssa, ppt: pdga.ppt, source: "pdga" as const, rounds: pdga.rounds };
  }
  const club = await getLayoutRatingBaseline(db, layoutId, holes, startedAt);
  return club ? { ssa: club.ssa, ppt: club.ppt, source: "layout" as const, rounds: null } : null;
}

/** Once an event is fully read: record the SSA each round's published ratings imply. */
export async function refreshRatingsSsa(db: D1Like, tournId: number): Promise<void> {
  const rounds = await db.prepare(`SELECT r.round_number, r.pdga_layout_id, r.official_ssa,
      (SELECT json_group_array(s.pairs_json) FROM pdga_round_scores s WHERE s.tourn_id = r.tourn_id
        AND s.round_number = r.round_number AND s.pdga_layout_id = r.pdga_layout_id) AS pairs
    FROM pdga_rated_rounds r WHERE r.tourn_id = ?`).bind(tournId).all<Row>();
  const statements = rounds.results.map((row) => {
    const pairs = parseJson<string[]>(row.pairs, []).flatMap((list) => parseJson<ScorePair[]>(list, []));
    return db.prepare("UPDATE pdga_rated_rounds SET ratings_ssa = ? WHERE tourn_id = ? AND round_number = ? AND pdga_layout_id = ?")
      .bind(publishedRatingsSsa(row.official_ssa == null ? null : Number(row.official_ssa), pairs), tournId, row.round_number, row.pdga_layout_id);
  });
  if (!statements.length) return;
  if (db.batch) await db.batch(statements);
  else for (const statement of statements) await statement.run();
}

// ---------------------------------------------------------------------------------------------
// Repairs

/** Ask the existing repair sweep to re-rate rounds on layouts whose PDGA evidence just changed. */
export async function queuePdgaLayoutRepairs(db: D1Like, layoutIds: Iterable<number | null>, now: string): Promise<void> {
  const ids = [...new Set([...layoutIds].filter((id): id is number => id != null && Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return;
  const slots = ids.map(() => "?").join(", ");
  const upsert = `ON CONFLICT(stream, source_id) DO UPDATE SET last_code = excluded.last_code,
      checked_at = excluded.checked_at, retry_at = MIN(rating_repair_issues.retry_at, excluded.retry_at)`;
  const statements = [
    db.prepare(`INSERT INTO rating_repair_issues (stream, source_id, attempts, last_code, checked_at, retry_at)
      SELECT 'casual', r.id, 1, ?, ?, ? FROM casual_rounds r
      WHERE r.layout_id IN (${slots}) AND EXISTS (SELECT 1 FROM casual_results cr WHERE cr.casual_round_id = r.id AND cr.member_id IS NOT NULL)
      ORDER BY r.id DESC LIMIT ${MAX_REPAIR_SOURCES} ${upsert}`).bind(PDGA_REPAIR_CODE, now, now, ...ids),
    db.prepare(`INSERT INTO rating_repair_issues (stream, source_id, attempts, last_code, checked_at, retry_at)
      SELECT 'competition', e.id, 1, ?, ?, ? FROM events e
      WHERE e.layout_id IN (${slots}) AND e.status = 'final'
      ORDER BY e.id DESC LIMIT ${MAX_REPAIR_SOURCES} ${upsert}`).bind(PDGA_REPAIR_CODE, now, now, ...ids),
  ];
  if (db.batch) await db.batch(statements);
  else for (const statement of statements) await statement.run();
}

// ---------------------------------------------------------------------------------------------
// Matching

type MatchRow = {
  pdga_layout_id: number; course_id: number | null; layout_id: number | null; quality: string; review_status: string;
};

/**
 * Our courses with a name like the PDGA course (same state when known), with their layouts loaded.
 * The course list is small; layouts (with full hole JSON) are read only for name candidates.
 */
function clubCourseLoader(db: D1Like) {
  let list: Promise<OurCourse[]> | null = null;
  const layouts = new Map<number, Promise<OurCourse["layouts"]>>();
  return async (courseName: string, state: string | null, city: string | null): Promise<OurCourse[]> => {
    list ??= db.prepare("SELECT id, name, location FROM courses ORDER BY id").all<{ id: number; name: string; location: string | null }>()
      .then((result) => result.results.map((course) => ({ ...course, layouts: [] })));
    const named = candidateCourses(courseName, state, await list, city).courses;
    return Promise.all(named.map(async (course) => {
      let loaded = layouts.get(course.id);
      if (!loaded) {
        loaded = db.prepare("SELECT id, name, holes FROM course_layouts WHERE course_id = ? ORDER BY id").bind(course.id)
          .all<{ id: number; name: string; holes: string }>()
          .then((result) => result.results.flatMap((layout) => {
            const holes = ourLayoutHoles(layout.holes);
            return holes ? [{ id: layout.id, name: layout.name, holes }] : [];
          }));
        layouts.set(course.id, loaded);
      }
      return { ...course, layouts: await loaded };
    }));
  };
}

async function layoutRevision(db: D1Like, layoutId: number | null): Promise<string | null> {
  if (layoutId == null) return null;
  const row = await db.prepare("SELECT holes FROM course_layouts WHERE id = ?").bind(layoutId).first<{ holes: string }>();
  const holes = row ? readArchivedRatingHoles(row.holes) : null;
  return holes ? ratingLayoutRevision(layoutId, holes) : null;
}

function reviewStatusFor(match: LayoutMatch): "auto" | "pending" {
  return match.quality === "exact" || match.quality === "close" ? "auto" : "pending";
}

/**
 * Re-grade every PDGA layout from one event (or the given layouts) against our current layouts.
 * Admin-confirmed and rejected rows are never overwritten. Returns the layouts whose effective match
 * changed so their rounds can be re-rated.
 */
export async function matchPdgaLayouts(db: D1Like, filter: { tournId?: number; pdgaLayoutIds?: number[] }, now: string, courses?: OurCourse[]) {
  const ids = filter.pdgaLayoutIds ?? [];
  const where = filter.tournId != null ? "tourn_id = ?" : ids.length ? `pdga_layout_id IN (${ids.map(() => "?").join(", ")})` : null;
  if (!where) return { matched: 0, pending: 0, changedLayouts: [] as number[] };
  const layouts = await db.prepare(`SELECT pdga_layout_id, course_name, holes_json, event_state, event_city, MAX(round_date) AS last_date
      FROM pdga_rated_rounds WHERE ${where} GROUP BY pdga_layout_id ORDER BY pdga_layout_id`)
    .bind(...(filter.tournId != null ? [filter.tournId] : ids)).all<Row>();
  if (!layouts.results.length) return { matched: 0, pending: 0, changedLayouts: [] as number[] };
  const load = courses ? async () => courses : clubCourseLoader(db);
  const changed = new Set<number>();
  let matched = 0;
  let pending = 0;
  for (const layout of layouts.results) {
    const pdgaLayoutId = Number(layout.pdga_layout_id);
    const existing = await db.prepare("SELECT pdga_layout_id, course_id, layout_id, quality, review_status FROM pdga_layout_matches WHERE pdga_layout_id = ?")
      .bind(pdgaLayoutId).first<MatchRow>();
    if (existing && (existing.review_status === "confirmed" || existing.review_status === "rejected")) continue;
    const state = typeof layout.event_state === "string" ? layout.event_state : null;
    const city = typeof layout.event_city === "string" ? layout.event_city : null;
    const courseName = String(layout.course_name);
    const match = matchPdgaLayout({ courseName, holes: holesFrom(layout.holes_json) }, state, await load(courseName, state, city), city);
    const status = reviewStatusFor(match);
    const revision = status === "auto" ? await layoutRevision(db, match.layoutId) : null;
    await db.prepare(`INSERT INTO pdga_layout_matches (pdga_layout_id, course_id, layout_id, layout_revision, quality, review_status,
        reason, candidates_json, matched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pdga_layout_id) DO UPDATE SET course_id = excluded.course_id, layout_id = excluded.layout_id,
        layout_revision = excluded.layout_revision, quality = excluded.quality, review_status = excluded.review_status,
        reason = excluded.reason, candidates_json = excluded.candidates_json, matched_at = excluded.matched_at
      WHERE pdga_layout_matches.review_status NOT IN ('confirmed', 'rejected')`)
      .bind(pdgaLayoutId, match.courseId, match.layoutId, revision, match.quality, status, match.reason,
        JSON.stringify(match.candidates.slice(0, 8)), now).run();
    const before = existing?.review_status === "auto" ? existing.layout_id : null;
    const after = status === "auto" ? match.layoutId : null;
    if (before !== after) {
      if (before != null) changed.add(before);
      if (after != null) changed.add(after);
    }
    if (status === "auto") matched += 1;
    else pending += 1;
  }
  if (changed.size) await queuePdgaLayoutRepairs(db, changed, now);
  return { matched, pending, changedLayouts: [...changed] };
}

/** Admin review: confirm the proposed layout, assign a different one, or reject the PDGA layout. */
export async function reviewPdgaMatch(
  db: D1Like, pdgaLayoutId: number, action: "confirm" | "reject" | "assign", layoutId: number | null, adminId: string, now: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const existing = await db.prepare("SELECT pdga_layout_id, course_id, layout_id, quality, review_status FROM pdga_layout_matches WHERE pdga_layout_id = ?")
    .bind(pdgaLayoutId).first<MatchRow>();
  if (!existing) return { error: "not_found", status: 404 };
  const target = action === "assign" ? layoutId : existing.layout_id;
  if (action !== "reject" && target == null) return { error: "layout_required", status: 400 };
  let courseId = existing.course_id;
  let quality = existing.quality;
  if (action !== "reject") {
    const layout = await db.prepare("SELECT id, course_id, holes FROM course_layouts WHERE id = ?").bind(target).first<{ id: number; course_id: number; holes: string }>();
    const round = await db.prepare("SELECT holes_json FROM pdga_rated_rounds WHERE pdga_layout_id = ? ORDER BY round_date DESC LIMIT 1")
      .bind(pdgaLayoutId).first<{ holes_json: string }>();
    const ours = layout ? ourLayoutHoles(layout.holes) : null;
    if (!layout || !ours || !round) return { error: "layout_not_found", status: 404 };
    const check = compareLayoutGeometry(holesFrom(round.holes_json), ours);
    // An admin may vouch past missing or differing hole lengths, never past a different hole count or pars.
    if (!check.parOk) return { error: "layout_geometry_mismatch", status: 409 };
    courseId = layout.course_id;
    quality = check.grade;
  }
  const revision = action === "reject" ? null : await layoutRevision(db, target);
  await db.prepare(`UPDATE pdga_layout_matches SET course_id = ?, layout_id = ?, layout_revision = ?, quality = ?,
      review_status = ?, reviewed_at = ?, reviewed_by = ? WHERE pdga_layout_id = ?`)
    .bind(courseId, target, revision, quality, action === "reject" ? "rejected" : "confirmed", now, adminId, pdgaLayoutId).run();
  const wasUsed = existing.review_status === "auto" || existing.review_status === "confirmed";
  await queuePdgaLayoutRepairs(db, [wasUsed ? existing.layout_id : null, action === "reject" ? null : target], now);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Admin reads

function candidatesFrom(raw: unknown): MatchCandidate[] {
  const list = parseJson<unknown>(raw, []);
  return Array.isArray(list) ? list as MatchCandidate[] : [];
}

export async function pdgaBaselineOverview(db: D1Like) {
  const [counts, queue, review, matched] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) AS count FROM pdga_ingest_queue GROUP BY status").all<{ status: string; count: number }>(),
    db.prepare(`SELECT tourn_id, source, status, attempts, last_error, ratings_official, event_name, event_date, pending_json,
        updated_at, next_attempt_at, ingested_at
      FROM pdga_ingest_queue ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
        updated_at DESC, tourn_id DESC LIMIT 25`).all<Row>(),
    db.prepare(`SELECT m.pdga_layout_id, m.quality, m.review_status, m.reason, m.candidates_json, m.course_id, m.layout_id,
        MAX(r.course_name) AS course_name, MAX(r.layout_name) AS layout_name, MAX(r.hole_count) AS hole_count,
        MAX(r.total_par) AS total_par, MAX(r.total_length_ft) AS total_length_ft, COUNT(*) AS rounds,
        MIN(r.round_date) AS first_date, MAX(r.round_date) AS last_date, MAX(r.event_name) AS event_name, MAX(r.tourn_id) AS tourn_id
      FROM pdga_layout_matches m JOIN pdga_rated_rounds r ON r.pdga_layout_id = m.pdga_layout_id
      WHERE m.review_status = 'pending' GROUP BY m.pdga_layout_id
      ORDER BY CASE m.quality WHEN 'ambiguous' THEN 0 WHEN 'unverified' THEN 1 ELSE 2 END,
        CASE WHEN m.candidates_json = '[]' THEN 1 ELSE 0 END, last_date DESC LIMIT 40`).all<Row>(),
    db.prepare(`SELECT m.review_status, COUNT(DISTINCT m.pdga_layout_id) AS layouts, COUNT(r.tourn_id) AS rounds
      FROM pdga_layout_matches m LEFT JOIN pdga_rated_rounds r ON r.pdga_layout_id = m.pdga_layout_id GROUP BY m.review_status`)
      .all<{ review_status: string; layouts: number; rounds: number }>(),
  ]);
  return {
    queue: {
      counts: Object.fromEntries(counts.results.map((row) => [row.status, Number(row.count)])),
      items: queue.results.map((row) => ({
        tournId: Number(row.tourn_id), source: row.source, status: row.status, attempts: Number(row.attempts),
        lastError: row.last_error ?? null, ratingsOfficial: row.ratings_official === 1, name: row.event_name ?? null,
        date: row.event_date ?? null, remainingFetches: parseJson<unknown[]>(row.pending_json, []).length,
        updatedAt: row.updated_at, nextAttemptAt: row.next_attempt_at, ingestedAt: row.ingested_at ?? null,
      })),
    },
    matches: Object.fromEntries(matched.results.map((row) => [row.review_status, { layouts: Number(row.layouts), rounds: Number(row.rounds) }])),
    review: review.results.map((row) => ({
      pdgaLayoutId: Number(row.pdga_layout_id), quality: row.quality, reason: row.reason ?? null,
      courseName: row.course_name, layoutName: row.layout_name, holes: Number(row.hole_count), par: row.total_par ?? null,
      lengthFt: row.total_length_ft ?? null, rounds: Number(row.rounds), firstDate: row.first_date, lastDate: row.last_date,
      eventName: row.event_name, tournId: Number(row.tourn_id), proposedLayoutId: row.layout_id ?? null,
      candidates: candidatesFrom(row.candidates_json),
    })),
  };
}

/** Per-layout PDGA rounds and the baseline a round played today on the current geometry would get. */
export async function pdgaCourseBaselines(db: D1Like, courseId: number, now: string) {
  const course = await db.prepare("SELECT id, name, location FROM courses WHERE id = ?").bind(courseId).first<{ id: number; name: string; location: string | null }>();
  if (!course) return null;
  const layouts = await db.prepare("SELECT id, name, holes FROM course_layouts WHERE course_id = ? ORDER BY id").bind(courseId)
    .all<{ id: number; name: string; holes: string }>();
  const rounds = await db.prepare(`SELECT r.tourn_id, r.round_number, r.pdga_layout_id, r.round_date, r.event_name, r.layout_name,
      ${EFFECTIVE_SSA} AS ssa, r.official_ssa, r.ratings_status, r.rated_players, r.holes_json, m.layout_id, m.quality, m.review_status
    FROM pdga_rated_rounds r JOIN pdga_layout_matches m ON m.pdga_layout_id = r.pdga_layout_id
    WHERE m.layout_id IN (SELECT id FROM course_layouts WHERE course_id = ?) AND m.review_status IN ('auto', 'confirmed')
    ORDER BY r.round_date DESC, r.tourn_id DESC, r.round_number DESC LIMIT 300`).bind(courseId).all<Row>();
  const tomorrow = clubCalendarDay(new Date(Date.parse(now) + 86_400_000).toISOString()) ?? now.slice(0, 10);
  return {
    course: { id: course.id, name: course.name, location: course.location, state: cityState(String(course.location ?? ""))?.state ?? null },
    layouts: layouts.results.map((layout) => {
      const own = rounds.results.filter((row) => Number(row.layout_id) === layout.id);
      const played = ourLayoutHoles(layout.holes);
      const baseline = pdgaBaselineFor(own.map(baselineRound), played, tomorrow);
      return {
        id: layout.id, name: layout.name, holes: played?.length ?? null,
        baseline: baseline ? { ...baseline, provenance: baselineProvenance(baseline) } : null,
        rounds: own.map((row) => ({
          tournId: Number(row.tourn_id), round: Number(row.round_number), pdgaLayoutId: Number(row.pdga_layout_id),
          date: row.round_date, eventName: row.event_name, pdgaLayoutName: row.layout_name,
          ssa: row.ssa == null ? null : Number(row.ssa), officialSsa: row.official_ssa == null ? null : Number(row.official_ssa),
          ratingsStatus: row.ratings_status,
          ratedPlayers: Number(row.rated_players), quality: row.quality, reviewStatus: row.review_status,
          fitsCurrentLayout: played ? compareLayoutGeometry(holesFrom(row.holes_json), played).grade : null,
        })),
      };
    }),
  };
}

/** Ground-truth check: PDGA rounds predicted from earlier PDGA rounds; club baselines beside PDGA. */
export async function pdgaValidationReport(db: D1Like) {
  const rounds = await db.prepare(`SELECT r.tourn_id, r.round_number, r.pdga_layout_id, r.round_date, ${EFFECTIVE_SSA} AS ssa,
      r.official_ssa, r.ratings_status, r.holes_json, m.review_status, m.layout_id,
      (SELECT json_group_array(s.pairs_json) FROM pdga_round_scores s WHERE s.tourn_id = r.tourn_id
        AND s.round_number = r.round_number AND s.pdga_layout_id = r.pdga_layout_id) AS pairs
    FROM pdga_rated_rounds r JOIN pdga_layout_matches m ON m.pdga_layout_id = r.pdga_layout_id
    WHERE m.layout_id IS NOT NULL AND m.review_status IN ('auto', 'confirmed') AND ${EFFECTIVE_SSA} IS NOT NULL
    ORDER BY m.layout_id, r.round_date, r.tourn_id, r.round_number LIMIT 2000`).all<Row>();
  const club = await db.prepare(`SELECT layout_id, played_at, ssa FROM layout_rating_baselines
    WHERE layout_id IN (SELECT layout_id FROM pdga_layout_matches WHERE review_status IN ('auto', 'confirmed')) LIMIT 2000`)
    .all<{ layout_id: number; played_at: string; ssa: number }>();
  const input: ValidationPdgaRound[] = rounds.results.map((row) => ({
    ...baselineRound(row), layoutId: Number(row.layout_id), officialSsa: row.official_ssa == null ? null : Number(row.official_ssa),
    pairs: parseJson<string[]>(row.pairs, []).flatMap((list) => parseJson<ScorePair[]>(list, [])),
  }));
  return evaluatePdgaBaselines(input, club.results.map((row) => ({ layoutId: row.layout_id, playedAt: row.played_at, ssa: row.ssa })));
}
