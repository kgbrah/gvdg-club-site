// Turn a public UDisc league or event page into club import candidates.
// The page is a React Router turbo-stream (see imports/udisc.ts). League schedules list
// `eventListings`; a single event page exposes `eventListing` plus optional `leagueInfo`.

import type { EventCandidate } from "./events.js";
import { readUdiscPage } from "./udisc.js";

export interface UdiscImportCandidate extends EventCandidate {
  season?: string | null;
  description?: string | null;
  league_name?: string | null;
  notes?: string | null;
}

export interface UdiscCalendar {
  league: UdiscImportCandidate | null;
  events: UdiscImportCandidate[];
  resultsCount: number | null;
  page: number | null;
  pageSize: number;
}

const LEAGUE_PATH = /^\/leagues\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/[a-z0-9-]+)?\/?$/i;
const EVENT_PATH = /^\/events\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/[a-z0-9-]+)?\/?$/i;

export function normalizeUdiscEventsUrl(raw: string | null | undefined): { kind: "league" | "event"; fetchUrl: string; scheduleUrl: string | null } | null {
  if (!raw || typeof raw !== "string") return null;
  let parsed: URL;
  try { parsed = new URL(raw.trim()); } catch { return null; }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== "udisc.com" && host !== "www.udisc.com") return null;
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const league = path.match(LEAGUE_PATH);
  if (league) {
    const scheduleUrl = `https://udisc.com/leagues/${league[1]}/schedule`;
    return { kind: "league", fetchUrl: scheduleUrl, scheduleUrl };
  }
  const event = path.match(EVENT_PATH);
  if (!event) return null;
  return { kind: "event", fetchUrl: `https://udisc.com/events/${event[1]}`, scheduleUrl: null };
}

export function udiscSchedulePageUrl(scheduleUrl: string, page: number): string {
  if (page <= 1) return scheduleUrl;
  const url = new URL(scheduleUrl);
  url.searchParams.set("page", String(page));
  return url.toString();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function dateOnly(value: unknown): string | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return null;
}

function clubFormat(play: string | null): "stroke" | "doubles" | "matchplay" | null {
  const value = (play || "").toLowerCase();
  if (!value) return null;
  if (value.includes("double") || value === "teams" || value === "team") return "doubles";
  if (value.includes("match")) return "matchplay";
  if (value === "singles" || value === "stroke" || value === "individual") return "stroke";
  return null;
}

function eventSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function eventUrl(name: string, shortId: string | null, fallback: string): string {
  if (!shortId) return fallback;
  const slug = eventSlug(name);
  return slug ? `https://udisc.com/events/${slug}-${shortId}` : fallback;
}

function leagueUrl(league: Record<string, unknown>): string | null {
  const slug = text(league.slug, 160);
  const shortId = text(league.shortId, 20);
  if (slug && shortId && !slug.endsWith(shortId)) return `https://udisc.com/leagues/${slug}-${shortId}`;
  if (slug) return `https://udisc.com/leagues/${slug}`;
  return null;
}

function listingToEvent(listing: Record<string, unknown>, fallbackUrl: string, leagueName: string | null): UdiscImportCandidate | null {
  const name = text(listing.name, 200);
  if (!name) return null;
  const location = record(listing.location);
  const scoring = record(listing.scoring);
  const course = text(location?.courseName, 120);
  const layout = text(listing.layoutName, 80);
  const where = [course, text(location?.locationText, 80)].filter(Boolean).join(", ");
  const detail = [course, layout].filter(Boolean).join(" · ");
  const kind = text(listing.eventType, 40);
  return {
    type: kind === "tournament" ? "tournament" : "league_round",
    source: "udisc",
    name,
    date: dateOnly(listing.startDate) || dateOnly(listing.endDate),
    format: clubFormat(text(scoring?.playFormat, 40)),
    external_url: eventUrl(name, text(listing.shortId, 20), fallbackUrl),
    venue: where || null,
    league_name: leagueName,
    notes: detail ? `UDisc · ${detail}` : "Imported from UDisc",
  };
}

function leagueCandidate(league: Record<string, unknown>, events: UdiscImportCandidate[]): UdiscImportCandidate | null {
  const name = text(league.name, 120);
  const url = leagueUrl(league);
  if (!name || !url) return null;
  const about = text(league.longDescription, 1400);
  const season = (events.find((event) => event.date)?.date || dateOnly(record(league.leagueEventDateRange)?.firstDateIso) || "").slice(0, 4) || null;
  return {
    type: "league",
    source: "udisc",
    name,
    date: null,
    format: clubFormat(text(league.playFormat, 40)),
    external_url: url,
    season,
    description: about ? `${about}\n${url}` : url,
    venue: null,
  };
}

export function parseUdiscCalendar(html: string, pageUrl: string): UdiscCalendar {
  const empty: UdiscCalendar = { league: null, events: [], resultsCount: null, page: null, pageSize: 0 };
  const root = record(readUdiscPage(html));
  const loader = record(root?.loaderData);
  if (!loader) return empty;
  let league: Record<string, unknown> | null = null;
  let leagueInfo: Record<string, unknown> | null = null;
  const listings: Record<string, unknown>[] = [];
  let resultsCount: number | null = null;
  let page: number | null = null;
  for (const route of Object.values(loader)) {
    const data = record(route);
    if (!data) continue;
    const foundLeague = record(data.league);
    if (foundLeague?.name) league = foundLeague;
    const info = record(data.leagueInfo);
    if (info?.name) leagueInfo = info;
    const one = record(data.eventListing);
    if (one?.name) listings.push(one);
    if (Array.isArray(data.eventListings)) {
      for (const item of data.eventListings) {
        const row = record(item);
        if (row?.name) listings.push(row);
      }
    }
    if (typeof data.resultsCount === "number") resultsCount = data.resultsCount;
    if (typeof data.currentPage === "number") page = data.currentPage;
  }
  const leagueName = text(league?.name, 120) || text(leagueInfo?.name, 120);
  const events = listings
    .map((listing) => listingToEvent(listing, pageUrl, leagueName))
    .filter((event): event is UdiscImportCandidate => Boolean(event));
  const source = league || leagueInfo;
  return {
    league: source ? leagueCandidate(source, events) : null,
    events,
    resultsCount,
    page,
    pageSize: events.length,
  };
}

export function mergeUdiscCalendars(pages: UdiscCalendar[]): UdiscCalendar {
  const league = pages.find((page) => page.league)?.league ?? null;
  const events: UdiscImportCandidate[] = [];
  const seen = new Set<string>();
  let resultsCount: number | null = null;
  let page: number | null = null;
  let pageSize = 0;
  for (const item of pages) {
    if (item.resultsCount != null) resultsCount = item.resultsCount;
    if (item.page != null) page = item.page;
    pageSize = item.pageSize;
    for (const event of item.events) {
      const key = event.external_url || `${event.name}|${event.date || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  events.sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.name.localeCompare(b.name));
  return { league, events, resultsCount, page, pageSize };
}

export function udiscImportCandidates(calendar: UdiscCalendar): UdiscImportCandidate[] {
  return calendar.league ? [calendar.league, ...calendar.events] : calendar.events;
}
