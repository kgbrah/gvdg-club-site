// Which club members are registered for upcoming PDGA events in North Carolina, Virginia and South Carolina (the
// owner's choice), read from pdga.com every hour.
//
// pdga.com player pages (where a player's own upcoming events are) sit behind a Cloudflare challenge, but the event
// search and each event's page are public HTML, and an event's page lists its registered players' PDGA numbers by
// division. So each hourly tick, with a bounded number of pdga.com requests (well inside the Free plan's 50):
//   1. refreshes ONE state's upcoming events from the search (NC, VA, SC in turn, so each list is at most 3 hours old);
//   2. reads the registration lists of up to EVENTS_PER_TICK events, never one read in the last 55 minutes: events
//      starting within two weeks first (so those are read every hour), then any never read, then the least recently
//      read;
//   3. matches the registered PDGA numbers against the club's (the roster's idx:pdga:<n> keys) and records each
//      member found, with their division. Someone who withdraws drops off at the next read; finished events go.
// Parsing is a couple of regular expressions over the page text (no DOM), so it stays inside the Free plan's CPU.
//
//   GET /pdga-registrations (member) -> { mine: [event + division + going], club: [events clubmates are going to] }
//   where going = the other club members on that event's list (names only, for signed-in members).
//   GET /admin/pdga-registrations/status (admin) -> counts only: is the hourly check running, and what has it found.
import { karmaKey } from "./karma-directory.js";
import { pdgaApiConfigured, searchPdgaEvents, type PdgaApiEnv } from "./pdga-api.js";
import { adminGate, requireAuth } from "./authz.js";
import type { D1Like } from "./db-types.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { safeFetch } from "./imports.js";
import { getMember, type KVListLike } from "./roster.js";

export const WATCH_STATES = ["NC", "VA", "SC"] as const;
export type WatchState = (typeof WATCH_STATES)[number];
/** How far ahead the search looks. */
export const WATCH_DAYS = 120;
/** Event pages read per tick, and search pages per tick (25 events a page). */
export const EVENTS_PER_TICK = 16;
export const SEARCH_PAGES_PER_TICK = 4;
const SOON_DAYS = 14;
const REREAD_MINUTES = 55;
const PDGA = "https://www.pdga.com";
const HOSTS = ["www.pdga.com"];
const CLUB_TIME_ZONE = "America/New_York";

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export interface WatchEvent {
  eventId: number;
  name: string;
  tier: string;
  location: string;
  start: string;
  end: string;
}

export interface RegisteredPlayer {
  pdga: string;
  division: string;
}

export interface PdgaRegistrationTick {
  state: WatchState;
  listed: number;
  removed: number;
  read: number;
  matched: number;
  failed: number;
  pruned: number;
  skipped?: string;
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&middot;/gi, "·")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function iso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !month || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * PDGA's search dates: "November 21, 2026", "November 21 - 22, 2026", "September 13 - November 29, 2026",
 * "December 30, 2026 - January 2, 2027" -> ISO start and end; null when it can't be read.
 */
export function parsePdgaDates(value: string): { start: string; end: string } | null {
  const raw = text(value).replace(/[–—]/g, "-");
  const part = "([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?";
  const match = new RegExp(`^${part}(?:\\s*-\\s*(?:([A-Za-z]{3,9})\\.?\\s+)?(\\d{1,2})(?:,\\s*(\\d{4}))?)?$`).exec(raw);
  if (!match) return null;
  const [, m1, d1, y1, m2, d2, y2] = match;
  const startMonth = MONTHS[m1!.toLowerCase()];
  const endMonth = m2 ? MONTHS[m2.toLowerCase()] : startMonth;
  const endYear = Number(y2 || y1);
  const startYear = Number(y1 || (startMonth && endMonth && startMonth > endMonth ? endYear - 1 : endYear));
  if (!startMonth || !endMonth || !endYear) return null;
  const start = iso(startYear, startMonth, Number(d1));
  const end = d2 ? iso(endYear, endMonth, Number(d2)) : start;
  return start && end && end >= start ? { start, end } : null;
}

/** One page of PDGA's event search: its events, and whether there's a next page. */
export function parsePdgaSearch(html: string): { events: WatchEvent[]; more: boolean } {
  const events: WatchEvent[] = [];
  for (const row of html.matchAll(/<tr class="[^"]*\btid-(\d{1,9})\b[^"]*">([\s\S]*?)<\/tr>/g)) {
    const cells = row[2]!;
    const cell = (name: string) => {
      const found = new RegExp(`views-field-${name}"[^>]*>([\\s\\S]*?)<\\/td>`).exec(cells);
      return found ? text(found[1]!) : "";
    };
    const eventId = Number(row[1]);
    const name = cell("OfficialName").slice(0, 160);
    const dates = parsePdgaDates(cell("StartDate"));
    if (!eventId || !name || !dates) continue;
    events.push({
      eventId, name, tier: cell("Tier").slice(0, 20), location: cell("Location").replace(/,\s*United States$/, "").slice(0, 120),
      start: dates.start, end: dates.end,
    });
  }
  return { events, more: /class="pager-next"/.test(html) };
}

/** An event page's registered players: each PDGA number under its division heading (Tournament Directors are separate). */
export function parseRegisteredPlayers(html: string): RegisteredPlayer[] {
  const players: RegisteredPlayer[] = [];
  let division = "";
  for (const hit of html.matchAll(/<h3 class="division" id="([A-Za-z0-9]{1,12})"|<td class="pdga-number">\s*(\d{1,7})\s*<\/td>/g)) {
    if (hit[1]) division = hit[1].toUpperCase();
    else if (hit[2]) players.push({ pdga: hit[2], division });
  }
  return players;
}

/** "2026-11-18" in the club's time zone. */
export function clubDay(now: number, plusDays = 0): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: CLUB_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const date = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + plusDays));
  return date.toISOString().slice(0, 10);
}

export function pdgaSearchUrl(state: WatchState, now: number, page = 0): string {
  const params = new URLSearchParams();
  params.set("date_filter[min][date]", clubDay(now));
  params.set("date_filter[max][date]", clubDay(now, WATCH_DAYS));
  params.set("State[]", state);
  if (page > 0) params.set("page", String(page));
  return `${PDGA}/tour/search?${params.toString()}`;
}

export function pdgaEventUrl(eventId: number): string {
  return `${PDGA}/tour/event/${eventId}`;
}

/** This hour's state: NC, VA, SC in turn. */
export function stateForHour(now: number): WatchState {
  return WATCH_STATES[Math.floor(now / 3_600_000) % WATCH_STATES.length]!;
}

/** Every club member's PDGA number (from the roster's login index keys: idx:pdga:<digits>). */
async function clubPdgaNumbers(kv: KVListLike): Promise<Set<string>> {
  const numbers = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const listed = await kv.list({ prefix: "idx:pdga:", cursor, limit: 1000 });
    for (const key of listed.keys) {
      const digits = key.name.slice("idx:pdga:".length);
      if (/^\d{1,7}$/.test(digits)) numbers.add(String(Number(digits)));
    }
    if (listed.list_complete || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return numbers;
}

/** The state's upcoming events from the official PDGA API (the club's developer account); null = not available. */
async function apiWatchEvents(env: Env, state: WatchState, now: number): Promise<WatchEvent[] | null> {
  const apiEnv = env as unknown as PdgaApiEnv;
  if (!pdgaApiConfigured(apiEnv)) return null;
  try {
    const events = await searchPdgaEvents(apiEnv, { startDate: clubDay(now), endDate: clubDay(now, WATCH_DAYS), states: [state] });
    return events.map((event) => ({
      eventId: event.id, name: event.name, tier: event.tier, location: [event.city, event.state].filter(Boolean).join(", "),
      start: event.startDate, end: event.endDate || event.startDate,
    }));
  } catch (error) {
    console.warn(JSON.stringify({ message: "pdga_api_event_search_failed", state, error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

async function refreshState(env: Env, db: D1Like, state: WatchState, now: number, fetchText: (url: string) => Promise<string>) {
  const fromApi = await apiWatchEvents(env, state, now);
  const seen: WatchEvent[] = fromApi ?? [];
  let complete = fromApi != null;
  for (let page = 0; !fromApi && page < SEARCH_PAGES_PER_TICK; page++) {
    const parsed = parsePdgaSearch(await fetchText(pdgaSearchUrl(state, now, page)));
    seen.push(...parsed.events);
    if (!parsed.more) { complete = true; break; }
  }
  for (const event of seen) {
    await db.prepare(
      `INSERT INTO pdga_watch_events (event_id, name, tier, location, state, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET name = excluded.name, tier = excluded.tier, location = excluded.location,
         state = excluded.state, start_date = excluded.start_date, end_date = excluded.end_date`,
    ).bind(event.eventId, event.name, event.tier, event.location, state, event.start, event.end).run();
  }
  // A full list lets events that left it (cancelled, moved out of the window) go too.
  let removed = 0;
  if (complete) {
    const ids = new Set(seen.map((event) => event.eventId));
    const listed = (await db.prepare("SELECT event_id FROM pdga_watch_events WHERE state = ?").bind(state).all<{ event_id: number }>()).results ?? [];
    for (const row of listed) {
      if (ids.has(Number(row.event_id))) continue;
      await db.prepare("DELETE FROM pdga_registrations WHERE event_id = ?").bind(row.event_id).run();
      await db.prepare("DELETE FROM pdga_watch_events WHERE event_id = ?").bind(row.event_id).run();
      removed += 1;
    }
  }
  return { listed: seen.length, removed };
}

async function readEvent(env: Env, eventId: number, club: Set<string>, html: string): Promise<number> {
  const found = new Map<string, string>();
  for (const player of parseRegisteredPlayers(html)) {
    const pdga = String(Number(player.pdga));
    if (club.has(pdga) && !found.has(pdga)) found.set(pdga, player.division);
  }
  const keep: string[] = [];
  for (const [pdga, division] of found) {
    const memberId = await env.ROSTER.get("idx:pdga:" + pdga);
    if (!memberId) continue;
    const member = await getMember(env.ROSTER, memberId);
    if (!member) continue;
    keep.push(memberId);
    await env.DB.prepare(
      `INSERT INTO pdga_registrations (event_id, member_id, pdga_number, member_name, division) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_id, member_id) DO UPDATE SET pdga_number = excluded.pdga_number, member_name = excluded.member_name,
         division = excluded.division, seen_at = datetime('now')`,
    ).bind(eventId, memberId, pdga, String(member.name || "").slice(0, 80), division.slice(0, 12)).run();
  }
  // Whoever is no longer on the list withdrew.
  const placeholders = keep.map(() => "?").join(", ");
  await env.DB.prepare(`DELETE FROM pdga_registrations WHERE event_id = ?${keep.length ? ` AND member_id NOT IN (${placeholders})` : ""}`)
    .bind(eventId, ...keep).run();
  return keep.length;
}

/** The hourly tick (see the top of this file). `fetchText` is for tests. */
export async function runPdgaRegistrationTick(
  env: Env, now = Date.now(),
  fetchText: (url: string) => Promise<string> = (url) => safeFetch(url, HOSTS, { maxBytes: 2_000_000, timeoutMs: 12_000 }),
): Promise<PdgaRegistrationTick> {
  const db = env.DB as unknown as D1Like;
  const state = stateForHour(now);
  const today = clubDay(now);
  const summary: PdgaRegistrationTick = { state, listed: 0, removed: 0, read: 0, matched: 0, failed: 0, pruned: 0 };
  // Finished events (and who was registered) go first.
  await db.prepare("DELETE FROM pdga_registrations WHERE event_id IN (SELECT event_id FROM pdga_watch_events WHERE end_date < ?)").bind(today).run();
  summary.pruned = Number((await db.prepare("DELETE FROM pdga_watch_events WHERE end_date < ?").bind(today).run()).meta?.changes ?? 0);
  try {
    Object.assign(summary, await refreshState(env, db, state, now, fetchText));
  } catch {
    summary.skipped = "search_failed";
  }
  const club = await clubPdgaNumbers(env.ROSTER);
  if (!club.size) return { ...summary, skipped: summary.skipped ?? "no_member_pdga_numbers" };
  const soon = clubDay(now, SOON_DAYS);
  const stale = new Date(now - REREAD_MINUTES * 60_000).toISOString().replace("T", " ").slice(0, 19);
  const due = (await db.prepare(
    `SELECT event_id FROM pdga_watch_events WHERE end_date >= ? AND (read_at IS NULL OR read_at < ?)
     ORDER BY CASE WHEN start_date <= ? THEN 0 WHEN read_at IS NULL THEN 1 ELSE 2 END, read_at IS NOT NULL, read_at, start_date
     LIMIT ${EVENTS_PER_TICK}`,
  ).bind(today, stale, soon).all<{ event_id: number }>()).results ?? [];
  let failuresInARow = 0;
  for (const row of due) {
    const eventId = Number(row.event_id);
    try {
      const html = await fetchText(pdgaEventUrl(eventId));
      summary.matched += await readEvent(env, eventId, club, html);
      summary.read += 1;
      failuresInARow = 0;
      await db.prepare("UPDATE pdga_watch_events SET read_at = datetime(?, 'unixepoch'), read_error = '' WHERE event_id = ?")
        .bind(Math.floor(now / 1000), eventId).run();
    } catch (error) {
      summary.failed += 1;
      failuresInARow += 1;
      // Mark it read so a broken page doesn't block the others; it's tried again next time round.
      await db.prepare("UPDATE pdga_watch_events SET read_at = datetime(?, 'unixepoch'), read_error = ? WHERE event_id = ?")
        .bind(Math.floor(now / 1000), String((error as Error)?.message || "read_failed").slice(0, 60), eventId).run();
      if (failuresInARow >= 3) break; // pdga.com is having a bad hour
    }
  }
  return summary;
}

interface RegistrationRow {
  event_id: number;
  name: string;
  tier: string;
  location: string;
  start_date: string;
  end_date: string;
  read_at: string | null;
  member_id: string;
  member_name: string;
  division: string;
}

function eventView(row: RegistrationRow) {
  return {
    eventId: Number(row.event_id), name: row.name, tier: row.tier, location: row.location, start: row.start_date, end: row.end_date,
    url: pdgaEventUrl(Number(row.event_id)), checkedAt: row.read_at,
  };
}

/** GET /pdga-registrations: the member's own PDGA events, and the events clubmates are registered for. */
export async function handlePdgaRegistrations(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const rows = (await (env.DB as unknown as D1Like).prepare(
    `SELECT e.event_id, e.name, e.tier, e.location, e.start_date, e.end_date, e.read_at, r.member_id, r.member_name, r.division
     FROM pdga_registrations r JOIN pdga_watch_events e ON e.event_id = r.event_id
     WHERE e.end_date >= ? ORDER BY e.start_date, e.event_id, r.member_name LIMIT 600`,
  ).bind(clubDay(Date.now())).all<RegistrationRow>()).results ?? [];
  const byEvent = new Map<number, { event: ReturnType<typeof eventView>; rows: RegistrationRow[] }>();
  for (const row of rows) {
    const id = Number(row.event_id);
    if (!byEvent.has(id)) byEvent.set(id, { event: eventView(row), rows: [] });
    byEvent.get(id)!.rows.push(row);
  }
  const mine = [];
  const club = [];
  for (const { event, rows: entries } of byEvent.values()) {
    const me = entries.find((row) => row.member_id === claims.sub);
    const going = entries.filter((row) => row.member_id !== claims.sub)
      // Clubmates' PDGA numbers stay private here (the linked PDGA event page lists its players).
      .map((row) => ({ name: row.member_name, division: row.division, karmaKey: karmaKey(row.member_id) }));
    if (me) mine.push({ ...event, division: me.division, going });
    else club.push({ ...event, going });
  }
  return json({ mine, club }, 200, origin, { "Cache-Control": "private, no-store" });
}

/** GET /admin/pdga-registrations/status: counts per state and the last read, so a deploy check can see the tick ran. */
export async function handlePdgaRegistrationStatus(request: Request, env: Env, origin: string | null): Promise<Response> {
  const gate = await adminGate(request, env, origin);
  if (gate instanceof Response) return gate;
  const db = env.DB as unknown as D1Like;
  const states = (await db.prepare(
    `SELECT state, COUNT(*) AS events, SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read,
            SUM(CASE WHEN read_error <> '' THEN 1 ELSE 0 END) AS errors, MAX(read_at) AS last_read, MAX(listed_at) AS last_listed
     FROM pdga_watch_events GROUP BY state ORDER BY state`,
  ).all<{ state: string; events: number; read: number; errors: number; last_read: string | null; last_listed: string | null }>()).results ?? [];
  const totals = await db.prepare("SELECT COUNT(*) AS registrations, COUNT(DISTINCT member_id) AS members FROM pdga_registrations")
    .first<{ registrations: number; members: number }>();
  return json({
    states: states.map((row) => ({
      state: row.state, events: Number(row.events) || 0, read: Number(row.read) || 0, errors: Number(row.errors) || 0,
      lastRead: row.last_read, lastListed: row.last_listed,
    })),
    registrations: Number(totals?.registrations) || 0,
    members: Number(totals?.members) || 0,
  }, 200, origin, { "Cache-Control": "private, no-store" });
}
