// Karma next to every player's name, across the app and the public site. Karma is the Lost & Found ledger (+10 for a
// disc returned) plus confirmed club donations from marketplace sales (+1 a dollar): the same total as karmaOf.
//
//   GET /karma (public) -> { players: { [playerKey]: karma }, traders: { [traderKey]: karma } }
//
// Only people with karma are listed. Players are keyed by handicapKey(memberId), the anonymous key the live scoring
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

export async function karmaDirectory(env: Env): Promise<KarmaDirectory> {
  const [ledger, donations] = await Promise.all([
    env.DB.prepare("SELECT person_id, SUM(delta) AS karma FROM lf_karma GROUP BY person_id").all<{ person_id: string; karma: number }>(),
    env.DB.prepare("SELECT seller_id AS person_id, SUM(karma) AS karma FROM market_donations WHERE status = 'confirmed' GROUP BY seller_id")
      .all<{ person_id: string; karma: number }>(),
  ]);
  const totals = new Map<string, number>();
  for (const row of [...(ledger.results ?? []), ...(donations.results ?? [])]) {
    totals.set(row.person_id, (totals.get(row.person_id) ?? 0) + (Number(row.karma) || 0));
  }
  const owners = [...totals].filter(([, karma]) => karma > 0);
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

export async function handleKarma(env: Env, origin: string | null): Promise<Response> {
  return json(await karmaDirectory(env), 200, origin, { "Cache-Control": "public, max-age=300" });
}
