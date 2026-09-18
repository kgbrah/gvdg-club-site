// Best-effort scraper for pdga.com player ratings (read-only, public data) — the live source behind
// the member dashboard's rating/stats panel. Player pages provide identity and event discovery:
//   /player/<n>          -> name + current OFFICIAL rating
//   /player/<n>/details  -> per-round ratings (grouped into events; used for live/peak/recent form)
//   /tour/event/<id>     -> newly reported rounds that have not reached rating details yet
// HTML parsing is regex-based and defensive: any field that doesn't match becomes null/empty rather
// than throwing. Results are cached in D1 (handlePdgaStats) to bound requests to pdga.com.

import type { Env } from "./env.js";
import { clientIp, json } from "./http.js";
import { readD1OrFallback } from "./d1-retry.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { emptyPlayTotals, sumPlayTotals, totalsFromPdgaScoreLine, type PlayTotals } from "./play-stats.js";

export interface PdgaRound { rating: number; score: number | null; round: string }
export interface PdgaPlayRound {
  tournament: string;
  date: string;
  division: string;
  round: string;
  breakdown: PlayTotals;
  group_format: "singles" | "doubles";
  scoring_style: "stroke" | "matchplay";
}
export interface PdgaEvent { tournament: string; date: string; epoch: number; division: string; eventId?: string | null; rounds: PdgaRound[] }
export interface PdgaStats {
  pdga: string;
  name: string | null;
  official_rating: number | null;
  rating_date: string | null;
  live_rating: number | null;
  peak_rating: number | null;
  events_count: number;
  events: PdgaEvent[];
  play?: PlayTotals;
  play_rounds?: PdgaPlayRound[];
  stats_version?: number;
}

const UA = "Mozilla/5.0 (compatible; GVDGClubBot/1.0; +https://gvdgclub.com)";
const CACHE_TTL_MS = 15 * 60 * 1000;
const PDGA_STATS_VERSION = 2;
const RECENT_ROUNDS = 8; // "live" rating = mean of the most recent N round ratings (recent-form estimate)
const MAX_HOLE_ROUNDS = 80; // newest-first hole mix; keeps worker subrequests bounded
const STAGING_QA_PDGA = "90000001";
const STAGING_QA_PLAY = {
  holes: 54,
  eagles: 1,
  birdies: 12,
  pars: 28,
  bogeys: 11,
  doubles_plus: 2,
  birdie_hit: 13,
  par_hit: 41,
  fir_hit: 0,
  fir_att: 0,
  c1r_hit: 0,
  c1r_att: 0,
  c2r_hit: 0,
  c2r_att: 0,
  parked_hit: 0,
  parked_att: 0,
  scramble_hit: 0,
  scramble_att: 0,
  c1_putt_hit: 0,
  c1_putt_att: 0,
  c2_putt_hit: 0,
  c2_putt_att: 0,
} satisfies PlayTotals;
const STAGING_QA_STATS: PdgaStats = {
  pdga: STAGING_QA_PDGA,
  name: "GVDG QA Dashboard",
  official_rating: 935,
  rating_date: "2026-07-01",
  live_rating: 941,
  peak_rating: 958,
  events_count: 3,
  events: [
    { tournament: "GVDG QA Monthly", date: "2026-06-20", epoch: 1781913600, division: "MA1", rounds: [{ rating: 958, score: 54, round: "1" }] },
    { tournament: "GVDG QA League", date: "2026-05-12", epoch: 1778544000, division: "MA1", rounds: [{ rating: 941, score: 56, round: "1" }] },
    { tournament: "GVDG QA Flex", date: "2026-04-18", epoch: 1776470400, division: "MA1", rounds: [{ rating: 924, score: 58, round: "1" }] },
  ],
  play: STAGING_QA_PLAY,
  play_rounds: [
    { tournament: "GVDG QA Monthly", date: "2026-06-20", division: "MA1", round: "1", breakdown: STAGING_QA_PLAY, group_format: "singles", scoring_style: "stroke" },
  ],
  stats_version: PDGA_STATS_VERSION,
};

function cap(re: RegExp, s: string): string | null {
  return re.exec(s)?.[1] ?? null;
}

/** Parse name + current official rating from a /player/<n> page. */
export function parsePlayerPage(html: string): { name: string | null; official_rating: number | null; rating_date: string | null } {
  const ratingStr = cap(/class="current-rating">\s*<strong>Current Rating:<\/strong>\s*(\d+)/i, html);
  const rawName = cap(/id="page-title"[^>]*>([^<]+)</i, html) ?? cap(/<title>([^|<]+?)\s*#\d+/i, html) ?? "";
  const name = rawName.replace(/\s*#\d+.*$/, "").trim() || null;
  return {
    name,
    official_rating: ratingStr ? parseInt(ratingStr, 10) : null,
    rating_date: cap(/class="rating-date">\s*\(as of ([^)]+)\)/i, html),
  };
}

/** Parse per-round ratings from a /player/<n>/details page, grouped into events (most recent first). */
export function parseDetailRounds(html: string): PdgaEvent[] {
  const events = new Map<string, PdgaEvent>();
  for (const row of html.split(/<tr[ >]/).slice(1)) {
    const ratingStr = cap(/<td class="round-rating">\s*(\d+)\s*</i, row);
    if (!ratingStr) continue; // header rows / non-round rows have no round-rating cell
    const tournament = (cap(/<td class="tournament">(?:<a[^>]*>)?\s*([^<]+)/i, row) ?? "Event").trim();
    const eventId = cap(/href="\/tour\/event\/(\d+)/i, row);
    const date = (cap(/<td class="date"[^>]*>\s*([^<]+?)\s*</i, row) ?? "").trim();
    const epoch = parseInt(cap(/<td class="date"[^>]*data-text="(\d+)"/i, row) ?? "0", 10) || 0;
    const division = (cap(/<td class="division">\s*([^<]*?)\s*</i, row) ?? "").trim();
    const round = (cap(/<td class="round[^"]*"[^>]*>\s*([^<]+?)\s*</i, row) ?? "").trim();
    const scoreStr = cap(/<td class="score">\s*(-?\d+)/i, row);
    const key = `${tournament}|${date}|${division}`;
    const existing = events.get(key);
    const parsedRound = { rating: parseInt(ratingStr, 10), score: scoreStr ? parseInt(scoreStr, 10) : null, round };
    if (existing) {
      existing.rounds.push(parsedRound);
      if (eventId && !existing.eventId) existing.eventId = eventId;
    } else events.set(key, { tournament, date, epoch, division, eventId, rounds: [parsedRound] });
  }
  return [...events.values()]
    .map((event) => ({ ...event, rounds: newestRoundsFirst(event.rounds) }))
    .sort((a, b) => b.epoch - a.epoch);
}

type PlayerEventRef = {
  readonly id: string;
  readonly tournament: string;
  readonly date: string;
  readonly epoch: number;
  readonly division: string;
};

function recentEventRefs(playerHtml: string, detailHtml: string): PlayerEventRef[] {
  const known = new Set([...detailHtml.matchAll(/href="\/tour\/event\/(\d+)"/gi)].flatMap((match) => match[1] ? [match[1]] : []));
  const events: PlayerEventRef[] = [];
  for (const row of playerHtml.split(/<tr[ >]/).slice(1)) {
    const event = /<td class="tournament"><a href="\/tour\/event\/(\d+)#([^"]+)">([^<]+)/i.exec(row);
    const date = /<td class="dates"[^>]*data-text="(\d+)"[^>]*>\s*([^<]+?)\s*</i.exec(row);
    const id = event?.[1];
    const tournament = event?.[3]?.trim();
    const epoch = Number(date?.[1]);
    const dateText = date?.[2]?.trim();
    const division = event?.[2];
    if (id && tournament && dateText && division && Number.isFinite(epoch)) events.push({ id, tournament, date: dateText, epoch, division });
  }
  return events
    .sort((a, b) => b.epoch - a.epoch)
    .filter((event, index) => index === 0 || !known.has(event.id))
    .slice(0, RECENT_ROUNDS);
}

function parseRecentEvent(html: string, pdga: string, event: PlayerEventRef): PdgaEvent | null {
  const row = html.split(/<tr[ >]/).slice(1).find((candidate) => new RegExp(`href="/player/${pdga}"`, "i").test(candidate));
  if (!row) return null;
  const rounds: PdgaRound[] = [];
  for (const match of row.matchAll(/<td class="round"[^>]*>\s*<a[^>]*href="\/live\/event\/\d+\/[^/"]+\/scores\?round=(\d+)"[^>]*>\s*(-?\d+)\s*<\/a>\s*<\/td>\s*<td class="round-rating"[^>]*>\s*(\d+)\s*<\/td>/gi)) {
    if (match[1] && match[2] && match[3]) rounds.push({ round: match[1], score: Number(match[2]), rating: Number(match[3]) });
  }
  return rounds.length
    ? { tournament: event.tournament, date: event.date, epoch: event.epoch, division: event.division, eventId: event.id, rounds: newestRoundsFirst(rounds) }
    : null;
}

function newestRoundsFirst(rounds: readonly PdgaRound[]): PdgaRound[] {
  return [...rounds].sort((a, b) => {
    const difference = Number(b.round) - Number(a.round);
    return Number.isFinite(difference) ? difference : 0;
  });
}

function mergeEvents(refreshed: readonly PdgaEvent[], detailed: readonly PdgaEvent[]): PdgaEvent[] {
  const events = new Map(detailed.map((event) => [eventKey(event), event]));
  for (const event of refreshed) {
    const key = eventKey(event);
    const existing = events.get(key);
    if (!existing) {
      events.set(key, event);
      continue;
    }
    const rounds = new Map(existing.rounds.map((round) => [roundKey(round), round]));
    for (const round of event.rounds) rounds.set(roundKey(round), round);
    events.set(key, { ...existing, ...event, eventId: event.eventId || existing.eventId, rounds: newestRoundsFirst([...rounds.values()]) });
  }
  return [...events.values()].sort((a, b) => b.epoch - a.epoch);
}

function eventKey(event: PdgaEvent): string {
  return `${event.epoch}|${event.division}`;
}

function roundKey(round: PdgaRound): string {
  return round.round || `${round.score ?? ""}|${round.rating}`;
}

function emptyPdgaStats(pdga: string): PdgaStats {
  return { pdga, name: null, official_rating: null, rating_date: null, live_rating: null, peak_rating: null, events_count: 0, events: [], play: emptyPlayTotals(), play_rounds: [], stats_version: PDGA_STATS_VERSION };
}

function fallbackPdgaStats(pdga: string): PdgaStats | null {
  return pdga === STAGING_QA_PDGA ? STAGING_QA_STATS : null;
}

type LiveRoundTarget = { eventId: string; division: string; round: number; tournament: string; date: string };

function holeScoreTargets(events: readonly PdgaEvent[]): LiveRoundTarget[] {
  const out: LiveRoundTarget[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const eventId = String(event.eventId || "").replace(/\D/g, "");
    const division = String(event.division || "").trim();
    if (!eventId || !division) continue;
    for (const round of event.rounds) {
      const n = Number(round.round);
      if (!Number.isInteger(n) || n < 1) continue;
      const key = `${eventId}|${division}|${n}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ eventId, division, round: n, tournament: event.tournament, date: event.date });
      if (out.length >= MAX_HOLE_ROUNDS) return out;
    }
  }
  return out;
}

function parseLiveRoundPlayer(json: unknown, pdga: string): { breakdown: PlayTotals; groupFormat: "singles" | "doubles" } | null {
  const data = json && typeof json === "object" && "data" in json ? (json as { data?: unknown }).data : json;
  const scores = data && typeof data === "object" && Array.isArray((data as { scores?: unknown }).scores)
    ? (data as { scores: Record<string, unknown>[] }).scores
    : [];
  const player = scores.find((row) => String(row?.PDGANum ?? "").replace(/\D/g, "") === pdga);
  if (!player) return null;
  const holes = Number(player.Holes) || 18;
  const breakdown = totalsFromPdgaScoreLine(player.Scores, player.Pars, holes);
  if (!breakdown.holes) return null;
  const teammates = Array.isArray(player.Teammates) ? player.Teammates : [];
  const doubles = teammates.length > 0 || (player.Team != null && String(player.Team) !== "");
  return { breakdown, groupFormat: doubles ? "doubles" : "singles" };
}

async function fetchPdgaHoleRounds(
  pdga: string,
  events: readonly PdgaEvent[],
  doFetch: typeof fetch,
  headers: Record<string, string>,
): Promise<PdgaPlayRound[]> {
  const targets = holeScoreTargets(events);
  const results = await Promise.allSettled(targets.map(async (target) => {
    const url = `https://www.pdga.com/apps/tournament/live-api/live_results_fetch_round?TournID=${encodeURIComponent(target.eventId)}&Division=${encodeURIComponent(target.division)}&Round=${target.round}`;
    const response = await doFetch(url, { headers: { ...headers, accept: "application/json" } });
    if (!response.ok) return null;
    let json: unknown = null;
    try { json = await response.json(); } catch { return null; }
    const parsed = parseLiveRoundPlayer(json, pdga);
    if (!parsed) return null;
    return {
      tournament: target.tournament,
      date: target.date,
      division: target.division,
      round: String(target.round),
      breakdown: parsed.breakdown,
      group_format: parsed.groupFormat,
      scoring_style: "stroke" as const,
    };
  }));
  return results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
}

function withStatsVersion(stats: PdgaStats): PdgaStats {
  return { ...stats, stats_version: PDGA_STATS_VERSION };
}

export function isFreshPdgaCache(cached: unknown, fetchedAt: number, now = Date.now()): cached is PdgaStats {
  if (now - fetchedAt >= CACHE_TTL_MS) return false;
  if (!cached || typeof cached !== "object") return false;
  const stats = cached as PdgaStats;
  if (stats.stats_version !== PDGA_STATS_VERSION) return false;
  if (!Array.isArray(stats.play_rounds)) return false;
  if (Array.isArray(stats.events) && stats.events.length < Number(stats.events_count || 0)) return false;
  return true;
}

/** Build the full stats object for a digits-only PDGA number from its player, detail, and pending-event pages. */
export async function fetchPdgaStats(pdga: string, doFetch: typeof fetch = fetch): Promise<PdgaStats> {
  const headers = { "user-agent": UA, accept: "text/html" };
  const base = `https://www.pdga.com/player/${pdga}`;
  const [pRes, dRes] = await Promise.all([doFetch(base, { headers }), doFetch(`${base}/details`, { headers })]);
  const [playerHtml, detailHtml] = await Promise.all([pRes.ok ? pRes.text() : Promise.resolve(""), dRes.ok ? dRes.text() : Promise.resolve("")]);
  const player = parsePlayerPage(playerHtml);
  const detailEvents = parseDetailRounds(detailHtml);
  const recentResults = await Promise.allSettled(recentEventRefs(playerHtml, detailHtml).map(async (event) => {
    const response = await doFetch(`https://www.pdga.com/tour/event/${event.id}`, { headers });
    return response.ok ? parseRecentEvent(await response.text(), pdga, event) : null;
  }));
  const refreshed = recentResults.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  const events = mergeEvents(refreshed, detailEvents);
  const play_rounds = await fetchPdgaHoleRounds(pdga, events, doFetch, headers);
  const play = play_rounds.length ? sumPlayTotals(play_rounds.map((round) => ({ breakdown: round.breakdown }))) : emptyPlayTotals();

  const ratings = events.flatMap((e) => e.rounds.map((r) => r.rating));
  const recent = ratings.slice(0, RECENT_ROUNDS);
  const live_rating = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null;
  const peak_rating = ratings.length ? ratings.reduce((m, r) => Math.max(m, r), 0) : null;

  return withStatsVersion({
    pdga,
    name: player.name,
    official_rating: player.official_rating,
    rating_date: player.rating_date,
    live_rating,
    peak_rating,
    events_count: events.length,
    events,
    play,
    play_rounds,
  });
}

/** GET /pdga-stats?pdga=<digits> — D1-cached (15m), IP-rate-limited, public read of pdga.com ratings. */
export async function handlePdgaStats(request: Request, env: Env, origin: string | null): Promise<Response> {
  const pdga = (new URL(request.url).searchParams.get("pdga") ?? "").replace(/\D/g, "");
  if (!pdga || pdga.length > 8) return json({ error: "invalid_pdga" }, 400, origin);

  // The endpoint makes outbound pdga.com requests on user input, so rate-limit per IP (cache covers repeats).
  if (await kvRateLimited(env, "pdga:" + clientIp(request), 30, 60)) return json({ error: "rate_limited" }, 429, origin);

  const now = Date.now();
  const headers = { "Cache-Control": "public, max-age=300" };
  try {
    const row = await readD1OrFallback(
      () => env.DB.prepare("SELECT data, fetched_at FROM pdga_cache WHERE pdga = ?1").bind(pdga).first<{ data: string; fetched_at: number }>(),
      () => null,
    );
    if (row) {
      const cached = JSON.parse(row.data);
      if (isFreshPdgaCache(cached, Number(row.fetched_at), now)) {
        return json(cached, 200, origin, headers);
      }
    }
  } catch (error) {
    console.warn(JSON.stringify({ message: "pdga_cache_read_failed", error: error instanceof Error ? error.message : String(error) }));
  }

  let stats: PdgaStats;
  try {
    stats = fallbackPdgaStats(pdga) ?? await fetchPdgaStats(pdga);
  } catch {
    stats = fallbackPdgaStats(pdga) ?? emptyPdgaStats(pdga);
  }
  stats = withStatsVersion(stats);
  // Only cache a useful result, so a transient pdga.com outage isn't pinned for the full TTL.
  if (stats.official_rating != null || stats.events.length) {
    try {
      await env.DB.prepare(
        "INSERT INTO pdga_cache (pdga, data, fetched_at) VALUES (?1, ?2, ?3) " +
          "ON CONFLICT(pdga) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at",
      ).bind(pdga, JSON.stringify(stats), now).run();
    } catch (error) {
      console.warn(JSON.stringify({ message: "pdga_cache_write_failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return json(stats, 200, origin, headers);
}
