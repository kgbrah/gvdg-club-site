import { parseCsvRows } from "./csv.js";

export const UDISC_HISTORY_MAX_ROUNDS = 2000;
export const UDISC_HISTORY_MAX_CSV_CHARS = 1_500_000;

export interface UdiscHistoryHole {
  hole: number;
  par: number | null;
  strokes: number;
}

export interface UdiscHistoryRound {
  roundKey: string;
  playerName: string;
  courseName: string;
  layoutName: string;
  playedAt: string;
  sourcePlayedAt?: string;
  sourceFinishedAt?: string;
  total: number | null;
  toPar: number | null;
  holes: UdiscHistoryHole[];
}

export type UdiscHistoryParse =
  | { rounds: UdiscHistoryRound[]; players: string[] }
  | { error: "unrecognized_csv" | "empty" | "too_many" };

function norm(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normUdiscPlayer(value: string): string {
  return norm(value);
}

function clip(value: string, max: number): string {
  const text = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return text.length > max ? text.slice(0, max) : text;
}

function headerKey(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_]+/g, "");
}

function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function udiscRoundKey(playerName: string, courseName: string, layoutName: string, playedAt: string): string {
  return fnv1a64([norm(playerName), norm(courseName), norm(layoutName), playedAt].join("\n"));
}

/** Local wall time. Old exports: `Date` `2024-03-15 1014`. Current Scorecards: `StartDate` `2025-05-10 1000-0400` (offset is the zone, not a UTC shift). */
export function parseUdiscPlayedAt(value: string): string | null {
  const text = value.trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(.+))?$/.exec(text);
  if (!date) return null;
  const month = Number(date[2]);
  const day = Number(date[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let hour = 0;
  let minute = 0;
  const clock = (date[4] || "").trim().replace(/\s*[+-]\d{2}:?\d{2}$/, "");
  if (clock) {
    const ampm = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])$/.exec(clock);
    const hm = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(clock);
    const compact = /^(\d{3,4})$/.exec(clock);
    if (ampm) {
      hour = Number(ampm[1]);
      minute = Number(ampm[2]);
      const suffix = ampm[3]!.toLowerCase();
      if (hour < 1 || hour > 12 || minute > 59) return null;
      if (suffix === "pm" && hour < 12) hour += 12;
      if (suffix === "am" && hour === 12) hour = 0;
    } else if (hm) {
      hour = Number(hm[1]);
      minute = Number(hm[2]);
      if (hour > 23 || minute > 59) return null;
    } else if (compact) {
      const digits = compact[1]!;
      hour = Number(digits.slice(0, digits.length - 2));
      minute = Number(digits.slice(-2));
      if (hour > 23 || minute > 59) return null;
    } else {
      return null;
    }
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date[1]}-${date[2]}-${date[3]}T${pad(hour)}:${pad(minute)}:00`;
}

function parseTotal(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 2000 ? n : null;
}

function parseToPar(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  if (/^(e|even|\+0|-0|0)$/i.test(text)) return 0;
  const signed = /^([+-])\s*(\d+)$/.exec(text);
  if (!signed) return null;
  const n = Number(signed[2]);
  if (n > 200) return null;
  return signed[1] === "-" ? -n : n;
}

function parseCount(value: string, max: number): number | null {
  const text = value.trim();
  if (!text || text === "-" || text === "0") return null;
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= max ? n : null;
}

function remap(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) out[headerKey(key)] = value;
  return out;
}

function holeColumns(headers: string[]): number[] {
  const holes: number[] = [];
  for (const header of headers) {
    const match = /^hole(\d+)$/.exec(header);
    if (!match) continue;
    const hole = Number(match[1]);
    if (hole >= 1 && hole <= 36) holes.push(hole);
  }
  return [...new Set(holes)].sort((a, b) => a - b);
}

function rowWhen(row: Record<string, string>): string {
  return row.startdate || row.date || "";
}

/** Drop UDisc's scratched-hole placeholder only when par + to_par consistency or single unambiguous gap confirms it. */
function dropScratchedHole(
  strokes: Map<number, number>,
  total: number | null,
  toPar: number | null,
  parFor: ReadonlyMap<number, number>,
): Map<number, number> {
  if (total == null) return strokes;
  let sum = 0;
  for (const score of strokes.values()) sum += score;
  const gap = sum - total;
  if (gap <= 0) return strokes;
  if (toPar != null && parFor.size > 0 && [...strokes.keys()].every((hole) => parFor.has(hole))) {
    let rawToPar = 0;
    for (const [hole, score] of strokes.entries()) rawToPar += score - parFor.get(hole)!;
    const expectedPar = gap - (rawToPar - toPar);
    if (expectedPar >= 2 && expectedPar <= 6) {
      const matches = [...strokes.entries()].filter(([hole, score]) => score === gap && parFor.get(hole) === expectedPar);
      if (matches.length === 1) {
        const next = new Map(strokes);
        next.delete(matches[0]![0]);
        return next;
      }
    }
    return strokes;
  }
  if (gap > 12) return strokes;
  const matches = [...strokes.entries()].filter(([, score]) => score === gap);
  if (matches.length !== 1) return strokes;
  const next = new Map(strokes);
  next.delete(matches[0]![0]);
  return next;
}

export function parseUdiscHistory(csv: string): UdiscHistoryParse {
  if (typeof csv !== "string" || !csv.trim() || csv.length > UDISC_HISTORY_MAX_CSV_CHARS) {
    return { error: "unrecognized_csv" };
  }
  const text = csv.includes("\u0000") ? csv.replace(/\u0000/g, "") : csv;
  const parsed = parseCsvRows(text).map(remap);
  if (!parsed.length) return { error: "unrecognized_csv" };
  const headers = Object.keys(parsed[0] || {});
  const holes = holeColumns(headers);
  const hasWhen = headers.includes("date") || headers.includes("startdate");
  if (!headers.includes("playername") || !headers.includes("coursename") || !hasWhen || !holes.length) {
    return { error: "unrecognized_csv" };
  }

  const pars = new Map<string, Map<number, number>>();
  const playerRows: { playerName: string; courseName: string; layoutName: string; playedAt: string; sourcePlayedAt: string; sourceFinishedAt?: string; total: number | null; toPar: number | null; strokes: Map<number, number> }[] = [];
  for (const row of parsed) {
    const playerName = clip(row.playername || "", 80);
    const courseName = clip(row.coursename || "", 120);
    const layoutName = clip(row.layoutname || "", 80);
    const sourcePlayedAt = rowWhen(row).trim();
    const playedAt = parseUdiscPlayedAt(sourcePlayedAt);
    if (!playerName || !courseName || !playedAt) continue;
    const cardKey = [norm(courseName), norm(layoutName), playedAt].join("\n");
    if (norm(playerName) === "par") {
      const parFor = pars.get(cardKey) || new Map<number, number>();
      for (const hole of holes) {
        const par = parseCount(row["hole" + hole] || "", 8);
        if (par != null && par >= 2) parFor.set(hole, par);
      }
      pars.set(cardKey, parFor);
      continue;
    }
    const rawStrokes = new Map<number, number>();
    for (const hole of holes) {
      const score = parseCount(row["hole" + hole] || "", 40);
      if (score != null) rawStrokes.set(hole, score);
    }
    if (!rawStrokes.size) continue;
    const sourceFinishedAt = row.enddate?.trim();
    playerRows.push({
      playerName,
      courseName,
      layoutName,
      playedAt,
      sourcePlayedAt,
      ...(sourceFinishedAt && parseUdiscPlayedAt(sourceFinishedAt) ? { sourceFinishedAt } : {}),
      total: parseTotal(row.total || ""),
      toPar: parseToPar(row["+/-"] || row.topar || ""),
      strokes: rawStrokes,
    });
  }

  const byKey = new Map<string, UdiscHistoryRound>();
  for (const row of playerRows) {
    const cardKey = [norm(row.courseName), norm(row.layoutName), row.playedAt].join("\n");
    const parFor = pars.get(cardKey) || new Map<number, number>();
    const strokes = dropScratchedHole(row.strokes, row.total, row.toPar, parFor);
    if (!strokes.size) continue;
    const holeRows: UdiscHistoryHole[] = [...strokes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hole, strokes]) => ({ hole, par: parFor.get(hole) ?? null, strokes }));
    let toPar = row.toPar;
    if (toPar == null && holeRows.every((hole) => hole.par != null)) {
      toPar = holeRows.reduce((sum, hole) => sum + hole.strokes - (hole.par || 0), 0);
    }
    const round: UdiscHistoryRound = {
      roundKey: udiscRoundKey(row.playerName, row.courseName, row.layoutName, row.playedAt),
      playerName: row.playerName,
      courseName: row.courseName,
      layoutName: row.layoutName,
      playedAt: row.playedAt,
      sourcePlayedAt: row.sourcePlayedAt,
      ...(row.sourceFinishedAt ? { sourceFinishedAt: row.sourceFinishedAt } : {}),
      total: row.total ?? holeRows.reduce((sum, hole) => sum + hole.strokes, 0),
      toPar,
      holes: holeRows,
    };
    byKey.set(round.roundKey, round);
  }
  const rounds = [...byKey.values()];
  if (rounds.length > UDISC_HISTORY_MAX_ROUNDS * 6) return { error: "too_many" };
  if (!rounds.length) return { error: "empty" };
  const players: string[] = [];
  const seen = new Set<string>();
  for (const round of rounds) {
    const key = norm(round.playerName);
    if (seen.has(key)) continue;
    seen.add(key);
    players.push(round.playerName);
  }
  return { rounds, players };
}

export function chooseUdiscPlayer(
  players: readonly string[],
  preferred: { name?: string | null; udisc?: string | null },
  requested?: string | null,
): { player: string } | { players: string[] } | { error: "unknown_player" } {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const player of players) {
    const name = player.trim();
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  const requestedName = requested?.trim() || "";
  if (requestedName) {
    const found = unique.find((player) => norm(player) === norm(requestedName));
    if (!found) return { error: "unknown_player" };
    return { player: found };
  }
  if (unique.length === 1) return { player: unique[0]! };
  const hints = [preferred.name, preferred.udisc].map((value) => norm(value || "")).filter(Boolean);
  const matches = unique.filter((player) => hints.includes(norm(player)));
  if (matches.length === 1) return { player: matches[0]! };
  return { players: unique };
}
