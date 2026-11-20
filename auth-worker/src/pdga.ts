// GET /pdga-stats: a member's official PDGA rating for the member dashboard and the scorer, read ONLY through the
// PDGA REST API with the club's developer account (pdga-api.ts). PDGA's Developer Program asked the club to stop
// reading pdga.com pages and PDGA's internal (undocumented) member endpoints; the per-round ratings, recent events, live
// rating estimate and PDGA hole mix those gave are gone. The response keeps its old shape (those fields empty) so older
// clients still render. Player records are cached a few hours by pdga-api.ts and purged after (temporary caching only).

import type { Env } from "./env.js";
import { clientIp, json } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { emptyPlayTotals, type PlayTotals } from "./play-stats.js";
import { cachedPdgaPlayers, lookupPdgaPlayer, normalPdgaNumber, pdgaApiConfigured, type PdgaApiEnv, type PdgaPlayer } from "./pdga-api.js";

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
  stats_version?: number;
  /** Where the numbers came from: always the PDGA REST API now. */
  source?: "pdga-api";
}

export const PDGA_STATS_VERSION = 4;
const STAGING_QA_PDGA = "90000001";

/** The stats for a PDGA number: the official rating (and its date) from the API; nothing else PDGA lets the club read. */
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
    stats_version: PDGA_STATS_VERSION,
    source: "pdga-api",
  };
}

/** The live QA drive's dashboard member: fixed numbers, no PDGA call (not a real PDGA number). */
function qaStats(pdga: string): PdgaStats | null {
  if (pdga !== STAGING_QA_PDGA) return null;
  return { ...statsFromPlayer(pdga, null), name: "GVDG QA Dashboard", official_rating: 935, rating_date: "2026-07-01" };
}

/** GET /pdga-stats?pdga=<digits>: the official rating from the PDGA API (cached a few hours, IP-rate-limited). */
export async function handlePdgaStats(request: Request, env: Env, origin: string | null): Promise<Response> {
  const raw = (new URL(request.url).searchParams.get("pdga") ?? "").trim();
  const headers = { "Cache-Control": "private, max-age=300" };
  const qa = qaStats(raw);
  if (qa) return json(qa, 200, origin, headers);
  const pdga = normalPdgaNumber(raw);
  if (!pdga) return json({ error: "invalid_pdga" }, 400, origin);

  const apiEnv = env as unknown as PdgaApiEnv;
  if (!pdgaApiConfigured(apiEnv)) return json(statsFromPlayer(pdga, null), 200, origin, { "Cache-Control": "no-store" });
  // A fresh cached record is free; only a lookup that would call PDGA counts against the per-IP limit (many members
  // share one IP behind a carrier NAT or event Wi-Fi, and counting cached reads blanked their ratings).
  const cached = await cachedPdgaPlayers(apiEnv, [pdga]).catch(() => new Map<string, PdgaPlayer | null>());
  if (cached.has(pdga)) return json(statsFromPlayer(pdga, cached.get(pdga) ?? null), 200, origin, headers);
  if (await kvRateLimited(env, "pdga:" + clientIp(request), 30, 60)) return json({ error: "rate_limited" }, 429, origin);
  try {
    return json(statsFromPlayer(pdga, await lookupPdgaPlayer(apiEnv, pdga)), 200, origin, headers);
  } catch (error) {
    console.warn(JSON.stringify({ message: "pdga_stats_api_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "pdga_unavailable" }, 503, origin);
  }
}
