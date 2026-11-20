import type { Env } from "./env.js";
import type { D1Like } from "./db-types.js";
import { getMember, type Member } from "./roster.js";
import { ratingTimestamp } from "./rating-layout.js";
import { RATING_STREAMS, type RatingStream } from "./rating-engine.js";
import { repairRatingSource } from "./rating-repair.js";
import { lookupPdgaPlayers, pdgaApiConfigured, type PdgaApiEnv } from "./pdga-api.js";

const SOURCES_PER_STREAM = 8;
const RETRIES_PER_TICK = 4;
const WAITING_REVIEW_DAYS = 7;
const DAY_MS = 86_400_000;
/**
 * PDGA ratings (from the PDGA REST API) calibrate club fields as rating anchors. PDGA's API license allows temporary
 * caching only, so a member's PDGA rating is kept only while the API keeps confirming it (refreshed daily) and for
 * ANCHOR_KEEP_DAYS after it stops (superseded by a newer rating, or the member's gone); then it's deleted.
 */
export const ANCHOR_KEEP_DAYS = 7;
const ROSTER_LIST_LIMIT = 1000;
const ROSTER_MAX_PAGES = 5;

type WorkSummary = {
  checkedSources: number;
  retriedSources: number;
  failedSources: number;
  waitingSources: number;
  roundRows: number;
  layoutBaselines: number;
};

type SourceRef = { stream: RatingStream; source_id: number; attempts?: number };
type RefreshSummary = { pdgaRefreshed: number; pdgaRefreshErrors: number; pdgaAnchorsPurged: number };

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
      // The rolling scan re-rates only recent rounds, or older ones whose scores changed; a queued issue always re-rates.
      const keepRatedBefore = ref.attempts == null ? new Date(Date.parse(now) - ANCHOR_KEEP_DAYS * DAY_MS).toISOString() : undefined;
      const result = await repairRatingSource(db, ref.stream, ref.source_id, null, { keepRatedBefore });
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

/** Record (or re-confirm) a member's current PDGA rating as an anchor. */
async function recordObservedAnchor(db: D1Like, memberId: string, observedAt: string, effectiveAt: string, rating: number) {
  const confirmed = await db.prepare(
    "UPDATE rating_anchor_snapshots SET confirmed_at = ? WHERE member_id = ? AND effective_at = ? AND rating = ?",
  ).bind(observedAt, memberId, effectiveAt, rating).run();
  if (Number(confirmed.meta?.changes ?? 0) > 0) return false;
  await db.prepare(
    `INSERT OR IGNORE INTO rating_anchor_snapshots (member_id, observed_at, effective_at, rating, confirmed_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(memberId, observedAt, effectiveAt, rating, observedAt).run();
  return true;
}

/** Every roster member with a PDGA number (held accounts excluded). */
async function membersWithPdga(env: Env): Promise<{ member: Member; pdga: string }[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < ROSTER_MAX_PAGES; page += 1) {
    const listed = await env.ROSTER.list({ prefix: "member:", limit: ROSTER_LIST_LIMIT, cursor });
    names.push(...listed.keys.map((key) => key.name));
    if (listed.list_complete || !listed.cursor) break;
    cursor = listed.cursor;
  }
  const members = await Promise.all(names.map((name) => getMember(env.ROSTER, name.slice("member:".length)).catch(() => null)));
  return members.flatMap((member) => {
    const pdga = member?.pdgaNo?.replace(/\D/g, "");
    return member && member.held !== true && pdga && /^[0-9]{1,8}$/.test(pdga) ? [{ member, pdga }] : [];
  });
}

/**
 * Re-read every member's PDGA rating from the PDGA REST API (one request per 200 members), confirm or record it as an
 * anchor, then delete anchors the API hasn't confirmed in ANCHOR_KEEP_DAYS. Nothing is read when the club's PDGA
 * developer account isn't configured (the anchors then simply age out).
 */
async function refreshRatingAnchors(env: Env, now = new Date()): Promise<RefreshSummary> {
  const result: RefreshSummary = { pdgaRefreshed: 0, pdgaRefreshErrors: 0, pdgaAnchorsPurged: 0 };
  const apiEnv = env as unknown as PdgaApiEnv;
  if (pdgaApiConfigured(apiEnv)) {
    const members = await membersWithPdga(env);
    if (members.length) {
      try {
        const players = await lookupPdgaPlayers(apiEnv, members.map((entry) => entry.pdga));
        const observedAt = now.toISOString();
        for (const { member, pdga } of members) {
          try {
            const player = players.get(pdga);
            const rating = player?.rating ?? null;
            const effectiveAt = player?.ratingDate ? ratingTimestamp(player.ratingDate) : null;
            if (rating == null || rating < 700 || rating > 1300 || !effectiveAt || effectiveAt > observedAt) continue;
            if (await recordObservedAnchor(env.DB, member.memberId, observedAt, effectiveAt, rating)) result.pdgaRefreshed += 1;
          } catch {
            result.pdgaRefreshErrors += 1;
          }
        }
      } catch (error) {
        result.pdgaRefreshErrors += 1;
        console.warn(JSON.stringify({ message: "pdga_api_anchor_read_failed", error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }
  const cutoff = new Date(now.getTime() - ANCHOR_KEEP_DAYS * DAY_MS).toISOString();
  const purged = await env.DB.prepare("DELETE FROM rating_anchor_snapshots WHERE confirmed_at IS NULL OR confirmed_at < ?").bind(cutoff).run();
  result.pdgaAnchorsPurged = Number(purged.meta?.changes ?? 0);
  return result;
}

export async function runRatingsRecompute(env: Env, now = new Date()) {
  // Repair local rows before making any provider requests, so provider failures do not delay recovery.
  const repair = await runRatingRepairCycle(env.DB, now.toISOString());
  try {
    return { ...repair, ...await refreshRatingAnchors(env, now) };
  } catch (error) {
    console.warn(JSON.stringify({ message: "rating_anchor_refresh_failed", error: error instanceof Error ? error.message : String(error) }));
    return { ...repair, pdgaRefreshed: 0, pdgaRefreshErrors: 1, pdgaAnchorsPurged: 0 };
  }
}
