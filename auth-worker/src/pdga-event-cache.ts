// The club's own PDGA events: the PDGA event details (name, tier, dates) its registration page shows, and each
// registrant's PDGA membership status and rating (they decide the non-member fee). Both come from the PDGA REST API,
// and PDGA's API license allows temporary caching only, so:
//   - the event details copy carries the time it was read and counts only while fresh (PDGA_EVENT_COPY_MAX_MS); the
//     hourly cron re-reads it from the API for current events;
//   - once an event is PDGA_EVENT_KEEP_DAYS past, the copy and every registrant's PDGA status/rating are cleared.

import type { D1Like } from "./db-types.js";
import { lookupPdgaEvent, pdgaApiConfigured, type PdgaApiEnv, type PdgaEventInfo } from "./pdga-api.js";

export const PDGA_EVENT_COPY_MAX_MS = 24 * 60 * 60 * 1000;
export const PDGA_EVENT_KEEP_DAYS = 14;
const DAY_MS = 86_400_000;
const MAX_REFRESH = 25;

/** The details as stored: the API's event plus when it was read. */
export function stampPdgaEvent(info: PdgaEventInfo, now = Date.now()): string {
  return JSON.stringify({ ...info, fetchedAt: now });
}

/** The stored details when they're fresh enough to show (older copies, and ones without a read time, count as none). */
export function freshPdgaEventCopy(raw: string | null | undefined, now = Date.now()): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fetchedAt = Number(parsed?.fetchedAt);
    if (!Number.isFinite(fetchedAt) || now - fetchedAt > PDGA_EVENT_COPY_MAX_MS || fetchedAt > now + 60_000) return null;
    const { fetchedAt: _read, ...event } = parsed;
    return event;
  } catch {
    return null;
  }
}

/**
 * Hourly: re-read current club PDGA events' details from the API, and clear PDGA data from events long past (their
 * details copy and registrants' PDGA status/rating). Copies that couldn't be refreshed in time are cleared too.
 */
export async function refreshClubPdgaEventCopies(env: { DB: D1Like } & Partial<PdgaApiEnv>, now = Date.now()) {
  const keepFrom = new Date(now - PDGA_EVENT_KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  const past = await env.DB.prepare(`SELECT ec.event_id FROM event_config ec JOIN events e ON e.id = ec.event_id
      WHERE e.date IS NOT NULL AND substr(e.date, 1, 10) < ?
        AND (ec.pdga_event IS NOT NULL OR EXISTS (SELECT 1 FROM registrations r WHERE r.event_id = ec.event_id
          AND (r.pdga_status IS NOT NULL OR r.pdga_rating IS NOT NULL)))`).bind(keepFrom).all<{ event_id: number }>();
  const pastIds = (past.results ?? []).map((row) => Number(row.event_id));
  for (const eventId of pastIds) {
    await env.DB.prepare("UPDATE event_config SET pdga_event = NULL WHERE event_id = ?").bind(eventId).run();
    await env.DB.prepare("UPDATE registrations SET pdga_status = NULL, pdga_rating = NULL, pdga_checked_at = NULL WHERE event_id = ?")
      .bind(eventId).run();
  }
  let refreshed = 0;
  let cleared = 0;
  const current = await env.DB.prepare(`SELECT ec.event_id, ec.pdga_event_id, ec.pdga_event FROM event_config ec JOIN events e ON e.id = ec.event_id
      WHERE ec.pdga_event_id IS NOT NULL AND (e.date IS NULL OR substr(e.date, 1, 10) >= ?) ORDER BY ec.event_id LIMIT ?`)
    .bind(keepFrom, MAX_REFRESH).all<{ event_id: number; pdga_event_id: number; pdga_event: string | null }>();
  const apiEnv = env as PdgaApiEnv;
  for (const row of current.results ?? []) {
    let info: PdgaEventInfo | null = null;
    if (pdgaApiConfigured(apiEnv)) {
      try { info = await lookupPdgaEvent(apiEnv, Number(row.pdga_event_id)); } catch { info = null; }
    }
    if (info) {
      await env.DB.prepare("UPDATE event_config SET pdga_event = ? WHERE event_id = ?").bind(stampPdgaEvent(info, now), row.event_id).run();
      refreshed += 1;
    } else if (row.pdga_event && !freshPdgaEventCopy(row.pdga_event, now)) {
      await env.DB.prepare("UPDATE event_config SET pdga_event = NULL WHERE event_id = ?").bind(row.event_id).run();
      cleared += 1;
    }
  }
  return { refreshed, cleared, pastCleared: pastIds.length };
}
