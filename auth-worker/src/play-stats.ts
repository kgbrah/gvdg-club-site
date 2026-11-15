import type { Breakdown } from "./score-breakdown.js";
import type { PlayerState } from "./scoring.js";

import { holePlayStats } from "../../src/shared/shot-stats-model.js";
export { PARKED_FT, FAIRWAY_WIDTH_FT, CIRCLE1_M, CIRCLE2_M, regulationStrokes, holePlayStats } from "../../src/shared/shot-stats-model.js";

export type PlayTotals = {
  holes: number;
  aces: number;
  eagles: number;
  birdies: number;
  pars: number;
  bogeys: number;
  doubles_plus: number;
  birdie_hit: number;
  par_hit: number;
  fir_hit: number;
  fir_att: number;
  c1r_hit: number;
  c1r_att: number;
  c2r_hit: number;
  c2r_att: number;
  parked_hit: number;
  parked_att: number;
  scramble_hit: number;
  scramble_att: number;
  c1_putt_hit: number;
  c1_putt_att: number;
  c1x_putt_hit: number;
  c1x_putt_att: number;
  shot_eligible_holes: number;
  shot_count_matched_holes: number;
  shot_verified_holes: number;
  shot_incomplete_holes: number;
  c2_putt_hit: number;
  c2_putt_att: number;
};

export type PlayCategory = {
  id: string;
  label: string;
  short: string;
  hit: keyof PlayTotals;
  att: keyof PlayTotals;
  min: number;
  invert: boolean;
  group: "mix" | "score" | "throw";
  tone: "ace" | "eagle" | "birdie" | "par" | "bogey" | "double" | null;
};

type HolePoint = { lat?: number | null; lng?: number | null } | null | undefined;
type HoleInput = {
  hole?: number;
  par?: number | null;
  tee?: HolePoint;
  target?: HolePoint;
  basket?: HolePoint;
};

export function emptyPlayTotals(): PlayTotals {
  return {
    holes: 0,
    aces: 0,
    eagles: 0,
    birdies: 0,
    pars: 0,
    bogeys: 0,
    doubles_plus: 0,
    birdie_hit: 0,
    par_hit: 0,
    fir_hit: 0,
    fir_att: 0,
    c1r_hit: 0,
    c1r_att: 0,
    c2r_hit: 0,
    c2r_att: 0,
    parked_hit: 0,
    parked_att: 0,
    scramble_hit: 0,
    scramble_att: 0,
    c1_putt_hit: 0,
    c1_putt_att: 0,
    c1x_putt_hit: 0,
    c1x_putt_att: 0,
    shot_eligible_holes: 0,
    shot_count_matched_holes: 0,
    shot_verified_holes: 0,
    shot_incomplete_holes: 0,
    c2_putt_hit: 0,
    c2_putt_att: 0,
  };
}

function applyScoreMix(totals: PlayTotals, par: number, strokes: number) {
  if (!Number.isInteger(strokes) || strokes <= 0 || !Number.isInteger(par) || par <= 0) return;
  totals.holes += 1;
  const delta = strokes - par;
  if (strokes === 1) totals.aces += 1;
  else if (delta <= -2) totals.eagles += 1;
  else if (delta === -1) totals.birdies += 1;
  else if (delta === 0) totals.pars += 1;
  else if (delta === 1) totals.bogeys += 1;
  else totals.doubles_plus += 1;
  if (delta === -1) totals.birdie_hit += 1;
  if (delta === 0) totals.par_hit += 1;
}

function addSample(totals: PlayTotals, value: { hit: number; att: number } | null, hitKey: keyof PlayTotals, attKey: keyof PlayTotals) {
  if (!value) return;
  totals[hitKey] += value.hit;
  totals[attKey] += value.att;
}

export function roundPlayStats(
  holes: readonly HoleInput[] | null | undefined,
  throwsByHole: Record<number, unknown> | null | undefined,
  scores: Record<number, number> | null | undefined,
): PlayTotals {
  const totals = emptyPlayTotals();
  for (const hole of holes || []) {
    const n = Number(hole.hole);
    const strokes = scores?.[n];
    applyScoreMix(totals, Number(hole.par), Number(strokes));
    const stats = holePlayStats(hole, throwsByHole?.[n], strokes);
    addSample(totals, stats.fir, "fir_hit", "fir_att");
    addSample(totals, stats.c1r, "c1r_hit", "c1r_att");
    addSample(totals, stats.c2r, "c2r_hit", "c2r_att");
    addSample(totals, stats.parked, "parked_hit", "parked_att");
    addSample(totals, stats.scramble, "scramble_hit", "scramble_att");
    addSample(totals, stats.c1Putt, "c1_putt_hit", "c1_putt_att");
    addSample(totals, stats.c1xPutt, "c1x_putt_hit", "c1x_putt_att");
    if (Number.isInteger(Number(strokes)) && Number(strokes) > 1) {
      totals.shot_eligible_holes += 1;
      if (stats.shotQuality === "estimated") totals.shot_count_matched_holes += 1;
      if (stats.shotQuality === "recorded") totals.shot_verified_holes += 1;
      if (stats.shotQuality === "incomplete") totals.shot_incomplete_holes += 1;
    }
    addSample(totals, stats.c2Putt, "c2_putt_hit", "c2_putt_att");
  }
  return totals;
}

export function parseBreakdown(raw: unknown): PlayTotals {
  const totals = emptyPlayTotals();
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return totals; }
  }
  if (!obj || typeof obj !== "object") return totals;
  const row = obj as Record<string, unknown>;
  const n = (key: string) => {
    const value = row[key];
    if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const aces = n("aces");
  let eagles = n("eagles");
  const birdies = n("birdies");
  const pars = n("pars");
  const bogeys = n("bogeys");
  const doubles = n("doubles_plus");
  const mix = aces + eagles + birdies + pars + bogeys + doubles;
  const holes = n("holes");
  if (holes && mix > holes && aces) eagles = Math.max(0, eagles - aces);
  totals.aces = aces;
  totals.eagles = eagles;
  totals.birdies = birdies;
  totals.pars = pars;
  totals.bogeys = bogeys;
  totals.doubles_plus = doubles;
  totals.holes = holes || (aces + eagles + birdies + pars + bogeys + doubles);
  totals.birdie_hit = birdies;
  totals.par_hit = pars;
  totals.fir_hit = n("fir_hit");
  totals.fir_att = n("fir_att");
  totals.c1r_hit = n("c1r_hit");
  totals.c1r_att = n("c1r_att");
  totals.c2r_hit = n("c2r_hit");
  totals.c2r_att = n("c2r_att");
  totals.parked_hit = n("parked_hit");
  totals.parked_att = n("parked_att");
  totals.scramble_hit = n("scramble_hit");
  totals.scramble_att = n("scramble_att");
  totals.c1_putt_hit = n("c1_putt_hit");
  totals.c1_putt_att = n("c1_putt_att");
  totals.c1x_putt_hit = n("c1x_putt_hit");
  totals.c1x_putt_att = n("c1x_putt_att");
  totals.shot_eligible_holes = n("shot_eligible_holes");
  totals.shot_count_matched_holes = n("shot_count_matched_holes");
  totals.shot_verified_holes = n("shot_verified_holes");
  totals.shot_incomplete_holes = n("shot_incomplete_holes");
  totals.c2_putt_hit = n("c2_putt_hit");
  totals.c2_putt_att = n("c2_putt_att");
  return totals;
}

export function sumPlayTotals(rows: readonly unknown[]): PlayTotals {
  const totals = emptyPlayTotals();
  for (const row of rows) {
    const parsed = parseBreakdown(row && typeof row === "object" && "breakdown" in row ? (row as { breakdown?: unknown }).breakdown : row);
    (Object.keys(totals) as (keyof PlayTotals)[]).forEach((key) => {
      totals[key] += parsed[key] || 0;
    });
  }
  return totals;
}

export function totalsFromHoleScores(pars: readonly unknown[], scores: readonly unknown[]): PlayTotals {
  const totals = emptyPlayTotals();
  const n = Math.min(pars.length, scores.length);
  for (let i = 0; i < n; i += 1) applyScoreMix(totals, Number(pars[i]), Number(scores[i]));
  return totals;
}

export function parseScoreCsv(raw: unknown, limit?: number): number[] {
  const values = String(raw || "").split(",");
  const out: number[] = [];
  for (const value of values) {
    const n = Number(String(value).trim());
    if (!Number.isInteger(n) || n <= 0) {
      if (out.length) break;
      continue;
    }
    out.push(n);
    if (limit && out.length >= limit) break;
  }
  return out;
}

export function totalsFromPdgaScoreLine(scoresRaw: unknown, parsRaw: unknown, holes: unknown): PlayTotals {
  const scores = parseScoreCsv(scoresRaw);
  const pars = parseScoreCsv(parsRaw);
  const n = Math.min(Number(holes) || 18, scores.length, pars.length);
  return totalsFromHoleScores(pars.slice(0, n), scores.slice(0, n));
}

type PlayInput = {
  scores?: Record<number, number> | null;
  throws?: Record<number, unknown> | null;
  memberId?: string | null;
  name?: string;
  removed?: boolean;
};

export function mergePartnerPlayInputs(players: readonly PlayInput[] | null | undefined) {
  const scores: Record<number, number> = {};
  const throwsByHole: Record<number, unknown> = {};
  for (const player of players || []) {
    if (!player) continue;
    for (const [hole, score] of Object.entries(player.scores || {})) {
      const n = Number(hole);
      if (scores[n] == null && Number.isFinite(Number(score)) && Number(score) > 0) scores[n] = Number(score);
    }
    for (const [hole, marks] of Object.entries(player.throws || {})) {
      const n = Number(hole);
      if (throwsByHole[n] == null && Array.isArray(marks) && marks.length) throwsByHole[n] = marks;
    }
  }
  return { scores, throws: throwsByHole };
}

export function partnersForStanding(
  standing: { memberId?: string | null; name?: string; scoringGroup?: { targetType?: string; members?: readonly string[] } | null } | null | undefined,
  players: readonly PlayInput[],
): PlayInput[] {
  const group = standing?.scoringGroup;
  if (group?.targetType === "pair" && Array.isArray(group.members) && group.members.length) {
    const names = new Set(group.members.map((name) => String(name)));
    const partners = players.filter((player) => player && !player.removed && names.has(String(player.name || "")));
    if (partners.length) return partners;
  }
  const one = players.find((row) => !row.removed && (standing?.memberId
    ? row.memberId === standing.memberId
    : standing && !row.memberId && row.name === standing.name));
  return one ? [one] : [];
}

export const PLAY_CATEGORIES: readonly PlayCategory[] = [
  { att: "holes", group: "mix", hit: "aces", id: "ace", invert: false, label: "Ace", min: 18, short: "Ace", tone: "ace" },
  { att: "holes", group: "mix", hit: "eagles", id: "eagle", invert: false, label: "Eagle", min: 18, short: "Eagle", tone: "eagle" },
  { att: "holes", group: "mix", hit: "birdies", id: "birdieMix", invert: false, label: "Birdie", min: 18, short: "Birdie", tone: "birdie" },
  { att: "holes", group: "mix", hit: "pars", id: "parMix", invert: false, label: "Par", min: 18, short: "Par", tone: "par" },
  { att: "holes", group: "mix", hit: "bogeys", id: "bogey", invert: true, label: "Bogey", min: 18, short: "Bogey", tone: "bogey" },
  { att: "holes", group: "mix", hit: "doubles_plus", id: "double", invert: true, label: "Double+", min: 18, short: "Dbl+", tone: "double" },
  { att: "holes", group: "score", hit: "birdie_hit", id: "birdie", invert: false, label: "Birdie", min: 18, short: "Birdie", tone: "birdie" },
  { att: "holes", group: "score", hit: "par_hit", id: "par", invert: false, label: "Par", min: 18, short: "Par", tone: "par" },
  { att: "fir_att", group: "throw", hit: "fir_hit", id: "fir", invert: false, label: "Fairways", min: 9, short: "FIR", tone: null },
  { att: "c1r_att", group: "throw", hit: "c1r_hit", id: "c1r", invert: false, label: "C1 in reg", min: 9, short: "C1R", tone: null },
  { att: "c2r_att", group: "throw", hit: "c2r_hit", id: "c2r", invert: false, label: "C2 in reg", min: 9, short: "C2R", tone: null },
  { att: "c1_putt_att", group: "throw", hit: "c1_putt_hit", id: "c1Putt", invert: false, label: "C1 putting", min: 8, short: "C1 putt", tone: null },
  { att: "c1x_putt_att", group: "throw", hit: "c1x_putt_hit", id: "c1xPutt", invert: false, label: "C1X putting", min: 8, short: "C1X putt", tone: null },
  { att: "c2_putt_att", group: "throw", hit: "c2_putt_hit", id: "c2Putt", invert: false, label: "C2 putting", min: 5, short: "C2 putt", tone: null },
  { att: "parked_att", group: "throw", hit: "parked_hit", id: "parked", invert: false, label: "Parked", min: 6, short: "Parked", tone: null },
  { att: "scramble_att", group: "throw", hit: "scramble_hit", id: "scramble", invert: false, label: "Scramble", min: 5, short: "Scramble", tone: null },
];

export const SCORE_MIX_IDS = PLAY_CATEGORIES.filter((row) => row.group === "mix").map((row) => row.id);

export function statPct(hit: number, att: number): number | null {
  if (!att) return null;
  return Math.round((1000 * hit) / att) / 10;
}

type RankPlayer = { memberId?: string | null; name?: string; totals: PlayTotals };

function playerSample(player: RankPlayer | null | undefined, category: PlayCategory) {
  if (!player) return null;
  const hit = player.totals[category.hit] || 0;
  const att = player.totals[category.att] || 0;
  return {
    att,
    hit,
    memberId: player.memberId ?? null,
    name: player.name || "Player",
    pct: statPct(hit, att),
  };
}

export function rankCategory(players: readonly RankPlayer[], category: PlayCategory) {
  const eligible = players.flatMap((player) => {
    const hit = player.totals[category.hit] || 0;
    const att = player.totals[category.att] || 0;
    if (att < category.min) return [];
    return [{
      att,
      hit,
      memberId: player.memberId ?? null,
      name: player.name || "Player",
      pct: statPct(hit, att),
    }];
  });
  const dir = category.invert ? 1 : -1;
  eligible.sort((a, b) => (dir * ((a.pct ?? 0) - (b.pct ?? 0))) || (b.att - a.att) || a.name.localeCompare(b.name));
  return eligible.map((row, index) => ({ ...row, field: eligible.length, rank: index + 1 }));
}

export function playStatsView(
  players: readonly RankPlayer[],
  memberId: string | null,
) {
  const me = players.find((player) => player.memberId && player.memberId === memberId) || null;
  return PLAY_CATEGORIES.map((category) => {
    const ranked = rankCategory(players, category);
    const rankedMine = ranked.find((row) => row.memberId && row.memberId === memberId) || null;
    const sample = playerSample(me, category);
    const mine = rankedMine || (sample && sample.att
      ? { ...sample, field: ranked.length, rank: null as number | null }
      : null);
    return {
      field: ranked.length,
      group: category.group,
      id: category.id,
      invert: category.invert,
      label: category.label,
      leaders: ranked.slice(0, 5),
      mine,
      min: category.min,
      short: category.short,
      tone: category.tone,
    };
  });
}

type PlayRow = {
  memberId?: unknown;
  member_id?: unknown;
  name?: unknown;
  breakdown?: unknown;
  kind?: unknown;
  groupFormat?: unknown;
  group_format?: unknown;
  scoringStyle?: unknown;
  scoring_style?: unknown;
};

export const PLAY_GROUPS = ["all", "singles", "doubles"] as const;
export const PLAY_STYLES = ["all", "stroke", "matchplay"] as const;

export function playRowKind(row: PlayRow | null | undefined): "casual" | "competitive" | "pdga" {
  const kind = String(row?.kind || "").toLowerCase();
  if (kind === "casual") return "casual";
  if (kind === "pdga") return "pdga";
  return "competitive";
}

export function playRowGroup(row: PlayRow | null | undefined): "singles" | "doubles" {
  return String(row?.groupFormat || row?.group_format || "").toLowerCase() === "doubles" ? "doubles" : "singles";
}

export function playRowStyle(row: PlayRow | null | undefined): "stroke" | "matchplay" | "putting" {
  const style = String(row?.scoringStyle || row?.scoring_style || "").toLowerCase();
  if (style === "matchplay") return "matchplay";
  if (style === "putting") return "putting";
  return "stroke";
}

export function playViewKey(group: string | null | undefined, style: string | null | undefined): string {
  const g = group === "doubles" || group === "singles" ? group : "all";
  const s = style === "matchplay" || style === "stroke" ? style : "all";
  return `${g}-${s}`;
}

function playersFromRows(rows: readonly PlayRow[]): RankPlayer[] {
  const byMember = new Map<string, { breakdowns: unknown[]; memberId: string; name: string }>();
  for (const raw of rows) {
    const memberId = String(raw.memberId || raw.member_id || "");
    if (!memberId) continue;
    const current = byMember.get(memberId) || { breakdowns: [], memberId, name: String(raw.name || "Player") };
    if (raw.name) current.name = String(raw.name);
    current.breakdowns.push(raw.breakdown != null ? raw.breakdown : raw);
    byMember.set(memberId, current);
  }
  return [...byMember.values()].map((player) => ({
    memberId: player.memberId,
    name: player.name,
    totals: sumPlayTotals(player.breakdowns.map((breakdown) => ({ breakdown }))),
  }));
}

export function playStatsBucket(rows: readonly PlayRow[], memberId: string | null) {
  const players = playersFromRows(rows);
  const me = players.find((player) => player.memberId === memberId);
  return {
    categories: playStatsView(players, memberId),
    mine: me
      ? { memberId: me.memberId, name: me.name, totals: me.totals }
      : { memberId: memberId || "", name: "", totals: emptyPlayTotals() },
  };
}

export function playStatsKindPayload(rows: readonly PlayRow[], memberId: string | null) {
  const views: Record<string, ReturnType<typeof playStatsBucket>> = {};
  for (const group of PLAY_GROUPS) {
    for (const style of PLAY_STYLES) {
      const filtered = rows.filter((row) => (
        playRowStyle(row) !== "putting" &&
        (group === "all" || playRowGroup(row) === group) &&
        (style === "all" || playRowStyle(row) === style)
      ));
      views[playViewKey(group, style)] = playStatsBucket(filtered, memberId);
    }
  }
  const all = views[playViewKey("all", "all")] ?? playStatsBucket([], memberId);
  return { ...all, views };
}

export function selectPlayStatsView(
  kindPayload: ReturnType<typeof playStatsKindPayload> | null | undefined,
  group: string | null | undefined,
  style: string | null | undefined,
) {
  if (!kindPayload) return null;
  const key = playViewKey(group, style);
  return kindPayload.views?.[key] || kindPayload;
}

export function playStatsByKind(rows: readonly PlayRow[], memberId: string | null) {
  const competitive: PlayRow[] = [];
  const casual: PlayRow[] = [];
  const pdga: PlayRow[] = [];
  for (const row of rows) {
    const kind = playRowKind(row);
    if (kind === "casual") casual.push(row);
    else if (kind === "pdga") pdga.push(row);
    else competitive.push(row);
  }
  return {
    casual: playStatsKindPayload(casual, memberId),
    competitive: playStatsKindPayload(competitive, memberId),
    pdga: playStatsKindPayload(pdga, memberId),
  };
}

export function parseThrowsBody(body: unknown): { hole: number; throws: { lat: number; lng: number; n: number }[] } | null {
  if (!body || typeof body !== "object") return null;
  const hole = Number((body as { hole?: unknown }).hole);
  if (!Number.isInteger(hole) || hole < 1 || hole > 36) return null;
  const raw = (body as { throws?: unknown }).throws;
  if (!Array.isArray(raw) || raw.length > 18) return null;
  const throws: { lat: number; lng: number; n: number }[] = [];
  for (const row of raw) {
    const lat = Number((row as { lat?: unknown })?.lat);
    const lng = Number((row as { lng?: unknown })?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    throws.push({ lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)), n: throws.length + 1 });
  }
  return { hole, throws };
}

export function withPlayBreakdown(
  breakdown: Breakdown,
  player: PlayInput | PlayerState | null | undefined,
  holes: readonly HoleInput[],
): Breakdown & PlayTotals {
  const play = roundPlayStats(holes, player?.throws ?? {}, player?.scores ?? {});
  return { ...breakdown, ...play };
}
