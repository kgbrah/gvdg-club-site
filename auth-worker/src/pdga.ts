// GET /pdga-stats: a member's official PDGA rating (official REST API) enriched with per-round ratings,
// live rating estimate, recent PDGA events, and throw/putting stats from the official PDGA Live API
// (pdga-live-api.ts). All PDGA responses are cached temporarily and purged hourly (License Section 6).

import { requireAuth } from "./authz.js";
import type { D1Like } from "./db-types.js";
import type { Env } from "./env.js";
import { clientIp, json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { emptyPlayTotals, sumPlayTotals, type PlayTotals } from "./play-stats.js";
import {
  cachedPdgaPlayers,
  cachedPdgaPlayerStats,
  lookupPdgaPlayer,
  lookupPdgaPlayers,
  lookupPdgaPlayerStats,
  normalPdgaNumber,
  PDGA_ATTRIBUTION,
  pdgaApiConfigured,
  PdgaApiError,
  pdgaPlayerStatsUrl,
  type PdgaAnnualStat,
  type PdgaApiEnv,
  type PdgaPlayer,
} from "./pdga-api.js";
import {
  applyPdgaLiveStatsToTotals,
  fetchPdgaLiveDivisions,
  fetchPdgaLiveEvent,
  fetchPdgaLivePlayer,
  fetchPdgaLiveScoreStats,
  PdgaLiveApiError,
  playTotalsFromLivePlayerRound,
  type PdgaLiveApiEnv,
  type PdgaLiveStatItem,
} from "./pdga-live-api.js";

export interface PdgaRoundStatRatio { hit: number; opp: number }
export interface PdgaRoundThrowStats {
  fwh?: PdgaRoundStatRatio;
  c1r?: PdgaRoundStatRatio;
  c2r?: PdgaRoundStatRatio;
  parked?: PdgaRoundStatRatio;
  scramble?: PdgaRoundStatRatio;
  c1p?: PdgaRoundStatRatio;
  c1x?: PdgaRoundStatRatio;
  c2p?: PdgaRoundStatRatio;
  ob?: { count: number; holes: number };
}
export interface PdgaRound {
  rating: number | null;
  score: number | null;
  round: string;
  to_par?: number | null;
  date?: string | null;
  complete?: boolean;
  holes?: number;
  aces?: number;
  eagles?: number;
  birdies?: number;
  pars?: number;
  bogeys?: number;
  doubles_plus?: number;
  stats?: PdgaRoundThrowStats | null;
}
export interface PdgaPlayRound {
  tournament: string;
  date: string;
  division: string;
  round: string;
  breakdown: PlayTotals;
  group_format: "singles" | "doubles";
  scoring_style: "stroke" | "matchplay";
}
export interface PdgaEvent {
  tournament: string;
  date: string;
  epoch: number;
  division: string;
  eventId?: string | null;
  place?: number | null;
  total?: number | null;
  to_par?: number | null;
  average_rating?: number | null;
  dnf?: boolean;
  live_url?: string | null;
  rounds: PdgaRound[];
}
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
  annual_stats?: PdgaAnnualStat[];
  play?: PlayTotals;
  play_rounds?: PdgaPlayRound[];
  live_stats?: { ob_count: number; ob_holes: number } | null;
  stats_version?: number;
  /** Official PDGA REST API + documented PDGA Live API. */
  source?: "pdga-api";
}

export const PDGA_STATS_VERSION = 7;
const RECENT_RATED_ROUNDS = 8;
const MAX_PLAYER_EVENTS = 12;
const MAX_SCORE_STATS_ROUNDS = 10;
const ANNUAL_STATS_YEARS = 3;
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
    annual_stats: [],
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
    annual_stats: [
      {
        year: 2026,
        divisionCode: "MA1",
        divisionName: "Mixed Amateur 1",
        classification: "A",
        rating: 935,
        events: 8,
        rounds: 16,
        points: 412,
        prize: 240,
        playersDefeated: 185,
        wins: 2,
        url: pdgaPlayerStatsUrl(pdga, 2026),
      },
      {
        year: 2025,
        divisionCode: "MA1",
        divisionName: "Mixed Amateur 1",
        classification: "A",
        rating: 924,
        events: 11,
        rounds: 22,
        points: 530,
        prize: 190,
        playersDefeated: 210,
        wins: 1,
        url: pdgaPlayerStatsUrl(pdga, 2025),
      },
    ],
    events: [
      {
        tournament: "GVDG QA Monthly",
        date: "2026-06-20",
        epoch: 1781913600,
        division: "MA1",
        eventId: "900001",
        place: 2,
        total: 108,
        to_par: -6,
        average_rating: 950,
        dnf: false,
        live_url: "https://www.pdga.com/live/event/900001/MA1/scores",
        rounds: [{
          rating: 958,
          score: 54,
          round: "1",
          to_par: -3,
          date: "2026-06-20",
          complete: true,
          holes: 18,
          birdies: 6,
          pars: 9,
          bogeys: 3,
          stats: {
            fwh: { hit: 14, opp: 18 },
            c1r: { hit: 8, opp: 18 },
            c1x: { hit: 9, opp: 10 },
          },
        }],
      },
      {
        tournament: "GVDG QA League",
        date: "2026-05-12",
        epoch: 1778544000,
        division: "MA1",
        eventId: "900002",
        place: 4,
        total: 56,
        to_par: -1,
        average_rating: 941,
        dnf: false,
        live_url: "https://www.pdga.com/live/event/900002/MA1/scores",
        rounds: [{ rating: 941, score: 56, round: "1", to_par: -1, date: "2026-05-12", complete: true }],
      },
      {
        tournament: "GVDG QA Flex",
        date: "2026-04-18",
        epoch: 1776470400,
        division: "MA1",
        eventId: "900003",
        place: 7,
        total: 58,
        to_par: 1,
        average_rating: 924,
        dnf: false,
        live_url: "https://www.pdga.com/live/event/900003/MA1/scores",
        rounds: [{ rating: 924, score: 58, round: "1", to_par: 1, date: "2026-04-18", complete: true }],
      },
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

const ROUND_STAT_KEY_MAP: Record<number, keyof Omit<PdgaRoundThrowStats, "ob">> = {
  1: "fwh",
  2: "c1r",
  3: "c2r",
  4: "parked",
  5: "scramble",
  6: "c1p",
  7: "c1x",
  8: "c2p",
};

function roundThrowStats(
  statsList: readonly PdgaLiveStatItem[] | null | undefined,
  ob: { obCount: number; obHoles: number },
): PdgaRoundThrowStats | null {
  const out: PdgaRoundThrowStats = {};
  let has = false;
  for (const item of statsList ?? []) {
    if (!item || !Number.isFinite(item.statOpportunityCount) || item.statOpportunityCount <= 0) continue;
    if (item.statCount == null || !Number.isFinite(item.statCount) || item.statCount < 0) continue;
    const key = ROUND_STAT_KEY_MAP[item.statId];
    if (!key) continue;
    out[key] = { hit: item.statCount, opp: item.statOpportunityCount };
    has = true;
  }
  if (ob.obHoles > 0) {
    out.ob = { count: ob.obCount, holes: ob.obHoles };
    has = true;
  }
  return has ? out : null;
}

function recentStatsYears(now: number): number[] {
  let yr = new Date(now).getUTCFullYear();
  try {
    const parsed = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date(now)));
    if (Number.isInteger(parsed) && parsed >= 1975 && parsed <= 2100) yr = parsed;
  } catch { /* UTC year fallback */ }
  return Array.from({ length: ANNUAL_STATS_YEARS }, (_, i) => yr - i);
}

async function enrichFromLiveApi(env: Env, baseStats: PdgaStats, links: readonly MatchedLinkRow[], now: number): Promise<PdgaStats> {
  if (!links.length) return baseStats;
  const liveEnv = env as unknown as PdgaLiveApiEnv;
  const today = new Date(now).toISOString().slice(0, 10);

  const events: PdgaEvent[] = [];
  const playRounds: PdgaPlayRound[] = [];
  const ratedDescending: number[] = [];
  const pendingStatFetches: { playRound: PdgaPlayRound; eventRound: PdgaRound | null; scoreId: number; completed: boolean }[] = [];

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
      if (s.dnf) continue;
      const breakdown = playTotalsFromLivePlayerRound(s);
      let eventRound: PdgaRound | null = null;
      if (s.round !== 13 && (s.roundRating != null || s.roundScore != null || breakdown.holes > 0)) {
        eventRound = {
          rating: s.roundRating,
          score: s.roundScore,
          round: String(s.round),
          to_par: s.roundToPar,
          date: s.roundDate,
          complete: s.roundComplete,
          ...(breakdown.holes > 0 ? {
            holes: breakdown.holes,
            aces: breakdown.aces,
            eagles: breakdown.eagles,
            birdies: breakdown.birdies,
            pars: breakdown.pars,
            bogeys: breakdown.bogeys,
            doubles_plus: breakdown.doubles_plus,
          } : {}),
          stats: null,
        };
        eventRounds.push(eventRound);
      }
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
            eventRound,
            scoreId: s.scoreId,
            completed: isCompleted || s.roundComplete,
          });
        }
      } else if (eventRound && s.round !== 13 && s.scoreId != null && s.scoreId > 0 && pendingStatFetches.length < MAX_SCORE_STATS_ROUNDS) {
        pendingStatFetches.push({
          playRound: {
            tournament: resolvedName,
            date: s.roundDate || eventDate,
            division,
            round: String(s.round),
            breakdown,
            group_format: "singles",
            scoring_style: "stroke",
          },
          eventRound,
          scoreId: s.scoreId,
          completed: isCompleted || s.roundComplete,
        });
      }
    }

    if (eventRounds.length) {
      const liveUrl = division
        ? `https://www.pdga.com/live/event/${encodeURIComponent(String(link.event_id))}/${encodeURIComponent(division)}/scores`
        : `https://www.pdga.com/live/event/${encodeURIComponent(String(link.event_id))}`;
      events.push({
        tournament: resolvedName,
        date: eventDate,
        epoch,
        division,
        eventId: String(link.event_id),
        place: playerRes.place ?? playerRes.runningPlace,
        total: playerRes.total,
        to_par: playerRes.toPar,
        average_rating: playerRes.averageRoundRating,
        dnf: playerRes.dnf,
        live_url: liveUrl,
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
    if (task.eventRound) task.eventRound.stats = roundThrowStats(statItems, ob);
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

/** GET /pdga-stats?pdga=<digits>[&fresh=1]: official rating + annual stats + Live API round ratings & stats (temporary cache, IP-rate-limited). */
export async function handlePdgaStats(request: Request, env: Env, origin: string | null): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const raw = (params.get("pdga") ?? "").trim();
  const fresh = params.get("fresh") === "1";
  const headers = { "Cache-Control": fresh ? "private, no-store" : "private, max-age=300" };
  const qa = qaStats(raw);
  if (qa) return json(qa, 200, origin, headers);
  const pdga = normalPdgaNumber(raw);
  if (!pdga) return json({ error: "invalid_pdga" }, 400, origin);

  if (fresh) {
    const claims = await requireAuth(request, env);
    if (!claims) return json({ error: "unauthorized" }, 401, origin);
    if (await kvRateLimited(env, "pdga-fresh:" + claims.sub, 6, 3600)) return json({ error: "rate_limited" }, 429, origin);
  }

  const now = Date.now();
  const db = env.DB as unknown as D1Like;
  const apiEnv = env as unknown as PdgaApiEnv;
  const targetYears = recentStatsYears(now);
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

  // Policy A: default loads check the temporary 6h D1 cache first; fresh=1 re-queries official PDGA endpoints on demand.
  const cached = fresh ? new Map<string, PdgaPlayer | null>() : await cachedPdgaPlayers(apiEnv, [pdga], now).catch(() => new Map<string, PdgaPlayer | null>());
  const cachedPlayer = cached.has(pdga) ? (cached.get(pdga) ?? null) : undefined;
  const cachedAnnual = !fresh && cachedPlayer !== undefined && cachedPlayer != null
    ? await cachedPdgaPlayerStats(apiEnv, pdga, targetYears, now).catch(() => new Map<number, PdgaAnnualStat[]>())
    : new Map<number, PdgaAnnualStat[]>();
  const annualCached = !fresh && (cachedPlayer === null || (cachedPlayer !== undefined && cachedAnnual.size === targetYears.length));

  if (!fresh && cachedPlayer !== undefined && annualCached && liveCached) {
    const base = statsFromPlayer(pdga, cachedPlayer);
    if (cachedPlayer) base.annual_stats = await lookupPdgaPlayerStats(apiEnv, pdga, targetYears, now).catch(() => []);
    const enriched = await enrichFromLiveApi(env, base, links, now).catch(() => base);
    return json(enriched, 200, origin, headers);
  }

  if (await kvRateLimited(env, "pdga:" + clientIp(request), 30, 60)) return json({ error: "rate_limited" }, 429, origin);

  let base: PdgaStats;
  try {
    const player = cachedPlayer !== undefined ? cachedPlayer : await lookupPdgaPlayer(apiEnv, pdga, fresh ? "all" : "none");
    base = statsFromPlayer(pdga, player);
    if (player) {
      base.annual_stats = await lookupPdgaPlayerStats(apiEnv, pdga, targetYears, now, fresh).catch(() => []);
    }
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

const LINK_KEEP_DAYS = 180;
const DAY_MS = 86_400_000;
const RECENT_DONE_DAYS = 14;
const WATCH_TTL_MS = 24 * 60 * 60_000;

/** Accept a numeric PDGA tournament ID ("107755", "#107755") or a pdga.com tour/live event URL. */
export function parsePdgaEventIdInput(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 1 && raw <= 99_999_999 ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const direct = /^#?([1-9]\d{0,7})$/.exec(s);
  if (direct) return Number(direct[1]);
  const urlMatch = /^https?:\/\/(?:www\.)?pdga\.com\/(?:tour|live)\/event\/([1-9]\d{0,7})(?:[/?#]|$)/i.exec(s);
  if (urlMatch) return Number(urlMatch[1]);
  return null;
}

/**
 * POST /pdga/link-event: look up a single PDGA event via the documented PDGA Live API on demand, confirm the
 * signed-in member's PDGA # appears on its roster, and store ONLY an expiring Section 6(a) record ID link.
 */
export async function handlePdgaLinkEvent(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const memberPdga = normalPdgaNumber(claims.member.pdgaNo);
  if (!memberPdga) return json({ error: "pdga_not_linked" }, 400, origin);
  if (await kvRateLimited(env, "pdga-link:" + claims.sub, 12, 3600)) return json({ error: "rate_limited" }, 429, origin);

  const body = await readJson(request, 1024);
  const eventId = parsePdgaEventIdInput(body?.event);
  if (!eventId) return json({ error: "invalid_pdga_event" }, 400, origin);

  const now = Date.now();
  const db = env.DB as unknown as D1Like;
  const liveEnv = env as unknown as PdgaLiveApiEnv;

  let eventInfo;
  try {
    eventInfo = await fetchPdgaLiveEvent(liveEnv, eventId, now);
  } catch (error) {
    const code = error instanceof PdgaLiveApiError && error.code === "rate_limited" ? 429 : 503;
    return json({ error: code === 429 ? "rate_limited" : "pdga_unavailable" }, code, origin);
  }
  if (!eventInfo) return json({ error: "event_not_found" }, 404, origin);

  const today = new Date(now).toISOString().slice(0, 10);
  const recentDoneCutoff = new Date(now - RECENT_DONE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const startDate = eventInfo.startDate || today;
  const endDate = eventInfo.endDate || startDate;
  const isCompleted = endDate < recentDoneCutoff
    || (endDate < today && eventInfo.highestCompletedRound != null && eventInfo.highestCompletedRound >= eventInfo.rounds);

  const divCodes = eventInfo.divisions.filter((d) => d.players > 0).map((d) => d.division);
  let matched: { resultId: number; division: string } | null = null;
  if (divCodes.length) {
    let blocksByDiv;
    try {
      blocksByDiv = await fetchPdgaLiveDivisions(liveEnv, eventId, divCodes, 1, now, isCompleted);
    } catch (error) {
      const code = error instanceof PdgaLiveApiError && error.code === "rate_limited" ? 429 : 503;
      return json({ error: code === 429 ? "rate_limited" : "pdga_unavailable" }, code, origin);
    }
    for (const [divCode, blocks] of blocksByDiv) {
      for (const block of blocks) {
        for (const score of block.scores) {
          if (score.pdgaNumber === memberPdga && score.resultId > 0) {
            matched = { resultId: score.resultId, division: score.division || divCode };
            break;
          }
        }
        if (matched) break;
      }
      if (matched) break;
    }
  }
  if (!matched) {
    return json({ error: "player_not_in_event", eventName: eventInfo.name }, 404, origin);
  }

  const parsedEnd = Date.parse(`${endDate}T23:59:59Z`);
  const linkExpires = (Number.isFinite(parsedEnd) ? parsedEnd : now) + LINK_KEEP_DAYS * DAY_MS;

  try {
    await db.prepare(
      `INSERT INTO pdga_member_event_links
         (event_id, member_id, pdga_number, result_id, division, event_start, event_end, matched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, member_id) DO UPDATE SET
         pdga_number = excluded.pdga_number, result_id = excluded.result_id,
         division = excluded.division, event_start = excluded.event_start, event_end = excluded.event_end,
         matched_at = excluded.matched_at, expires_at = excluded.expires_at`,
    ).bind(eventId, claims.sub, memberPdga, matched.resultId, matched.division.slice(0, 24), startDate, endDate, now, linkExpires).run();

    await db.prepare(
      `INSERT INTO pdga_watch_events
         (event_id, state, name, tier, location, start_date, end_date, listed_at, read_at, read_error, completed, expires_at)
       VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         name = excluded.name, tier = excluded.tier, location = excluded.location,
         start_date = excluded.start_date, end_date = excluded.end_date,
         read_at = excluded.read_at, read_error = '', completed = excluded.completed, expires_at = excluded.expires_at`,
    ).bind(
      eventId,
      eventInfo.name.slice(0, 160),
      eventInfo.tier.slice(0, 24),
      eventInfo.location.slice(0, 120),
      startDate,
      endDate,
      now,
      now,
      isCompleted ? 1 : 0,
      now + WATCH_TTL_MS,
    ).run();
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }

  return json({
    ok: true,
    linked: {
      eventId,
      name: eventInfo.name,
      division: matched.division,
      startDate,
      endDate,
      resultId: matched.resultId,
    },
    attribution: PDGA_ATTRIBUTION,
  }, 200, origin, { "Cache-Control": "private, no-store" });
}

/**
 * GET /pdga/players/batch?numbers=123,456 (max 20): signed-in member on-demand batch PDGA lookup for Member Directory
 * cards using 1 official REST API call (6h temporary cache).
 */
export async function handlePdgaPlayersBatch(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);

  const raw = new URL(request.url).searchParams.get("numbers") ?? "";
  const numbers = [...new Set(raw.split(",").map((part) => normalPdgaNumber(part)).filter((v): v is string => v != null))];
  if (!numbers.length || numbers.length > 20) return json({ error: "invalid_numbers" }, 400, origin);

  const now = Date.now();
  const apiEnv = env as unknown as PdgaApiEnv;
  const cached = await cachedPdgaPlayers(apiEnv, numbers, now).catch(() => new Map<string, PdgaPlayer | null>());
  const allCached = numbers.every((num) => cached.has(num));

  let resolved: Map<string, PdgaPlayer | null>;
  if (allCached) {
    resolved = cached;
  } else {
    if (!pdgaApiConfigured(apiEnv)) return json({ error: "pdga_unavailable" }, 503, origin);
    if (await kvRateLimited(env, "pdga-batch:" + claims.sub, 20, 600)) return json({ error: "rate_limited" }, 429, origin);
    try {
      resolved = await lookupPdgaPlayers(apiEnv, numbers, now);
    } catch (error) {
      const code = error instanceof PdgaApiError && error.code === "rate_limited" ? 429 : 503;
      return json({ error: code === 429 ? "rate_limited" : "pdga_unavailable" }, code, origin);
    }
  }

  const players: Record<string, {
    pdgaNumber: string;
    name: string;
    rating: number | null;
    ratingDate: string | null;
    classification: "P" | "A" | null;
    membershipStatus: string;
    url: string;
  } | null> = {};

  for (const num of numbers) {
    const p = resolved.get(num) ?? null;
    players[num] = p ? {
      pdgaNumber: p.pdgaNumber,
      name: p.name,
      rating: p.rating,
      ratingDate: p.ratingDate,
      classification: p.classification,
      membershipStatus: p.membershipStatus,
      url: p.url,
    } : null;
  }

  return json({ players, attribution: PDGA_ATTRIBUTION }, 200, origin, { "Cache-Control": "private, max-age=300" });
}
