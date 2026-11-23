// GET /pdga-stats: a member's official PDGA rating (official REST API) enriched with per-round ratings,
// live rating estimate, recent PDGA events, and throw/putting stats from the official PDGA Live API
// (pdga-live-api.ts). All PDGA responses are cached temporarily and purged hourly (License Section 6).

import type { D1Like } from "./db-types.js";
import type { Env } from "./env.js";
import { clientIp, json } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { emptyPlayTotals, sumPlayTotals, type PlayTotals } from "./play-stats.js";
import { cachedPdgaPlayers, lookupPdgaPlayer, normalPdgaNumber, pdgaApiConfigured, type PdgaApiEnv, type PdgaPlayer } from "./pdga-api.js";
import {
  applyPdgaLiveStatsToTotals,
  fetchPdgaLiveEvent,
  fetchPdgaLivePlayer,
  fetchPdgaLiveScoreStats,
  playTotalsFromLivePlayerRound,
  type PdgaLiveApiEnv,
} from "./pdga-live-api.js";

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
  previous_rating: number | null;
  previous_rating_date: string | null;
  live_rating: number | null;
  peak_rating: number | null;
  events_count: number;
  events: PdgaEvent[];
  play?: PlayTotals;
  play_rounds?: PdgaPlayRound[];
  live_stats?: { ob_count: number; ob_holes: number } | null;
  stats_version?: number;
  /** Official PDGA REST API + documented PDGA Live API. */
  source?: "pdga-api";
}

export const PDGA_STATS_VERSION = 5;
const RECENT_RATED_ROUNDS = 8;
const MAX_PLAYER_EVENTS = 6;
const MAX_SCORE_STATS_ROUNDS = 6;
const STAGING_QA_PDGA = "90000001";
const STAGING_QA_PLAY: PlayTotals = {
  ...emptyPlayTotals(),
  holes: 54,
  eagles: 1,
  birdies: 12,
  pars: 28,
  bogeys: 11,
  doubles_plus: 2,
  birdie_hit: 12,
  par_hit: 28,
  fir_hit: 34,
  fir_att: 48,
  c1r_hit: 18,
  c1r_att: 54,
  c2r_hit: 28,
  c2r_att: 54,
  c1x_putt_hit: 19,
  c1x_putt_att: 22,
};

/** Build baseline stats directly from the official REST API player record. */
export function statsFromPlayer(pdga: string, player: PdgaPlayer | null): PdgaStats {
  return {
    pdga,
    name: player?.name ?? null,
    official_rating: player?.rating ?? null,
    rating_date: player?.ratingDate ?? null,
    previous_rating: null,
    previous_rating_date: null,
    live_rating: null,
    peak_rating: null,
    events_count: 0,
    events: [],
    play: emptyPlayTotals(),
    play_rounds: [],
    live_stats: null,
    stats_version: PDGA_STATS_VERSION,
    source: "pdga-api",
  };
}

/** The live QA drive's dashboard member: fixed numbers, zero PDGA network calls. */
function qaStats(pdga: string): PdgaStats | null {
  if (pdga !== STAGING_QA_PDGA) return null;
  return {
    ...statsFromPlayer(pdga, null),
    name: "GVDG QA Dashboard",
    official_rating: 935,
    rating_date: "2026-07-01",
    live_rating: 941,
    peak_rating: 958,
    events_count: 3,
    events: [
      { tournament: "GVDG QA Monthly", date: "2026-06-20", epoch: 1781913600, division: "MA1", eventId: "900001", rounds: [{ rating: 958, score: 54, round: "1" }] },
      { tournament: "GVDG QA League", date: "2026-05-12", epoch: 1778544000, division: "MA1", eventId: "900002", rounds: [{ rating: 941, score: 56, round: "1" }] },
      { tournament: "GVDG QA Flex", date: "2026-04-18", epoch: 1776470400, division: "MA1", eventId: "900003", rounds: [{ rating: 924, score: 58, round: "1" }] },
    ],
    play: STAGING_QA_PLAY,
    play_rounds: [
      { tournament: "GVDG QA Monthly", date: "2026-06-20", division: "MA1", round: "1", breakdown: STAGING_QA_PLAY, group_format: "singles", scoring_style: "stroke" },
    ],
  };
}

interface MatchedLinkRow {
  event_id: number;
  result_id: number;
  division: string;
  event_start: string;
  event_end: string;
  watch_name: string | null;
  watch_completed: number | null;
}

function isMissingTable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /no such table|does not exist/i.test(msg);
}

function isoToEpoch(isoDay: string): number {
  const ms = Date.parse(`${isoDay}T12:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

async function loadMatchedEventLinks(db: D1Like, pdga: string, now: number): Promise<MatchedLinkRow[]> {
  if (!db || typeof db.prepare !== "function") return [];
  try {
    const stmt = db.prepare(
      `SELECT l.event_id, l.result_id, l.division, l.event_start, l.event_end,
              e.name AS watch_name, e.completed AS watch_completed
         FROM pdga_member_event_links l
         LEFT JOIN pdga_watch_events e ON e.event_id = l.event_id AND e.expires_at > ?
        WHERE l.pdga_number = ? AND l.result_id > 0 AND l.expires_at > ?
        ORDER BY l.event_start DESC, l.event_id DESC
        LIMIT ?`,
    ).bind(now, pdga, now, MAX_PLAYER_EVENTS);
    if (!stmt || typeof stmt.all !== "function") return [];
    return (await stmt.all<MatchedLinkRow>()).results ?? [];
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

async function allLiveCacheFresh(db: D1Like, keys: readonly string[], now: number): Promise<boolean> {
  if (!keys.length) return true;
  if (!db || typeof db.prepare !== "function") return false;
  try {
    const placeholders = keys.map(() => "?").join(", ");
    const stmt = db.prepare(
      `SELECT cache_key FROM pdga_live_cache WHERE cache_key IN (${placeholders}) AND expires_at > ?`,
    ).bind(...keys, now);
    if (!stmt || typeof stmt.all !== "function") return false;
    const rows = (await stmt.all<{ cache_key: string }>()).results ?? [];
    return rows.length === keys.length;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

async function enrichFromLiveApi(env: Env, baseStats: PdgaStats, links: readonly MatchedLinkRow[], now: number): Promise<PdgaStats> {
  if (!links.length) return baseStats;
  const liveEnv = env as unknown as PdgaLiveApiEnv;
  const today = new Date(now).toISOString().slice(0, 10);

  const events: PdgaEvent[] = [];
  const playRounds: PdgaPlayRound[] = [];
  const ratedDescending: number[] = [];
  const pendingStatFetches: { playRound: PdgaPlayRound; scoreId: number; completed: boolean }[] = [];

  for (const link of links) {
    const isCompleted = Number(link.watch_completed) === 1 || (Boolean(link.event_end) && link.event_end < today);
    const playerRes = await fetchPdgaLivePlayer(liveEnv, Number(link.result_id), now, isCompleted).catch(() => null);
    if (!playerRes || !playerRes.scores.length) continue;

    let tournamentName = link.watch_name;
    let eventDate = link.event_start || playerRes.scores[0]?.roundDate || "";
    if (!tournamentName) {
      const eventMeta = await fetchPdgaLiveEvent(liveEnv, Number(link.event_id), now, isCompleted).catch(() => null);
      if (eventMeta) {
        tournamentName = eventMeta.name;
        if (!eventDate) eventDate = eventMeta.startDate;
      }
    }
    const resolvedName = tournamentName || `PDGA Event #${link.event_id}`;
    const division = playerRes.division || link.division;
    const epoch = isoToEpoch(eventDate || link.event_end || today);

    // Order rounds highest-first when computing recent form / peak ratings, and chronological for card display.
    const sortedScores = [...playerRes.scores].sort((a, b) => a.round - b.round);
    const eventRounds: PdgaRound[] = [];
    for (const s of [...sortedScores].reverse()) {
      if (!s.dnf && s.roundRating != null && s.round !== 13) ratedDescending.push(s.roundRating);
    }

    for (const s of sortedScores) {
      if (!s.dnf && s.round !== 13 && s.roundRating != null) {
        eventRounds.push({ rating: s.roundRating, score: s.roundScore, round: String(s.round) });
      }
      if (s.dnf) continue;
      const breakdown = playTotalsFromLivePlayerRound(s);
      if (breakdown.holes > 0) {
        const playRound: PdgaPlayRound = {
          tournament: resolvedName,
          date: s.roundDate || eventDate,
          division,
          round: String(s.round),
          breakdown,
          group_format: "singles",
          scoring_style: "stroke",
        };
        playRounds.push(playRound);
        if (s.round !== 13 && s.scoreId != null && s.scoreId > 0 && pendingStatFetches.length < MAX_SCORE_STATS_ROUNDS) {
          pendingStatFetches.push({
            playRound,
            scoreId: s.scoreId,
            completed: isCompleted || s.roundComplete,
          });
        }
      }
    }

    if (eventRounds.length) {
      events.push({
        tournament: resolvedName,
        date: eventDate,
        epoch,
        division,
        eventId: String(link.event_id),
        rounds: eventRounds,
      });
    }
  }

  let obCount = 0;
  let obHoles = 0;
  for (const task of pendingStatFetches) {
    const statItems = await fetchPdgaLiveScoreStats(liveEnv, task.scoreId, now, task.completed).catch(() => null);
    if (!statItems?.length) continue;
    const ob = applyPdgaLiveStatsToTotals(task.playRound.breakdown, statItems);
    obCount += ob.obCount;
    obHoles += ob.obHoles;
  }

  const recentRated = ratedDescending.slice(0, RECENT_RATED_ROUNDS);
  const liveRating = recentRated.length
    ? Math.round(recentRated.reduce((sum, r) => sum + r, 0) / recentRated.length)
    : null;
  const peakRating = ratedDescending.length ? Math.max(...ratedDescending) : null;
  const play = playRounds.length ? sumPlayTotals(playRounds) : baseStats.play;

  return {
    ...baseStats,
    live_rating: liveRating,
    peak_rating: peakRating,
    events_count: events.length,
    events,
    play,
    play_rounds: playRounds,
    live_stats: obHoles > 0 ? { ob_count: obCount, ob_holes: obHoles } : null,
  };
}

/** GET /pdga-stats?pdga=<digits>: official rating + Live API round ratings & stats (temporary cache, IP-rate-limited). */
export async function handlePdgaStats(request: Request, env: Env, origin: string | null): Promise<Response> {
  const raw = (new URL(request.url).searchParams.get("pdga") ?? "").trim();
  const headers = { "Cache-Control": "private, max-age=300" };
  const qa = qaStats(raw);
  if (qa) return json(qa, 200, origin, headers);
  const pdga = normalPdgaNumber(raw);
  if (!pdga) return json({ error: "invalid_pdga" }, 400, origin);

  const now = Date.now();
  const db = env.DB as unknown as D1Like;
  const apiEnv = env as unknown as PdgaApiEnv;
  const links = await loadMatchedEventLinks(db, pdga, now).catch(() => []);
  const expectedLiveKeys = links.flatMap((link) => (
    link.watch_name ? [`player:${link.result_id}`] : [`player:${link.result_id}`, `event:${link.event_id}`]
  ));
  const liveCached = await allLiveCacheFresh(db, expectedLiveKeys, now).catch(() => false);

  if (!pdgaApiConfigured(apiEnv)) {
    const base = statsFromPlayer(pdga, null);
    if (!liveCached && links.length && await kvRateLimited(env, "pdga:" + clientIp(request), 30, 60)) {
      return json({ error: "rate_limited" }, 429, origin);
    }
    const enriched = await enrichFromLiveApi(env, base, links, now).catch(() => base);
    return json(enriched, 200, origin, { "Cache-Control": "no-store" });
  }

  // Fresh cached records are free; only uncached external fetches count toward the per-IP rate limit.
  const cached = await cachedPdgaPlayers(apiEnv, [pdga], now).catch(() => new Map<string, PdgaPlayer | null>());
  if (cached.has(pdga) && liveCached) {
    const base = statsFromPlayer(pdga, cached.get(pdga) ?? null);
    const enriched = await enrichFromLiveApi(env, base, links, now).catch(() => base);
    return json(enriched, 200, origin, headers);
  }

  if (await kvRateLimited(env, "pdga:" + clientIp(request), 30, 60)) return json({ error: "rate_limited" }, 429, origin);

  let base: PdgaStats;
  try {
    const player = cached.has(pdga) ? cached.get(pdga) ?? null : await lookupPdgaPlayer(apiEnv, pdga);
    base = statsFromPlayer(pdga, player);
  } catch (error) {
    console.warn(JSON.stringify({ message: "pdga_stats_api_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "pdga_unavailable" }, 503, origin);
  }

  const enriched = await enrichFromLiveApi(env, base, links, now).catch((error) => {
    console.warn(JSON.stringify({ message: "pdga_live_stats_enrich_failed", error: error instanceof Error ? error.message : String(error) }));
    return base;
  });
  return json(enriched, 200, origin, headers);
}
