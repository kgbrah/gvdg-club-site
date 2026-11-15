import type { D1Like } from "./db-types.js";
import { emptyPlayTotals, parseBreakdown, roundPlayStats, statPct, sumPlayTotals, type PlayTotals } from "./play-stats.js";
import { SHOT_STAT_DEFINITIONS } from "../../src/shared/shot-stats-model.js";
import { parseShotRows, shotHoleGeometry, shotPoint, validLedgerRevision } from "../../src/shared/shot-ledger.js";
import type { ArchivedShotLedger } from "./shot-ledgers.js";

type RoundSource = "competitive" | "casual" | "udisc";
type GroupFormat = "singles" | "doubles" | "unknown";
type ScoringStyle = "stroke" | "matchplay" | "putting";
type Point = { lat: number; lng: number; label?: string };
type Mark = { lat: number; lng: number; n: number };
type LayoutAtPlay = { tee: Point | null; target: Point | null; distanceFt: number | null; overridden: boolean };
type Hole = {
  hole: number; par: number | null; strokes: number | null; points: number | null;
  distanceFt: number | null; layoutAtPlay: LayoutAtPlay | null;
  marks: Mark[]; marksStatus: "saved" | "none" | "unattributed";
  shotLedger?: ArchivedShotLedger;
};
type Round = {
  id: string; source: RoundSource; resultId: number; eventId: number | null; roundCode: string | null;
  importedRoundKey: string | null; importedAt: string | null;
  playedAt: string | null; playedDate: string | null; eventName: string | null;
  courseId: number | null; courseName: string | null; layoutId: number | null; layoutName: string | null;
  group: GroupFormat; style: ScoringStyle; total: number | null; toPar: number | null;
  holes: Hole[]; savedBreakdown: Partial<PlayTotals> | null;
};
type Clip = {
  id: number; scope: "round" | "event"; scopeKey: string; hole: number; createdAt: string;
  contentType: string; bytes: number; highlight: boolean; moment: string | null; mediaPath: string;
};
type Row = Record<string, unknown>;

const ROUND_QUERIES: Record<RoundSource, string> = {
  competitive: `SELECT res.id, res.event_id, res.total, res.to_par, res.breakdown, res.scorecard,
      res.scoring_group, res.match_result, e.name AS event_name, e.date AS event_date,
      res.created_at AS played_at, e.format AS event_format, e.course_id, e.layout_id,
      c.name AS course_name, l.name AS layout_name, ec.live_scoring_config AS scoring_config,
      ec.play_format, private_shots.ledger_json AS shot_ledger,
      EXISTS (SELECT 1 FROM results other WHERE other.event_id = res.event_id AND other.id != res.id
          AND other.name = res.name AND other.member_id IS NOT res.member_id) AS name_collision
    FROM results res
    JOIN events e ON e.id = res.event_id
    LEFT JOIN courses c ON c.id = e.course_id
    LEFT JOIN course_layouts l ON l.id = e.layout_id
    LEFT JOIN event_config ec ON ec.event_id = e.id
    LEFT JOIN round_shot_ledgers private_shots ON private_shots.event_result_id = res.id AND private_shots.member_id = res.member_id
    WHERE res.member_id = ?`,
  casual: `SELECT res.id, res.total, res.to_par, res.breakdown, res.scorecard,
      res.scoring_group, res.match_result, r.round_code, r.course_id, r.layout_id,
      COALESCE(NULLIF(r.course_name, ''), c.name) AS course_name,
      COALESCE(NULLIF(r.layout_name, ''), l.name) AS layout_name,
      COALESCE(NULLIF(r.started_at, ''), r.finalized_at, res.created_at) AS played_at, r.holes AS round_holes,
      r.scoring_config, private_shots.ledger_json AS shot_ledger,
      EXISTS (SELECT 1 FROM casual_results other WHERE other.casual_round_id = res.casual_round_id
          AND other.id != res.id AND other.name = res.name AND other.member_id IS NOT res.member_id) AS name_collision
    FROM casual_results res
    JOIN casual_rounds r ON r.id = res.casual_round_id
    LEFT JOIN courses c ON c.id = r.course_id
    LEFT JOIN course_layouts l ON l.id = r.layout_id
    LEFT JOIN round_shot_ledgers private_shots ON private_shots.casual_result_id = res.id AND private_shots.member_id = res.member_id
    WHERE res.member_id = ?`,
  udisc: `SELECT id, round_key, imported_at, course_name, layout_name, played_at, total, to_par,
      holes AS scorecard FROM udisc_history res WHERE member_id = ?`,
};

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function records(value: unknown): Row[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.map(record) : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  const parsed = number(value);
  return parsed != null && Number.isInteger(parsed) ? parsed : null;
}

function point(value: unknown): Point | null {
  const row = record(value);
  const lat = number(row.lat);
  const lng = number(row.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, ...(typeof row.label === "string" ? { label: row.label } : {}) };
}

function archivedLedger(value: unknown): ArchivedShotLedger | null {
  const data = record(value);
  const rows = parseShotRows(data.rows);
  const geometry = record(data.geometry);
  const { revision, scope, binding, targetId, label, version, matchesResult } = data;
  if (!rows?.length || typeof revision !== "string" || !validLedgerRevision(revision) ||
      typeof binding !== "string" || typeof targetId !== "string" || typeof label !== "string" ||
      typeof version !== "number" || !Number.isSafeInteger(version) || (scope !== "team" && scope !== "player")) return null;
  return {
    rows, revision, scope, binding, targetId, label, version, matchesResult: matchesResult === true,
    geometry: { tee: shotPoint(geometry.tee), target: shotPoint(geometry.target) },
  };
}

function exactDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

const easternDateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
function easternDate(date: Date): string {
  const parts = easternDateFormat.formatToParts(date);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
}

function playedDate(localDate: string | null, timestamp: string | null): string | null {
  const wallDate = exactDate(localDate?.slice(0, 10) ?? null);
  if (wallDate) return wallDate;
  if (!timestamp) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)
    ? timestamp.replace(" ", "T") + "Z" : timestamp;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? easternDate(date) : exactDate(timestamp.slice(0, 10));
}

function normalRound(raw: Row, source: RoundSource): Round | null {
  const resultId = integer(raw.id);
  if (!resultId) return null;
  const eventId = integer(raw.event_id);
  const roundCode = string(raw.round_code);
  const importedRoundKey = string(raw.round_key);
  const groupConfig = record(parseJson(raw.scoring_group));
  const roundConfig = record(parseJson(raw.scoring_config));
  const group = source === "udisc" ? "unknown" :
    [groupConfig.targetType, roundConfig.groupFormat, raw.event_format, raw.play_format].some((s) => s === "doubles" || s === "pair") ? "doubles" : "singles";
  const style = Object.keys(record(parseJson(raw.match_result))).length || [roundConfig.scoringStyle, raw.event_format].includes("matchplay")
    ? "matchplay" : [roundConfig.scoringStyle, raw.event_format].includes("putting") ? "putting" : "stroke";
  const byHole = new Map<number, Hole>();
  const sources = [
    ...records(raw.round_holes).map((row) => ({ row, scorecard: false })),
    ...records(raw.scorecard).map((row) => ({ row, scorecard: true })),
  ];
  const layoutIdentity = sources.map(({ row }) => record(row.layoutAtPlay)).find((row) =>
    row.courseId != null || row.layoutId != null || row.courseName != null || row.layoutName != null,
  ) ?? {};
  for (const { row, scorecard } of sources) {
    const hole = integer(row.hole);
    if (hole == null || hole < 1 || hole > 36) continue;
    const prior = byHole.get(hole);
    const asPlayed = record(row.layoutAtPlay);
    const distanceFt = number(asPlayed.distance_ft) ?? number(row.distance_ft) ?? prior?.distanceFt ?? null;
    const layoutAtPlay = Object.keys(asPlayed).length ? {
      tee: point(asPlayed.tee), target: point(asPlayed.target), distanceFt, overridden: asPlayed.overridden === true,
    } : prior?.layoutAtPlay ?? null;
    const knownOwner = row.throwsProvenance === "member";
    // Old finalized cards copied team marks to both players, and resolved names before IDs.
    const owned = group !== "doubles" && (knownOwner ||
      (row.throwsProvenance == null && raw.name_collision !== 1));
    const rawMarks = Array.isArray(row.throws) ? row.throws : [];
    const marks = owned ? rawMarks.flatMap((mark, i) => {
      const p = point(mark);
      const n = integer(record(mark).n) ?? i + 1;
      return p && n > 0 ? [{ lat: p.lat, lng: p.lng, n }] : [];
    }) : [];
    byHole.set(hole, {
      hole, par: integer(row.par) ?? prior?.par ?? null,
      strokes: scorecard ? integer(row.strokes) : prior?.strokes ?? null,
      points: number(row.points) ?? prior?.points ?? null,
      distanceFt, layoutAtPlay, marks,
      marksStatus: marks.length ? "saved" : rawMarks.length && !owned ? "unattributed" : "none",
    });
  }
  for (const [key, rawLedger] of Object.entries(record(parseJson(raw.shot_ledger)))) {
    const hole = Number(key);
    const shotLedger = archivedLedger(rawLedger);
    if (!Number.isInteger(hole) || hole < 1 || hole > 36 || !shotLedger) continue;
    const prior = byHole.get(hole);
    byHole.set(hole, prior ? { ...prior, shotLedger } : {
      hole, par: null, strokes: null, points: null, distanceFt: null, layoutAtPlay: null,
      marks: [], marksStatus: "none", shotLedger,
    });
  }
  const breakdown = record(parseJson(raw.breakdown));
  const savedBreakdown = Object.keys(breakdown).length ? Object.fromEntries(
    Object.keys(emptyPlayTotals()).flatMap((key) => {
      const count = integer(breakdown[key]);
      return count != null && count >= 0 ? [[key, count]] : [];
    }),
  ) : null;
  const eventDate = string(raw.event_date);
  const timestamp = string(raw.played_at);
  return {
    id: source + ":" + (eventId ?? roundCode ?? importedRoundKey ?? resultId) + ":" + resultId,
    source, resultId, eventId, roundCode, importedRoundKey,
    importedAt: string(raw.imported_at), playedAt: eventDate ?? timestamp,
    playedDate: playedDate(source === "udisc" ? timestamp : eventDate, timestamp),
    eventName: string(raw.event_name), courseId: integer(layoutIdentity.courseId) ?? integer(raw.course_id),
    courseName: string(layoutIdentity.courseName) ?? string(raw.course_name),
    layoutId: integer(layoutIdentity.layoutId) ?? integer(raw.layout_id), layoutName: string(layoutIdentity.layoutName) ?? string(raw.layout_name),
    group, style, total: number(raw.total), toPar: number(raw.to_par), holes: [...byHole.values()],
    // Team results include aggregate scores, but may also contain another player's historical mark counts.
    savedBreakdown: savedBreakdown && (group === "doubles" || raw.name_collision === 1) ? Object.fromEntries(
      Object.entries(savedBreakdown).filter(([key]) => /^(holes|aces|eagles|birdies|pars|bogeys|doubles_plus|birdie_hit|par_hit)$/.test(key)),
    ) : savedBreakdown,
  };
}

export const HISTORY_LIMIT_PER_SOURCE = 2_000;
const ROUND_SOURCES: RoundSource[] = ["competitive", "casual", "udisc"];

async function* scanHistoryRounds(db: D1Like, memberId: string, status: { truncated: boolean }): AsyncGenerator<Round> {
  const batchSize = 125;
  for (const source of ROUND_SOURCES) {
    let remaining = HISTORY_LIMIT_PER_SOURCE;
    let before = Number.MAX_SAFE_INTEGER;
    while (remaining > 0) {
      const batch = Math.min(batchSize, remaining);
      const dbResult = await db.prepare(ROUND_QUERIES[source] + " AND res.id < ? ORDER BY res.id DESC LIMIT ?")
        .bind(memberId, before, batch + 1).all();
      if (!dbResult.success) throw new Error("play_history_read_failed");
      const rows = dbResult.results.slice(0, batch);
      for (const row of rows) {
        const round = normalRound(row, source);
        if (round) yield round;
      }
      if (dbResult.results.length <= batch) break;
      remaining -= batch;
      if (!remaining) status.truncated = true;
      before = integer(rows.at(-1)?.id) ?? 0;
    }
  }
}

function exportClips(rows: Row[]): Clip[] {
  return rows.flatMap((row) => {
    const id = integer(row.id);
    const hole = integer(row.hole);
    const scope = row.scope;
    const scopeKey = string(row.scope_key);
    if (!id || !hole || (scope !== "round" && scope !== "event") || !scopeKey) return [];
    const base = scope === "event" ? "/events/" : "/rounds/";
    return [{
      id, scope, scopeKey, hole, createdAt: string(row.created_at) ?? "",
      contentType: string(row.content_type) ?? "", bytes: integer(row.bytes) ?? 0,
      highlight: row.highlight === 1, moment: string(row.moment),
      mediaPath: base + encodeURIComponent(scopeKey) + "/live/clips/" + id + "/media",
    }];
  });
}

export const PLAY_EXPORT_PAGE_SIZE = 100;
export type ExportCursor = { section: number; after: number };

export function parseExportCursor(raw: string | null): ExportCursor | null {
  if (!raw) return { section: 0, after: 0 };
  const match = /^([0-3]):(\d{1,16})$/.exec(raw);
  return match && Number.isSafeInteger(Number(match[2])) ? { section: Number(match[1]), after: Number(match[2]) } : null;
}

export async function readPersonalPlayPage(db: D1Like, memberId: string, cursor: ExportCursor) {
  const rounds: Round[] = [];
  const clips: Clip[] = [];
  let remaining = PLAY_EXPORT_PAGE_SIZE;
  let after = cursor.after;
  let next: string | null = null;
  for (let section = cursor.section; section <= ROUND_SOURCES.length && remaining > 0; section += 1) {
    const source = ROUND_SOURCES[section];
    const sql = source ? ROUND_QUERIES[source] + " AND res.id > ? ORDER BY res.id LIMIT ?" :
      `SELECT id, scope, scope_key, hole, content_type, bytes, highlight, moment, created_at
       FROM throw_clips WHERE filmed_by = ? AND id > ? ORDER BY id LIMIT ?`;
    const response = await db.prepare(sql).bind(memberId, after, remaining + 1).all();
    if (!response.success) throw new Error("play_export_read_failed");
    const results = response.results.slice(0, remaining);
    if (source) {
      for (const row of results) {
        const round = normalRound(row, source);
        if (round) rounds.push(round);
      }
    } else clips.push(...exportClips(results));
    remaining -= results.length;
    if (response.results.length > results.length) {
      next = section + ":" + integer(results.at(-1)?.id);
      break;
    }
    if (!remaining && section < ROUND_SOURCES.length) next = (section + 1) + ":0";
    after = 0;
  }
  return { rounds, clips, next };
}

export async function readRoundShotHistory(db: D1Like, memberId: string, source: "competitive" | "casual", resultId: number) {
  const raw = await db.prepare(ROUND_QUERIES[source] + " AND res.id = ?").bind(memberId, resultId).first();
  const round = raw ? normalRound(raw, source) : null;
  return round ? round.holes.filter((hole) => hole.shotLedger).map(({ hole, strokes, shotLedger }) => ({ hole, strokes, shotLedger })) : null;
}

export const PLAY_EXPORT_SCHEMA = "gvdg-play-export-1";

export function personalPlayExport(memberId: string, rounds: Round[], clips: Clip[], exportedAt = new Date().toISOString()) {
  return {
    schemaVersion: PLAY_EXPORT_SCHEMA, exportedAt, memberId,
    definitions: {
      ...SHOT_STAT_DEFINITIONS,
      scope: "Saved GVDG results, imported UDisc rounds, and clips uploaded by this account. Active cards and local drafts are not archived results.",
      layout: "Course/layout IDs identify the saved round's layout record or configured event layout. Older cards may have hole pars and distances but no archived tee or target. Current map positions are not substituted.",
      marks: "Coordinates are the saved positions, ordered by n. Doubles and ambiguous legacy mark ownership are excluded. Empty marks do not imply no throws.",
      shotLedger: "Explicit edits are exported with their saved classifications, measurements, and basket and tee. Team ledgers describe the team's observed strokes. A changed team assignment excludes the earlier ledger from statistics.",
      clips: "Clip references identify videos uploaded by this account; video bytes are not embedded and existing access rules apply.",
      csv: "Each data_json cell contains the exact record. Use it to recover text that CSV spreadsheet protection prefixes with an apostrophe.",
    },
    rounds, clips,
  };
}

export function escapePlayCsv(value: string | number | null | undefined): string {
  if (value == null) return "";
  if (typeof value === "number") return String(value);
  // Quoting alone does not stop spreadsheet cells from evaluating a formula.
  const safe = /^[\s\uFEFF]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r\n]/u.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

export function personalPlayCsv(data: ReturnType<typeof personalPlayExport>): string {
  const header = ["record_type", "schema_version", "member_id", "round_id", "source", "played_at", "course", "layout", "hole", "par", "strokes", "data_json"];
  const lines: string[] = [];
  function line(type: string, round: Round | null, hole: Hole | null, record: unknown) {
    lines.push([
      type, data.schemaVersion, data.memberId, round?.id, round?.source, round?.playedAt,
      round?.courseName, round?.layoutName, hole?.hole, hole?.par, hole?.strokes, JSON.stringify(record),
    ].map(escapePlayCsv).join(","));
  }
  line("manifest", null, null, { schemaVersion: data.schemaVersion, exportedAt: data.exportedAt, memberId: data.memberId, definitions: data.definitions });
  for (const round of data.rounds) {
    const { holes, ...summary } = round;
    line("round", round, null, summary);
    for (const hole of holes) line("hole", round, hole, hole);
  }
  for (const clip of data.clips) line("clip", null, null, clip);
  return header.join(",") + "\r\n" + lines.join("\r\n") + "\r\n";
}

const HISTORY_MODES = ["all", "year", "last", "custom"] as const;
type HistoryMode = typeof HISTORY_MODES[number];
const MAX_LAST_ROUNDS = 200;
type HistoryFilter = {
  window: HistoryMode; from: string | null; to: string | null; last: number | null;
  source: RoundSource | "all"; group: GroupFormat | "all"; style: Exclude<ScoringStyle, "putting"> | "all";
  course: string; layout: string; hole: number | null;
};
type FilterOption = { key: string; label: string };

export function parsePlayHistoryFilter(params: URLSearchParams, now = new Date()): HistoryFilter | null {
  const window = params.get("window") ?? "year";
  const source = params.get("source") ?? "all";
  const group = params.get("group") ?? "singles";
  const style = params.get("style") ?? "stroke";
  if (window !== "all" && window !== "year" && window !== "last" && window !== "custom") return null;
  if (source !== "all" && source !== "competitive" && source !== "casual" && source !== "udisc") return null;
  if (group !== "all" && group !== "singles" && group !== "doubles" && group !== "unknown") return null;
  if (style !== "all" && style !== "stroke" && style !== "matchplay") return null;
  const course = params.get("course") ?? "";
  const layout = params.get("layout") ?? "";
  if (course.length > 512 || layout.length > 1_024) return null;
  const rawHole = params.get("hole");
  const hole = rawHole ? Number(rawHole) : null;
  if (hole != null && (!Number.isInteger(hole) || hole < 1 || hole > 36)) return null;
  const from = window === "year" ? easternDate(now).slice(0, 4) + "-01-01" : window === "custom" ? exactDate(params.get("from")) : null;
  const to = window === "year" ? easternDate(now).slice(0, 4) + "-12-31" : window === "custom" ? exactDate(params.get("to")) : null;
  if (window === "custom" && (!from || !to || from > to)) return null;
  const last = window === "last" ? Number(params.get("last") ?? 10) : null;
  if (last != null && (!Number.isInteger(last) || last < 1 || last > MAX_LAST_ROUNDS)) return null;
  return { window, from, to, last, source, group, style, course, layout, hole };
}

function courseKey(round: Round): string {
  return round.courseId != null ? "id:" + round.courseId : round.courseName ? "name:" + round.courseName : "unknown";
}

function layoutKey(round: Round): string {
  return round.layoutId != null ? "id:" + round.layoutId : round.layoutName ? JSON.stringify([courseKey(round), round.layoutName]) : "unknown";
}

function sortedOptions(options: Map<string, string>): FilterOption[] {
  return [...options].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

function summarizeRound(round: Round, selectedHole: number | null) {
  const holes = selectedHole == null ? round.holes : round.holes.filter((hole) => hole.hole === selectedHole);
  const scores: Record<number, number> = {};
  const marks: Record<number, unknown> = {};
  for (const hole of holes) {
    if (hole.strokes != null) scores[hole.hole] = hole.strokes;
    // Shot totals need archived geometry; current pin positions can silently change apparent distances.
    if (hole.shotLedger?.matchesResult) marks[hole.hole] = hole.shotLedger.rows;
    else if (hole.layoutAtPlay?.target) marks[hole.hole] = hole.marks;
  }
  const play = roundPlayStats(holes.map((hole) => shotHoleGeometry({
    par: hole.par, hole: hole.hole, tee: hole.layoutAtPlay?.tee, target: hole.layoutAtPlay?.target,
  }, hole.shotLedger?.matchesResult ? hole.shotLedger : null)), marks, scores);
  const played = holes.filter((hole) => (hole.strokes ?? 0) > 0);
  const scoreSample = played.filter((hole) => (hole.par ?? 0) > 0);
  const toPar = scoreSample.reduce((sum, hole) => sum + (hole.strokes! - hole.par!), 0);
  const strokes = played.reduce((sum, hole) => sum + hole.strokes!, 0);
  const oldScoreMix = selectedHole == null && !play.holes && round.savedBreakdown ? parseBreakdown(round.savedBreakdown) : null;
  // Existing aggregate-only score mix is still useful, but unverified legacy shot totals are not reused.
  if (oldScoreMix) {
    const keys = ["holes", "aces", "eagles", "birdies", "pars", "bogeys", "doubles_plus", "birdie_hit", "par_hit"] as const;
    for (const key of keys) play[key] = oldScoreMix[key];
  }
  return {
    id: round.id, eventName: round.eventName, course: round.courseName, layout: round.layoutName,
    date: round.playedDate, playedAt: round.playedAt, resultId: round.resultId, source: round.source, group: round.group, style: round.style,
    scoredHoles: played.length, scoredWithPar: scoreSample.length,
    strokes: played.length ? strokes : selectedHole == null ? round.total : null,
    toPar: scoreSample.length ? toPar : selectedHole == null ? round.toPar : null,
    // Never attach a denominator to an aggregate-only to-par number whose holes were not archived.
    toParForTrend: toPar,
    noArchivedGeometry: played.filter((hole) => !hole.shotLedger?.matchesResult && hole.marks.length && !hole.layoutAtPlay?.target).length,
    withheldMarkHoles: holes.filter((hole) => hole.marksStatus === "unattributed").length,
    explicitLedgerHoles: holes.filter((hole) => hole.shotLedger).length,
    totals: play,
  };
}

function trend(rows: ReturnType<typeof summarizeRound>[]) {
  const scoreHoles = rows.reduce((sum, row) => sum + row.scoredWithPar, 0);
  const scoreDelta = rows.reduce((sum, row) => sum + row.toParForTrend, 0);
  const totals = sumPlayTotals(rows.map(({ totals }) => totals));
  return {
    rounds: rows.length, scoreHoles, averageToParPerHole: scoreHoles ? Math.round(100 * scoreDelta / scoreHoles) / 100 : null,
    c1x: { made: totals.c1x_putt_hit, attempts: totals.c1x_putt_att, percentage: statPct(totals.c1x_putt_hit, totals.c1x_putt_att) },
  };
}

export async function loadPlayHistory(db: D1Like, memberId: string, filters: HistoryFilter) {
  const status = { truncated: false };
  const courses = new Map<string, string>();
  const layouts = new Map<string, string>();
  const holes = new Set<number>();
  const candidates: ReturnType<typeof summarizeRound>[] = [];
  for await (const round of scanHistoryRounds(db, memberId, status)) {
    if (round.style === "putting" ||
        (filters.source !== "all" && round.source !== filters.source) ||
        (filters.group !== "all" && round.group !== filters.group) ||
        (filters.style !== "all" && round.style !== filters.style)) continue;
    const course = courseKey(round);
    if (!courses.has(course)) courses.set(course, round.courseName ?? "Course not recorded");
    if (filters.course && course !== filters.course) continue;
    const layout = layoutKey(round);
    if (!layouts.has(layout)) layouts.set(layout, round.layoutName == null ? "Layout not recorded" :
      filters.course || !round.courseName ? round.layoutName : round.courseName + " · " + round.layoutName);
    if (filters.layout && layout !== filters.layout) continue;
    if (filters.from && (round.playedDate == null || round.playedDate < filters.from)) continue;
    if (filters.to && (round.playedDate == null || round.playedDate > filters.to)) continue;
    const played = round.holes.filter((hole) => (hole.strokes ?? 0) > 0);
    for (const hole of played) holes.add(hole.hole);
    if (filters.hole != null && !played.some((hole) => hole.hole === filters.hole)) continue;
    candidates.push(summarizeRound(round, filters.hole));
  }
  candidates.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") ||
    (b.playedAt ?? "").localeCompare(a.playedAt ?? "") || b.resultId - a.resultId || a.id.localeCompare(b.id));
  const visible = filters.last == null ? candidates : candidates.slice(0, filters.last);
  const sampleCount = 5;
  return {
    filters, truncated: status.truncated, maxSavedRoundsPerSource: HISTORY_LIMIT_PER_SOURCE,
    options: { courses: sortedOptions(courses), layouts: sortedOptions(layouts), holes: [...holes].sort((a, b) => a - b) },
    roundCount: visible.length,
    scoreTrend: trend(visible),
    latest: trend(visible.slice(0, sampleCount)),
    previous: trend(visible.slice(sampleCount, sampleCount * 2)),
    coverage: {
      noArchivedGeometry: visible.reduce((sum, row) => sum + row.noArchivedGeometry, 0),
      withheldMarkHoles: visible.reduce((sum, row) => sum + row.withheldMarkHoles, 0),
    },
    totals: sumPlayTotals(visible.map(({ totals }) => totals)),
    recentRounds: visible.slice(0, 12).map(({ id, eventName, date, course, layout, source, group, style, strokes, toPar, scoredHoles, explicitLedgerHoles }) =>
      ({ id, eventName, date, course, layout, source, group, style, strokes, toPar, scoredHoles, explicitLedgerHoles })),
    definitions: SHOT_STAT_DEFINITIONS,
  };
}
