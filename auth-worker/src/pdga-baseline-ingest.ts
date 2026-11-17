// Cron/admin-only ingestion of PDGA rated rounds for layout baselines. Never runs on a member's
// request path. Each tick makes a small, bounded number of pdga.com JSON requests:
//   1. discovery: a few members' public /rating-detail -> local events go on the queue;
//   2. ingest:    queued events, one [division, round] fetch at a time, resumable across ticks;
//   3. re-match:  a few stale automatic/pending layout matches against our current layouts.
// pdga.com HTML is behind a Cloudflare challenge, so only the JSON endpoints are used.

import type { D1Like, D1StatementLike } from "./db-types.js";
import type { Env } from "./env.js";
import {
  clubPlaces, discoverableEvent, parsePdgaEvent, parsePdgaRound, parseRatingDetailEvents, pdgaEventComplete, pdgaRoundTasks,
  PDGA_LIVE_API, PDGA_MEMBER_API, type PdgaEventSummary,
} from "./pdga-baselines.js";
import { matchPdgaLayouts, refreshRatingsSsa } from "./pdga-baseline-store.js";
import { getMember } from "./roster.js";

const UA = "Mozilla/5.0 (compatible; GVDGClubBot/1.0; +https://gvdgclub.com)";
export const PDGA_FETCHES_PER_TICK = 10;
export const PDGA_ADMIN_FETCHES = 20;
const DISCOVERY_MEMBERS_PER_TICK = 3;
const DISCOVERY_REST_MS = 7 * 86_400_000;
const REMATCH_AFTER_MS = 7 * 86_400_000;
const REMATCH_PER_TICK = 10;
const MAX_ATTEMPTS = 6;
const BACKOFF_HOURS = [1, 4, 12, 24, 72];
const FETCH_TIMEOUT_MS = 8_000;

type QueueRow = {
  tourn_id: number; status: string; attempts: number; ratings_official: number;
  event_json: string | null; pending_json: string | null;
};
export type PdgaTickSummary = {
  fetches: number;
  membersChecked: number;
  eventsQueued: number;
  eventsTouched: number;
  eventsCompleted: number;
  eventsFailed: number;
  roundsStored: number;
  layoutsMatched: number;
  layoutsPending: number;
  errors: string[];
};

type JsonResult = { ok: true; json: unknown } | { ok: false; error: string };

async function getJson(doFetch: typeof fetch, url: string): Promise<JsonResult> {
  try {
    const response = await doFetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, error: "http-" + response.status };
    const body = (await response.text()).trim();
    if (!body.startsWith("{") && !body.startsWith("[")) return { ok: false, error: "not-json" };
    return { ok: true, json: JSON.parse(body) };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "fetch-failed" };
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function later(now: string, hours: number): string {
  return new Date(Date.parse(now) + hours * 3_600_000).toISOString();
}

async function run(db: D1Like, statements: D1StatementLike[]): Promise<void> {
  if (!statements.length) return;
  if (db.batch) await db.batch(statements);
  else for (const statement of statements) await statement.run();
}

export type QueueRequest = {
  tournId: number;
  source: "member-history" | "admin";
  official: boolean;
  name?: string | null;
  city?: string | null;
  state?: string | null;
  date?: string | null;
};

/**
 * Queue an event. Re-reads a finished event when PDGA has since published its ratings (it now
 * appears in a member's rating history) or when an admin adds it again.
 */
export async function enqueuePdgaEvent(db: D1Like, request: QueueRequest, now: string): Promise<void> {
  const reread = `((excluded.ratings_official > pdga_ingest_queue.ratings_official AND pdga_ingest_queue.status = 'done')
    OR (excluded.source = 'admin' AND pdga_ingest_queue.status IN ('done', 'failed')))`;
  await db.prepare(`INSERT INTO pdga_ingest_queue (tourn_id, source, status, attempts, ratings_official, event_name, event_city,
      event_state, event_date, queued_at, updated_at, next_attempt_at)
    VALUES (?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tourn_id) DO UPDATE SET
      ratings_official = MAX(pdga_ingest_queue.ratings_official, excluded.ratings_official),
      event_name = COALESCE(pdga_ingest_queue.event_name, excluded.event_name),
      event_city = COALESCE(pdga_ingest_queue.event_city, excluded.event_city),
      event_state = COALESCE(pdga_ingest_queue.event_state, excluded.event_state),
      event_date = COALESCE(pdga_ingest_queue.event_date, excluded.event_date),
      status = CASE WHEN ${reread} THEN 'pending' ELSE pdga_ingest_queue.status END,
      attempts = CASE WHEN ${reread} THEN 0 ELSE pdga_ingest_queue.attempts END,
      event_json = CASE WHEN ${reread} THEN NULL ELSE pdga_ingest_queue.event_json END,
      pending_json = CASE WHEN ${reread} THEN NULL ELSE pdga_ingest_queue.pending_json END,
      next_attempt_at = CASE WHEN ${reread} THEN excluded.next_attempt_at ELSE pdga_ingest_queue.next_attempt_at END,
      updated_at = CASE WHEN ${reread} THEN excluded.updated_at ELSE pdga_ingest_queue.updated_at END`)
    .bind(request.tournId, request.source, request.official ? 1 : 0, request.name ?? null, request.city ?? null,
      request.state ?? null, request.date ?? null, now, now, now).run();
}

// ---------------------------------------------------------------------------------------------
// Discovery from members' public PDGA rating history

async function discoverFromMembers(env: Env, doFetch: typeof fetch, now: string, budget: number, summary: PdgaTickSummary) {
  const db = env.DB;
  const state = await db.prepare("SELECT cursor, last_key, pass_completed_at FROM pdga_discovery_state WHERE id = 1")
    .first<{ cursor: string | null; last_key: string | null; pass_completed_at: string | null }>();
  const resting = state?.pass_completed_at && !state.cursor && !state.last_key &&
    Date.parse(now) - Date.parse(state.pass_completed_at) < DISCOVERY_REST_MS;
  if (resting || budget <= 0) return;
  const page = await env.ROSTER.list({ prefix: "member:", limit: DISCOVERY_MEMBERS_PER_TICK, cursor: state?.cursor ?? undefined });
  // The D1 roster fallback returns every key; skip what an earlier tick already handled.
  const keys = page.keys.filter(({ name }) => !state?.last_key || name > state.last_key);
  const batch = keys.slice(0, Math.min(DISCOVERY_MEMBERS_PER_TICK, budget));
  const locations = await db.prepare("SELECT DISTINCT location FROM courses WHERE location IS NOT NULL").all<{ location: string }>();
  const places = clubPlaces(locations.results.map((row) => row.location));
  for (const key of batch) {
    summary.membersChecked += 1;
    const member = await getMember(env.ROSTER, key.name.slice("member:".length)).catch(() => null);
    const pdga = member?.pdgaNo?.replace(/\D/g, "");
    if (!pdga || !/^[0-9]{1,8}$/.test(pdga)) continue;
    summary.fetches += 1;
    const detail = await getJson(doFetch, `${PDGA_MEMBER_API}/${pdga}/rating-detail`);
    if (!detail.ok) {
      summary.errors.push("rating-detail " + detail.error);
      continue;
    }
    // Rounds listed in a rating history have published (official) ratings.
    for (const event of parseRatingDetailEvents(detail.json).filter((row) => discoverableEvent(row, places, now))) {
      await enqueuePdgaEvent(db, { tournId: event.tournId, source: "member-history", official: true, name: event.name,
        city: event.city, state: event.state, date: event.startDate }, now);
      summary.eventsQueued += 1;
    }
  }
  const moreInPage = keys.length > batch.length;
  const cursor = moreInPage ? state?.cursor ?? null : page.list_complete ? null : page.cursor ?? null;
  const lastKey = moreInPage ? batch.at(-1)?.name ?? null : null;
  const complete = !moreInPage && page.list_complete;
  await db.prepare(`INSERT INTO pdga_discovery_state (id, cursor, last_key, pass_completed_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, last_key = excluded.last_key,
        pass_completed_at = COALESCE(excluded.pass_completed_at, pdga_discovery_state.pass_completed_at)`)
    .bind(cursor, lastKey, complete ? now : null).run();
}

// ---------------------------------------------------------------------------------------------
// Ingest

async function recordFailure(db: D1Like, row: QueueRow, error: string, now: string, summary: PdgaTickSummary) {
  const attempts = row.attempts + 1;
  const failed = attempts >= MAX_ATTEMPTS;
  if (failed) summary.eventsFailed += 1;
  summary.errors.push("event " + row.tourn_id + " " + error);
  await db.prepare(`UPDATE pdga_ingest_queue SET attempts = ?, status = ?, last_error = ?, updated_at = ?, next_attempt_at = ?
      WHERE tourn_id = ?`)
    .bind(attempts, failed ? "failed" : row.status, error.slice(0, 120), now,
      later(now, BACKOFF_HOURS[Math.min(attempts, BACKOFF_HOURS.length) - 1]!), row.tourn_id).run();
}

function roundStatements(db: D1Like, event: PdgaEventSummary, official: boolean, division: string, round: number, json: unknown, now: string) {
  const parsed = parsePdgaRound(json, round);
  const date = event.roundDates[String(round)] ?? event.startDate;
  const statements: D1StatementLike[] = [];
  for (const layout of parsed.layouts) {
    const lengths = layout.holes.map((hole) => hole.lengthFt);
    const totalLength = lengths.every((length) => length != null) ? lengths.reduce((sum, length) => sum! + length!, 0) : null;
    const pairs = parsed.pairs.get(layout.layoutId) ?? [];
    const key = [event.tournId, round, layout.layoutId] as const;
    statements.push(
      db.prepare(`INSERT INTO pdga_rated_rounds (tourn_id, round_number, pdga_layout_id, round_date, event_name, event_city, event_state,
          tier, pdga_course_id, course_name, layout_name, hole_count, total_par, total_length_ft, holes_json, official_ssa,
          ratings_status, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tourn_id, round_number, pdga_layout_id) DO UPDATE SET round_date = excluded.round_date,
          event_name = excluded.event_name, event_city = excluded.event_city, event_state = excluded.event_state, tier = excluded.tier,
          pdga_course_id = excluded.pdga_course_id, course_name = excluded.course_name, layout_name = excluded.layout_name,
          hole_count = excluded.hole_count, total_par = excluded.total_par, total_length_ft = excluded.total_length_ft,
          holes_json = excluded.holes_json, official_ssa = COALESCE(excluded.official_ssa, pdga_rated_rounds.official_ssa),
          ratings_status = excluded.ratings_status, fetched_at = excluded.fetched_at`)
        .bind(...key, date, event.name, event.city, event.state, event.tier, layout.courseId, layout.courseName, layout.name,
          layout.holes.length, layout.holes.reduce((sum, hole) => sum + hole.par, 0), totalLength, JSON.stringify(layout.holes),
          layout.ssa, official ? "official" : "unconfirmed", now),
      db.prepare(`INSERT INTO pdga_round_scores (tourn_id, round_number, pdga_layout_id, division, pairs_json, rated_count)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(tourn_id, round_number, pdga_layout_id, division) DO UPDATE SET pairs_json = excluded.pairs_json,
          rated_count = excluded.rated_count`)
        .bind(...key, division, JSON.stringify(pairs), pairs.length),
      db.prepare(`UPDATE pdga_rated_rounds SET rated_players = (SELECT COALESCE(SUM(rated_count), 0) FROM pdga_round_scores
          WHERE tourn_id = ? AND round_number = ? AND pdga_layout_id = ?)
        WHERE tourn_id = ? AND round_number = ? AND pdga_layout_id = ?`).bind(...key, ...key),
    );
  }
  return { statements, layouts: parsed.layouts.length };
}

async function ingestEvent(db: D1Like, doFetch: typeof fetch, row: QueueRow, now: string, budget: number, summary: PdgaTickSummary) {
  summary.eventsTouched += 1;
  let event = parseJson<PdgaEventSummary | null>(row.event_json, null);
  let tasks = parseJson<[string, number][] | null>(row.pending_json, null);
  if (!event || !tasks) {
    summary.fetches += 1;
    budget -= 1;
    const response = await getJson(doFetch, `${PDGA_LIVE_API}/live_results_fetch_event?TournID=${row.tourn_id}`);
    if (!response.ok) return recordFailure(db, row, response.error, now, summary);
    event = parsePdgaEvent(response.json, row.tourn_id);
    if (!event) return recordFailure(db, row, "event-not-found", now, summary);
    if (!pdgaEventComplete(event, now)) {
      await db.prepare(`UPDATE pdga_ingest_queue SET status = 'pending', last_error = 'event-not-complete', event_name = ?,
          event_date = ?, updated_at = ?, next_attempt_at = ? WHERE tourn_id = ?`)
        .bind(event.name, event.startDate, now, later(now, 24), row.tourn_id).run();
      return;
    }
    tasks = pdgaRoundTasks(event);
    await db.prepare(`UPDATE pdga_ingest_queue SET status = 'in_progress', event_json = ?, pending_json = ?, event_name = ?,
        event_city = ?, event_state = ?, event_date = ?, updated_at = ?, last_error = NULL WHERE tourn_id = ?`)
      .bind(JSON.stringify(event), JSON.stringify(tasks), event.name, event.city, event.state, event.startDate, now, row.tourn_id).run();
    row = { ...row, status: "in_progress" };
  }
  while (tasks.length && budget > 0) {
    const [division, round] = tasks[0]!;
    summary.fetches += 1;
    budget -= 1;
    const url = `${PDGA_LIVE_API}/live_results_fetch_round?TournID=${row.tourn_id}&Division=${encodeURIComponent(division)}&Round=${round}`;
    const response = await getJson(doFetch, url);
    if (!response.ok) return recordFailure(db, row, response.error, now, summary);
    const { statements, layouts } = roundStatements(db, event, row.ratings_official === 1, division, round, response.json, now);
    tasks = tasks.slice(1);
    statements.push(db.prepare("UPDATE pdga_ingest_queue SET pending_json = ?, updated_at = ? WHERE tourn_id = ?")
      .bind(JSON.stringify(tasks), now, row.tourn_id));
    await run(db, statements);
    summary.roundsStored += layouts;
  }
  if (tasks.length) return;
  await db.prepare(`UPDATE pdga_ingest_queue SET status = 'done', pending_json = '[]', attempts = 0, last_error = NULL,
      updated_at = ?, ingested_at = ? WHERE tourn_id = ?`).bind(now, now, row.tourn_id).run();
  summary.eventsCompleted += 1;
  await refreshRatingsSsa(db, row.tourn_id);
  const matched = await matchPdgaLayouts(db, { tournId: row.tourn_id }, now);
  summary.layoutsMatched += matched.matched;
  summary.layoutsPending += matched.pending;
}

async function ingestDue(db: D1Like, doFetch: typeof fetch, now: string, budget: number, summary: PdgaTickSummary) {
  const due = await db.prepare(`SELECT tourn_id, status, attempts, ratings_official, event_json, pending_json FROM pdga_ingest_queue
      WHERE status IN ('pending', 'in_progress') AND next_attempt_at <= ?
      ORDER BY status = 'in_progress' DESC, next_attempt_at, tourn_id LIMIT 6`).bind(now).all<QueueRow>();
  for (const row of due.results) {
    const remaining = budget - summary.fetches;
    if (remaining <= 0) break;
    const failures = summary.errors.length;
    await ingestEvent(db, doFetch, row, now, remaining, summary);
    // A failing pdga.com is unlikely to recover within this tick.
    if (summary.errors.length > failures) break;
  }
}

async function rematchStale(db: D1Like, now: string, all: boolean, summary: PdgaTickSummary) {
  const stale = await db.prepare(`SELECT pdga_layout_id FROM pdga_layout_matches WHERE review_status IN ('auto', 'pending')
      AND matched_at < ? ORDER BY matched_at, pdga_layout_id LIMIT ?`)
    .bind(all ? now : new Date(Date.parse(now) - REMATCH_AFTER_MS).toISOString(), all ? 200 : REMATCH_PER_TICK)
    .all<{ pdga_layout_id: number }>();
  if (!stale.results.length) return;
  const matched = await matchPdgaLayouts(db, { pdgaLayoutIds: stale.results.map((row) => row.pdga_layout_id) }, now);
  summary.layoutsMatched += matched.matched;
  summary.layoutsPending += matched.pending;
}

/** One bounded unit of PDGA baseline work (hourly cron, or an admin's "Ingest now"). */
export async function runPdgaBaselineTick(env: Env, options: {
  doFetch?: typeof fetch; now?: string; fetchBudget?: number; rematchAll?: boolean;
} = {}): Promise<PdgaTickSummary> {
  const doFetch = options.doFetch ?? fetch;
  const now = options.now ?? new Date().toISOString();
  const budget = options.fetchBudget ?? PDGA_FETCHES_PER_TICK;
  const summary: PdgaTickSummary = {
    fetches: 0, membersChecked: 0, eventsQueued: 0, eventsTouched: 0, eventsCompleted: 0, eventsFailed: 0,
    roundsStored: 0, layoutsMatched: 0, layoutsPending: 0, errors: [],
  };
  try {
    await discoverFromMembers(env, doFetch, now, Math.min(DISCOVERY_MEMBERS_PER_TICK, budget), summary);
  } catch (error) {
    summary.errors.push("discovery " + (error instanceof Error ? error.message : String(error)));
  }
  await ingestDue(env.DB, doFetch, now, budget, summary);
  await rematchStale(env.DB, now, options.rematchAll === true, summary);
  return summary;
}
