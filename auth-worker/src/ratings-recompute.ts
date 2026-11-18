import type { Env } from "./env.js";
import type { D1Like } from "./db-types.js";
import { parseMemberOverview } from "./pdga.js";
import { getMember } from "./roster.js";
import { ratingRecord, ratingTimestamp } from "./rating-layout.js";
import { RATING_STREAMS, type RatingStream } from "./rating-engine.js";
import { repairRatingSource } from "./rating-repair.js";

const SOURCES_PER_STREAM = 8;
const RETRIES_PER_TICK = 4;
const ROSTER_PAGE_SIZE = 12;
const WAITING_REVIEW_DAYS = 7;
const DAY_MS = 86_400_000;

type WorkSummary = {
  checkedSources: number;
  retriedSources: number;
  failedSources: number;
  waitingSources: number;
  roundRows: number;
  layoutBaselines: number;
};

type SourceRef = { stream: RatingStream; source_id: number; attempts?: number };
type RefreshSummary = { pdgaRefreshed: number; pdgaRefreshErrors: number };

async function dueIssues(db: D1Like, now: string) {
  const { results } = await db.prepare(
    `SELECT stream, source_id, attempts FROM rating_repair_issues WHERE retry_at <= ?
      ORDER BY (last_code = 'awaiting-evidence'), retry_at, source_id LIMIT ?`,
  ).bind(now, RETRIES_PER_TICK).all<SourceRef>();
  return results;
}

async function scanSources(db: D1Like, stream: RatingStream) {
  const checkpoint = await db.prepare("SELECT after_id FROM rating_repair_checkpoints WHERE stream = ?")
    .bind(stream).first<{ after_id: number }>();
  const sql = stream === "competition"
    ? `SELECT e.id FROM events e WHERE e.id > ? AND e.status = 'final'
         AND EXISTS (SELECT 1 FROM results r WHERE r.event_id = e.id AND r.member_id IS NOT NULL)
       ORDER BY e.id LIMIT ?`
    : `SELECT r.id FROM casual_rounds r WHERE r.id > ?
         AND EXISTS (SELECT 1 FROM casual_results cr WHERE cr.casual_round_id = r.id AND cr.member_id IS NOT NULL)
       ORDER BY r.id LIMIT ?`;
  const { results } = await db.prepare(sql).bind(checkpoint?.after_id ?? 0, SOURCES_PER_STREAM).all<{ id: number }>();
  return results.map(({ id }) => ({ stream, source_id: id }));
}

async function saveCheckpoint(db: D1Like, stream: RatingStream, afterId: number, now: string) {
  await db.prepare(
    `INSERT INTO rating_repair_checkpoints (stream, after_id, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(stream) DO UPDATE SET after_id = excluded.after_id, checked_at = excluded.checked_at`,
  ).bind(stream, afterId, now).run();
}

async function saveIssue(db: D1Like, ref: SourceRef, code: string, now: string) {
  const attempts = (ref.attempts ?? 0) + 1;
  const days = code === "awaiting-evidence" ? WAITING_REVIEW_DAYS : Math.min(28, 2 ** Math.min(attempts - 1, 5));
  const retryAt = new Date(Date.parse(now) + days * DAY_MS).toISOString();
  await db.prepare(
    `INSERT INTO rating_repair_issues (stream, source_id, attempts, last_code, checked_at, retry_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(stream, source_id) DO UPDATE SET attempts = rating_repair_issues.attempts + 1,
        last_code = excluded.last_code, checked_at = excluded.checked_at, retry_at = excluded.retry_at`,
  ).bind(ref.stream, ref.source_id, attempts, code, now, retryAt).run();
}

export async function runRatingRepairCycle(db: D1Like, now = new Date().toISOString()): Promise<WorkSummary> {
  const summary: WorkSummary = { checkedSources: 0, retriedSources: 0, failedSources: 0, waitingSources: 0, roundRows: 0, layoutBaselines: 0 };
  const seen = new Set<string>();
  async function repair(ref: SourceRef) {
    const key = ref.stream + ":" + ref.source_id;
    if (seen.has(key)) return;
    seen.add(key);
    if (ref.attempts == null) {
      const issue = await db.prepare("SELECT retry_at FROM rating_repair_issues WHERE stream = ? AND source_id = ?")
        .bind(ref.stream, ref.source_id).first<{ retry_at: string }>();
      if (issue?.retry_at && issue.retry_at > now) return;
    }
    summary.checkedSources += 1;
    if (ref.attempts != null) summary.retriedSources += 1;
    try {
      const result = await repairRatingSource(db, ref.stream, ref.source_id);
      summary.roundRows += result.rows;
      summary.layoutBaselines += result.layoutBaselines;
      if (result.waiting) {
        summary.waitingSources += 1;
        await saveIssue(db, ref, "awaiting-evidence", now);
      } else {
        await db.prepare("DELETE FROM rating_repair_issues WHERE stream = ? AND source_id = ?")
          .bind(ref.stream, ref.source_id).run();
      }
    } catch (error) {
      summary.failedSources += 1;
      await saveIssue(db, ref, "source-repair-failed", now);
      console.warn(JSON.stringify({ message: "rating_repair_failed", stream: ref.stream, sourceId: ref.source_id,
        error: error instanceof Error ? error.message : String(error) }));
    }
  }
  for (const issue of await dueIssues(db, now)) await repair(issue);
  for (const stream of RATING_STREAMS) {
    const sources = await scanSources(db, stream);
    for (const ref of sources) await repair(ref);
    // Start the next sweep at zero so late corrections or newly finalized lower IDs get repaired too.
    await saveCheckpoint(db, stream, sources.length === SOURCES_PER_STREAM ? sources.at(-1)!.source_id : 0, now);
  }
  return summary;
}

async function recordObservedAnchor(db: D1Like, memberId: string, observedAt: string, effectiveAt: string, rating: number) {
  const response = await db.prepare(
    `INSERT OR IGNORE INTO rating_anchor_snapshots (member_id, observed_at, effective_at, rating)
     SELECT ?, ?, ?, ? WHERE NOT EXISTS (
       SELECT 1 FROM rating_anchor_snapshots WHERE member_id = ? AND effective_at = ? AND rating = ?
     )`,
  ).bind(memberId, observedAt, effectiveAt, rating, memberId, effectiveAt, rating).run();
  return Number(response.meta?.changes ?? 0) > 0;
}

async function refreshRatingAnchors(env: Env, doFetch: typeof fetch): Promise<RefreshSummary> {
  const state = await env.DB.prepare("SELECT cursor, last_key FROM rating_anchor_refresh_state WHERE id = 1")
    .first<{ cursor: string | null; last_key: string | null }>();
  const page = await env.ROSTER.list({ prefix: "member:", limit: ROSTER_PAGE_SIZE, cursor: state?.cursor ?? undefined });
  // D1's roster fallback returns all matching keys. Bound processing there too using the last processed key.
  const keys = page.keys.filter(({ name }) => !state?.last_key || name > state.last_key);
  const batch = keys.slice(0, ROSTER_PAGE_SIZE);
  const result = { pdgaRefreshed: 0, pdgaRefreshErrors: 0 };
  for (const key of batch) {
    try {
      const member = await getMember(env.ROSTER, key.name.slice("member:".length));
      const pdga = member?.pdgaNo?.replace(/\D/g, "");
      if (!member || member.held === true || !pdga || !/^[0-9]{1,8}$/.test(pdga)) continue;
      // Read the authoritative overview only. The dashboard may contain demo data and the
      // complete PDGA stats fetch fans out into events unrelated to establishing an anchor.
      const response = await doFetch(`https://www.pdga.com/api/v1/feat/members/${pdga}/overview`, {
        headers: { Accept: "application/json", "User-Agent": "GVDGClubBot/1.0" },
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const player = parseMemberOverview(payload);
      const effectiveAt = ratingTimestamp(ratingRecord(ratingRecord(payload).currentRating).effectiveDate);
      const observedAt = new Date().toISOString();
      const rating = player.official_rating;
      if (rating == null || rating < 700 || rating > 1300 || !effectiveAt || effectiveAt > observedAt) continue;
      if (await recordObservedAnchor(env.DB, member.memberId, observedAt, effectiveAt, rating)) result.pdgaRefreshed += 1;
    } catch {
      result.pdgaRefreshErrors += 1;
    }
  }
  const nextCursor = !page.list_complete ? page.cursor ?? null : null;
  const nextKey = keys.length > batch.length ? batch.at(-1)?.name ?? null : null;
  await env.DB.prepare(
    `INSERT INTO rating_anchor_refresh_state (id, cursor, last_key) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, last_key = excluded.last_key`,
  ).bind(nextCursor, nextKey).run();
  return result;
}

export async function runRatingsRecompute(env: Env, doFetch: typeof fetch = fetch) {
  // Repair local rows before making any provider requests, so provider failures do not delay recovery.
  const repair = await runRatingRepairCycle(env.DB);
  try {
    return { ...repair, ...await refreshRatingAnchors(env, doFetch) };
  } catch (error) {
    console.warn(JSON.stringify({ message: "rating_anchor_refresh_failed", error: error instanceof Error ? error.message : String(error) }));
    return { ...repair, pdgaRefreshed: 0, pdgaRefreshErrors: 1 };
  }
}
