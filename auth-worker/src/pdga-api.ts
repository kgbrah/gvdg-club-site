// The PDGA REST API (https://www.pdga.com/dev): players and events, read with the club's developer account
// (PDGA_API_USERNAME / PDGA_API_PASSWORD secrets). Terms: non-commercial use by a current PDGA member; at most 70
// requests per 10 seconds per IP (login included); every screen showing PDGA data says "Player, event, and course
// data provided by PDGA" and links names to pdga.com. The PDGA asks to review an app before it launches.
//
// The session from a login is reused (in memory, and in RATELIMIT storage across isolates) until PDGA refuses it.
// Player records are kept in D1 for a few hours, so a registration form and its submit don't each call PDGA.

import type { D1Like } from "./db-types.js";
import type { KVLike } from "./ratelimit.js";

export const PDGA_ATTRIBUTION = "Player, event, and course data provided by PDGA";
const DEFAULT_BASE = "https://api.pdga.com";
const SESSION_KEY = "pdga-api:session";
const SESSION_TTL_SECONDS = 6 * 60 * 60;
const FOUND_TTL_MS = 6 * 60 * 60 * 1000;
const MISSING_TTL_MS = 60 * 60 * 1000;

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

async function login(env: PdgaApiEnv): Promise<Session> {
  const res = await fetch(base(env) + "/services/json/user/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username: env.PDGA_API_USERNAME, password: env.PDGA_API_PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429) throw new PdgaApiError("rate_limited");
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
    const res = await fetch(base(env) + path, {
      headers: { Accept: "application/json", Cookie: current.cookie, ...(current.token ? { "X-CSRF-Token": current.token } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      await forgetSession(env);
      continue;
    }
    if (res.status === 429) throw new PdgaApiError("rate_limited");
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
export async function lookupPdgaPlayers(env: PdgaApiEnv, numbers: readonly string[], now = Date.now()): Promise<Map<string, PdgaPlayer | null>> {
  const wanted = [...new Set(numbers.map(normalPdgaNumber).filter((value): value is string => value != null))];
  const found = new Map<string, PdgaPlayer | null>();
  if (!wanted.length) return found;
  const cached = await env.DB.prepare(`SELECT pdga_number, data, fetched_at FROM pdga_api_players WHERE pdga_number IN (${wanted.map(() => "?").join(", ")})`)
    .bind(...wanted).all<{ pdga_number: string; data: string | null; fetched_at: number }>();
  for (const row of cached.results ?? []) {
    const age = now - Number(row.fetched_at);
    if (age > (row.data ? FOUND_TTL_MS : MISSING_TTL_MS) || age < 0) continue;
    found.set(row.pdga_number, row.data ? parsePdgaPlayer(JSON.parse(row.data)) : null);
  }
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

export async function lookupPdgaPlayer(env: PdgaApiEnv, pdgaNumber: string): Promise<PdgaPlayer | null> {
  return (await lookupPdgaPlayers(env, [pdgaNumber])).get(normalPdgaNumber(pdgaNumber) ?? "") ?? null;
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

/** For tests: forget the in-memory session. */
export function resetPdgaApiSession() {
  memorySession = null;
}
