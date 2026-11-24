// Official PDGA event registration matching (https://www.pdga.com/dev + https://www.pdga.com/dev/api/live):
//   1. Discovers upcoming & recent events per rotating state (NC, VA, SC) using the official PDGA REST API
//      (searchPdgaEvents) plus the club's own PDGA-sanctioned event_config rows;
//   2. Reads rosters from the documented PDGA Live API via pdga-live-api helpers with
//      ETag / If-None-Match conditional requests and Section 6 temporary caching;
//   3. Stores ONLY Section 6(a)-permitted PDGA record IDs (event_id, pdga_number, result_id) in
//      pdga_member_event_links for back-end matching (pruned past expires_at; withdrawals drop off at next read).
//
//   GET /pdga-registrations (member)       -> { mine, club } (names from club ROSTER, never clubmates' PDGA #s)
//   GET /admin/pdga-registrations/status   -> admin monitoring counts

import { adminGate, requireAuth } from "./authz.js";
import type { D1Like, D1StatementLike } from "./db-types.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { karmaKey } from "./karma-directory.js";
import { pdgaApiConfigured, pdgaEventUrl, searchPdgaEvents, type PdgaApiEnv } from "./pdga-api.js";
import {
  fetchPdgaLiveDivisions,
  fetchPdgaLiveEvent,
  purgePdgaLiveCaches,
  type PdgaLiveApiEnv,
} from "./pdga-live-api.js";
import { getMember, readInBatches, type KVListLike } from "./roster.js";

export const WATCH_STATES = ["NC", "VA", "SC"] as const;
export type WatchState = (typeof WATCH_STATES)[number];
export const WATCH_DAYS_AHEAD = 120;
export const WATCH_DAYS_BACK = 180;
export const RECENT_DONE_DAYS = 14;
export const EVENTS_PER_TICK = 6;
const SOON_DAYS = 14;
const REREAD_MINUTES = 55;
const RECENT_DONE_RECHECK_MS = 6 * 60 * 60_000;
const WATCH_TTL_MS = 24 * 60 * 60_000;
const LINK_KEEP_DAYS = 180;
const DAY_MS = 86_400_000;
const CLUB_TIME_ZONE = "America/New_York";

export interface PdgaRegistrationTick {
  state: WatchState;
  listed: number;
  removed: number;
  read: number;
  matched: number;
  failed: number;
  pruned: number;
  skipped?: string;
}

function clubDay(now: number, plusDays = 0): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLUB_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const date = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + plusDays));
  return date.toISOString().slice(0, 10);
}

/** This hour's state: NC, VA, SC in turn. */
export function stateForHour(now: number): WatchState {
  return WATCH_STATES[Math.floor(now / 3_600_000) % WATCH_STATES.length]!;
}

/** All normalized member PDGA numbers in the club roster (key-list only; zero extra KV gets). */
async function clubPdgaNumbers(kv: KVListLike): Promise<Set<string>> {
  const numbers = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const listed = await kv.list({ prefix: "idx:pdga:", cursor, limit: 1000 });
    for (const key of listed.keys) {
      const digits = key.name.slice("idx:pdga:".length);
      if (/^\d{1,7}$/.test(digits)) numbers.add(String(Number(digits)));
    }
    if (listed.list_complete || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return numbers;
}

async function runBatch(db: D1Like, statements: D1StatementLike[]) {
  if (!statements.length) return;
  if (db.batch) await db.batch(statements);
  else for (const stmt of statements) await stmt.run();
}

function isMissingTable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /no such table|does not exist/i.test(msg);
}

function linkExpiresAt(endDate: string, now: number): number {
  const parsed = Date.parse(`${endDate}T23:59:59Z`);
  return Number.isFinite(parsed) ? parsed + LINK_KEEP_DAYS * DAY_MS : now + LINK_KEEP_DAYS * DAY_MS;
}

async function syncWatchEventsFromRestApi(env: Env, state: WatchState, now: number): Promise<{ listed: number; removed: number }> {
  const apiEnv = env as unknown as PdgaApiEnv;
  const db = env.DB as unknown as D1Like;
  let listed = 0;
  let removed = 0;
  const today = clubDay(now);
  const recentDoneCutoff = clubDay(now, -RECENT_DONE_DAYS);
  const watchExpires = now + WATCH_TTL_MS;

  const backWindow = clubDay(now, -WATCH_DAYS_BACK);
  // Load club-owned PDGA event IDs first (recent/upcoming) so state pruning never removes them.
  const clubRows = (await db.prepare(
    `SELECT ec.pdga_event_id, e.name, COALESCE(substr(e.date, 1, 10), substr(e.starts_at, 1, 10)) AS start_date
       FROM event_config ec JOIN events e ON e.id = ec.event_id
      WHERE ec.pdga_event_id IS NOT NULL AND e.status != 'cancelled'
        AND (COALESCE(substr(e.date, 1, 10), substr(e.starts_at, 1, 10)) IS NULL
             OR COALESCE(substr(e.date, 1, 10), substr(e.starts_at, 1, 10)) >= ?)
      ORDER BY start_date DESC, ec.event_id DESC
      LIMIT 25`,
  ).bind(backWindow).all<{ pdga_event_id: number; name: string; start_date: string | null }>().catch(() => ({ results: [] }))).results ?? [];
  const clubEventIds = new Set<number>(
    clubRows.map((row) => Number(row.pdga_event_id)).filter((id) => Number.isInteger(id) && id > 0),
  );

  if (pdgaApiConfigured(apiEnv)) {
    try {
      const startDate = backWindow;
      const endDate = clubDay(now, WATCH_DAYS_AHEAD);
      const events = await searchPdgaEvents(apiEnv, { startDate, endDate, states: [state] });
      listed = events.length;
      const statements: D1StatementLike[] = events.map((event) => {
        const start = event.startDate || startDate;
        const end = event.endDate || start;
        const location = [event.city, event.state].filter(Boolean).join(", ");
        const initialCompleted = end < recentDoneCutoff ? 1 : 0;
        return db.prepare(`INSERT INTO pdga_watch_events
            (event_id, state, name, tier, location, start_date, end_date, listed_at, completed, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(event_id) DO UPDATE SET
              state = excluded.state, name = excluded.name, tier = excluded.tier, location = excluded.location,
              start_date = excluded.start_date, end_date = excluded.end_date,
              listed_at = excluded.listed_at, expires_at = excluded.expires_at`)
          .bind(event.id, state, event.name.slice(0, 160), event.tier.slice(0, 24), location.slice(0, 120), start, end, now, initialCompleted, watchExpires);
      });
      for (let i = 0; i < statements.length; i += 50) await runBatch(db, statements.slice(i, i + 50));

      // Only prune unseen watch rows when the REST response looks complete (non-empty and below searchPdgaEvents' 1000 cap).
      if (events.length > 0 && events.length < 1000) {
        const seenIds = new Set(events.map((event) => event.id));
        const existing = (await db.prepare(
          "SELECT event_id, start_date FROM pdga_watch_events WHERE state = ? AND end_date >= ?",
        ).bind(state, startDate).all<{ event_id: number; start_date: string | null }>()).results ?? [];
        const pruneStatements: D1StatementLike[] = [];
        for (const row of existing) {
          const id = Number(row.event_id);
          if (seenIds.has(id) || clubEventIds.has(id)) continue;
          // Preserve links for already-started/played events so /pdga-stats round ratings are not deleted early.
          if (String(row.start_date || "") > today) {
            pruneStatements.push(db.prepare("DELETE FROM pdga_member_event_links WHERE event_id = ?").bind(id));
          }
          pruneStatements.push(db.prepare("DELETE FROM pdga_watch_events WHERE event_id = ?").bind(id));
          removed += 1;
        }
        for (let i = 0; i < pruneStatements.length; i += 50) await runBatch(db, pruneStatements.slice(i, i + 50));
      }
    } catch (error) {
      console.warn(JSON.stringify({
        message: "pdga_watch_search_failed",
        state,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  // Ensure the club's own PDGA-sanctioned events stay watched even outside the current rotating state.
  const clubStatements: D1StatementLike[] = [];
  for (const row of clubRows) {
    const id = Number(row.pdga_event_id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const fallbackDay = row.start_date && /^\d{4}-\d{2}-\d{2}$/.test(row.start_date) ? row.start_date : today;
    clubStatements.push(db.prepare(`INSERT INTO pdga_watch_events
        (event_id, state, name, tier, location, start_date, end_date, listed_at, expires_at)
        VALUES (?, 'NC', ?, '', '', ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET expires_at = excluded.expires_at, listed_at = excluded.listed_at`)
      .bind(id, String(row.name || `PDGA #${id}`).slice(0, 160), fallbackDay, fallbackDay, now, watchExpires));
  }
  for (let i = 0; i < clubStatements.length; i += 50) await runBatch(db, clubStatements.slice(i, i + 50));

  return { listed, removed };
}

/**
 * Hourly cron job: refresh upcoming/recent regional events via the REST API, read due event rosters via the
 * official PDGA Live API, update Section 6(a) record-ID links, and purge expired caches.
 */
export async function refreshPdgaRegistrations(
  env: Env,
  now = Date.now(),
  opts: { skipPurge?: boolean } = {},
): Promise<PdgaRegistrationTick> {
  const state = stateForHour(now);
  const db = env.DB as unknown as D1Like;
  const liveEnv = env as unknown as PdgaLiveApiEnv;

  let pruned = 0;
  if (!opts.skipPurge) {
    try {
      const purged = await purgePdgaLiveCaches(db, now);
      pruned = purged.liveResponses + purged.watchEvents + purged.memberLinks;
    } catch (error) {
      if (isMissingTable(error)) return { state, listed: 0, removed: 0, read: 0, matched: 0, failed: 0, pruned: 0, skipped: "no_migration" };
      throw error;
    }
  }

  const club = await clubPdgaNumbers(env.ROSTER);
  if (!club.size) {
    return { state, listed: 0, removed: 0, read: 0, matched: 0, failed: 0, pruned, skipped: "no_pdga_members" };
  }

  const { listed, removed } = await syncWatchEventsFromRestApi(env, state, now);

  const today = clubDay(now);
  const backWindow = clubDay(now, -WATCH_DAYS_BACK);
  const recentDoneCutoff = clubDay(now, -RECENT_DONE_DAYS);
  const soon = clubDay(now, SOON_DAYS);
  const stale = now - REREAD_MINUTES * 60_000;
  const doneRecheck = now - RECENT_DONE_RECHECK_MS;

  const due = (await db.prepare(
    `SELECT event_id, start_date, end_date, completed
       FROM pdga_watch_events
      WHERE expires_at > ? AND end_date >= ?
        AND (
          (completed = 0 AND (read_at IS NULL OR read_at < ?))
          OR (completed = 1 AND end_date >= ? AND (read_at IS NULL OR read_at < ?))
          OR (completed = 1 AND end_date < ? AND read_at IS NULL)
        )
      ORDER BY
        CASE
          WHEN completed = 0 AND start_date <= ? THEN 0
          WHEN completed = 0 AND read_at IS NULL THEN 1
          WHEN completed = 0 THEN 2
          WHEN completed = 1 AND end_date >= ? THEN 3
          ELSE 4
        END,
        read_at IS NOT NULL,
        CASE WHEN completed = 0 THEN start_date END ASC,
        CASE WHEN completed = 1 THEN start_date END DESC,
        read_at
      LIMIT ?`,
  ).bind(now, backWindow, stale, recentDoneCutoff, doneRecheck, recentDoneCutoff, soon, recentDoneCutoff, EVENTS_PER_TICK)
    .all<{ event_id: number; start_date: string; end_date: string; completed: number }>()).results ?? [];

  let read = 0;
  let matched = 0;
  let failed = 0;
  let failuresInARow = 0;
  const memberCache = new Map<string, { memberId: string } | null>();

  for (const row of due) {
    const eventId = Number(row.event_id);
    try {
      const eventInfo = await fetchPdgaLiveEvent(liveEnv, eventId, now);
      if (!eventInfo) {
        const done = row.end_date < today ? 1 : 0;
        await db.prepare("UPDATE pdga_member_event_links SET expires_at = ? WHERE event_id = ? AND expires_at > ?")
          .bind(now, eventId, now).run();
        await db.prepare("UPDATE pdga_watch_events SET read_at = ?, read_error = '', completed = ? WHERE event_id = ?")
          .bind(now, done, eventId).run();
        read += 1;
        failuresInARow = 0;
        continue;
      }

      const startDate = eventInfo.startDate || row.start_date;
      const endDate = eventInfo.endDate || row.end_date || startDate;
      const isCompleted = endDate < recentDoneCutoff
        || (endDate < today && eventInfo.highestCompletedRound != null && eventInfo.highestCompletedRound >= eventInfo.rounds)
        ? 1 : 0;

      const divCodes = eventInfo.divisions.filter((d) => d.players > 0).map((d) => d.division);
      const foundByPdga = new Map<string, { resultId: number; division: string }>();
      if (divCodes.length) {
        const blocksByDiv = await fetchPdgaLiveDivisions(liveEnv, eventId, divCodes, 1, now, isCompleted === 1);
        for (const [divCode, blocks] of blocksByDiv) {
          for (const block of blocks) {
            for (const score of block.scores) {
              if (!score.pdgaNumber || !club.has(score.pdgaNumber)) continue;
              if (!foundByPdga.has(score.pdgaNumber)) {
                foundByPdga.set(score.pdgaNumber, {
                  resultId: score.resultId,
                  division: score.division || divCode,
                });
              }
            }
          }
        }
      }

      const missingPdga = [...foundByPdga.keys()].filter((pdga) => !memberCache.has(pdga));
      if (missingPdga.length) {
        await readInBatches(missingPdga, async (pdga) => {
          const memberId = await env.ROSTER.get("idx:pdga:" + pdga);
          if (!memberId) {
            memberCache.set(pdga, null);
            return null;
          }
          const member = await getMember(env.ROSTER, memberId);
          memberCache.set(pdga, member && member.held !== true ? { memberId } : null);
          return null;
        });
      }

      const matchedStatements: D1StatementLike[] = [];
      const linkExp = linkExpiresAt(endDate, now);
      let keptCount = 0;

      for (const [pdga, info] of foundByPdga) {
        const resolved = memberCache.get(pdga);
        if (!resolved) continue;
        keptCount += 1;
        matchedStatements.push(db.prepare(
          `INSERT INTO pdga_member_event_links
             (event_id, member_id, pdga_number, result_id, division, event_start, event_end, matched_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id, member_id) DO UPDATE SET
             pdga_number = excluded.pdga_number, result_id = excluded.result_id,
             division = excluded.division, event_start = excluded.event_start, event_end = excluded.event_end,
             matched_at = excluded.matched_at, expires_at = excluded.expires_at`,
        ).bind(eventId, resolved.memberId, pdga, info.resultId, info.division.slice(0, 24), startDate, endDate, now, linkExp));
      }

      for (let i = 0; i < matchedStatements.length; i += 50) await runBatch(db, matchedStatements.slice(i, i + 50));
      // Use a constant-parameter timestamp delete (matched_at < now) so >=100 matched members never overflow D1's 100-variable limit.
      await db.prepare("DELETE FROM pdga_member_event_links WHERE event_id = ? AND matched_at < ?")
        .bind(eventId, now).run();

      await db.prepare(
        `UPDATE pdga_watch_events
            SET name = ?, tier = ?, location = ?, start_date = ?, end_date = ?,
                read_at = ?, read_error = '', completed = ?, expires_at = ?
          WHERE event_id = ?`,
      ).bind(
        eventInfo.name.slice(0, 160),
        eventInfo.tier.slice(0, 24),
        eventInfo.location.slice(0, 120),
        startDate,
        endDate,
        now,
        isCompleted,
        now + WATCH_TTL_MS,
        eventId,
      ).run();

      matched += keptCount;
      read += 1;
      failuresInARow = 0;
    } catch (error) {
      failed += 1;
      failuresInARow += 1;
      await db.prepare("UPDATE pdga_watch_events SET read_at = ?, read_error = ? WHERE event_id = ?")
        .bind(now, String((error as Error)?.message || "read_failed").slice(0, 60), eventId).run();
      if (failuresInARow >= 3) break;
    }
  }

  return { state, listed, removed, read, matched, failed, pruned };
}

interface RegistrationLinkRow {
  event_id: number;
  name: string;
  tier: string;
  location: string;
  start_date: string;
  end_date: string;
  read_at: number | null;
  member_id: string;
  division: string;
}

/** GET /pdga-registrations: upcoming PDGA events the viewer and clubmates are registered in. */
export async function handlePdgaRegistrations(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);

  const now = Date.now();
  const db = env.DB as unknown as D1Like;
  let rows: RegistrationLinkRow[] = [];
  try {
    rows = (await db.prepare(
      `SELECT e.event_id, e.name, e.tier, e.location, e.start_date, e.end_date, e.read_at, l.member_id, l.division
         FROM pdga_member_event_links l
         JOIN pdga_watch_events e ON e.event_id = l.event_id
        WHERE e.end_date >= ? AND e.expires_at > ? AND l.expires_at > ?
        ORDER BY e.start_date, e.event_id, l.member_id
        LIMIT 600`,
    ).bind(clubDay(now), now, now).all<RegistrationLinkRow>()).results ?? [];
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    return json({ mine: [], club: [] }, 200, origin, { "Cache-Control": "private, no-store" });
  }

  const uniqueIds = [...new Set(rows.map((row) => row.member_id))];
  const membersById = new Map<string, string | null>();
  await readInBatches(uniqueIds, async (memberId) => {
    const member = await getMember(env.ROSTER, memberId);
    membersById.set(memberId, member && member.held !== true ? String(member.name || "Member").slice(0, 80) : null);
    return null;
  });

  const byEvent = new Map<number, {
    event: {
      eventId: number;
      name: string;
      tier: string;
      location: string;
      start: string;
      end: string;
      url: string;
      checkedAt: string | null;
    };
    entries: { memberId: string; name: string; division: string }[];
  }>();

  for (const row of rows) {
    const memberName = membersById.get(row.member_id);
    if (!memberName) continue;
    const id = Number(row.event_id);
    if (!byEvent.has(id)) {
      byEvent.set(id, {
        event: {
          eventId: id,
          name: row.name,
          tier: row.tier,
          location: row.location,
          start: row.start_date,
          end: row.end_date,
          url: pdgaEventUrl(id),
          checkedAt: row.read_at ? new Date(Number(row.read_at)).toISOString() : null,
        },
        entries: [],
      });
    }
    byEvent.get(id)!.entries.push({ memberId: row.member_id, name: memberName, division: row.division });
  }

  const mine = [];
  const club = [];
  for (const { event, entries } of byEvent.values()) {
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const me = entries.find((entry) => entry.memberId === claims.sub);
    // Clubmates' PDGA numbers never leave the server (linked PDGA event page lists players).
    const going = entries
      .filter((entry) => entry.memberId !== claims.sub)
      .map((entry) => ({ name: entry.name, division: entry.division, karmaKey: karmaKey(entry.memberId) }));
    if (me) mine.push({ ...event, division: me.division, going });
    else if (going.length) club.push({ ...event, going });
  }

  return json({ mine, club }, 200, origin, { "Cache-Control": "private, no-store" });
}

/** GET /admin/pdga-registrations/status: per-state counts and match totals for deploy/admin checks. */
export async function handlePdgaRegistrationStatus(request: Request, env: Env, origin: string | null): Promise<Response> {
  const gate = await adminGate(request, env, origin);
  if (gate instanceof Response) return gate;
  const db = env.DB as unknown as D1Like;
  const now = Date.now();
  try {
    const states = (await db.prepare(
      `SELECT state, COUNT(*) AS events, SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read,
              SUM(CASE WHEN read_error <> '' THEN 1 ELSE 0 END) AS errors, MAX(read_at) AS last_read, MAX(listed_at) AS last_listed
         FROM pdga_watch_events
        WHERE expires_at > ?
        GROUP BY state ORDER BY state`,
    ).bind(now).all<{
      state: string; events: number; read: number; errors: number; last_read: number | null; last_listed: number | null;
    }>()).results ?? [];
    const totals = await db.prepare(
      "SELECT COUNT(*) AS registrations, COUNT(DISTINCT member_id) AS members FROM pdga_member_event_links WHERE expires_at > ?",
    ).bind(now).first<{ registrations: number; members: number }>();
    return json({
      states: states.map((row) => ({
        state: row.state,
        events: Number(row.events) || 0,
        read: Number(row.read) || 0,
        errors: Number(row.errors) || 0,
        lastRead: row.last_read ? new Date(Number(row.last_read)).toISOString() : null,
        lastListed: row.last_listed ? new Date(Number(row.last_listed)).toISOString() : null,
      })),
      registrations: Number(totals?.registrations) || 0,
      members: Number(totals?.members) || 0,
    }, 200, origin, { "Cache-Control": "private, no-store" });
  } catch (error) {
    if (isMissingTable(error)) return json({ states: [], registrations: 0, members: 0 }, 200, origin, { "Cache-Control": "private, no-store" });
    throw error;
  }
}
