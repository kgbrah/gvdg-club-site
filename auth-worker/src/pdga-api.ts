// The PDGA REST API (https://www.pdga.com/dev): players and events, read with the club's developer account
// (PDGA_API_USERNAME / PDGA_API_PASSWORD secrets). Terms: non-commercial use by a current PDGA member; at most 70
// requests per 10 seconds per IP (login included); every screen showing PDGA data says "Player, event, and course
// data provided by PDGA" and links names to pdga.com. The PDGA asks to review an app before it launches.
//
// The session from a login is reused (in memory, and in RATELIMIT storage across isolates) until PDGA refuses it.
// Player records are kept in D1 for a few hours, so a registration form and its submit don't each call PDGA.
//
// PDGA's API license (Section 6) allows TEMPORARY caching only: PDGA data (ratings, scores, events) is never stored
// permanently or used to build the club's own database. Every PDGA cache here has an expiry, and purgePdgaCaches
// (hourly cron) deletes what's past it. This client is the ONLY way the Worker reads PDGA data: no pdga.com pages, no
// internal pdga.com endpoints (e.g. /api/v1/feat/...), nothing PDGA hasn't documented for developers.

import type { D1Like } from "./db-types.js";
import type { KVLike } from "./ratelimit.js";

export const PDGA_ATTRIBUTION = "Player, event, and course data provided by PDGA";
/** The longest any PDGA player record is kept (the longest it's ever used is FOUND_TTL_MS). */
export const PDGA_PLAYER_CACHE_MAX_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BASE = "https://api.pdga.com";
const SESSION_KEY = "pdga-api:session";
const SESSION_TTL_SECONDS = 6 * 60 * 60;
const FOUND_TTL_MS = 6 * 60 * 60 * 1000;
const MISSING_TTL_MS = 60 * 60 * 1000;
/**
 * A player whose PDGA membership has lapsed or ends within RECHECK_DAYS is about to renew, so their record is asked
 * for again after 15 minutes instead of 6 hours (owner: "the notification should go away once the player has
 * renewed").
 */
const RECHECK_TTL_MS = 15 * 60 * 1000;
const RECHECK_DAYS = 45;

/** True when a player's membership has lapsed or ends within RECHECK_DAYS of `now`. */
export function membershipMayChange(player: PdgaPlayer | null, now = Date.now()): boolean {
  if (!player) return false;
  if (player.membershipStatus !== "current") return true;
  const ends = Date.parse(String(player.membershipExpires || "") + "T23:59:59Z");
  return Number.isFinite(ends) && ends - now <= RECHECK_DAYS * 86_400_000;
}

/**
 * How fresh a stored record must be: "lapsed" asks PDGA again whenever the stored membership isn't current (for a
 * fee or a division that depends on it); "all" always asks PDGA (the player says they just renewed).
 */
export type PdgaRefresh = "none" | "lapsed" | "all";

export type PdgaApiEnv = {
  DB: D1Like;
  RATELIMIT: KVLike;
  PDGA_API_USERNAME?: string;
  PDGA_API_PASSWORD?: string;
  PDGA_API_BASE?: string;
};

export type PdgaPlayer = {
  pdgaNumber: string;
  name: string;
  membershipStatus: string;          // "current", "expired", ...
  membershipExpires: string | null;  // YYYY-MM-DD
  rating: number | null;             // PDGA omits it for members who aren't current
  ratingDate: string | null;
  classification: "P" | "A" | null;
  city: string | null;
  state: string | null;
  country: string | null;
  url: string;
};

export type PdgaEventInfo = {
  id: number;
  name: string;
  tier: string;
  status: string;
  startDate: string;
  endDate: string;
  city: string | null;
  state: string | null;
  director: string | null;
  registrationUrl: string | null;
  url: string;
};

export class PdgaApiError extends Error {
  constructor(readonly code: "not_configured" | "rate_limited" | "unavailable" | "refused") {
    super("pdga_api_" + code);
  }
}

type Session = { cookie: string; token: string };
let memorySession: Session | null = null;

export function pdgaApiConfigured(env: Partial<PdgaApiEnv>): boolean {
  return Boolean(env.PDGA_API_USERNAME && env.PDGA_API_PASSWORD);
}

export function pdgaPlayerUrl(pdgaNumber: string | number): string {
  return "https://www.pdga.com/player/" + encodeURIComponent(String(pdgaNumber));
}

export function pdgaEventUrl(eventId: string | number): string {
  return "https://www.pdga.com/tour/event/" + encodeURIComponent(String(eventId));
}

/** A PDGA number as typed: digits only, 1–7 of them (PDGA numbers are positive integers). */
export function normalPdgaNumber(raw: unknown): string | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().replace(/^#/, "") : "";
  return /^[1-9]\d{0,6}$/.test(text) ? text : null;
}

function base(env: PdgaApiEnv): string {
  return (env.PDGA_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

const PDGA_OUTBOUND_LIMIT = 60;
const PDGA_OUTBOUND_WINDOW_MS = 10_000;
const BUDGET_PREFIX = "pdga-api:win:";
const COOLDOWN_KEY = "pdga-api:cooldown";

function retryAfterSeconds(header: string | null, now: number): number {
  if (!header) return 10;
  const num = Number(header.trim());
  if (Number.isFinite(num) && num > 0) return Math.min(120, Math.max(1, Math.ceil(num)));
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs) && dateMs > now) return Math.min(120, Math.max(1, Math.ceil((dateMs - now) / 1000)));
  return 10;
}

async function acquirePdgaBudget(env: PdgaApiEnv, now = Date.now()): Promise<void> {
  const cooldownUntil = Number(await env.RATELIMIT.get(COOLDOWN_KEY).catch(() => null));
  if (Number.isFinite(cooldownUntil) && cooldownUntil > now) throw new PdgaApiError("rate_limited");
  const key = BUDGET_PREFIX + Math.floor(now / PDGA_OUTBOUND_WINDOW_MS);
  const used = Number(await env.RATELIMIT.get(key).catch(() => null)) || 0;
  if (used >= PDGA_OUTBOUND_LIMIT) throw new PdgaApiError("rate_limited");
  await env.RATELIMIT.put(key, String(used + 1), { expirationTtl: 60 }).catch(() => {});
}

async function notePdgaRateLimited(env: PdgaApiEnv, res: Response, now = Date.now()): Promise<void> {
  const waitSec = retryAfterSeconds(res.headers.get("Retry-After"), now);
  await env.RATELIMIT.put(COOLDOWN_KEY, String(now + waitSec * 1000), { expirationTtl: Math.max(60, waitSec + 10) }).catch(() => {});
}

async function login(env: PdgaApiEnv): Promise<Session> {
  await acquirePdgaBudget(env);
  const res = await fetch(base(env) + "/services/json/user/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username: env.PDGA_API_USERNAME, password: env.PDGA_API_PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429) {
    await notePdgaRateLimited(env, res);
    throw new PdgaApiError("rate_limited");
  }
  if (res.status === 401 || res.status === 403) throw new PdgaApiError("refused");
  if (!res.ok) throw new PdgaApiError("unavailable");
  const body = (await res.json().catch(() => null)) as { sessid?: string; session_name?: string; token?: string } | null;
  if (!body?.sessid || !body.session_name) throw new PdgaApiError("refused");
  const session = { cookie: body.session_name + "=" + body.sessid, token: body.token ?? "" };
  memorySession = session;
  await env.RATELIMIT.put(SESSION_KEY, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS }).catch(() => {});
  return session;
}

async function session(env: PdgaApiEnv): Promise<Session> {
  if (memorySession) return memorySession;
  const stored = await env.RATELIMIT.get(SESSION_KEY).catch(() => null);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Session;
      if (parsed?.cookie) return (memorySession = parsed);
    } catch { /* log in again */ }
  }
  return login(env);
}

async function forgetSession(env: PdgaApiEnv) {
  memorySession = null;
  await env.RATELIMIT.delete(SESSION_KEY).catch(() => {});
}

/** GET a /services/json path with the session; logs in again once when PDGA no longer accepts it. */
async function apiGet(env: PdgaApiEnv, path: string): Promise<Record<string, unknown> | null> {
  if (!pdgaApiConfigured(env)) throw new PdgaApiError("not_configured");
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await session(env);
    await acquirePdgaBudget(env);
    const res = await fetch(base(env) + path, {
      headers: { Accept: "application/json", Cookie: current.cookie, ...(current.token ? { "X-CSRF-Token": current.token } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      await forgetSession(env);
      continue;
    }
    if (res.status === 429) {
      await notePdgaRateLimited(env, res);
      throw new PdgaApiError("rate_limited");
    }
    // status 1 (no match) comes back as 404 for a requested id that doesn't exist.
    if (res.status === 404) return null;
    if (!res.ok) throw new PdgaApiError(res.status === 401 || res.status === 403 ? "refused" : "unavailable");
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  }
  throw new PdgaApiError("refused");
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

export function parsePdgaPlayer(raw: unknown): PdgaPlayer | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const pdgaNumber = normalPdgaNumber(row.pdga_number);
  if (!pdgaNumber) return null;
  const rating = Number(row.rating);
  const classification = row.classification === "P" || row.classification === "A" ? row.classification : null;
  return {
    pdgaNumber,
    name: [text(row.first_name), text(row.last_name)].filter(Boolean).join(" ") || "PDGA #" + pdgaNumber,
    membershipStatus: text(row.membership_status)?.toLowerCase() ?? "unknown",
    membershipExpires: text(row.membership_expiration_date),
    rating: Number.isInteger(rating) && rating > 0 ? rating : null,
    ratingDate: text(row.rating_effective_date),
    classification,
    city: text(row.city),
    state: text(row.state_prov),
    country: text(row.country),
    url: pdgaPlayerUrl(pdgaNumber),
  };
}

export function parsePdgaEvent(raw: unknown): PdgaEventInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = Number(row.tournament_id);
  const name = text(row.tournament_name);
  if (!Number.isInteger(id) || id <= 0 || !name) return null;
  return {
    id, name, tier: text(row.tier) ?? "", status: text(row.status) ?? "",
    startDate: text(row.start_date) ?? "", endDate: text(row.end_date) ?? "",
    city: text(row.city), state: text(row.state_prov), director: text(row.tournament_director),
    registrationUrl: text(row.registration_url), url: pdgaEventUrl(id),
  };
}

/**
 * PDGA players by number (up to 200 per PDGA call), from D1 when read in the last few hours. A number PDGA doesn't
 * know maps to null. Throws PdgaApiError when PDGA can't be asked and nothing fresh is stored.
 */
export async function lookupPdgaPlayers(env: PdgaApiEnv, numbers: readonly string[], now = Date.now(), refresh: PdgaRefresh = "none"): Promise<Map<string, PdgaPlayer | null>> {
  const wanted = [...new Set(numbers.map(normalPdgaNumber).filter((value): value is string => value != null))];
  const found = await cachedPdgaPlayers(env, wanted, now, refresh);
  const missing = wanted.filter((number) => !found.has(number));
  for (let offset = 0; offset < missing.length; offset += 200) {
    const group = missing.slice(offset, offset + 200);
    const body = await apiGet(env, "/services/json/players?pdga_number=" + group.join(","));
    const players = Array.isArray(body?.players) ? body!.players as unknown[] : [];
    const byNumber = new Map(players.map((raw) => [normalPdgaNumber((raw as Record<string, unknown>)?.pdga_number), raw] as const));
    const writes = group.map((number) => {
      const raw = byNumber.get(number) ?? null;
      const player = raw ? parsePdgaPlayer(raw) : null;
      found.set(number, player);
      return env.DB.prepare(`INSERT INTO pdga_api_players (pdga_number, data, fetched_at) VALUES (?, ?, ?)
          ON CONFLICT(pdga_number) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`)
        .bind(number, raw ? JSON.stringify(raw) : null, now);
    });
    if (env.DB.batch) await env.DB.batch(writes);
    else for (const write of writes) await write.run();
  }
  return found;
}

/** The players read from PDGA recently enough to use without asking again (a number PDGA doesn't know maps to null). */
export async function cachedPdgaPlayers(env: Pick<PdgaApiEnv, "DB">, numbers: readonly string[], now = Date.now(), refresh: PdgaRefresh = "none"): Promise<Map<string, PdgaPlayer | null>> {
  const wanted = [...new Set(numbers.map(normalPdgaNumber).filter((value): value is string => value != null))];
  const found = new Map<string, PdgaPlayer | null>();
  if (!wanted.length || refresh === "all") return found;
  for (let offset = 0; offset < wanted.length; offset += 80) {
    const group = wanted.slice(offset, offset + 80);
    const cached = await env.DB.prepare(`SELECT pdga_number, data, fetched_at FROM pdga_api_players WHERE pdga_number IN (${group.map(() => "?").join(", ")})`)
      .bind(...group).all<{ pdga_number: string; data: string | null; fetched_at: number }>();
    for (const row of cached.results ?? []) {
      const age = now - Number(row.fetched_at);
      let player: PdgaPlayer | null = null;
      try { player = row.data ? parsePdgaPlayer(JSON.parse(row.data)) : null; } catch { continue; }
      const ttl = !row.data ? MISSING_TTL_MS : membershipMayChange(player, now) ? RECHECK_TTL_MS : FOUND_TTL_MS;
      if (age > ttl || age < 0) continue;
      if (refresh === "lapsed" && player && player.membershipStatus !== "current") continue;
      found.set(row.pdga_number, player);
    }
  }
  return found;
}

export async function lookupPdgaPlayer(env: PdgaApiEnv, pdgaNumber: string, refresh: PdgaRefresh = "none"): Promise<PdgaPlayer | null> {
  return (await lookupPdgaPlayers(env, [pdgaNumber], Date.now(), refresh)).get(normalPdgaNumber(pdgaNumber) ?? "") ?? null;
}

export type PdgaEventSearch = {
  startDate: string;              // YYYY-MM-DD
  endDate: string;                // YYYY-MM-DD
  states?: readonly string[];     // administrative_area codes, e.g. NC
  near?: { lat: number; lng: number; miles: number };
};

/** PDGA events in a date range, by state or within a distance (nearest first), every page of them (up to 1000). */
export async function searchPdgaEvents(env: PdgaApiEnv, search: PdgaEventSearch): Promise<(PdgaEventInfo & { lat: number | null; lng: number | null })[]> {
  const out: (PdgaEventInfo & { lat: number | null; lng: number | null })[] = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    const params = new URLSearchParams({ start_date: search.startDate, end_date: search.endDate, limit: "200", offset: String(offset) });
    if (search.states?.length) params.set("administrative_area", search.states.join(","));
    if (search.near) {
      params.set("latitude", String(search.near.lat));
      params.set("longitude", String(search.near.lng));
      params.set("proximity_radius", String(search.near.miles));
    }
    const body = await apiGet(env, "/services/json/event?" + params.toString());
    const events = Array.isArray(body?.events) ? body!.events as unknown[] : [];
    for (const raw of events) {
      const event = parsePdgaEvent(raw);
      if (!event) continue;
      const row = raw as Record<string, unknown>;
      const lat = Number(row.latitude);
      const lng = Number(row.longitude);
      out.push({ ...event, lat: Number.isFinite(lat) && row.latitude != null ? lat : null, lng: Number.isFinite(lng) && row.longitude != null ? lng : null });
    }
    if (events.length < 200) break;
  }
  return out;
}

export async function lookupPdgaEvent(env: PdgaApiEnv, eventId: number): Promise<PdgaEventInfo | null> {
  const body = await apiGet(env, "/services/json/event?tournament_id=" + encodeURIComponent(String(eventId)));
  const events = Array.isArray(body?.events) ? body!.events as unknown[] : [];
  return parsePdgaEvent(events[0]);
}

/**
 * Delete PDGA data past its cache time: player records older than PDGA_PLAYER_CACHE_MAX_MS and expired nearby-event
 * lists (pdga-events.ts, D1KV namespace "pdgaevents", one hour).
 */
export async function purgePdgaCaches(env: { DB: D1Like }, now = Date.now()): Promise<{ players: number; events: number }> {
  const players = await env.DB.prepare("DELETE FROM pdga_api_players WHERE fetched_at < ?").bind(now - PDGA_PLAYER_CACHE_MAX_MS).run();
  const events = await env.DB.prepare("DELETE FROM kv_store WHERE ns = ? AND expires_at IS NOT NULL AND expires_at <= ?").bind("pdgaevents", now).run();
  return { players: Number(players.meta?.changes) || 0, events: Number(events.meta?.changes) || 0 };
}

/** For tests: forget the in-memory session. */
export function resetPdgaApiSession() {
  memorySession = null;
}
