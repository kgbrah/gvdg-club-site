import { computeRoundWinners, computeTeamStandings } from "./scoring.js";

export const RYDER_CUP_LEAGUE_ID = 4;

export type RyderLeagueEvent = {
  readonly id: number;
  readonly name?: string | null;
  readonly date?: string | null;
  readonly status?: string | null;
  readonly format?: string | null;
};

export type RyderResultRow = {
  readonly event_id?: number | null;
  readonly name: string;
  readonly match_result?: string | null;
  readonly scoring_group?: string | null;
};

export type RyderMatch = {
  readonly eventId: number;
  readonly status: string;
  readonly date: string;
  readonly weekLabel: string;
  readonly num: number;
  readonly format: "singles" | "doubles";
  readonly red: readonly string[];
  readonly blue: readonly string[];
  readonly score: string;
  readonly winner: "red" | "blue" | "tie" | null;
  readonly livePath: string;
  readonly official: boolean;
};

export type RyderWeek = {
  readonly label: string;
  readonly dates: string;
  readonly format: "singles" | "doubles";
  readonly official: boolean;
  readonly matches: readonly RyderMatch[];
};

export type RyderBoard = {
  readonly scoreboard: {
    readonly red: { readonly name: string; readonly players: readonly string[] };
    readonly blue: { readonly name: string; readonly players: readonly string[] };
  };
  readonly teamPoints: { readonly red: number; readonly blue: number };
  readonly weeks: readonly RyderWeek[];
};

type GroupJson = {
  readonly label?: unknown;
  readonly teamName?: unknown;
  readonly members?: unknown;
};

type MatchJson = {
  readonly status?: unknown;
  readonly outcome?: unknown;
};

export function buildRyderCupBoard(events: readonly RyderLeagueEvent[], rows: readonly RyderResultRow[]): RyderBoard {
  const winners = computeRoundWinners([...rows]);
  const teams = computeTeamStandings([...rows]);
  const redTeam = teams.find((team) => sideFromLabel(team.team) === "red");
  const blueTeam = teams.find((team) => sideFromLabel(team.team) === "blue");
  const players = playersBySide(rows);
  const matches = [...events]
    .slice()
    .sort(compareEvents)
    .map((event) => matchFromEvent(event, rows, winners));

  const weeks = groupMatches(matches);
  return {
    scoreboard: {
      red: { name: redTeam?.teamName || "Red Team", players: players.red },
      blue: { name: blueTeam?.teamName || "Blue Team", players: players.blue },
    },
    teamPoints: { red: redTeam?.points ?? 0, blue: blueTeam?.points ?? 0 },
    weeks,
  };
}

function matchFromEvent(
  event: RyderLeagueEvent,
  rows: readonly RyderResultRow[],
  winners: Record<number, "red" | "blue" | "tie">,
): RyderMatch {
  const eventRows = rows.filter((row) => row.event_id === event.id);
  const red = uniqueNames(eventRows, "red");
  const blue = uniqueNames(eventRows, "blue");
  const parsed = parseEventTitle(event.name || "");
  const winnerRow = eventRows.find((row) => parseMatch(row.match_result)?.outcome === "won") || eventRows[0];
  const score = scoreFromMatch(parseMatch(winnerRow?.match_result));
  const status = String(event.status || "scheduled");
  return {
    eventId: event.id,
    status,
    date: String(event.date || ""),
    weekLabel: parsed.weekLabel,
    num: parsed.num ?? 0,
    format: red.length > 1 || blue.length > 1 || isDoublesName(event.name) ? "doubles" : "singles",
    red: red.length ? red : parsed.red,
    blue: blue.length ? blue : parsed.blue,
    score,
    winner: winners[event.id] ?? (status === "final" ? winnerFromRows(eventRows) : null),
    livePath: "score.html?event=" + event.id,
    official: status === "final",
  };
}

function groupMatches(matches: readonly RyderMatch[]): RyderWeek[] {
  const order: string[] = [];
  const buckets = new Map<string, RyderMatch[]>();
  for (const match of matches) {
    const label = weekLabelFor(match);
    if (!buckets.has(label)) {
      order.push(label);
      buckets.set(label, []);
    }
    buckets.get(label)!.push(match);
  }
  return order.map((label) => {
    const weekMatches = numberWeekMatches((buckets.get(label) || []).slice().sort((a, b) => a.num - b.num || a.eventId - b.eventId));
    const dates = unique(weekMatches.map((match) => match.date).filter(Boolean)).join(" · ");
    const doubles = weekMatches.filter((match) => match.format === "doubles").length;
    return {
      label,
      dates,
      format: doubles >= weekMatches.length / 2 ? "doubles" : "singles",
      official: weekMatches.some((match) => match.official),
      matches: weekMatches,
    };
  });
}

function weekLabelFor(match: RyderMatch): string {
  return match.weekLabel || match.date || "Live matches";
}

function numberWeekMatches(matches: readonly RyderMatch[]): RyderMatch[] {
  const used = new Set(matches.map((match) => match.num).filter((num) => num > 0));
  let next = 1;
  return matches.map((match) => {
    if (match.num > 0) return match;
    while (used.has(next)) next += 1;
    const num = next;
    used.add(num);
    next += 1;
    return { ...match, num };
  });
}

function parseEventTitle(name: string): { weekLabel: string; num: number | null; red: string[]; blue: string[] } {
  const finale = /\bfinale\b/i.test(name);
  const week = name.match(/week\s+(\d+)/i);
  const num = name.match(/#\s*(\d+)/);
  const vs = name.split(/\s+vs\.?\s+/i);
  const left = vs[0] ? stripEventPrefix(vs[0]) : "";
  const right = vs[1] ? stripEventPrefix(vs[1]) : "";
  return {
    weekLabel: finale ? "Finale" : week ? "Week " + week[1] : "",
    num: num ? Number(num[1]) : null,
    red: splitPair(left),
    blue: splitPair(right),
  };
}

function stripEventPrefix(value: string): string {
  return value
    .replace(/^.*ryder\s*cup\s*/i, "")
    .replace(/^week\s+\d+\s*/i, "")
    .replace(/^#\s*\d+\s*[—\-–:]+\s*/i, "")
    .replace(/ryder\s*cup.*$/i, "")
    .replace(/matchplay.*$/i, "")
    .replace(/alt-shot.*$/i, "")
    .replace(/dubs.*$/i, "")
    .trim();
}

function splitPair(value: string): string[] {
  const cleaned = value.replace(/&/g, "/").replace(/\s+and\s+/i, "/");
  return cleaned.split(/\s*\/\s*/).map((part) => part.trim()).filter(Boolean);
}

function isDoublesName(name: string | null | undefined): boolean {
  return /dubs|doubles|alt-shot/i.test(String(name || ""));
}

function uniqueNames(rows: readonly RyderResultRow[], side: "red" | "blue"): string[] {
  const names: string[] = [];
  for (const row of rows) {
    const group = parseGroup(row.scoring_group);
    if (sideFromLabel(group?.label) !== side) continue;
    const members = Array.isArray(group?.members) ? group.members : [row.name];
    for (const member of members) {
      const name = String(member || "").trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function playersBySide(rows: readonly RyderResultRow[]): { red: string[]; blue: string[] } {
  return { red: uniqueNames(rows, "red"), blue: uniqueNames(rows, "blue") };
}

function winnerFromRows(rows: readonly RyderResultRow[]): "red" | "blue" | "tie" | null {
  for (const row of rows) {
    const match = parseMatch(row.match_result);
    if (!match) continue;
    if (match.outcome === "draw") return "tie";
    if (match.outcome === "won") {
      const side = sideFromLabel(parseGroup(row.scoring_group)?.label);
      if (side) return side;
    }
  }
  return null;
}

function scoreFromMatch(match: MatchJson | null): string {
  if (!match) return "";
  const status = String(match.status || "");
  if (/^AS$/i.test(status.trim())) return "AS";
  const margin = status.match(/(\d+\s*&\s*\d+)/);
  if (margin?.[1]) return margin[1].replace(/\s+/g, "");
  if (match.outcome === "draw") return "AS";
  return "";
}

function parseMatch(raw: string | null | undefined): MatchJson | null {
  return parseJson<MatchJson>(raw);
}

function parseGroup(raw: string | null | undefined): GroupJson | null {
  return parseJson<GroupJson>(raw);
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function sideFromLabel(label: unknown): "red" | "blue" | null {
  const text = String(label ?? "").toLowerCase();
  return text.includes("red") ? "red" : text.includes("blue") ? "blue" : null;
}

function compareEvents(a: RyderLeagueEvent, b: RyderLeagueEvent): number {
  const date = String(a.date || "").localeCompare(String(b.date || ""));
  if (date) return date;
  return a.id - b.id;
}

function unique(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (value && !out.includes(value)) out.push(value);
  return out;
}
