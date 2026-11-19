import type { Env } from "./env.js";
import * as db from "./db.js";
import { haversineMiles } from "./distance.js";
import { safeFetch } from "./imports.js";
import { D1KV } from "./d1kv.js";
import { pdgaApiConfigured, searchPdgaEvents, type PdgaApiEnv } from "./pdga-api.js";

export const PDGA_EVENT_MILES = 100;
export const PDGA_EVENT_CRON = "7 * * * *";
const CLUB_ORIGIN = { lat: 35.6127, lng: -77.3664 } as const;
const CACHE_TTL_SEC = 3600;
const CLUB_TIME_ZONE = "America/New_York";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const GENERIC = new Set(["the", "at", "and", "of", "disc", "golf", "course", "dgc", "park"]);

export interface PdgaEventCourse {
  name?: string | null;
  location?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface PdgaEvent {
  name: string;
  date: string;
  tier: string;
  course: string;
  place: string;
  url: string;
  lat: number | null;
  lng: number | null;
  miles: number | null;
  /** Set when the event came from the official PDGA API: its PDGA event page (names link there, with PDGA credit). */
  pdgaUrl?: string;
  /** The club event this PDGA event is, when the club runs it (its Register goes to the club's event page). */
  clubEventId?: number;
}

// How far ahead the official PDGA event search looks.
const API_EVENT_DAYS = 120;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TIER_NAMES: Record<string, string> = { M: "Major", ES: "Elite Series", NT: "National Tour", L: "League", XM: "XM-tier" };

/**
 * "Nov 22, 2026", "Nov 22-23, 2026", "Sep 13 – Dec 20, 2026" (a league still running shows its whole span, not a
 * start day already past) or "Dec 31, 2026 – Jan 1, 2027". eventDay() sorts a span by the day it shows with a year.
 */
export function pdgaApiEventDate(start: string, end: string): string {
  const [year, month, day] = start.split("-").map(Number);
  if (!year || !month || !day) return start;
  const [endYear, endMonth, endDay] = (end || start).split("-").map(Number);
  if (!endYear || !endMonth || !endDay || (endYear === year && endMonth === month)) {
    return `${SHORT_MONTHS[month - 1]} ${endDay && endDay !== day && endYear === year ? `${day}-${endDay}` : day}, ${year}`;
  }
  return endYear === year
    ? `${SHORT_MONTHS[month - 1]} ${day} – ${SHORT_MONTHS[endMonth - 1]} ${endDay}, ${year}`
    : `${SHORT_MONTHS[month - 1]} ${day}, ${year} – ${SHORT_MONTHS[endMonth - 1]} ${endDay}, ${endYear}`;
}

export function pdgaApiTierLabel(code: string): string {
  const tier = code.trim().toUpperCase();
  if (!tier) return "";
  return TIER_NAMES[tier] ?? (/^X?[ABC]$/.test(tier) ? `${tier}-tier` : tier);
}

function civilDay(now: number, plusDays = 0): string {
  const today = civilToday(now);
  const date = new Date(Date.UTC(Math.floor(today / 10000), Math.floor(today / 100) % 100 - 1, today % 100 + plusDays));
  return date.toISOString().slice(0, 10);
}

/** Nearby PDGA events from the official API (the club's developer account); null when it isn't available. */
async function apiPlacedPdgaEvents(env: Env, origin: { lat: number; lng: number }, now: number): Promise<PdgaEvent[] | null> {
  const apiEnv = env as unknown as PdgaApiEnv;
  if (!pdgaApiConfigured(apiEnv)) return null;
  try {
    const events = await searchPdgaEvents(apiEnv, {
      startDate: civilDay(now), endDate: civilDay(now, API_EVENT_DAYS), near: { ...origin, miles: PDGA_EVENT_MILES },
    });
    const today = civilDay(now);
    // The club's own PDGA events register here, not on the link PDGA lists (Disc Golf Scene, Flipt, ...).
    const ids = events.map((event) => event.id);
    const clubRun = new Map<number, number>();
    for (let offset = 0; offset < ids.length; offset += 90) {
      const group = ids.slice(offset, offset + 90);
      const rows = await env.DB.prepare(`SELECT event_id, pdga_event_id FROM event_config WHERE pdga_event_id IN (${group.map(() => "?").join(", ")})`)
        .bind(...group).all<{ event_id: number; pdga_event_id: number }>().catch(() => ({ results: [] as { event_id: number; pdga_event_id: number }[] }));
      for (const row of rows.results ?? []) clubRun.set(Number(row.pdga_event_id), Number(row.event_id));
    }
    return events
      // PDGA's search includes everything not over yet, e.g. a weekly league that began in September; the list (and
      // its Register buttons) is for events still to start, as Disc Golf Scene's list was.
      .filter((event) => !event.startDate || event.startDate >= today)
      .map((event) => {
        const point = event.lat != null && event.lng != null ? { lat: event.lat, lng: event.lng } : null;
        return {
          name: event.name, date: pdgaApiEventDate(event.startDate, event.endDate), tier: pdgaApiTierLabel(event.tier), course: "",
          place: [event.city, event.state].filter(Boolean).join(", "), pdgaUrl: event.url,
          url: clubRun.has(event.id) ? `/events#event/${clubRun.get(event.id)}` : event.registrationUrl || event.url,
          ...(clubRun.has(event.id) ? { clubEventId: clubRun.get(event.id) } : {}),
          lat: point?.lat ?? null, lng: point?.lng ?? null, miles: point ? Math.round(haversineMiles(origin, point) * 10) / 10 : null,
        };
      })
      .filter((event) => event.miles == null || event.miles <= PDGA_EVENT_MILES)
      .sort((a, b) => (eventDay(a.date) ?? Number.MAX_SAFE_INTEGER) - (eventDay(b.date) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
  } catch (error) {
    console.warn(JSON.stringify({ message: "pdga_api_nearby_events_failed", error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

export function discGolfSceneSearchUrl(lat: number, lng: number, miles = PDGA_EVENT_MILES): string {
  const params = new URLSearchParams();
  params.set("filter[location][country]", "USA");
  params.set("filter[location][latitude]", lat.toFixed(4));
  params.set("filter[location][longitude]", lng.toFixed(4));
  params.set("filter[location][distance]", String(miles));
  params.set("filter[location][units]", "mi");
  return `https://www.discgolfscene.com/tournaments/search?${params.toString()}`;
}

function decodeText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&middot;/gi, "·")
    .replace(/&/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#0*39;|'/gi, "'")
    .replace(/"/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function registrationUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "www.discgolfscene.com" && parsed.hostname !== "discgolfscene.com") return null;
  const match = parsed.pathname.match(/^\/tournaments\/([A-Za-z0-9][A-Za-z0-9_-]{2,})$/);
  if (!match || /^[A-Z]{2}$/.test(match[1]!)) return null;
  return `https://www.discgolfscene.com/tournaments/${match[1]}`;
}

function civilToday(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CLUB_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return year * 10000 + month * 100 + day;
}

function tierLabel(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > 48 || !/tier|flex|league/i.test(text)) return "";
  if (/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(text) && !/tier/i.test(text)) return "";
  return text;
}

function eventDay(date: string): number | null {
  const match = date.match(/\b([A-Za-z]{3})\s+(\d{1,2})(?:-\d{1,2})?,\s+(\d{4})\b/);
  if (!match) return null;
  const month = MONTHS[match[1]!.toLowerCase()];
  if (month == null) return null;
  return Number(match[3]) * 10000 + (month + 1) * 100 + Number(match[2]);
}

export function parseDiscGolfSceneSearch(html: string, now = Date.now()): Omit<PdgaEvent, "lat" | "lng" | "miles">[] {
  const today = civilToday(now);
  const out: Omit<PdgaEvent, "lat" | "lng" | "miles">[] = [];
  const seen = new Set<string>();
  for (const chunk of html.split('class="tournament-list list-record').slice(1)) {
    const href = chunk.match(/href="(https?:\/\/(?:www\.)?discgolfscene\.com\/tournaments\/[^"]+)"/i);
    const url = href ? registrationUrl(href[1]!) : null;
    if (!url || seen.has(url)) continue;
    const name = decodeText(chunk.match(/<span class="name">([\s\S]*?)<\/span>/i)?.[1] || "");
    if (!name) continue;
    const info = decodeText(chunk.match(/<span class="info">([\s\S]*?)<\/span>/i)?.[1] || "");
    const bolds = [...chunk.matchAll(/<b>([^<]+)<\/b>/gi)].map((match) => decodeText(match[1] || "")).filter(Boolean);
    const place = bolds.find((value) => /,\s*[A-Z]{2}\b/.test(value)) || "";
    const course = bolds.find((value) => value !== place) || "";
    const badge = decodeText(chunk.match(/list-tier[\s\S]*?<br\s*\/?>\s*([^<]+)/i)?.[1] || "");
    const tier = tierLabel(badge) || tierLabel(info.split("·")[0] || "") || "";
    const dated = info.match(/\b[A-Za-z]{3}\s+\d{1,2}(?:-\d{1,2})?,\s+\d{4}\b/)?.[0] || info;
    const day = eventDay(dated);
    if (day != null && day < today) continue;
    seen.add(url);
    out.push({ name, date: dated, tier, course, place, url });
  }
  return out;
}

export function normalizePlaceText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Distinctive course-name words (generic words such as "disc", "golf" and "park" removed). */
export function courseNameTokens(value: string): Set<string> {
  return new Set(normalizePlaceText(value).split(" ").filter((part) => part.length > 2 && !GENERIC.has(part)));
}

/** "Greenville, NC" -> { city: "greenville", state: "NC" }. */
export function cityState(value: string): { city: string; state: string } | null {
  const match = value.match(/^(.*?),\s*([A-Z]{2})\b/);
  if (!match) return null;
  return { city: normalizePlaceText(match[1] || ""), state: match[2]!.toUpperCase() };
}

function pointOf(course: PdgaEventCourse): { lat: number; lng: number } | null {
  const lat = Number(course.lat);
  const lng = Number(course.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function centroid(courses: PdgaEventCourse[]): { lat: number; lng: number } | null {
  const points = courses.map(pointOf).filter((point): point is { lat: number; lng: number } => point != null);
  if (!points.length) return null;
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
  };
}

export function locatePdgaEvent(
  event: { course: string; place: string },
  courses: PdgaEventCourse[],
): { lat: number; lng: number } | null {
  const place = cityState(event.place);
  const sameCity = place
    ? courses.filter((course) => {
        const geo = cityState(String(course.location || ""));
        return geo && geo.city === place.city && geo.state === place.state && pointOf(course);
      })
    : [];
  const want = courseNameTokens(event.course);
  let best: PdgaEventCourse | null = null;
  let bestScore = 0;
  for (const course of sameCity) {
    if (!want.size) continue;
    const have = courseNameTokens(String(course.name || ""));
    let shared = 0;
    for (const token of want) if (have.has(token)) shared += 1;
    const score = shared / want.size;
    if (score > bestScore) {
      best = course;
      bestScore = score;
    }
  }
  if (best && bestScore >= 0.5) return pointOf(best);
  return centroid(sameCity);
}

export function placePdgaEvents(
  events: Omit<PdgaEvent, "lat" | "lng" | "miles">[],
  courses: PdgaEventCourse[],
  origin: { lat: number; lng: number },
): PdgaEvent[] {
  return events
    .map((event) => {
      const point = locatePdgaEvent(event, courses);
      const miles = point ? Math.round(haversineMiles(origin, point) * 10) / 10 : null;
      return { ...event, lat: point?.lat ?? null, lng: point?.lng ?? null, miles };
    })
    .filter((event) => event.miles == null || event.miles <= PDGA_EVENT_MILES)
    .sort((a, b) => {
      const dayA = eventDay(a.date) ?? Number.MAX_SAFE_INTEGER;
      const dayB = eventDay(b.date) ?? Number.MAX_SAFE_INTEGER;
      return dayA - dayB || a.name.localeCompare(b.name);
    });
}

function cacheKey(lat: number, lng: number): string {
  return `v5:${lat.toFixed(1)}:${lng.toFixed(1)}`;
}

export function isPdgaEventCron(cron: string): boolean {
  return cron.trim() === PDGA_EVENT_CRON;
}

export function newPdgaEventNames(previous: { url: string }[], next: { url: string; name: string }[]): string[] {
  if (!previous.length) return [];
  const seen = new Set(previous.map((event) => event.url));
  return next.filter((event) => !seen.has(event.url)).map((event) => event.name);
}

async function fetchPlacedPdgaEvents(
  env: Env,
  origin: { lat: number; lng: number },
  now: number,
): Promise<PdgaEvent[]> {
  const fromApi = await apiPlacedPdgaEvents(env, origin, now);
  if (fromApi) return fromApi;
  const html = await safeFetch(discGolfSceneSearchUrl(origin.lat, origin.lng), ["discgolfscene.com"], {
    maxBytes: 2_000_000,
    timeoutMs: 12000,
  });
  const courses = (await db.listCourses(env.DB).catch(() => [])) as PdgaEventCourse[];
  return placePdgaEvents(parseDiscGolfSceneSearch(html, now), courses, origin);
}

export async function listNearbyPdgaEvents(
  env: Env,
  origin: { lat: number; lng: number },
  now = Date.now(),
): Promise<PdgaEvent[]> {
  const cache = new D1KV(env.DB, "pdgaevents");
  const key = cacheKey(origin.lat, origin.lng);
  try {
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit) as PdgaEvent[];
  } catch {
    /* fresh fetch */
  }
  const events = await fetchPlacedPdgaEvents(env, origin, now);
  try {
    await cache.put(key, JSON.stringify(events), { expirationTtl: CACHE_TTL_SEC });
  } catch {
    /* cache is best-effort */
  }
  return events;
}

export async function refreshClubPdgaEvents(
  env: Env,
  now = Date.now(),
): Promise<{ total: number; added: string[] }> {
  const cache = new D1KV(env.DB, "pdgaevents");
  const key = cacheKey(CLUB_ORIGIN.lat, CLUB_ORIGIN.lng);
  let previous: PdgaEvent[] = [];
  try {
    const hit = await cache.get(key);
    if (hit) previous = JSON.parse(hit) as PdgaEvent[];
  } catch {
    previous = [];
  }
  const events = await fetchPlacedPdgaEvents(env, CLUB_ORIGIN, now);
  try {
    await cache.put(key, JSON.stringify(events), { expirationTtl: CACHE_TTL_SEC });
  } catch {
    /* the live request path can still fetch */
  }
  return { total: events.length, added: newPdgaEventNames(previous, events) };
}
