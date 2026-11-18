// Karma next to every player's name, across the app and the public site. Karma is the Lost & Found ledger (+10 for a
// disc returned), confirmed club donations from marketplace sales (+1 a dollar), and +1 for every round finished in the
// app (roundKarmaSql), less any admin penalty for gaming it (karma_adjustments, karma-watch.ts): the same total as
// karmaOf. A total can be negative.
//
//   GET /karma (public) -> { players: { [playerKey]: karma }, traders: { [traderKey]: karma } }
//
// Only people with karma (above or below zero) are listed. Players are keyed by handicapKey(memberId), the anonymous key the live scoring
// payloads already carry (handicapKeys), never by member id; the marketplace and Lost & Found are keyed by their
// opaque trader key. Pages read this once (cached for a few minutes) and put a small chip after each name they show.
import type { Env } from "./env.js";
import { handicapKey } from "./handicap.js";
import { json } from "./http.js";

export interface KarmaDirectory {
  players: Record<string, number>;
  traders: Record<string, number>;
}

/** The anonymous key a page uses to look a member up in the karma directory ("" for guests). */
export function karmaKey(memberId: string | null | undefined): string {
  const id = String(memberId || "");
  return id.startsWith("mg_") ? "" : handicapKey(id);
}

/**
 * +1 karma for every round a member finished in the app (the owner's rule: every member on the card, every finished
 * round of any length, past rounds included, no daily limit). Counted from what's already stored, so nothing is
 * double-counted and nothing needs backfilling:
 *   - casual rounds: a member's result in a finalized round, finished (a place; a player who left mid-round has none);
 *   - club events scored live in the app, finalized, finished. Event results are written only by live finalize and by
 *     imports (the UDisc league import, source 'udisc'; the Ryder Cup sheet backfill, 'ryder-import'), so every other
 *     source (a hand-made event, or one created from the DGS / CSV event import and then scored live) counts;
 *   - offline rounds a member finished and synced (one per round, to its owner).
 * `members` (optional) limits it to those member ids (bound as ?s, in order: casual, events, offline).
 */
/** Event sources whose results were imported, not scored in the app (see roundKarmaSql). */
export const IMPORTED_RESULT_SOURCES = "('udisc', 'ryder-import')";

export function roundKarmaSql(members: number | null = null): string {
  const only = (column: string) => (members ? ` AND ${column} IN (${Array.from({ length: members }, () => "?").join(",")})` : "");
  return `SELECT member_id AS person_id, COUNT(*) AS karma FROM (
      SELECT cr.member_id FROM casual_results cr WHERE substr(cr.member_id, 1, 2) = 'm_' AND cr.place IS NOT NULL${only("cr.member_id")}
      UNION ALL
      SELECT r.member_id FROM results r JOIN events e ON e.id = r.event_id
        WHERE e.source NOT IN ${IMPORTED_RESULT_SOURCES} AND e.status = 'final' AND substr(r.member_id, 1, 2) = 'm_' AND r.place IS NOT NULL${only("r.member_id")}
      UNION ALL
      SELECT o.owner_id AS member_id FROM offline_rounds o WHERE o.owner_kind = 'member'${only("o.owner_id")}
    ) GROUP BY member_id`;
}

/** Admin karma changes (karma-watch.ts: round karma taken back, and the 3x penalty), per member. */
export function adjustmentKarmaSql(members: number | null = null): string {
  const only = members ? ` WHERE member_id IN (${Array.from({ length: members }, () => "?").join(",")})` : "";
  return `SELECT member_id AS person_id, SUM(delta) AS karma FROM karma_adjustments${only} GROUP BY member_id`;
}

export async function karmaDirectory(env: Env): Promise<KarmaDirectory> {
  const [ledger, donations, rounds, adjustments] = await Promise.all([
    env.DB.prepare("SELECT person_id, SUM(delta) AS karma FROM lf_karma GROUP BY person_id").all<{ person_id: string; karma: number }>(),
    env.DB.prepare("SELECT seller_id AS person_id, SUM(karma) AS karma FROM market_donations WHERE status = 'confirmed' GROUP BY seller_id")
      .all<{ person_id: string; karma: number }>(),
    env.DB.prepare(roundKarmaSql()).all<{ person_id: string; karma: number }>(),
    env.DB.prepare(adjustmentKarmaSql()).all<{ person_id: string; karma: number }>(),
  ]);
  const totals = new Map<string, number>();
  for (const row of [...(ledger.results ?? []), ...(donations.results ?? []), ...(rounds.results ?? []), ...(adjustments.results ?? [])]) {
    totals.set(row.person_id, (totals.get(row.person_id) ?? 0) + (Number(row.karma) || 0));
  }
  const owners = [...totals].filter(([, karma]) => karma !== 0);
  const players: Record<string, number> = {};
  for (const [owner, karma] of owners) {
    const key = karmaKey(owner);
    if (key) players[key] = karma;
  }
  const traders: Record<string, number> = {};
  for (let i = 0; i < owners.length; i += 50) {
    const chunk = owners.slice(i, i + 50);
    const rows = (await env.DB.prepare(`SELECT owner_id, trader_key FROM market_traders WHERE owner_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk.map(([owner]) => owner)).all<{ owner_id: string; trader_key: string }>()).results ?? [];
    const karmaOf = new Map(chunk);
    for (const row of rows) traders[row.trader_key] = karmaOf.get(row.owner_id) ?? 0;
  }
  return { players, traders };
}

const CACHE_SECONDS = 300;

/** The directory, built at most every few minutes (it reads whole tables, and D1 reads are metered on the Free plan). */
export async function handleKarma(env: Env, origin: string | null, request?: Request): Promise<Response> {
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
  const key = request ? new Request(new URL("/karma", request.url).toString(), { method: "GET" }) : null;
  let body: string | null = null;
  if (cache && key) {
    try { body = (await (await cache.match(key))?.text()) ?? null; } catch { body = null; }
  }
  if (body == null) {
    body = JSON.stringify(await karmaDirectory(env));
    if (cache && key) {
      const stored = new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` } });
      try { await cache.put(key, stored); } catch { /* the next request builds it again */ }
    }
  }
  return json(JSON.parse(body), 200, origin, { "Cache-Control": `public, max-age=${CACHE_SECONDS}` });
}
