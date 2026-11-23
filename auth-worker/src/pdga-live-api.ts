// Official PDGA Live API client (https://www.pdga.com/dev/api/live):
//   - Live results endpoints: https://www.pdga.com/apps/tournament/live-api
//   - Detailed throw/putting statistics: https://www.pdga.com/api/v1
//
// Strictly read-only documented endpoints with conditional GET (ETag / If-None-Match -> 304 Not Modified),
// descriptive User-Agent, respected Cloudflare TTLs, and Section 6 temporary D1 caching purged hourly.
// Never hits pdga.com HTML pages or undocumented member-profile endpoints.

import type { D1Like } from "./db-types.js";
import { emptyPlayTotals, totalsFromHoleScores, type PlayTotals } from "./play-stats.js";

export const PDGA_LIVE_API_BASE = "https://www.pdga.com/apps/tournament/live-api";
export const PDGA_LIVE_STATS_BASE = "https://www.pdga.com/api/v1";
export const PDGA_LIVE_USER_AGENT = "GVDGClubSite/1.0 (+https://gvdgclub.com; greenvillediscgolf@gmail.com)";

const EVENT_CACHE_MS = 5 * 60_000;          // docs s-maxage: 300s
const LIVE_ROUND_CACHE_MS = 60_000;         // docs s-maxage: 20s / max-age: 15s
const COMPLETED_ROUND_CACHE_MS = 5 * 60_000;
const PLAYER_ACTIVE_CACHE_MS = 15 * 60_000; // docs s-maxage: 45s
const PLAYER_DONE_CACHE_MS = 6 * 60 * 60_000;
const DIV_STATS_CACHE_MS = 10 * 60_000;     // docs s-maxage: 600s
const CATALOG_CACHE_MS = 60 * 60_000;       // docs s-maxage: 300s
const FETCH_TIMEOUT_MS = 10_000;

export type PdgaLiveApiEnv = {
  DB: D1Like;
  PDGA_LIVE_API_BASE?: string;
  PDGA_LIVE_STATS_BASE?: string;
};

export class PdgaLiveApiError extends Error {
  constructor(readonly code: "rate_limited" | "unavailable") {
    super("pdga_live_" + code);
  }
}

export type PdgaLiveStatCatalogEntry = {
  statId: number;
  name: string;
  abbreviation: string;
  valueType: string;
  valueSort: string;
};

export type PdgaLiveStatItem = {
  statId: number;
  statCount: number | null;
  statOpportunityCount: number;
  statValue: number;
  rank?: number | null;
  isTie?: boolean | null;
};

export type PdgaLiveDivisionMeta = {
  division: string;
  divisionName: string;
  players: number;
  latestRound: number | null;
};

export type PdgaLiveRoundMeta = {
  number: number;
  label: string;
  labelAbbreviated: string;
  date: string | null;
};

export type PdgaLiveEvent = {
  tournId: number;
  name: string;
  startDate: string;
  endDate: string;
  location: string;
  tier: string;
  rounds: number;
  highestCompletedRound: number | null;
  latestRound: number | null;
  finalRound: number | null;
  divisions: PdgaLiveDivisionMeta[];
  roundsList: PdgaLiveRoundMeta[];
};

export type PdgaLiveScoreRow = {
  resultId: number;
  scoreId: number | null;
  roundId: number | null;
  pdgaNumber: string | null;
  name: string;
  shortName: string;
  profileUrl: string | null;
  division: string;
  pool: string | null;
  rating: number | null;
  runningPlace: number | null;
  tied: boolean;
  previousPlace: number | null;
  toPar: number | null;
  parThruRound: number | null;
  roundToPar: number | null;
  roundScore: number | null;
  played: number;
  completed: boolean;
  dnf: boolean;
  roundRating: number | null;
  holeScores: (number | null)[];
  holePars: (number | null)[];
};

export type PdgaLiveRoundBlock = {
  division: string;
  pool: string | null;
  liveRoundId: number | null;
  teeTimes: boolean;
  shotgunTime: string | null;
  holesCount: number;
  scores: PdgaLiveScoreRow[];
};

export type PdgaLivePlayerScore = {
  scoreId: number | null;
  round: number;
  roundDate: string | null;
  roundField: string;
  roundScore: number | null;
  roundToPar: number | null;
  roundComplete: boolean;
  roundRating: number | null;
  dnf: boolean;
  holeScores: Record<string, number>;
  holePars: Record<string, number>;
};

export type PdgaLivePlayerResult = {
  resultId: number;
  tournId: number;
  pdgaNumber: string | null;
  name: string;
  division: string;
  place: number | null;
  runningPlace: number | null;
  rating: number | null;
  averageRoundRating: number | null;
  toPar: number | null;
  total: number | null;
  dnf: boolean;
  scores: PdgaLivePlayerScore[];
};

export type PdgaLiveDivisionStatRow = {
  resultId: number;
  dnf: boolean;
  stats: PdgaLiveStatItem[];
};

type CachedRow = {
  etag: string | null;
  payload: string;
  fetched_at: number;
  expires_at: number;
};

type Row = Record<string, unknown>;

function liveApiBase(env: Partial<PdgaLiveApiEnv>): string {
  return (env.PDGA_LIVE_API_BASE || PDGA_LIVE_API_BASE).replace(/\/+$/, "");
}

function liveStatsBase(env: Partial<PdgaLiveApiEnv>): string {
  return (env.PDGA_LIVE_STATS_BASE || PDGA_LIVE_STATS_BASE).replace(/\/+$/, "");
}

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n != null && Number.isInteger(n) ? n : null;
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function normalPdgaDigits(raw: unknown): string | null {
  const n = int(raw);
  return n != null && n > 0 && n <= 9_999_999 ? String(n) : null;
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  apos: "'",
  quot: '"',
  "#039": "'",
  nbsp: " ",
};

/** Decode simple HTML entities PDGA Live metadata occasionally returns (display names only). */
export function decodePdgaText(value: unknown): string {
  return String(value ?? "").replace(/&(#\d+|#x[\da-fA-F]+|amp|apos|quot|#039|nbsp);/g, (match, entity: string) => {
    if (ENTITY_MAP[entity]) return ENTITY_MAP[entity]!;
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return match;
  }).trim();
}

function isMissingTable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /no such table|does not exist/i.test(msg);
}

async function readCacheRow(db: D1Like, cacheKey: string): Promise<CachedRow | null> {
  try {
    return await db.prepare("SELECT etag, payload, fetched_at, expires_at FROM pdga_live_cache WHERE cache_key = ?")
      .bind(cacheKey).first<CachedRow>();
  } catch (error) {
    if (!isMissingTable(error)) {
      console.warn(JSON.stringify({ message: "pdga_live_cache_read_failed", cacheKey, error: error instanceof Error ? error.message : String(error) }));
    }
    return null;
  }
}

async function writeCacheRow(db: D1Like, cacheKey: string, etag: string | null, payload: string, now: number, ttlMs: number): Promise<void> {
  try {
    await db.prepare(`INSERT INTO pdga_live_cache (cache_key, etag, payload, fetched_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET etag = excluded.etag, payload = excluded.payload,
          fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`)
      .bind(cacheKey, etag, payload, now, now + ttlMs).run();
  } catch (error) {
    if (!isMissingTable(error)) {
      console.warn(JSON.stringify({ message: "pdga_live_cache_write_failed", cacheKey, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

async function deleteCacheRow(db: D1Like, cacheKey: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM pdga_live_cache WHERE cache_key = ?").bind(cacheKey).run();
  } catch (error) {
    if (!isMissingTable(error)) {
      console.warn(JSON.stringify({ message: "pdga_live_cache_delete_failed", cacheKey, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

async function fetchLiveCached(
  env: Partial<PdgaLiveApiEnv>,
  opts: { cacheKey: string; url: string; ttlMs: number; now?: number; expectEnvelope: boolean; cacheNotFoundMs?: number },
): Promise<unknown | null> {
  const now = opts.now ?? Date.now();
  const cached = env.DB ? await readCacheRow(env.DB, opts.cacheKey) : null;
  if (cached && cached.expires_at > now && cached.fetched_at <= now) {
    try { return JSON.parse(cached.payload); } catch { /* re-fetch */ }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": PDGA_LIVE_USER_AGENT,
  };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  const res = await fetch(opts.url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 304 && cached) {
    if (env.DB) await writeCacheRow(env.DB, opts.cacheKey, cached.etag, cached.payload, now, opts.ttlMs);
    try { return JSON.parse(cached.payload); } catch { return null; }
  }
  if (res.status === 404) {
    if (env.DB) {
      if (opts.cacheNotFoundMs && opts.cacheNotFoundMs > 0) {
        await writeCacheRow(env.DB, opts.cacheKey, null, "null", now, opts.cacheNotFoundMs);
      } else if (cached) {
        await deleteCacheRow(env.DB, opts.cacheKey);
      }
    }
    return null;
  }
  if (res.status === 429) throw new PdgaLiveApiError("rate_limited");
  if (!res.ok) throw new PdgaLiveApiError("unavailable");

  const rawText = (await res.text()).trim();
  if (!rawText.startsWith("{") && !rawText.startsWith("[")) {
    throw new PdgaLiveApiError("unavailable");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(rawText); } catch { throw new PdgaLiveApiError("unavailable"); }

  let data: unknown = parsed;
  if (opts.expectEnvelope) {
    const envObj = record(parsed);
    if (!envObj || !("data" in envObj)) throw new PdgaLiveApiError("unavailable");
    data = envObj.data;
    if (Array.isArray(data) && data.length === 0) {
      if (env.DB && cached) await deleteCacheRow(env.DB, opts.cacheKey);
      return null;
    }
  }

  if (env.DB) {
    const nextEtag = res.headers.get("etag") ?? null;
    await writeCacheRow(env.DB, opts.cacheKey, nextEtag, JSON.stringify(data), now, opts.ttlMs);
  }
  return data;
}

function parseScoreRow(raw: unknown, holesCount: number, isPlayoffRound = false): PdgaLiveScoreRow | null {
  const row = record(raw);
  if (!row) return null;
  const resultId = int(row.ResultID);
  if (resultId == null || resultId <= 0) return null;

  const pdgaNumber = Number(row.HasPDGANum) === 0 ? null : normalPdgaDigits(row.PDGANum);
  const completed = Number(row.Completed) === 1;
  const rawRoundScore = int(row.RoundScore);
  const rawTotal = int(row.GrandTotal ?? row.RunningTotalScore);
  const dnf = rawRoundScore === 888 || rawRoundScore === 999 || rawTotal === 888 || rawTotal === 999;
  const roundNum = int(row.Round);
  const rawRating = int(row.RoundRating);
  const roundRating = isPlayoffRound || roundNum === 13 || rawRating == null || rawRating <= 0 ? null : rawRating;

  const trimLen = holesCount > 0 ? Math.min(36, holesCount) : 36;
  const rawHoleScores = Array.isArray(row.HoleScores) ? row.HoleScores : String(row.Scores ?? "").split(",");
  const rawHolePars = String(row.Pars ?? "").split(",");
  const holeScores: (number | null)[] = [];
  const holePars: (number | null)[] = [];
  const actualLen = holesCount > 0 ? trimLen : rawHoleScores.filter((v) => String(v ?? "").trim() !== "").length || 18;
  for (let i = 0; i < Math.min(36, actualLen); i++) {
    const s = int(rawHoleScores[i]);
    holeScores.push(s != null && s > 0 && s !== 888 && s !== 999 ? s : null);
    const p = int(rawHolePars[i]);
    holePars.push(p != null && p >= 2 && p <= 7 ? p : null);
  }

  return {
    resultId,
    scoreId: int(row.ScoreID),
    roundId: int(row.RoundID),
    pdgaNumber,
    name: decodePdgaText(text(row.Name) ?? text(row.ShortName) ?? (pdgaNumber ? `PDGA #${pdgaNumber}` : "Player")),
    shortName: decodePdgaText(text(row.ShortName) ?? text(row.Name) ?? "Player"),
    profileUrl: pdgaNumber ? `https://www.pdga.com/player/${pdgaNumber}` : null,
    division: text(row.Division, 24) ?? "",
    pool: text(row.RoundPool ?? row.Pool, 16),
    rating: int(row.Rating),
    runningPlace: int(row.RunningPlace),
    tied: Boolean(row.Tied),
    previousPlace: int(row.PreviousPlace),
    toPar: dnf ? null : int(row.ToPar),
    parThruRound: dnf ? null : int(row.ParThruRound),
    roundToPar: dnf ? null : int(row.RoundtoPar ?? row.RoundToPar),
    roundScore: dnf ? null : rawRoundScore,
    played: Math.max(0, int(row.Played) ?? 0),
    completed,
    dnf,
    roundRating,
    holeScores,
    holePars,
  };
}

function parseDivisionBlock(raw: unknown, isPlayoffRound = false): PdgaLiveRoundBlock | null {
  const block = record(raw);
  if (!block) return null;
  const division = text(block.division, 24) ?? "";
  const holesArr = Array.isArray(block.holes) ? block.holes : [];
  const holesCount = holesArr.length || 0;
  const rawScores = Array.isArray(block.scores) ? block.scores : [];
  const scores = rawScores
    .map((item) => parseScoreRow(item, holesCount, isPlayoffRound))
    .filter((item): item is PdgaLiveScoreRow => item != null);
  return {
    division,
    pool: text(block.pool, 16),
    liveRoundId: int(block.live_round_id),
    teeTimes: Boolean(block.tee_times),
    shotgunTime: text(block.shotgun_time, 40),
    holesCount,
    scores,
  };
}

/** Normalize a PDGA round number query token (supports 1..10, 11/"Semis", 12/"Finals", 13/"Playoff"). */
export function normalPdgaLiveRound(round: string | number | null | undefined): string {
  const raw = String(round ?? "1").trim();
  const lower = raw.toLowerCase();
  if (lower === "semis" || raw === "11") return "11";
  if (lower === "finals" || raw === "12") return "12";
  if (lower === "playoff" || raw === "13") return "13";
  const parsed = int(raw);
  if (parsed != null && parsed >= 1 && parsed <= 13) return String(parsed);
  return "1";
}

/** GET /live_results_fetch_event?TournID=<id> */
export async function fetchPdgaLiveEvent(
  env: Partial<PdgaLiveApiEnv>,
  tournId: number,
  now = Date.now(),
  completed = false,
): Promise<PdgaLiveEvent | null> {
  if (!Number.isInteger(tournId) || tournId <= 0) return null;
  const data = await fetchLiveCached(env, {
    cacheKey: `event:${tournId}`,
    url: `${liveApiBase(env)}/live_results_fetch_event?TournID=${encodeURIComponent(String(tournId))}`,
    ttlMs: completed ? PLAYER_DONE_CACHE_MS : EVENT_CACHE_MS,
    now,
    expectEnvelope: true,
  });
  const obj = record(data);
  if (!obj) return null;
  const name = decodePdgaText(text(obj.Name, 200) ?? text(obj.SimpleName, 200) ?? "");
  if (!name) return null;
  const rawDivs = Array.isArray(obj.Divisions) ? obj.Divisions : [];
  const divisions: PdgaLiveDivisionMeta[] = [];
  for (const item of rawDivs) {
    const d = record(item);
    const code = d ? text(d.Division, 24) : null;
    if (!d || !code) continue;
    divisions.push({
      division: code,
      divisionName: decodePdgaText(text(d.DivisionName, 120) ?? code),
      players: Math.max(0, int(d.Players) ?? 0),
      latestRound: int(d.LatestRound),
    });
  }
  const roundsList: PdgaLiveRoundMeta[] = [];
  const rawRoundsList = record(obj.RoundsList);
  if (rawRoundsList) {
    for (const [key, value] of Object.entries(rawRoundsList)) {
      const item = record(value);
      const number = int(item?.Number ?? key);
      if (!item || number == null) continue;
      roundsList.push({
        number,
        label: decodePdgaText(text(item.Label, 40) ?? `Round ${number}`),
        labelAbbreviated: decodePdgaText(text(item.LabelAbbreviated, 20) ?? `Rd ${number}`),
        date: text(item.Date, 32),
      });
    }
    roundsList.sort((a, b) => a.number - b.number);
  }
  const startDate = text(obj.StartDate, 32) ?? "";
  return {
    tournId: int(obj.TournamentId) ?? tournId,
    name,
    startDate,
    endDate: text(obj.EndDate, 32) ?? startDate,
    location: decodePdgaText(text(obj.LocationShort, 160) ?? text(obj.Location, 160) ?? ""),
    tier: decodePdgaText(text(obj.FormattedTier, 40) ?? text(obj.RawTier, 16) ?? text(obj.Tier, 40) ?? ""),
    rounds: Math.max(1, int(obj.Rounds) ?? (roundsList.length || 1)),
    highestCompletedRound: int(obj.HighestCompletedRound),
    latestRound: int(obj.LatestRound),
    finalRound: int(obj.FinalRound),
    divisions,
    roundsList,
  };
}

/** GET /live_results_fetch_round?TournID=<id>&Division=<div>&Round=<round> (handles single block or pooled array). */
export async function fetchPdgaLiveRound(
  env: Partial<PdgaLiveApiEnv>,
  tournId: number,
  division: string,
  round: string | number = 1,
  now = Date.now(),
  completed = false,
): Promise<PdgaLiveRoundBlock[]> {
  const normRound = normalPdgaLiveRound(round);
  const isPlayoff = normRound === "13";
  const data = await fetchLiveCached(env, {
    cacheKey: `round:${tournId}:${division}:${normRound}`,
    url: `${liveApiBase(env)}/live_results_fetch_round?TournID=${encodeURIComponent(String(tournId))}&Division=${encodeURIComponent(division)}&Round=${encodeURIComponent(normRound)}`,
    ttlMs: completed ? COMPLETED_ROUND_CACHE_MS : LIVE_ROUND_CACHE_MS,
    now,
    expectEnvelope: true,
  });
  if (!data) return [];
  const items = Array.isArray(data) ? data : [data];
  return items
    .map((item) => parseDivisionBlock(item, isPlayoff))
    .filter((item): item is PdgaLiveRoundBlock => item != null);
}

/** GET /live_results_fetch?TournID=<id>&Divisions=<csv>&Round=<round> (chunked, pool-safe). */
export async function fetchPdgaLiveDivisions(
  env: Partial<PdgaLiveApiEnv>,
  tournId: number,
  divisions: readonly string[],
  round: string | number = 1,
  now = Date.now(),
  completed = false,
): Promise<Map<string, PdgaLiveRoundBlock[]>> {
  const out = new Map<string, PdgaLiveRoundBlock[]>();
  const cleanDivs = [...new Set(divisions.map((d) => d.trim()).filter(Boolean))];
  if (!cleanDivs.length) return out;
  const normRound = normalPdgaLiveRound(round);
  const isPlayoff = normRound === "13";

  for (let offset = 0; offset < cleanDivs.length; offset += 12) {
    const group = cleanDivs.slice(offset, offset + 12);
    const csv = group.join(",");
    const data = await fetchLiveCached(env, {
      cacheKey: `fetch:${tournId}:${normRound}:${csv}`,
      url: `${liveApiBase(env)}/live_results_fetch?TournID=${encodeURIComponent(String(tournId))}&Divisions=${encodeURIComponent(csv)}&Round=${encodeURIComponent(normRound)}`,
      ttlMs: completed ? COMPLETED_ROUND_CACHE_MS : LIVE_ROUND_CACHE_MS,
      now,
      expectEnvelope: true,
    });
    const obj = record(data);
    if (!obj) continue;
    for (const [divKey, rawVal] of Object.entries(obj)) {
      const blocks = (Array.isArray(rawVal) ? rawVal : [rawVal])
        .map((item) => parseDivisionBlock(item, isPlayoff))
        .filter((item): item is PdgaLiveRoundBlock => item != null);
      if (blocks.length) out.set(divKey, blocks);
    }
  }
  return out;
}

/** GET /live_results_fetch_player?ResultID=<id> */
export async function fetchPdgaLivePlayer(
  env: Partial<PdgaLiveApiEnv>,
  resultId: number,
  now = Date.now(),
  completed = false,
): Promise<PdgaLivePlayerResult | null> {
  if (!Number.isInteger(resultId) || resultId <= 0) return null;
  const data = await fetchLiveCached(env, {
    cacheKey: `player:${resultId}`,
    url: `${liveApiBase(env)}/live_results_fetch_player?ResultID=${encodeURIComponent(String(resultId))}`,
    ttlMs: completed ? PLAYER_DONE_CACHE_MS : PLAYER_ACTIVE_CACHE_MS,
    now,
    expectEnvelope: true,
  });
  const obj = record(data);
  if (!obj) return null;
  const rawScores = Array.isArray(obj.Scores) ? obj.Scores : [];
  const scores: PdgaLivePlayerScore[] = [];
  for (const item of rawScores) {
    const s = record(item);
    if (!s) continue;
    const round = int(s.Round);
    if (round == null) continue;
    const rawRoundScore = int(s.RoundScore);
    const holeScores: Record<string, number> = {};
    const holeScoresObj = record(s.HoleScores);
    if (holeScoresObj) {
      for (const [hKey, hVal] of Object.entries(holeScoresObj)) {
        const hv = int(hVal);
        if (hv != null && hv > 0 && hv !== 888 && hv !== 999) holeScores[hKey] = hv;
      }
    }
    // Only treat tournament-level obj.DNF as DNF on rounds that don't themselves have a completed/valid score.
    const roundDnf = Boolean(s.DNF)
      || rawRoundScore === 888
      || rawRoundScore === 999
      || (Boolean(obj.DNF) && !Object.keys(holeScores).length && (rawRoundScore == null || rawRoundScore <= 0));
    const rawRating = int(s.RoundRating);
    const holePars: Record<string, number> = {};
    const layoutDetail = record(record(s.Layout)?.Detail);
    if (layoutDetail) {
      for (const [hKey, hVal] of Object.entries(layoutDetail)) {
        const par = int(record(hVal)?.Par);
        if (par != null && par >= 2 && par <= 7) holePars[hKey] = par;
      }
    }
    scores.push({
      scoreId: int(s.ScoreID),
      round,
      roundDate: text(s.RoundDate, 32),
      roundField: text(s.RoundField, 16) ?? `Rd${round}`,
      roundScore: roundDnf ? null : rawRoundScore,
      roundToPar: roundDnf ? null : int(s.RoundToPar ?? s.ScoreToPar),
      roundComplete: Boolean(s.RoundComplete) && !roundDnf,
      roundRating: round === 13 || roundDnf || rawRating == null || rawRating <= 0 ? null : rawRating,
      dnf: roundDnf,
      holeScores,
      holePars,
    });
  }
  return {
    resultId: int(obj.ResultID) ?? resultId,
    tournId: int(obj.TournID) ?? 0,
    pdgaNumber: normalPdgaDigits(obj.PDGANum),
    name: decodePdgaText(text(obj.Name) ?? "Player"),
    division: text(obj.Division, 24) ?? "",
    place: int(obj.Place),
    runningPlace: int(obj.RunningPlace),
    rating: int(obj.Rating),
    averageRoundRating: int(obj.AverageRoundRating),
    toPar: Boolean(obj.DNF) ? null : int(obj.ToPar),
    total: Boolean(obj.DNF) ? null : int(obj.Total),
    dnf: Boolean(obj.DNF),
    scores,
  };
}

function parseStatItems(raw: unknown): PdgaLiveStatItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PdgaLiveStatItem[] = [];
  for (const item of raw) {
    const obj = record(item);
    if (!obj) continue;
    const statId = int(obj.statId);
    const statOpportunityCount = int(obj.statOpportunityCount);
    const statValue = num(obj.statValue);
    if (statId == null || statOpportunityCount == null || statValue == null) continue;
    out.push({
      statId,
      statCount: obj.statCount == null ? null : int(obj.statCount),
      statOpportunityCount: Math.max(0, statOpportunityCount),
      statValue,
      rank: obj.rank == null ? null : int(obj.rank),
      isTie: typeof obj.isTie === "boolean" ? obj.isTie : null,
    });
  }
  return out;
}

/** GET /api/v1/feat/live-scores/{scoreId}/round-stats (must validate scoreId via fetchPdgaLivePlayer first). */
export async function fetchPdgaLiveScoreStats(
  env: Partial<PdgaLiveApiEnv>,
  scoreId: number,
  now = Date.now(),
  completed = false,
): Promise<PdgaLiveStatItem[] | null> {
  if (!Number.isInteger(scoreId) || scoreId <= 0) return null;
  const data = await fetchLiveCached(env, {
    cacheKey: `score-stats:${scoreId}`,
    url: `${liveStatsBase(env)}/feat/live-scores/${encodeURIComponent(String(scoreId))}/round-stats`,
    ttlMs: completed ? PLAYER_DONE_CACHE_MS : PLAYER_ACTIVE_CACHE_MS,
    now,
    expectEnvelope: false,
    cacheNotFoundMs: completed ? PLAYER_DONE_CACHE_MS : PLAYER_ACTIVE_CACHE_MS,
  });
  return data == null ? null : parseStatItems(data);
}

/** GET /api/v1/feat/stats/tournament-division-stats/{tournId}/{division} */
export async function fetchPdgaDivisionStats(
  env: Partial<PdgaLiveApiEnv>,
  tournId: number,
  division: string,
  now = Date.now(),
): Promise<PdgaLiveDivisionStatRow[]> {
  if (!Number.isInteger(tournId) || tournId <= 0 || !division.trim()) return [];
  const data = await fetchLiveCached(env, {
    cacheKey: `div-stats:${tournId}:${division}`,
    url: `${liveStatsBase(env)}/feat/stats/tournament-division-stats/${encodeURIComponent(String(tournId))}/${encodeURIComponent(division)}`,
    ttlMs: DIV_STATS_CACHE_MS,
    now,
    expectEnvelope: false,
    cacheNotFoundMs: DIV_STATS_CACHE_MS,
  });
  const obj = record(data);
  const rawRows = Array.isArray(obj?.resultStats) ? obj!.resultStats : [];
  const out: PdgaLiveDivisionStatRow[] = [];
  for (const row of rawRows) {
    const r = record(row);
    const meta = r ? record(r.result) : null;
    const resultId = meta ? int(meta.resultId) : null;
    if (!r || resultId == null) continue;
    out.push({
      resultId,
      dnf: Boolean(meta?.dnf),
      stats: parseStatItems(r.stats),
    });
  }
  return out;
}

/** GET /api/v1/live-stats */
export async function fetchPdgaLiveStatCatalog(
  env: Partial<PdgaLiveApiEnv>,
  now = Date.now(),
): Promise<PdgaLiveStatCatalogEntry[]> {
  const data = await fetchLiveCached(env, {
    cacheKey: "live-stats-catalog",
    url: `${liveStatsBase(env)}/live-stats`,
    ttlMs: CATALOG_CACHE_MS,
    now,
    expectEnvelope: false,
  });
  if (!Array.isArray(data)) return [];
  const out: PdgaLiveStatCatalogEntry[] = [];
  for (const item of data) {
    const obj = record(item);
    const statId = obj ? int(obj.statId) : null;
    const abbr = obj ? text(obj.abbreviation, 24) : null;
    const name = obj ? text(obj.name, 80) : null;
    if (!obj || statId == null || !abbr || !name) continue;
    out.push({
      statId,
      name,
      abbreviation: abbr,
      valueType: text(obj.valueType, 24) ?? "float",
      valueSort: text(obj.valueSort, 16) ?? "desc",
    });
  }
  return out;
}

const STAT_KEY_MAP: Record<number, readonly [keyof PlayTotals, keyof PlayTotals]> = {
  1: ["fir_hit", "fir_att"],
  2: ["c1r_hit", "c1r_att"],
  3: ["c2r_hit", "c2r_att"],
  4: ["parked_hit", "parked_att"],
  5: ["scramble_hit", "scramble_att"],
  6: ["c1_putt_hit", "c1_putt_att"],
  7: ["c1x_putt_hit", "c1x_putt_att"],
  8: ["c2_putt_hit", "c2_putt_att"],
};

/**
 * Sum documented /api/v1/ live-stats into PlayTotals.
 * PDGA docs: statOpportunityCount === 0 means NO throw tracking data (NOT 0%), and custom aggregates
 * must combine statCount and statOpportunityCount rather than averaging statValue.
 */
export function applyPdgaLiveStatsToTotals(
  totals: PlayTotals,
  statsList: readonly PdgaLiveStatItem[] | null | undefined,
): { obCount: number; obHoles: number } {
  let ob9Count = 0;
  let ob9Holes = 0;
  let ob21Count = 0;
  let ob21Holes = 0;
  for (const item of statsList ?? []) {
    if (!item || !Number.isFinite(item.statOpportunityCount) || item.statOpportunityCount <= 0) continue;
    if (item.statCount == null || !Number.isFinite(item.statCount) || item.statCount < 0) continue;
    const target = STAT_KEY_MAP[item.statId];
    if (target) {
      totals[target[0]] += item.statCount;
      totals[target[1]] += item.statOpportunityCount;
      continue;
    }
    if (item.statId === 9) {
      ob9Count += item.statCount;
      ob9Holes += item.statOpportunityCount;
    } else if (item.statId === 21) {
      ob21Count += item.statCount;
      ob21Holes += item.statOpportunityCount;
    }
  }
  return ob9Holes > 0
    ? { obCount: ob9Count, obHoles: ob9Holes }
    : { obCount: ob21Count, obHoles: ob21Holes };
}

/** Hole score breakdown from a single round of /live_results_fetch_player (ignores DNF 888/999). */
export function playTotalsFromLivePlayerRound(score: PdgaLivePlayerScore): PlayTotals {
  if (score.dnf) return emptyPlayTotals();
  const keys = Object.keys(score.holeScores).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  if (!keys.length) return emptyPlayTotals();
  const pars: number[] = [];
  const strokes: number[] = [];
  for (const key of keys) {
    const stroke = score.holeScores[key];
    const par = score.holePars[key];
    if (stroke == null || par == null || stroke <= 0 || stroke === 888 || stroke === 999) continue;
    pars.push(par);
    strokes.push(stroke);
  }
  return pars.length ? totalsFromHoleScores(pars, strokes) : emptyPlayTotals();
}

/** Purge all temporary PDGA Live caches past expires_at (API License Section 6). */
export async function purgePdgaLiveCaches(
  db: D1Like,
  now = Date.now(),
): Promise<{ liveResponses: number; watchEvents: number; memberLinks: number }> {
  const clean = async (sql: string) => {
    try {
      const res = await db.prepare(sql).bind(now).run();
      return Number(res.meta?.changes) || 0;
    } catch (error) {
      if (isMissingTable(error)) return 0;
      throw error;
    }
  };
  const liveResponses = await clean("DELETE FROM pdga_live_cache WHERE expires_at <= ?");
  const watchEvents = await clean("DELETE FROM pdga_watch_events WHERE expires_at <= ?");
  const memberLinks = await clean("DELETE FROM pdga_member_event_links WHERE expires_at <= ?");
  return { liveResponses, watchEvents, memberLinks };
}
