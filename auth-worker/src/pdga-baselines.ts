// Pure PDGA layout-baseline logic (no I/O). It reads the public PDGA live-results JSON, decides
// whether a PDGA layout is one of our layouts, and turns matched official round SSAs into a
// chronological baseline for club round ratings. pdga-baseline-store.ts / -ingest.ts do the I/O.
//
// Privacy: parsers keep only (score, round rating) pairs. Player names, PDGA numbers, cities and
// player ratings in the PDGA payload are never returned.

import { cityState, courseNameTokens, normalizePlaceText } from "./pdga-events.js";
import { pointsPerThrow, roundRatingForScore } from "./rating-engine.js";

export const PDGA_LIVE_API = "https://www.pdga.com/apps/tournament/live-api";
export const PDGA_MEMBER_API = "https://www.pdga.com/api/v1/feat/members";
export const PDGA_MAX_ROUND = 10;
const CLUB_TIME_ZONE = "America/New_York";
const FEET_PER_METER = 3.28084;

// Matching thresholds (owner's spec): par equal on >= 90% of holes, each hole's length within
// max(25 ft, 8%) on >= 80% of holes, and the compared total within 5%.
export const MATCH_RULES = {
  parShare: 0.9,
  lengthShare: 0.8,
  lengthToleranceFt: 25,
  lengthTolerancePct: 0.08,
  totalTolerancePct: 0.05,
  nameShare: 0.5,
  // Two passing layouts whose closeness scores differ by less than this are "equally close".
  ambiguousWithinFt: 10,
  parMismatchFt: 25,
} as const;

export type PdgaHole = { hole: number; par: number; lengthFt: number | null };
export type PdgaLayout = {
  layoutId: number;
  courseId: number | null;
  courseName: string;
  name: string;
  holes: PdgaHole[];
};
export type PdgaEventSummary = {
  tournId: number;
  name: string;
  startDate: string;
  endDate: string | null;
  city: string | null;
  state: string | null;
  tier: string | null;
  rounds: number;
  highestCompletedRound: number;
  roundDates: Record<string, string>;
  divisions: { code: string; latestRound: number | null }[];
  layouts: PdgaLayout[];
};
export type ScorePair = readonly [score: number, rating: number];
export type PdgaRoundLayout = PdgaLayout & { ssa: number | null };
export type PdgaRoundResult = {
  layouts: PdgaRoundLayout[];
  pairs: Map<number, ScorePair[]>;
};
export type DiscoveredPdgaEvent = {
  tournId: number;
  name: string;
  startDate: string;
  city: string | null;
  state: string | null;
};

type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n != null && Number.isInteger(n) ? n : null;
}

function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function isoDay(value: unknown): string | null {
  const match = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  if (!match) return null;
  const day = new Date(match[1] + "T00:00:00Z");
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === match[1] ? match[1] : null;
}

function data(json: unknown): Row {
  return record(record(json).data);
}

function lengthFeet(raw: unknown, units: unknown): number | null {
  const n = num(raw);
  if (n == null || n <= 0 || n > 3000) return null;
  return Math.round(/^met/i.test(String(units ?? "")) ? n * FEET_PER_METER : n);
}

/** Holes in playing order from a PDGA layout (event Details, round Detail, or H1..Hn pars). */
export function pdgaLayoutHoles(layout: Row): PdgaHole[] | null {
  const count = int(layout.Holes);
  const detail = Array.isArray(layout.Detail) ? layout.Detail : Array.isArray(layout.Details) ? layout.Details : null;
  const units = layout.Units;
  let holes: PdgaHole[];
  if (detail && detail.length) {
    const rows = detail.map(record);
    const ordered = rows.every((row) => int(row.HoleOrdinal ?? row.Ordinal) != null)
      ? [...rows].sort((a, b) => int(a.HoleOrdinal ?? a.Ordinal)! - int(b.HoleOrdinal ?? b.Ordinal)!)
      : rows;
    holes = ordered.map((row, index) => ({ hole: index + 1, par: int(row.Par) ?? 0, lengthFt: lengthFeet(row.Length, units) }));
  } else if (count != null) {
    holes = Array.from({ length: count }, (_, index) => ({ hole: index + 1, par: int(layout["H" + (index + 1)]) ?? 0, lengthFt: null }));
  } else return null;
  if (!holes.length || holes.length > 36 || (count != null && count !== holes.length)) return null;
  return holes.every((hole) => hole.par >= 2 && hole.par <= 8) ? holes : null;
}

function parseLayout(raw: unknown): PdgaLayout | null {
  const layout = record(raw);
  const layoutId = int(layout.LayoutID);
  const holes = pdgaLayoutHoles(layout);
  const courseName = text(layout.CourseName);
  if (layoutId == null || layoutId <= 0 || !holes || !courseName) return null;
  return { layoutId, courseId: int(layout.CourseID), courseName, name: text(layout.Name) ?? "Layout", holes };
}

/** `live_results_fetch_event?TournID=N` -> event summary, or null when PDGA has no such event. */
export function parsePdgaEvent(json: unknown, tournId: number): PdgaEventSummary | null {
  const event = data(json);
  const startDate = isoDay(event.StartDate);
  if (!startDate || String(event.TournamentId ?? tournId) !== String(tournId)) return null;
  const place = cityState(String(event.LocationShort ?? ""));
  const roundDates: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record(event.RoundsList))) {
    const day = isoDay(record(raw).Date);
    const n = int(record(raw).Number) ?? int(key);
    if (day && n != null && n >= 1 && n <= PDGA_MAX_ROUND) roundDates[String(n)] = day;
  }
  const divisions = (Array.isArray(event.Divisions) ? event.Divisions : []).flatMap((raw) => {
    const row = record(raw);
    const code = text(row.Division, 12);
    return code && /^[A-Za-z0-9+_-]+$/.test(code) ? [{ code, latestRound: int(row.LatestRound) }] : [];
  });
  const rawCity = text(String(event.LocationShort ?? "").split(",")[0], 80);
  return {
    tournId,
    name: text(event.Name) ?? text(event.SimpleName) ?? "PDGA event " + tournId,
    startDate,
    endDate: isoDay(event.EndDate),
    city: place?.city ?? (rawCity ? normalizePlaceText(rawCity) : null),
    state: place?.state ?? null,
    tier: text(event.Tier, 12),
    rounds: int(event.Rounds) ?? 0,
    highestCompletedRound: int(event.HighestCompletedRound) ?? 0,
    roundDates,
    divisions,
    layouts: (Array.isArray(event.Layouts) ? event.Layouts : []).flatMap((raw) => parseLayout(raw) ?? []),
  };
}

/** True once every scheduled round is complete, or the event ended more than a week ago. */
export function pdgaEventComplete(event: PdgaEventSummary, now: string): boolean {
  if (event.rounds > 0 && event.highestCompletedRound >= event.rounds) return true;
  const end = event.endDate ?? event.startDate;
  return event.highestCompletedRound > 0 && Date.parse(end + "T00:00:00Z") + 7 * 86_400_000 < Date.parse(now);
}

/** Every [division, round] fetch needed to cover all layouts played in the event's completed rounds. */
export function pdgaRoundTasks(event: PdgaEventSummary): [string, number][] {
  const last = Math.min(event.highestCompletedRound, PDGA_MAX_ROUND);
  const tasks: [string, number][] = [];
  for (let round = 1; round <= last; round += 1) {
    for (const division of event.divisions) {
      if (division.latestRound == null || division.latestRound >= round) tasks.push([division.code, round]);
    }
  }
  return tasks;
}

function officialSsa(value: unknown): number | null {
  const ssa = num(value);
  return ssa != null && ssa >= 20 && ssa <= 120 ? Math.round(ssa * 1000) / 1000 : null;
}

/**
 * `live_results_fetch_round?TournID&Division&Round` -> the layouts played with PDGA's SSA for this
 * round, and each layout's anonymous (score, round rating) pairs. Only completed singles rounds with
 * a published round rating become pairs.
 */
export function parsePdgaRound(json: unknown, round: number): PdgaRoundResult {
  const body = data(json);
  const layouts: PdgaRoundLayout[] = [];
  for (const raw of Array.isArray(body.layouts) ? body.layouts : []) {
    const layout = parseLayout(raw);
    if (layout) layouts.push({ ...layout, ssa: officialSsa(record(raw)["SSARd" + round]) });
  }
  const known = new Set(layouts.map((layout) => layout.layoutId));
  const pairs = new Map<number, ScorePair[]>();
  for (const raw of Array.isArray(body.scores) ? body.scores : []) {
    const row = record(raw);
    const layoutId = int(row.LayoutID);
    const score = int(row.RoundScore);
    const rating = int(row.RoundRating);
    const teammates = Array.isArray(row.Teammates) ? row.Teammates.length : 0;
    const completed = row.Completed === 1 || row.Completed === true || row.Completed === "1";
    if (layoutId == null || !known.has(layoutId) || !completed || teammates > 0 || (row.Team != null && String(row.Team) !== "") ||
      score == null || score <= 0 || score >= 200 || rating == null || rating < 300 || rating > 1300) continue;
    const list = pairs.get(layoutId) ?? [];
    list.push([score, rating]);
    pairs.set(layoutId, list);
  }
  for (const list of pairs.values()) list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { layouts, pairs };
}

/** Events from a member's `/rating-detail` (rated rounds only), one entry per tournament. */
export function parseRatingDetailEvents(json: unknown): DiscoveredPdgaEvent[] {
  if (!Array.isArray(json)) return [];
  const events = new Map<number, DiscoveredPdgaEvent>();
  for (const raw of json) {
    const row = record(raw);
    const tournament = record(row.tournament);
    const tournId = int(row.tournId ?? tournament.tournId);
    const startDate = isoDay(tournament.startDate);
    if (tournId == null || tournId <= 0 || !startDate || num(row.rating) == null || events.has(tournId)) continue;
    const state = text(tournament.state, 4);
    const city = text(tournament.city, 80);
    events.set(tournId, {
      tournId, startDate, name: text(tournament.officialName) ?? "PDGA event " + tournId,
      city: city ? normalizePlaceText(city) : null, state: state && /^[A-Za-z]{2}$/.test(state) ? state.toUpperCase() : null,
    });
  }
  return [...events.values()].sort((a, b) => a.tournId - b.tournId);
}

function editDistanceWithin1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diffs = [...a].flatMap((char, index) => char === b[index] ? [] : [index]);
    if (diffs.length === 1) return true;
    // One transposition ("greenivlle").
    return diffs.length === 2 && diffs[1] === diffs[0]! + 1 && a[diffs[0]!] === b[diffs[1]!] && a[diffs[1]!] === b[diffs[0]!];
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i += 1) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

export type ClubPlaces = ReadonlyMap<string, ReadonlySet<string>>;

/** State -> normalized city names, from our courses' "City, ST" locations. */
export function clubPlaces(locations: readonly (string | null)[]): Map<string, Set<string>> {
  const places = new Map<string, Set<string>>();
  for (const location of locations) {
    const place = cityState(String(location ?? ""));
    if (!place || !place.city) continue;
    const cities = places.get(place.state) ?? new Set<string>();
    cities.add(place.city);
    places.set(place.state, cities);
  }
  return places;
}

/**
 * Discovery filter: the last ~3 years, a state we have courses in, and a city that matches one of
 * our course cities (one typo tolerated). A ZIP code or blank city falls back to the state check.
 */
export function discoverableEvent(event: DiscoveredPdgaEvent, places: ClubPlaces, now: string, years = 3): boolean {
  const started = Date.parse(event.startDate + "T00:00:00Z");
  const nowMs = Date.parse(now);
  if (!Number.isFinite(started) || started > nowMs || nowMs - started > years * 365.25 * 86_400_000) return false;
  const cities = event.state ? places.get(event.state) : null;
  if (!cities) return false;
  const city = event.city ?? "";
  if (!/[a-z]/.test(city)) return true;
  if (cities.has(city)) return true;
  return city.length >= 5 && [...cities].some((candidate) => candidate.length >= 5 && editDistanceWithin1(city, candidate));
}

// ---------------------------------------------------------------------------------------------
// Layout matching

export type OurHole = { hole: number; par: number; distanceFt: number | null };
export type OurLayout = { id: number; name: string; holes: OurHole[] };
export type OurCourse = { id: number; name: string; location: string | null; layouts: OurLayout[] };
export type GeometryGrade = "exact" | "close" | "unverified" | "none";
export type GeometryCheck = {
  grade: GeometryGrade;
  /** Same hole count and par equal on >= 90% of holes: an admin may vouch past length differences. */
  parOk: boolean;
  holes: number;
  parMatches: number;
  comparableHoles: number;
  lengthMatches: number;
  totalDiffPct: number | null;
  meanDiffFt: number | null;
  reason: string | null;
};

function plural(count: number, one: string, many: string): string {
  return count + " " + (count === 1 ? one : many);
}

/** Compare a PDGA layout's holes to one of ours (or to an as-played scorecard), hole by hole in order. */
export function compareLayoutGeometry(pdga: readonly PdgaHole[], ours: readonly OurHole[]): GeometryCheck {
  const n = pdga.length;
  const base = { holes: n, parOk: false, parMatches: 0, comparableHoles: 0, lengthMatches: 0, totalDiffPct: null, meanDiffFt: null };
  if (n !== ours.length || !n) {
    return { ...base, grade: "none", reason: "Hole count differs (" + n + " vs " + ours.length + ")" };
  }
  let parMatches = 0;
  let comparable = 0;
  let lengthMatches = 0;
  let pdgaTotal = 0;
  let ourTotal = 0;
  let diffSum = 0;
  for (let i = 0; i < n; i += 1) {
    const theirs = pdga[i]!;
    const mine = ours[i]!;
    if (theirs.par === mine.par) parMatches += 1;
    if (theirs.lengthFt != null && mine.distanceFt != null && mine.distanceFt > 0) {
      comparable += 1;
      const diff = Math.abs(theirs.lengthFt - mine.distanceFt);
      diffSum += diff;
      pdgaTotal += theirs.lengthFt;
      ourTotal += mine.distanceFt;
      if (diff <= Math.max(MATCH_RULES.lengthToleranceFt, MATCH_RULES.lengthTolerancePct * theirs.lengthFt)) lengthMatches += 1;
    }
  }
  const totalDiffPct = comparable && pdgaTotal > 0 ? Math.round(1000 * Math.abs(ourTotal - pdgaTotal) / pdgaTotal) / 10 : null;
  const meanDiffFt = comparable ? Math.round(10 * diffSum / comparable) / 10 : null;
  const parOk = parMatches >= MATCH_RULES.parShare * n;
  const result = { holes: n, parOk, parMatches, comparableHoles: comparable, lengthMatches, totalDiffPct, meanDiffFt };
  if (!parOk) {
    return { ...result, grade: "none", reason: "Par differs on " + plural(n - parMatches, "hole", "holes") + " of " + n };
  }
  if (comparable < MATCH_RULES.lengthShare * n) {
    return { ...result, grade: "unverified", reason: "Only " + comparable + " of " + n + " holes have lengths on both layouts" };
  }
  if (lengthMatches < MATCH_RULES.lengthShare * n) {
    return { ...result, grade: "none", reason: "Length differs by more than max(25 ft, 8%) on " + plural(n - lengthMatches, "hole", "holes") };
  }
  if (totalDiffPct! > MATCH_RULES.totalTolerancePct * 100) {
    return { ...result, grade: "none", reason: "Total length differs by " + totalDiffPct + "%" };
  }
  const exact = parMatches === n && comparable === n && lengthMatches === n;
  return { ...result, grade: exact ? "exact" : "close", reason: null };
}

/** Lower is closer. A par mismatch counts like 25 ft of length difference. */
function closeness(check: GeometryCheck): number {
  return (check.meanDiffFt ?? 0) + MATCH_RULES.parMismatchFt * (check.holes - check.parMatches);
}

export type MatchCandidate = {
  courseId: number;
  courseName: string;
  layoutId: number;
  layoutName: string;
  grade: GeometryGrade;
  parMatches: number;
  lengthMatches: number;
  comparableHoles: number;
  holes: number;
  totalDiffPct: number | null;
  meanDiffFt: number | null;
  reason: string | null;
};
export type MatchQuality = "exact" | "close" | "unverified" | "ambiguous" | "none";
export type LayoutMatch = {
  quality: MatchQuality;
  courseId: number | null;
  layoutId: number | null;
  reason: string | null;
  candidates: MatchCandidate[];
};

function nameShare(pdgaCourse: string, ours: string): number {
  const want = courseNameTokens(pdgaCourse);
  const have = courseNameTokens(ours);
  if (!want.size || !have.size) return 0;
  let shared = 0;
  for (const token of want) if (have.has(token)) shared += 1;
  return shared ? Math.max(shared / want.size, shared / have.size) : 0;
}

function sameTown(a: string, b: string): boolean {
  return a === b || (a.length >= 5 && b.length >= 5 && editDistanceWithin1(a, b));
}

/**
 * Courses that could be this PDGA course: same state as the event (when known) and a course-name
 * token match. When no name matches (PDGA calls ECU North Rec "East Carolina University"), courses in
 * the event's own town are candidates instead, and hole-by-hole geometry has to decide.
 */
export function candidateCourses(pdgaCourseName: string, eventState: string | null, courses: readonly OurCourse[], eventCity: string | null = null) {
  const inState = courses.filter((course) => {
    const place = cityState(String(course.location ?? ""));
    return !eventState || !place || place.state === eventState;
  });
  const named = inState.filter((course) => nameShare(pdgaCourseName, course.name) >= MATCH_RULES.nameShare);
  if (named.length || !eventCity || !eventState) return { courses: named, by: "name" as const };
  const town = normalizePlaceText(eventCity);
  return { courses: inState.filter((course) => {
    const place = cityState(String(course.location ?? ""));
    return place != null && place.state === eventState && sameTown(place.city, town);
  }), by: "town" as const };
}

/**
 * Grade a PDGA layout against our candidate layouts. Exact or close matches are automatic only when
 * one layout is clearly closest; two equally close layouts are ambiguous and wait for an admin, as
 * do layouts we cannot verify because our hole lengths are missing.
 */
export function matchPdgaLayout(
  layout: Pick<PdgaLayout, "courseName" | "holes">, eventState: string | null, courses: readonly OurCourse[], eventCity: string | null = null,
): LayoutMatch {
  const { courses: named, by } = candidateCourses(layout.courseName, eventState, courses, eventCity);
  if (!named.length) {
    return { quality: "none", courseId: null, layoutId: null, candidates: [],
      reason: "No club course named like \"" + layout.courseName + "\"" + (eventState ? " in " + eventState : "") };
  }
  const byTown = by === "town" ? "Matched by town and hole geometry; PDGA names the course \"" + layout.courseName + "\"" : null;
  const candidates: MatchCandidate[] = [];
  for (const course of named) {
    for (const ours of course.layouts) {
      if (ours.holes.length !== layout.holes.length) continue;
      const check = compareLayoutGeometry(layout.holes, ours.holes);
      candidates.push({
        courseId: course.id, courseName: course.name, layoutId: ours.id, layoutName: ours.name, grade: check.grade,
        parMatches: check.parMatches, lengthMatches: check.lengthMatches, comparableHoles: check.comparableHoles,
        holes: check.holes, totalDiffPct: check.totalDiffPct, meanDiffFt: check.meanDiffFt, reason: check.reason,
      });
    }
  }
  if (!candidates.length) {
    return { quality: "none", courseId: null, layoutId: null, candidates: [],
      reason: "No " + layout.holes.length + "-hole layout at " + named.map((course) => course.name).join(", ") };
  }
  const rank = { exact: 0, close: 1, unverified: 2, none: 3 } as const;
  const score = (candidate: MatchCandidate) => closeness({ ...candidate, parOk: true, reason: null });
  candidates.sort((a, b) => rank[a.grade] - rank[b.grade] || score(a) - score(b) || a.layoutId - b.layoutId);
  const passing = candidates.filter((candidate) => candidate.grade === "exact" || candidate.grade === "close");
  if (!passing.length) {
    const unverified = candidates.filter((candidate) => candidate.grade === "unverified");
    if (unverified.length) {
      const only = unverified.length === 1 ? unverified[0]! : null;
      return { quality: "unverified", courseId: only?.courseId ?? null, layoutId: only?.layoutId ?? null, candidates,
        reason: unverified[0]!.reason + "; an admin must confirm" };
    }
    return { quality: "none", courseId: null, layoutId: null, candidates, reason: "Closest layout: " + candidates[0]!.reason };
  }
  const best = passing[0]!;
  const runner = passing[1];
  if (runner && runner.grade === best.grade && score(runner) - score(best) < MATCH_RULES.ambiguousWithinFt) {
    return { quality: "ambiguous", courseId: null, layoutId: null, candidates,
      reason: best.layoutName + " and " + runner.layoutName + " are equally close" };
  }
  return { quality: best.grade, courseId: best.courseId, layoutId: best.layoutId, candidates, reason: byTown };
}

/** Our stored layout holes -> comparable holes. A par-estimated distance is not a measurement. */
export function ourLayoutHoles(raw: unknown): OurHole[] | null {
  let source = raw;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { return null; }
  }
  if (!Array.isArray(source) || !source.length || source.length > 36) return null;
  const holes = source.map(record).map((hole) => ({
    hole: int(hole.hole) ?? 0,
    par: int(hole.par) ?? 0,
    distanceFt: hole.distance_source === "par_estimate" ? null : num(hole.distance_ft),
  })).sort((a, b) => a.hole - b.hole);
  return holes.every((hole, index) => hole.hole === index + 1 && hole.par >= 1) ? holes : null;
}

// ---------------------------------------------------------------------------------------------
// Baselines

export type BaselineRound = {
  tournId: number;
  roundNumber: number;
  pdgaLayoutId: number;
  roundDate: string;
  ssa: number | null;
  ratingsStatus: "official" | "unconfirmed";
  reviewStatus: "auto" | "confirmed";
  holes: PdgaHole[];
};
export type PdgaBaseline = {
  ssa: number;
  ppt: number;
  rounds: number;
  officialRounds: number;
  minSsa: number;
  maxSsa: number;
  firstDate: string;
  lastDate: string;
};

/**
 * A round's calendar day at the club (US Eastern), so "before" means an earlier day of play. A
 * date-only event (stored as UTC midnight by ratingTimestamp) is that calendar day itself.
 */
export function clubCalendarDay(iso: string): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  if (/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(iso)) return iso.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: CLUB_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(time));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return part("year") + "-" + part("month") + "-" + part("day");
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Does a matched PDGA round describe the layout as it was played in one of our rounds? Automatic
 * matches must pass the full geometry rules against the as-played holes. An admin-confirmed match
 * may differ in hole lengths (our lengths are straight tee-to-basket lines; PDGA's follow the
 * fairway), but never in hole count or par.
 */
export function roundFitsPlayedLayout(round: Pick<BaselineRound, "holes" | "reviewStatus">, played: readonly OurHole[] | null): boolean {
  if (!played) return true;
  const check = compareLayoutGeometry(round.holes, played);
  return check.grade === "exact" || check.grade === "close" || (round.reviewStatus === "confirmed" && check.parOk);
}

/**
 * The PDGA baseline for one of our rounds: the median of the official SSAs of matched PDGA rounds
 * played on an EARLIER calendar day (no look-ahead) on a layout that fits the as-played geometry.
 */
export function pdgaBaselineFor(rounds: readonly BaselineRound[], played: readonly OurHole[] | null, beforeDay: string): PdgaBaseline | null {
  const usable = rounds.filter((round) => round.ssa != null && Number.isFinite(round.ssa) && round.roundDate < beforeDay &&
    roundFitsPlayedLayout(round, played));
  const ssa = median(usable.map((round) => round.ssa!));
  if (ssa == null) return null;
  const rounded = Math.round(ssa * 1000) / 1000;
  const values = usable.map((round) => round.ssa!);
  const dates = usable.map((round) => round.roundDate).sort();
  return {
    ssa: rounded,
    ppt: pointsPerThrow(rounded),
    rounds: usable.length,
    officialRounds: usable.filter((round) => round.ratingsStatus === "official").length,
    minSsa: Math.min(...values),
    maxSsa: Math.max(...values),
    firstDate: dates[0]!,
    lastDate: dates.at(-1)!,
  };
}

/** "6 PDGA rated rounds, 2023–2026, median SSA 49.6" */
export function baselineProvenance(baseline: Pick<PdgaBaseline, "rounds" | "firstDate" | "lastDate" | "ssa">): string {
  const first = baseline.firstDate.slice(0, 4);
  const last = baseline.lastDate.slice(0, 4);
  return plural(baseline.rounds, "PDGA rated round", "PDGA rated rounds") + ", " + (first === last ? first : first + "–" + last) +
    ", median SSA " + baseline.ssa.toFixed(1);
}

// ---------------------------------------------------------------------------------------------
// Validation against PDGA's own round ratings (ground truth)

export type ValidationPdgaRound = BaselineRound & { layoutId: number; pairs: readonly ScorePair[] };
export type ClubBaselineSample = { layoutId: number; playedAt: string; ssa: number };

type ErrorStats = { count: number; mae: number | null; bias: number | null; maxAbs: number | null };

function stats(errors: readonly number[], digits = 1): ErrorStats {
  if (!errors.length) return { count: 0, mae: null, bias: null, maxAbs: null };
  const scale = 10 ** digits;
  const mean = (values: readonly number[]) => Math.round(scale * values.reduce((sum, value) => sum + value, 0) / values.length) / scale;
  return { count: errors.length, mae: mean(errors.map(Math.abs)), bias: mean(errors), maxAbs: Math.max(...errors.map(Math.abs)) };
}

/**
 * Walk forward through matched PDGA rounds. Predict each round's player ratings from the baseline
 * built only from EARLIER PDGA rounds on the same layout, and compare with PDGA's published ratings.
 * The formula check rates each pair with that round's own official SSA, isolating the engine's
 * score-to-rating formula from the baseline. Club layout baselines are compared where both exist.
 */
export function evaluatePdgaBaselines(rounds: readonly ValidationPdgaRound[], clubBaselines: readonly ClubBaselineSample[] = []) {
  const byLayout = new Map<number, ValidationPdgaRound[]>();
  for (const round of rounds) {
    if (round.ssa == null) continue;
    const list = byLayout.get(round.layoutId) ?? [];
    list.push(round);
    byLayout.set(round.layoutId, list);
  }
  const ratingErrors: number[] = [];
  const formulaErrors: number[] = [];
  const ssaErrors: number[] = [];
  const layouts: { layoutId: number; rounds: number; predictedRounds: number; pairs: number; maeRating: number | null; biasRating: number | null }[] = [];
  let noPriorRound = 0;
  let predictedRounds = 0;
  for (const [layoutId, list] of [...byLayout.entries()].sort((a, b) => a[0] - b[0])) {
    const layoutErrors: number[] = [];
    let layoutPredicted = 0;
    for (const round of list) {
      for (const [score, rating] of round.pairs) {
        formulaErrors.push(roundRatingForScore(score, round.ssa!, pointsPerThrow(round.ssa!)) - rating);
      }
      const baseline = pdgaBaselineFor(list, round.holes.map((hole) => ({ hole: hole.hole, par: hole.par, distanceFt: hole.lengthFt })), round.roundDate);
      if (!baseline) {
        noPriorRound += 1;
        continue;
      }
      predictedRounds += 1;
      layoutPredicted += 1;
      ssaErrors.push(baseline.ssa - round.ssa!);
      for (const [score, rating] of round.pairs) {
        const error = roundRatingForScore(score, baseline.ssa, baseline.ppt) - rating;
        ratingErrors.push(error);
        layoutErrors.push(error);
      }
    }
    const layoutStats = stats(layoutErrors);
    layouts.push({ layoutId, rounds: list.length, predictedRounds: layoutPredicted, pairs: layoutErrors.length,
      maeRating: layoutStats.mae, biasRating: layoutStats.bias });
  }
  const clubDiffs: number[] = [];
  for (const club of clubBaselines) {
    const day = clubCalendarDay(club.playedAt);
    const prior = day ? pdgaBaselineFor(byLayout.get(club.layoutId) ?? [], null, day) : null;
    if (prior) clubDiffs.push(club.ssa - prior.ssa);
  }
  const rating = stats(ratingErrors);
  const ssa = stats(ssaErrors, 2);
  const formula = stats(formulaErrors);
  const club = stats(clubDiffs, 2);
  return {
    status: rating.count === 0 ? "no-data" : rating.count < 30 || predictedRounds < 3 ? "small-sample" : "measured",
    matchedRounds: [...byLayout.values()].reduce((sum, list) => sum + list.length, 0),
    matchedLayouts: byLayout.size,
    predictedRounds,
    roundsWithoutPriorBaseline: noPriorRound,
    ratingPairs: rating.count,
    maeRating: rating.mae,
    biasRating: rating.bias,
    maxAbsRating: rating.maxAbs,
    ssaRounds: ssa.count,
    maeSsaStrokes: ssa.mae,
    biasSsaStrokes: ssa.bias,
    formulaPairs: formula.count,
    formulaMaeRating: formula.mae,
    formulaMaxAbsRating: formula.maxAbs,
    clubComparisons: club.count,
    clubMinusPdgaSsaMean: club.bias,
    clubMinusPdgaSsaMae: club.mae,
    layouts,
  };
}
