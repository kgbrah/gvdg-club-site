import type { Env } from "./env.js";
import * as db from "./db.js";
import { haversineMiles } from "./distance.js";
import { safeFetch } from "./imports.js";
import { D1KV } from "./d1kv.js";

export const PDGA_EVENT_MILES = 100;
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
    const tier = decodeText(chunk.match(/list-tier[\s\S]*?<br\s*\/?>\s*([^<]+)/i)?.[1] || "") || info.split("·")[0]?.trim() || "";
    const dated = info.match(/\b[A-Za-z]{3}\s+\d{1,2}(?:-\d{1,2})?,\s+\d{4}\b/)?.[0] || info;
    const day = eventDay(dated);
    if (day != null && day < today) continue;
    seen.add(url);
    out.push({ name, date: dated, tier, course, place, url });
  }
  return out;
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value: string): Set<string> {
  return new Set(norm(value).split(" ").filter((part) => part.length > 2 && !GENERIC.has(part)));
}

function cityState(value: string): { city: string; state: string } | null {
  const match = value.match(/^(.*?),\s*([A-Z]{2})\b/);
  if (!match) return null;
  return { city: norm(match[1] || ""), state: match[2]!.toUpperCase() };
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
  const want = tokens(event.course);
  let best: PdgaEventCourse | null = null;
  let bestScore = 0;
  for (const course of sameCity) {
    if (!want.size) continue;
    const have = tokens(String(course.name || ""));
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
      if (a.miles == null && b.miles == null) return a.date.localeCompare(b.date) || a.name.localeCompare(b.name);
      if (a.miles == null) return 1;
      if (b.miles == null) return -1;
      if (a.miles !== b.miles) return a.miles - b.miles;
      return a.date.localeCompare(b.date) || a.name.localeCompare(b.name);
    });
}

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(1)}:${lng.toFixed(1)}`;
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
  const html = await safeFetch(discGolfSceneSearchUrl(origin.lat, origin.lng), ["discgolfscene.com"], {
    maxBytes: 2_000_000,
    timeoutMs: 12000,
  });
  const courses = (await db.listCourses(env.DB).catch(() => [])) as PdgaEventCourse[];
  const events = placePdgaEvents(parseDiscGolfSceneSearch(html, now), courses, origin);
  try {
    await cache.put(key, JSON.stringify(events), { expirationTtl: CACHE_TTL_SEC });
  } catch {
    /* cache is best-effort */
  }
  return events;
}
