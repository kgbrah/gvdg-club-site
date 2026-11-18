// Marketplace housekeeping on the existing 15-minute cron: a withdrawal becomes final 24 hours after it was
// made (the relist window), and that listing's photos are deleted from R2. Idempotent and bounded per tick:
// a listing is claimed with a compare-and-set before its photos are removed, and a claimed listing that
// still has photo rows (an earlier tick failed part-way) is picked up again on the next tick.

import type { Env } from "./env.js";
import { RELIST_WINDOW_HOURS } from "./market-store.js";

export const SWEEP_BATCH = 25;

export interface SweepResult {
  finalized: number;
  photosDeleted: number;
}

/** Delete one listing's photos from R2, then their rows. R2 deletes of missing keys are no-ops. */
export async function purgeListingPhotos(env: Env, listingId: number): Promise<number> {
  const rows = (await env.DB.prepare("SELECT id, r2_key FROM market_listing_photos WHERE listing_id = ?")
    .bind(listingId).all<{ id: number; r2_key: string }>()).results ?? [];
  for (const row of rows) {
    if (env.PHOTOS) await env.PHOTOS.delete(row.r2_key);
    await env.DB.prepare("DELETE FROM market_listing_photos WHERE id = ?").bind(row.id).run();
  }
  return rows.length;
}

export async function finalizeWithdrawals(env: Env, limit = SWEEP_BATCH): Promise<SweepResult> {
  const due = (await env.DB.prepare(
    `SELECT id, withdrawal_final FROM market_listings
     WHERE status = 'withdrawn' AND (
       (withdrawal_final = 0 AND withdrawn_at IS NOT NULL AND withdrawn_at <= datetime('now', '-${RELIST_WINDOW_HOURS} hours'))
       OR (withdrawal_final = 1 AND EXISTS (SELECT 1 FROM market_listing_photos p WHERE p.listing_id = market_listings.id)))
     ORDER BY withdrawn_at, id LIMIT ?`,
  ).bind(Math.max(1, Math.min(100, Math.floor(limit)))).all<{ id: number; withdrawal_final: number }>()).results ?? [];
  const result: SweepResult = { finalized: 0, photosDeleted: 0 };
  for (const row of due) {
    if (row.withdrawal_final === 0) {
      // Claim first: a relist that won the race has already moved the listing back to active.
      const claimed = await env.DB.prepare(
        `UPDATE market_listings SET withdrawal_final = 1, updated_at = datetime('now')
         WHERE id = ? AND status = 'withdrawn' AND withdrawal_final = 0 AND withdrawn_at <= datetime('now', '-${RELIST_WINDOW_HOURS} hours')`,
      ).bind(row.id).run();
      if (!((claimed.meta?.changes ?? 0) > 0)) continue;
      await env.DB.prepare(
        "INSERT INTO market_deal_log (listing_id, actor_id, action, from_status, to_status, note) VALUES (?, 'system', 'withdraw_final', 'withdrawn', 'withdrawn', 'relist window closed')",
      ).bind(row.id).run();
      result.finalized += 1;
    }
    try {
      result.photosDeleted += await purgeListingPhotos(env, row.id);
    } catch (error) {
      console.error(JSON.stringify({ message: "market_photo_purge_failed", listingId: row.id, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return result;
}
