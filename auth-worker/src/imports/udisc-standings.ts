// UDisc league standings pages list every counted round (event columns), the points each
// player earned, and the round score. That is enough to archive past results and rebuild
// the season table without opening every event leaderboard.

import { readUdiscPage } from "./udisc.js";
import { udiscPublicEventUrl } from "./udisc-events.js";

export interface UdiscRoundResult {
  name: string;
  place: number | null;
  total: number | null;
  toPar: number | null;
  points: number | null;
  division: string | null;
}

export interface UdiscPastEvent {
  name: string;
  date: string | null;
  shortId: string | null;
  externalUrl: string | null;
  venue: string | null;
  results: UdiscRoundResult[];
}

export interface UdiscStandingRow {
  name: string;
  points: number;
  events: number;
  wins: number;
  bestPlace: number | null;
}

export interface UdiscStandings {
  leagueName: string | null;
  shortId: string | null;
  seasonStart: string | null;
  seasonEnd: string | null;
  roundsKept: number | null;
  minimumPoints: number | null;
  events: UdiscPastEvent[];
  standings: UdiscStandingRow[];
}

const EMPTY: UdiscStandings = {
  leagueName: null,
  shortId: null,
  seasonStart: null,
  seasonEnd: null,
  roundsKept: null,
  minimumPoints: null,
  events: [],
  standings: [],
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max = 160): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function dateOnly(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function playerName(user: Record<string, unknown> | null): string | null {
  if (!user) return null;
  return text(user.fullName, 80) || text(user.leagueMemberName, 80) || text(user.name, 80);
}

export function summarizeUdiscStandings(events: UdiscPastEvent[], roundsKept: number | null, minimumPoints: number | null): UdiscStandingRow[] {
  const byName = new Map<string, { points: number[]; wins: number; best: number | null }>();
  for (const event of events) {
    for (const result of event.results) {
      const row = byName.get(result.name) ?? { points: [], wins: 0, best: null };
      if (typeof result.points === "number") row.points.push(result.points);
      if (result.place === 1) row.wins += 1;
      if (result.place != null && (row.best == null || result.place < row.best)) row.best = result.place;
      byName.set(result.name, row);
    }
  }
  const standings: UdiscStandingRow[] = [];
  for (const [name, row] of byName) {
    const ranked = [...row.points].sort((a, b) => b - a);
    const kept = roundsKept != null && roundsKept > 0 ? ranked.slice(0, roundsKept) : ranked;
    const points = kept.reduce((sum, value) => sum + value, 0);
    if (minimumPoints != null && points < minimumPoints) continue;
    standings.push({ name, points, events: row.points.length, wins: row.wins, bestPlace: row.best });
  }
  standings.sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name));
  return standings;
}

export function udiscStandingsFromLoader(root: unknown): UdiscStandings {
  const loader = record(record(root)?.loaderData);
  if (!loader) return EMPTY;
  let route: Record<string, unknown> | null = null;
  for (const value of Object.values(loader)) {
    const data = record(value);
    if (data && Array.isArray(data.points) && (Array.isArray(data.eventColumns) || record(data.usersById))) route = data;
  }
  if (!route) return EMPTY;
  const league = record(route.league);
  const season = record(route.season);
  const config = record(route.standings);
  const users = record(route.usersById) ?? {};
  const scores = record(route.eventRoundEntryResultsById) ?? {};
  const columns = Array.isArray(route.eventColumns) ? route.eventColumns : [];
  const points = Array.isArray(route.points) ? route.points : [];
  const byEvent = new Map<string, UdiscRoundResult[]>();
  for (const item of points) {
    const row = record(item);
    if (!row) continue;
    const eventId = text(row.eventListingId, 80);
    const user = record(users[text(row.userId, 80) || ""] ?? users[text(row.playerId, 80) || ""]);
    const name = playerName(user);
    if (!eventId || !name) continue;
    const score = record(scores[text(row.eventRoundEntryId, 80) || ""]);
    const results = byEvent.get(eventId) ?? [];
    results.push({
      name,
      place: whole(row.eventRanking),
      total: whole(score?.eventScore),
      toPar: whole(score?.relativeEventScore),
      points: whole(row.points),
      division: text(row.division, 40),
    });
    byEvent.set(eventId, results);
  }
  const events: UdiscPastEvent[] = [];
  for (const item of columns) {
    const column = record(item);
    if (!column) continue;
    const id = text(column._id, 80);
    const name = text(column.name, 160);
    const results = (id && byEvent.get(id)) || [];
    if (!name || !results.length) continue;
    const shortId = text(column.shortId, 20);
    const location = record(column.location);
    events.push({
      name,
      date: dateOnly(column.startDate),
      shortId,
      externalUrl: shortId ? udiscPublicEventUrl(name, shortId) : null,
      venue: text(location?.courseName, 120),
      results,
    });
  }
  const roundsKept = whole(config?.roundsKept);
  const minimumPoints = whole(config?.minimumPoints);
  return {
    leagueName: text(league?.name, 120),
    shortId: text(league?.shortId, 20),
    seasonStart: dateOnly(season?.startDate),
    seasonEnd: dateOnly(season?.endDate),
    roundsKept,
    minimumPoints,
    events,
    standings: summarizeUdiscStandings(events, roundsKept, minimumPoints),
  };
}

export function parseUdiscStandings(html: string): UdiscStandings {
  return udiscStandingsFromLoader(readUdiscPage(html));
}
