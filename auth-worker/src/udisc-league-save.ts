import type { Env } from "./env.js";
import * as db from "./db.js";
import type { UdiscImportCandidate } from "./imports/udisc-events.js";
import type { UdiscPastEvent, UdiscStandings } from "./imports/udisc-standings.js";
import { resetLeagueLadderFromUdisc } from "./bag-tag-leagues.js";

const MAX_EVENTS = 80;
const MAX_RESULTS = 80;

export async function saveUdiscLeague(
  env: Env,
  adminId: string,
  input: { league: UdiscImportCandidate | null; events: UdiscImportCandidate[]; standings: UdiscStandings | null },
): Promise<{ league_id: number; events: number; results: number; skipped: number; standings: UdiscStandings["standings"] }> {
  const leagueName = input.league?.name || input.standings?.leagueName || null;
  if (!leagueName) throw new Error("league_required");
  const existingLeague = await env.DB.prepare("SELECT id, description FROM leagues WHERE name = ? COLLATE NOCASE LIMIT 1").bind(leagueName).first<{ id: number; description: string | null }>();
  const league = existingLeague ?? await db.createLeague(env.DB, {
    name: leagueName,
    season: input.league?.season || input.standings?.seasonStart?.slice(0, 4) || null,
    format: input.league?.format || null,
    description: input.league?.description || input.league?.external_url || null,
    created_by: adminId,
  }) as { id: number };
  const leagueId = Number(league.id);
  const sourceUrl = input.league?.external_url || null;
  if (existingLeague && sourceUrl && !String(existingLeague.description || "").includes(sourceUrl)) {
    const description = existingLeague.description ? `${existingLeague.description}\n${sourceUrl}` : sourceUrl;
    await db.updateLeague(env.DB, leagueId, { description });
  }
  const past = new Map<string, UdiscPastEvent>();
  for (const event of input.standings?.events || []) {
    if (event.externalUrl) past.set(event.externalUrl, event);
  }
  const planned = mergeEvents(input.events, [...past.values()]).slice(0, MAX_EVENTS);
  const currentUrl = [...past.values()].sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0]?.externalUrl || null;
  const externalUrls = [...new Set(planned.map((event) => event.external_url).filter((url): url is string => Boolean(url)))];
  const existingByUrl = new Map<string, ExistingUdiscEvent>();
  for (let i = 0; i < externalUrls.length; i += 80) {
    const chunk = externalUrls.slice(i, i + 80);
    const rows = (await env.DB.prepare(
      `SELECT id, status, external_url, league_id, date, notes FROM events WHERE external_url IN (${chunk.map(() => "?").join(",")}) ORDER BY id`,
    ).bind(...chunk).all<ExistingUdiscEvent>()).results ?? [];
    for (const row of rows) {
      if (row.external_url && !existingByUrl.has(row.external_url)) existingByUrl.set(row.external_url, row);
    }
  }
  let events = 0;
  let results = 0;
  let skipped = 0;
  for (const event of planned) {
    const scored = event.external_url ? past.get(event.external_url) : null;
    const existing = event.external_url ? existingByUrl.get(event.external_url) ?? null : null;
    const outcome = await saveEvent(env, adminId, leagueId, event, scored, input.standings, scored?.externalUrl === currentUrl, existing, existingByUrl);
    if (outcome === "skipped") skipped += 1;
    else {
      events += 1;
      results += outcome;
    }
  }
  // UDisc wins: a new tag order replaces the app's ladder and closes open challenges.
  if (input.standings?.mode === "tags") await resetLeagueLadderFromUdisc(env, leagueId);
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

function resultBreakdown(points: number | null, standings: UdiscStandings | null, current: boolean): string | null {
  if (standings?.mode === "tags") {
    return JSON.stringify({ udisc_bag_tag: true, udisc_current: current });
  }
  if (points == null) return null;
  return JSON.stringify({
    udisc_points: points,
    udisc_rounds_kept: standings?.roundsKept ?? null,
    udisc_minimum_points: standings?.minimumPoints ?? null,
  });
}

type ExistingUdiscEvent = {
  id: number;
  status: string;
  external_url: string;
  league_id: number | null;
  date: string | null;
  notes: string | null;
};

async function saveEvent(
  env: Env,
  adminId: string,
  leagueId: number,
  event: UdiscImportCandidate,
  scored: UdiscPastEvent | null | undefined,
  standings: UdiscStandings | null,
  current: boolean,
  existing: ExistingUdiscEvent | null,
  existingByUrl: Map<string, ExistingUdiscEvent>,
): Promise<number | "skipped"> {
  const url = event.external_url;
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
    if (url && eventId != null) {
      existingByUrl.set(url, { id: eventId, status, external_url: url, league_id: leagueId, date: event.date ?? null, notes: event.notes ?? null });
    }
  } else if (scored && scored.results.length) {
    const needsUpdate = existing!.status !== "final"
      || existing!.league_id !== leagueId
      || (event.date ? existing!.date !== event.date : false)
      || (event.notes ? existing!.notes !== event.notes : false);
    if (needsUpdate) {
      await db.updateEvent(env.DB, eventId, { status: "final", league_id: leagueId, date: event.date || undefined, notes: event.notes || undefined });
      if (url) existingByUrl.set(url, { ...existing!, status: "final", league_id: leagueId, date: event.date || existing!.date, notes: event.notes || existing!.notes });
    }
  } else if (existing!.league_id !== leagueId) {
    await db.updateEvent(env.DB, eventId, { league_id: leagueId });
    if (url) existingByUrl.set(url, { ...existing!, league_id: leagueId });
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
      breakdown: resultBreakdown(result.points, standings, current),
    }));
  }
  await db.runBatch(env.DB, statements);
  return statements.length - 1;
}
