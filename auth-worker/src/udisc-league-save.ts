import type { Env } from "./env.js";
import * as db from "./db.js";
import type { UdiscImportCandidate } from "./imports/udisc-events.js";
import type { UdiscPastEvent, UdiscStandings } from "./imports/udisc-standings.js";

const MAX_EVENTS = 80;
const MAX_RESULTS = 80;

export async function saveUdiscLeague(
  env: Env,
  adminId: string,
  input: { league: UdiscImportCandidate | null; events: UdiscImportCandidate[]; standings: UdiscStandings | null },
): Promise<{ league_id: number; events: number; results: number; skipped: number; standings: UdiscStandings["standings"] }> {
  const leagueName = input.league?.name || input.standings?.leagueName || null;
  if (!leagueName) throw new Error("league_required");
  const existingLeague = await env.DB.prepare("SELECT id FROM leagues WHERE name = ? COLLATE NOCASE LIMIT 1").bind(leagueName).first<{ id: number }>();
  const league = existingLeague ?? await db.createLeague(env.DB, {
    name: leagueName,
    season: input.league?.season || input.standings?.seasonStart?.slice(0, 4) || null,
    format: input.league?.format || null,
    description: input.league?.description || input.league?.external_url || null,
    created_by: adminId,
  }) as { id: number };
  const leagueId = Number(league.id);
  const past = new Map<string, UdiscPastEvent>();
  for (const event of input.standings?.events || []) {
    if (event.externalUrl) past.set(event.externalUrl, event);
  }
  const planned = mergeEvents(input.events, [...past.values()]).slice(0, MAX_EVENTS);
  let events = 0;
  let results = 0;
  let skipped = 0;
  for (const event of planned) {
    const scored = event.external_url ? past.get(event.external_url) : null;
    const outcome = await saveEvent(env, adminId, leagueId, event, scored, input.standings);
    if (outcome === "skipped") skipped += 1;
    else {
      events += 1;
      results += outcome;
    }
  }
  return { league_id: leagueId, events, results, skipped, standings: input.standings?.standings || [] };
}

function mergeEvents(calendar: UdiscImportCandidate[], past: UdiscPastEvent[]): UdiscImportCandidate[] {
  const seen = new Set<string>();
  const events: UdiscImportCandidate[] = [];
  for (const event of [...calendar.filter((item) => item.type !== "league"), ...past.map(pastCandidate)]) {
    const key = event.external_url || `${event.name}|${event.date || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  return events;
}

function pastCandidate(event: UdiscPastEvent): UdiscImportCandidate {
  return {
    type: "league_round",
    source: "udisc",
    name: event.name,
    date: event.date,
    format: "stroke",
    external_url: event.externalUrl,
    venue: event.venue,
    notes: event.venue ? `UDisc · ${event.venue}` : "Imported from UDisc",
  };
}

function resultBreakdown(points: number | null, standings: UdiscStandings | null): string | null {
  if (points == null) return null;
  return JSON.stringify({
    udisc_points: points,
    udisc_rounds_kept: standings?.roundsKept ?? null,
    udisc_minimum_points: standings?.minimumPoints ?? null,
  });
}

async function saveEvent(
  env: Env,
  adminId: string,
  leagueId: number,
  event: UdiscImportCandidate,
  scored: UdiscPastEvent | null | undefined,
  standings: UdiscStandings | null,
): Promise<number | "skipped"> {
  const url = event.external_url;
  const existing = url
    ? await env.DB.prepare("SELECT id, status FROM events WHERE external_url = ? LIMIT 1").bind(url).first<{ id: number; status: string }>()
    : null;
  if (existing?.status === "live") return "skipped";
  const status = scored && scored.results.length ? "final" : "scheduled";
  let eventId = existing?.id ?? null;
  if (eventId == null) {
    const created = await db.createEvent(env.DB, {
      type: event.type === "tournament" ? "tournament" : "league_round",
      name: event.name,
      status,
      format: event.format,
      date: event.date,
      league_id: leagueId,
      source: "udisc",
      external_url: url,
      notes: event.notes || null,
      created_by: adminId,
    }) as { id?: number } | null;
    eventId = created?.id ?? null;
  } else if (scored && scored.results.length) {
    await db.updateEvent(env.DB, eventId, { status: "final", league_id: leagueId, date: event.date || undefined, notes: event.notes || undefined });
  } else {
    await db.updateEvent(env.DB, eventId, { league_id: leagueId });
  }
  if (eventId == null || !scored?.results.length) return 0;
  const statements = [db.clearResultsStmt(env.DB, eventId)];
  for (const result of scored.results.slice(0, MAX_RESULTS)) {
    statements.push(db.createResultStmt(env.DB, {
      event_id: eventId,
      name: result.name,
      place: result.place,
      total: result.total,
      to_par: result.toPar,
      breakdown: resultBreakdown(result.points, standings),
    }));
  }
  await db.runBatch(env.DB, statements);
  return statements.length - 1;
}
