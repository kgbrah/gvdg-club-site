// GET /pdga/live/event/:tournId[?division=...&round=...]: documented PDGA Live API leaderboard + /api/v1/
// detailed statistics for a PDGA-sanctioned event (cached temporarily in pdga_live_cache with ETag/304).

import type { D1Like } from "./db-types.js";
import type { Env } from "./env.js";
import { clientIp, json } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { PDGA_ATTRIBUTION, pdgaEventUrl } from "./pdga-api.js";
import {
  fetchPdgaDivisionStats,
  fetchPdgaLiveEvent,
  fetchPdgaLiveRound,
  normalPdgaLiveRound,
  PdgaLiveApiError,
  type PdgaLiveApiEnv,
  type PdgaLiveStatItem,
} from "./pdga-live-api.js";

const ALLOWED_STAT_IDS: Record<number, string> = {
  1: "fwh",
  2: "c1r",
  3: "c2r",
  4: "pkd",
  5: "scr",
  6: "c1p",
  7: "c1x",
  8: "c2p",
  9: "obRate",
  21: "obCount",
};

type PublicStatEntry = {
  hit: number | null;
  opp: number;
  value: number;
  rank: number | null;
  isTie: boolean | null;
};

function summarizePlayerStats(items: readonly PdgaLiveStatItem[] | undefined): Record<string, PublicStatEntry> | null {
  if (!items?.length) return null;
  const out: Record<string, PublicStatEntry> = {};
  let hasData = false;
  for (const item of items) {
    const key = ALLOWED_STAT_IDS[item.statId];
    // Per PDGA docs: statOpportunityCount === 0 means no throw tracking data, not 0%.
    if (!key || !Number.isFinite(item.statOpportunityCount) || item.statOpportunityCount <= 0) continue;
    out[key] = {
      hit: item.statCount,
      opp: item.statOpportunityCount,
      value: Math.round(item.statValue * 100) / 100,
      rank: item.rank ?? null,
      isTie: item.isTie ?? null,
    };
    hasData = true;
  }
  return hasData ? out : null;
}

async function isCacheFresh(db: D1Like, cacheKey: string, now: number): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT expires_at FROM pdga_live_cache WHERE cache_key = ? AND expires_at > ?")
      .bind(cacheKey, now).first<{ expires_at: number }>();
    return Boolean(row);
  } catch {
    return false;
  }
}

/** Public proxy to official PDGA Live standings + detailed /api/v1/ division stats for a PDGA tournament id. */
export async function handlePdgaLiveEvent(
  request: Request,
  env: Env,
  origin: string | null,
  tournIdRaw: string,
): Promise<Response> {
  const tournId = Number(tournIdRaw);
  if (!Number.isInteger(tournId) || tournId <= 0) {
    return json({ error: "invalid_pdga_event" }, 400, origin);
  }

  const now = Date.now();
  const db = env.DB as unknown as D1Like;
  const liveEnv = env as unknown as PdgaLiveApiEnv;
  const eventFresh = await isCacheFresh(db, `event:${tournId}`, now);
  if (!eventFresh && await kvRateLimited(env, "pdga-live:" + clientIp(request), 30, 60)) {
    return json({ error: "rate_limited" }, 429, origin);
  }

  let event;
  try {
    event = await fetchPdgaLiveEvent(liveEnv, tournId, now);
  } catch (error) {
    const code = error instanceof PdgaLiveApiError && error.code === "rate_limited" ? 429 : 503;
    return json({ error: code === 429 ? "rate_limited" : "pdga_unavailable" }, code, origin);
  }
  if (!event) return json({ error: "not_found" }, 404, origin);

  const params = new URL(request.url).searchParams;
  const reqDiv = (params.get("division") ?? "").trim().toUpperCase();
  const matchedDiv = reqDiv
    ? event.divisions.find((d) => d.division.toUpperCase() === reqDiv)
    : event.divisions.find((d) => d.players > 0) ?? event.divisions[0];
  const division = matchedDiv?.division ?? null;

  const defaultRound = matchedDiv?.latestRound ?? event.latestRound ?? event.highestCompletedRound ?? 1;
  const reqRound = params.get("round");
  const round = reqRound ? normalPdgaLiveRound(reqRound) : String(defaultRound);
  const roundNum = Number(round);
  const pdgaEventHref = pdgaEventUrl(tournId);
  const pdgaLiveHref = division
    ? `https://www.pdga.com/live/event/${encodeURIComponent(String(tournId))}/${encodeURIComponent(division)}/scores?round=${encodeURIComponent(round)}`
    : `https://www.pdga.com/live/event/${encodeURIComponent(String(tournId))}`;

  if (!division) {
    return json({
      event,
      division: null,
      round,
      blocks: [],
      attribution: PDGA_ATTRIBUTION,
      pdgaEventUrl: pdgaEventHref,
      pdgaLiveUrl: pdgaLiveHref,
    }, 200, origin, { "Cache-Control": "public, max-age=30" });
  }

  const today = new Date(now).toISOString().slice(0, 10);
  const completed = Boolean(
    (event.endDate && event.endDate < today)
    || (event.highestCompletedRound != null && roundNum > 0 && event.highestCompletedRound >= roundNum),
  );

  let blocks;
  try {
    blocks = await fetchPdgaLiveRound(liveEnv, tournId, division, round, now, completed);
  } catch (error) {
    const code = error instanceof PdgaLiveApiError && error.code === "rate_limited" ? 429 : 503;
    return json({ error: code === 429 ? "rate_limited" : "pdga_unavailable" }, code, origin);
  }

  const divStats = await fetchPdgaDivisionStats(liveEnv, tournId, division, now).catch(() => []);
  const statsByResult = new Map(divStats.map((row) => [row.resultId, row.stats]));

  const viewBlocks = blocks.map((block) => ({
    division: block.division || division,
    pool: block.pool,
    holesCount: block.holesCount,
    scores: block.scores.map((row) => ({
      resultId: row.resultId,
      name: row.name,
      shortName: row.shortName,
      profileUrl: row.profileUrl,
      division: row.division || division,
      pool: row.pool,
      runningPlace: row.runningPlace,
      tied: row.tied,
      previousPlace: row.previousPlace,
      toPar: row.toPar,
      parThruRound: row.parThruRound,
      roundToPar: row.roundToPar,
      roundScore: row.roundScore,
      played: row.played,
      completed: row.completed,
      dnf: row.dnf,
      roundRating: row.roundRating,
      holeScores: row.holeScores,
      stats: summarizePlayerStats(statsByResult.get(row.resultId)),
    })),
  }));

  return json({
    event,
    division,
    round,
    blocks: viewBlocks,
    attribution: PDGA_ATTRIBUTION,
    pdgaEventUrl: pdgaEventHref,
    pdgaLiveUrl: pdgaLiveHref,
  }, 200, origin, { "Cache-Control": "public, max-age=30" });
}
