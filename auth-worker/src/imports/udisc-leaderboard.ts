// Bag-tag leagues have no /standings page. Each event leaderboard carries the round
// scores, and the latest finished round is the current tag order.

import { readUdiscPage } from "./udisc.js";
import type { UdiscPastEvent, UdiscRoundResult, UdiscStandings, UdiscStandingRow } from "./udisc-standings.js";

export interface UdiscLeaderboard {
  finished: boolean;
  results: UdiscRoundResult[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max = 80): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function resultRow(row: Record<string, unknown>): UdiscRoundResult | null {
  const name = text(row.name, 80);
  if (!name) return null;
  const state = text(row.eventEntryState, 40);
  if (state && state !== "active") return null;
  const place = whole(row.ranking);
  if (place == null && row.isComplete !== true) return null;
  return {
    name,
    place,
    total: whole(row.eventScore) ?? whole(row.currentRoundScore),
    toPar: whole(row.relativeEventScore) ?? whole(row.relativeRoundScore),
    points: null,
    division: text(row.division, 40),
  };
}

export function udiscLeaderboardFromLoader(root: unknown): UdiscLeaderboard {
  const loader = record(record(root)?.loaderData);
  let route: Record<string, unknown> | null = null;
  if (loader) {
    for (const value of Object.values(loader)) {
      const data = record(value);
      if (data && Array.isArray(data.roundEntryResults)) route = data;
    }
  }
  if (!route) return { finished: false, results: [] };
  const results = (route.roundEntryResults as unknown[]).map((item) => resultRow(record(item) || {})).filter((row): row is UdiscRoundResult => Boolean(row));
  const rounds = Array.isArray(route.rounds) ? route.rounds : [];
  const roundFinished = rounds.some((item) => record(item)?.status === "finished");
  const progressValue = record(record(route.publicRoundPreviewProps)?.progress)?.percentage;
  const progress = typeof progressValue === "number" && Number.isFinite(progressValue) ? progressValue : null;
  const stillPlaying = progress != null && progress < 100 && !roundFinished;
  const complete = results.length > 0 && results.every((row) => row.place != null);
  return { finished: !stillPlaying && (roundFinished || progress === 100 || (progress == null && complete)), results };
}

export function parseUdiscLeaderboard(html: string): UdiscLeaderboard {
  return udiscLeaderboardFromLoader(readUdiscPage(html));
}

export function tagStandingsFromBoards(
  leagueName: string | null,
  boards: { name: string; date: string | null; externalUrl: string | null; venue: string | null; finished: boolean; results: UdiscRoundResult[] }[],
): UdiscStandings | null {
  const events: UdiscPastEvent[] = boards
    .filter((board) => board.finished && board.results.length)
    .map((board) => ({
      name: board.name,
      date: board.date,
      shortId: null,
      externalUrl: board.externalUrl,
      venue: board.venue,
      results: board.results,
    }))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (!events.length) return null;
  return {
    leagueName,
    shortId: null,
    seasonStart: events[0]?.date || null,
    seasonEnd: events[events.length - 1]?.date || null,
    roundsKept: null,
    minimumPoints: null,
    events,
    standings: summarizeTagOrder(events),
    mode: "tags",
  };
}

export function summarizeTagOrder(events: UdiscPastEvent[]): UdiscStandingRow[] {
  const played = new Map<string, { events: number; wins: number; best: number | null }>();
  for (const event of events) {
    for (const result of event.results) {
      const row = played.get(result.name) ?? { events: 0, wins: 0, best: null };
      row.events += 1;
      if (result.place === 1) row.wins += 1;
      if (result.place != null && (row.best == null || result.place < row.best)) row.best = result.place;
      played.set(result.name, row);
    }
  }
  const latest = events[events.length - 1];
  const ordered = [...(latest?.results || [])].sort((a, b) => (a.place ?? 999) - (b.place ?? 999) || a.name.localeCompare(b.name));
  const seen = new Set<string>();
  const standings: UdiscStandingRow[] = [];
  for (const result of ordered) {
    if (seen.has(result.name)) continue;
    seen.add(result.name);
    const row = played.get(result.name);
    standings.push({ name: result.name, points: 0, events: row?.events || 1, wins: row?.wins || 0, bestPlace: row?.best ?? result.place });
  }
  for (const [name, row] of played) {
    if (seen.has(name)) continue;
    standings.push({ name, points: 0, events: row.events, wins: row.wins, bestPlace: row.best });
  }
  return standings;
}
