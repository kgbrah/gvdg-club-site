import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { haversineMiles } from "../src/distance.js";
import {
  clubPlaces, compareLayoutGeometry, discoverableEvent, matchPdgaLayout, median, ourLayoutHoles, parsePdgaEvent, parsePdgaRound,
  parseRatingDetailEvents, pdgaEventComplete, publishedRatingsSsa, PDGA_LIVE_API, PDGA_MEMBER_API,
  type OurCourse, type PdgaEventSummary, type PdgaHole, type ScorePair,
} from "../src/pdga-baselines.js";
import { pointsPerThrow, roundRatingForScore } from "../src/rating-engine.js";

// Rating-tuning research on REAL public data (never the live D1). Off by default.
//
//   GVDG_RATING_TUNING=1 GVDG_RATING_TUNING_CACHE=<dir> [GVDG_RATING_TUNING_FETCH=1] \
//     GVDG_RATING_TUNING_OUT=<report.json> npx vitest run test/rating-tuning-research.test.ts
//
// With FETCH set it may read pdga.com (at most GVDG_RATING_TUNING_BUDGET requests, default 400, >= 1.5 s
// apart, waiting out 429s), Open-Meteo's archive and our public course catalog; every body is cached
// in the cache dir. Without FETCH it runs offline from the cache. Evaluation is leave-one-event-out:
// each event's published ratings are predicted only from OTHER events played on EARLIER days.

const env = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const CACHE = env.GVDG_RATING_TUNING_CACHE ?? "";
const FETCH = env.GVDG_RATING_TUNING_FETCH === "1";
const BUDGET = Number(env.GVDG_RATING_TUNING_BUDGET ?? 400);
const DELAY_MS = Math.max(1500, Number(env.GVDG_RATING_TUNING_DELAY_MS ?? 1600));
const CLUB = { lat: 35.6127, lng: -77.3664 };
const UA = "Mozilla/5.0 (compatible; GVDGClubBot/1.0; +https://gvdgclub.com)";
const API = "https://auth.gvdgclub.com";
const NOW = env.GVDG_RATING_TUNING_NOW ?? "2026-11-17T12:00:00.000Z";

type Json = Record<string, unknown>;
const stats = { pdgaRequests: 0, pdgaCached: 0, pdga429: 0, weatherRequests: 0, weatherCached: 0, apiRequests: 0 };

function cacheFile(url: string) {
  return CACHE + "/" + url.replace(/^https:\/\/www\.pdga\.com\//, "").replace(/[^A-Za-z0-9]+/g, "_") + ".json";
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cached GET. Returns null on a cache miss when offline, on 404, or when the pdga.com budget is spent. */
async function cachedJson(url: string): Promise<unknown | null> {
  const file = cacheFile(url);
  const pdga = url.startsWith("https://www.pdga.com/");
  if (existsSync(file)) {
    if (pdga) stats.pdgaCached += 1;
    else if (url.includes("open-meteo")) stats.weatherCached += 1;
    return JSON.parse(readFileSync(file, "utf8"));
  }
  if (!FETCH || (pdga && stats.pdgaRequests >= BUDGET)) return null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (pdga) {
      if (stats.pdgaRequests >= BUDGET) return null;
      stats.pdgaRequests += 1;
      await sleep(DELAY_MS);
    } else if (url.includes("open-meteo")) {
      stats.weatherRequests += 1;
      await sleep(700);
    } else stats.apiRequests += 1;
    const response = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } }).catch(() => null);
    if (response?.status === 429) {
      stats.pdga429 += 1;
      await sleep(60_000);
      continue;
    }
    if (!response?.ok) return null;
    const body = await response.text();
    writeFileSync(file, body);
    return JSON.parse(body);
  }
  return null;
}

// --------------------------------------------------------------------------------------------
// Our courses (public catalog), cached; the live catalog occasionally serves a degraded fallback.

async function clubCourses(): Promise<{ all: OurCourse[]; places: ReturnType<typeof clubPlaces>; coords: Map<number, { lat: number; lng: number }> }> {
  const list = await cachedJson(API + "/courses") as { courses: (Json & { layouts?: unknown[] })[] } | null;
  if (!list || list.courses.length < 50) throw new Error("course catalog unavailable or degraded");
  const coords = new Map<number, { lat: number; lng: number }>();
  const all: OurCourse[] = [];
  for (const course of list.courses) {
    const id = Number(course.id);
    const lat = Number(course.lat);
    const lng = Number(course.lng);
    const near = Number.isFinite(lat) && Number.isFinite(lng) && haversineMiles(CLUB, { lat, lng }) <= 70;
    if (Number.isFinite(lat) && Number.isFinite(lng)) coords.set(id, { lat, lng });
    let layouts: OurCourse["layouts"] = [];
    if (near) {
      const body = await cachedJson(API + "/courses/" + id + "/layouts") as { layouts: Json[] } | null;
      layouts = (body?.layouts ?? []).flatMap((layout) => {
        const holes = ourLayoutHoles(layout.holes);
        return holes && Number(layout.course_id) === id ? [{ id: Number(layout.id), name: String(layout.name), holes }] : [];
      });
    }
    all.push({ id, name: String(course.name), location: course.location == null ? null : String(course.location), layouts });
  }
  return { all, places: clubPlaces(list.courses.map((course) => course.location == null ? null : String(course.location))), coords };
}

// --------------------------------------------------------------------------------------------
// Events and rounds

type Round = {
  tournId: number; round: number; date: string; layoutId: number; courseName: string; layoutName: string; holes: PdgaHole[];
  officialSsa: number | null; pairs: ScorePair[]; state: string | null; city: string | null;
};

function cachedRoundFiles(tournId: number): { division: string; round: number }[] {
  const prefix = "apps_tournament_live_api_live_results_fetch_round_TournID_" + tournId + "_Division_";
  return readdirSync(CACHE).filter((name) => name.startsWith(prefix)).flatMap((name) => {
    const match = /_Division_([A-Za-z0-9]+)_Round_(\d+)\.json$/.exec(name);
    return match ? [{ division: match[1]!, round: Number(match[2]) }] : [];
  });
}

/** Read an event's rounds: every cached division, plus (when fetching) just enough divisions per round to see its layouts. */
async function eventRounds(tournId: number): Promise<{ event: PdgaEventSummary; rounds: Round[] } | null> {
  const eventJson = await cachedJson(`${PDGA_LIVE_API}/live_results_fetch_event?TournID=${tournId}`);
  const event = eventJson ? parsePdgaEvent(eventJson, tournId) : null;
  if (!event || !pdgaEventComplete(event, NOW)) return null;
  const players = new Map(((eventJson as { data?: { Divisions?: Json[] } }).data?.Divisions ?? [])
    .map((row) => [String(row.Division), Number(row.Players) || 0]));
  const byKey = new Map<string, Round>();
  const take = (json: unknown, round: number) => {
    const parsed = parsePdgaRound(json, round);
    let fresh = false;
    for (const layout of parsed.layouts) {
      const key = round + ":" + layout.layoutId;
      const existing = byKey.get(key);
      if (!existing) fresh = true;
      const entry = existing ?? { tournId, round, date: event.roundDates[String(round)] ?? event.startDate, layoutId: layout.layoutId,
        courseName: layout.courseName, layoutName: layout.name, holes: layout.holes, officialSsa: layout.ssa, pairs: [], state: event.state, city: event.city };
      entry.pairs.push(...(parsed.pairs.get(layout.layoutId) ?? []));
      if (entry.officialSsa == null) entry.officialSsa = layout.ssa;
      byKey.set(key, entry);
    }
    return fresh;
  };
  const cached = new Set(cachedRoundFiles(tournId).map((file) => file.division + ":" + file.round));
  for (let round = 1; round <= Math.min(event.highestCompletedRound, 10); round += 1) {
    const divisions = event.divisions.filter((division) => division.latestRound == null || division.latestRound >= round)
      .sort((a, b) => (players.get(b.code) ?? 0) - (players.get(a.code) ?? 0) || a.code.localeCompare(b.code));
    let stale = 0;
    for (const division of divisions) {
      const url = `${PDGA_LIVE_API}/live_results_fetch_round?TournID=${tournId}&Division=${encodeURIComponent(division.code)}&Round=${round}`;
      const isCached = cached.has(division.code + ":" + round);
      // New events: stop a round once two more divisions add no new layout (all cached ones are read).
      if (!isCached && stale >= 2) continue;
      const json = await cachedJson(url);
      if (!json) continue;
      const added = take(json, round);
      if (!isCached) stale = added ? 0 : stale + 1;
    }
  }
  return { event, rounds: [...byKey.values()] };
}

// --------------------------------------------------------------------------------------------
// Analysis model

export type Obs = {
  tournId: number; round: number; date: string; layout: number; ssa: number; gust: number | null; temp: number | null;
  holes: PdgaHole[]; pairs: ScorePair[];
};
type GustModel = { k: number; threshold: number; cap: number };
type Model = {
  gust: GustModel; maxRounds: number; years: number; halfLifeMonths: number | null;
  stat: "median" | "mean" | "trimmed"; tempCoef?: number; trendPerYear?: number;
  /** false: normalise the baseline rounds' temperature but predict the target at the 60 °F reference. */
  tempTarget?: boolean;
};
const CURRENT: Model = { gust: { k: 0.035, threshold: 18, cap: 1.5 }, maxRounds: 6, years: 3, halfLifeMonths: null, stat: "median" };

function adj(gust: GustModel, g: number | null): number {
  if (g == null || g <= gust.threshold) return 0;
  return Math.round(Math.min(gust.cap, (g - gust.threshold) * gust.k) * 100) / 100;
}

const DAY = 86_400_000;
const days = (a: string, b: string) => (Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / DAY;

function weightedMedian(values: { v: number; w: number }[]): number {
  const sorted = [...values].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((sum, entry) => sum + entry.w, 0);
  let acc = 0;
  for (const entry of sorted) {
    acc += entry.w;
    if (acc >= total / 2) return entry.v;
  }
  return sorted.at(-1)!.v;
}

function statistic(model: Model, values: { v: number; w: number }[]): number {
  if (model.stat === "mean") return values.reduce((sum, e) => sum + e.v * e.w, 0) / values.reduce((sum, e) => sum + e.w, 0);
  if (model.stat === "trimmed") {
    const sorted = values.map((e) => e.v).sort((a, b) => a - b);
    const cut = sorted.length >= 5 ? Math.floor(sorted.length * 0.2) : 0;
    const kept = sorted.slice(cut, sorted.length - cut);
    return kept.reduce((sum, v) => sum + v, 0) / kept.length;
  }
  return model.halfLifeMonths == null ? median(values.map((e) => e.v))! : weightedMedian(values);
}

/** Predicted no-wind SSA for a target from earlier rounds of OTHER events on the same layout. */
function baseline(model: Model, rounds: readonly Obs[], target: Obs): number | null {
  const earliest = new Date(target.date + "T00:00:00Z");
  earliest.setUTCFullYear(earliest.getUTCFullYear() - model.years);
  const floor = earliest.toISOString().slice(0, 10);
  const played = target.holes.map((hole) => ({ hole: hole.hole, par: hole.par, distanceFt: hole.lengthFt }));
  const prior = rounds.filter((r) => r.layout === target.layout && r.tournId !== target.tournId && r.date < target.date && r.date >= floor &&
    ["exact", "close"].includes(compareLayoutGeometry(r.holes, played).grade))
    .sort((a, b) => b.date.localeCompare(a.date) || b.tournId - a.tournId || b.round - a.round)
    .slice(0, model.maxRounds);
  if (!prior.length) return null;
  const values = prior.map((r) => ({
    v: r.ssa - adj(model.gust, r.gust) - (model.tempCoef && r.temp != null ? model.tempCoef * (r.temp - 60) : 0)
      + (model.trendPerYear ? model.trendPerYear * days(target.date, r.date) / 365.25 : 0),
    w: model.halfLifeMonths == null ? 1 : 0.5 ** (days(target.date, r.date) / 30.44 / model.halfLifeMonths),
  }));
  return statistic(model, values);
}

export function evaluate(model: Model, rounds: readonly Obs[], fitPerEvent?: (train: readonly Obs[]) => Partial<Model>) {
  const errors: number[] = [];
  const ssaErrors: number[] = [];
  const events = new Set<number>();
  const byEvent = new Map<number, number[]>();
  let predicted = 0;
  for (const target of rounds) {
    if (!target.pairs.length) continue;
    const fitted = fitPerEvent ? { ...model, ...fitPerEvent(rounds.filter((r) => r.tournId !== target.tournId)) } : model;
    const base = baseline(fitted, rounds, target);
    if (base == null) continue;
    const ssa = base + adj(fitted.gust, target.gust) +
      (fitted.tempCoef && fitted.tempTarget !== false && target.temp != null ? fitted.tempCoef * (target.temp - 60) : 0);
    predicted += 1;
    events.add(target.tournId);
    ssaErrors.push(ssa - target.ssa);
    const eventErrors = byEvent.get(target.tournId) ?? [];
    for (const [score, rating] of target.pairs) {
      const error = roundRatingForScore(score, ssa, pointsPerThrow(base)) - rating;
      errors.push(error);
      eventErrors.push(error);
    }
    byEvent.set(target.tournId, eventErrors);
  }
  const mean = (values: number[]) => values.length ? Math.round(10 * values.reduce((sum, v) => sum + v, 0) / values.length) / 10 : null;
  const roundMean = (values: number[]) => values.length ? Math.round(100 * values.reduce((sum, v) => sum + v, 0) / values.length) / 100 : null;
  const eventMae = new Map([...byEvent].map(([id, list]) => [id, list.reduce((sum, v) => sum + Math.abs(v), 0) / list.length]));
  return { pairs: errors.length, rounds: predicted, events: events.size, mae: mean(errors.map(Math.abs)), bias: mean(errors),
    ssaMae: roundMean(ssaErrors.map(Math.abs)), ssaBias: roundMean(ssaErrors), eventMae };
}

const T95 = [12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09, 2.09,
  2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05];
const t95 = (df: number) => df >= 30 ? 2.04 : T95[df - 1]!;

/** Event-level paired difference in MAE (candidate − reference): mean and 95% CI over held-out events. */
export function pairedVsReference(candidate: Map<number, number>, reference: Map<number, number>) {
  const diffs = [...candidate].flatMap(([id, mae]) => reference.has(id) ? [mae - reference.get(id)!] : []);
  if (diffs.length < 2) return { events: diffs.length, diff: null, low: null, high: null };
  const mean = diffs.reduce((sum, v) => sum + v, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (diffs.length - 1));
  const half = t95(diffs.length - 1) * sd / Math.sqrt(diffs.length);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { events: diffs.length, diff: r1(mean), low: r1(mean - half), high: r1(mean + half) };
}

/** Within-layout OLS on two regressors at the event-day level: coefficients with 95% CIs. */
export function withinLayoutTwo(rounds: readonly Obs[], a: (r: Obs) => number | null, b: (r: Obs) => number | null) {
  const groups = new Map<string, { layout: number; y: number[]; a: number; b: number }>();
  for (const r of rounds) {
    const va = a(r);
    const vb = b(r);
    if (va == null || vb == null) continue;
    const key = r.layout + "|" + r.tournId + "|" + r.date;
    const group = groups.get(key) ?? { layout: r.layout, y: [], a: va, b: vb };
    group.y.push(r.ssa);
    groups.set(key, group);
  }
  const byLayout = new Map<number, { a: number; b: number; y: number }[]>();
  for (const g of groups.values()) {
    const list = byLayout.get(g.layout) ?? [];
    list.push({ a: g.a, b: g.b, y: g.y.reduce((s, v) => s + v, 0) / g.y.length });
    byLayout.set(g.layout, list);
  }
  const rows: { a: number; b: number; y: number }[] = [];
  let layouts = 0;
  for (const list of byLayout.values()) {
    if (list.length < 2) continue;
    layouts += 1;
    const m = (f: (p: { a: number; b: number; y: number }) => number) => list.reduce((s, p) => s + f(p), 0) / list.length;
    const ma = m((p) => p.a); const mb = m((p) => p.b); const my = m((p) => p.y);
    for (const p of list) rows.push({ a: p.a - ma, b: p.b - mb, y: p.y - my });
  }
  const sum = (f: (p: { a: number; b: number; y: number }) => number) => rows.reduce((s, p) => s + f(p), 0);
  const saa = sum((p) => p.a * p.a); const sbb = sum((p) => p.b * p.b); const sab = sum((p) => p.a * p.b);
  const say = sum((p) => p.a * p.y); const sby = sum((p) => p.b * p.y);
  const det = saa * sbb - sab * sab;
  const df = rows.length - layouts - 2;
  if (!det || df < 1) return null;
  const ca = (sbb * say - sab * sby) / det;
  const cb = (saa * sby - sab * say) / det;
  const sigma2 = sum((p) => (p.y - ca * p.a - cb * p.b) ** 2) / df;
  const seA = Math.sqrt(sigma2 * sbb / det); const seB = Math.sqrt(sigma2 * saa / det);
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const t = t95(df);
  return { a: { coef: r4(ca), low: r4(ca - t * seA), high: r4(ca + t * seA) }, b: { coef: r4(cb), low: r4(cb - t * seB), high: r4(cb + t * seB) },
    n: rows.length, layouts, df, correlation: r4(sab / Math.sqrt(saa * sbb)) };
}

/**
 * Within-layout regression of SSA on x at the event-day level (rounds of one event on one day share their
 * gust, and PDGA often shares their SSA, so they are one observation). Returns slope, 95% CI and n.
 */
export function withinLayoutSlope(rounds: readonly Obs[], x: (r: Obs) => number | null) {
  const groups = new Map<string, { layout: number; ssa: number[]; x: number }>();
  for (const r of rounds) {
    const value = x(r);
    if (value == null) continue;
    const key = r.layout + "|" + r.tournId + "|" + r.date;
    const group = groups.get(key) ?? { layout: r.layout, ssa: [], x: value };
    group.ssa.push(r.ssa);
    groups.set(key, group);
  }
  const byLayout = new Map<number, { x: number; y: number }[]>();
  for (const group of groups.values()) {
    const list = byLayout.get(group.layout) ?? [];
    list.push({ x: group.x, y: group.ssa.reduce((s, v) => s + v, 0) / group.ssa.length });
    byLayout.set(group.layout, list);
  }
  const demeaned: { x: number; y: number }[] = [];
  let layouts = 0;
  for (const list of byLayout.values()) {
    if (list.length < 2) continue;
    layouts += 1;
    const mx = list.reduce((s, p) => s + p.x, 0) / list.length;
    const my = list.reduce((s, p) => s + p.y, 0) / list.length;
    for (const p of list) demeaned.push({ x: p.x - mx, y: p.y - my });
  }
  const sxx = demeaned.reduce((s, p) => s + p.x * p.x, 0);
  const n = demeaned.length;
  const df = n - layouts - 1;
  if (!sxx || df < 1) return { slope: null, low: null, high: null, n, layouts, df };
  const slope = demeaned.reduce((s, p) => s + p.x * p.y, 0) / sxx;
  const sse = demeaned.reduce((s, p) => s + (p.y - slope * p.x) ** 2, 0);
  const se = Math.sqrt(sse / df / sxx);
  const t = t95(df);
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return { slope: r4(slope), low: r4(slope - t * se), high: r4(slope + t * se), n, layouts, df };
}

// --------------------------------------------------------------------------------------------

it("research statistics recover known effects from synthetic rounds", () => {
  // Three layouts with different difficulty; SSA = layout + 0.2/mph over 18 - 0.03/F around 60, plus small noise.
  const noise = [0.05, -0.04, 0.02, -0.03, 0.01, -0.02, 0.04, -0.05, 0.03, -0.01, 0.02, -0.02];
  const obs: Obs[] = [];
  let i = 0;
  for (const [layout, base] of [[1, 48], [2, 52], [3, 56]] as const) {
    for (const [gust, temp] of [[12, 50], [22, 62], [30, 45], [18, 80]] as const) {
      const ssa = base + 0.2 * Math.max(0, gust - 18) - 0.03 * (temp - 60) + noise[i]!;
      obs.push({ tournId: 100 + i, round: 1, date: "2025-0" + (1 + (i % 9)) + "-01", layout, ssa, gust, temp, holes: [], pairs: [] });
      i += 1;
    }
  }
  const joint = withinLayoutTwo(obs, (r) => r.gust == null ? null : Math.max(0, r.gust - 18), (r) => r.temp)!;
  expect(joint.a.coef).toBeCloseTo(0.2, 1);
  expect(joint.b.coef).toBeCloseTo(-0.03, 2);
  expect(joint.a.low!).toBeLessThan(0.2);
  expect(joint.a.high!).toBeGreaterThan(0.2);
  expect(joint).toMatchObject({ n: 12, layouts: 3, df: 7 });
  const single = withinLayoutSlope(obs.map((o) => ({ ...o, temp: 60, ssa: o.ssa + 0.03 * ((o.temp ?? 60) - 60) })), (r) => r.gust == null ? null : Math.max(0, r.gust - 18));
  expect(single.slope).toBeCloseTo(0.2, 1);
  expect(pairedVsReference(new Map([[1, 10], [2, 12], [3, 14]]), new Map([[1, 11], [2, 13], [3, 15], [4, 9]])))
    .toEqual({ events: 3, diff: -1, low: -1, high: -1 });
});

it.skipIf(!env.GVDG_RATING_TUNING || !CACHE)("tunes PDGA baselines on real data with leave-one-event-out evaluation", { timeout: 7_200_000 }, async () => {
  mkdirSync(CACHE, { recursive: true });
  const { all: courses, places, coords } = await clubCourses();

  // 1. Known local events: everything already cached.
  const known = new Set(readdirSync(CACHE).flatMap((name) => {
    const match = /^apps_tournament_live_api_live_results_fetch_event_TournID_(\d+)\.json$/.exec(name);
    return match ? [Number(match[1])] : [];
  }));
  const seed = [...known];

  // 2. Discovery: the players of those events, most regular first; their public rating histories.
  const attendance = new Map<string, Set<number>>();
  for (const name of readdirSync(CACHE)) {
    const match = /_fetch_round_TournID_(\d+)_/.exec(name);
    if (!match) continue;
    const body = JSON.parse(readFileSync(CACHE + "/" + name, "utf8")) as { data?: { scores?: Json[] } };
    for (const score of body.data?.scores ?? []) {
      const pdga = String(score.PDGANum ?? "").replace(/\D/g, "");
      if (!pdga) continue;
      attendance.set(pdga, (attendance.get(pdga) ?? new Set()).add(Number(match[1])));
    }
  }
  const players = [...attendance.entries()].sort((a, b) => b[1].size - a[1].size || Number(a[0]) - Number(b[0]))
    .slice(0, Number(env.GVDG_RATING_TUNING_PLAYERS ?? 80)).map(([pdga]) => pdga);
  const discovered = new Map<number, { players: number; city: string | null; name: string; date: string }>();
  let historiesRead = 0;
  for (const pdga of players) {
    const detail = await cachedJson(`${PDGA_MEMBER_API}/${pdga}/rating-detail`);
    if (!detail) continue;
    historiesRead += 1;
    for (const event of parseRatingDetailEvents(detail).filter((row) => discoverableEvent(row, places, NOW))) {
      const entry = discovered.get(event.tournId) ?? { players: 0, city: event.city, name: event.name, date: event.startDate };
      entry.players += 1;
      discovered.set(event.tournId, entry);
    }
  }
  // Towns where our layouts are mapped and nearby come first; then how many regulars played.
  const homeTowns = new Set(["greenville", "greenivlle", "ayden", "winterville", "farmville", "kinston", "grifton", "washington"]);
  const fresh = [...discovered.entries()].filter(([id]) => !known.has(id))
    .sort((a, b) => Number(homeTowns.has(b[1].city ?? "")) - Number(homeTowns.has(a[1].city ?? "")) || b[1].players - a[1].players || b[0] - a[0]);

  // 3. Read events (cached first, then new ones while the request budget lasts).
  const rounds: Round[] = [];
  const eventsRead: number[] = [];
  for (const tournId of [...seed, ...fresh.map(([id]) => id)]) {
    if (!known.has(tournId) && stats.pdgaRequests >= BUDGET - 3) break;
    const result = await eventRounds(tournId);
    if (!result) continue;
    eventsRead.push(tournId);
    rounds.push(...result.rounds);
  }

  // 4. Match PDGA layouts to ours exactly as production does (automatic matches only).
  const matchCache = new Map<string, ReturnType<typeof matchPdgaLayout>>();
  const matched: (Round & { ourLayout: number; ourCourse: number; quality: string })[] = [];
  for (const round of rounds) {
    const key = round.tournId + ":" + round.layoutId;
    const match = matchCache.get(key) ?? matchPdgaLayout(round, round.state, courses, round.city);
    matchCache.set(key, match);
    if ((match.quality === "exact" || match.quality === "close") && match.layoutId != null && match.courseId != null) {
      matched.push({ ...round, ourLayout: match.layoutId, ourCourse: match.courseId, quality: match.quality });
    }
  }

  // 5. Weather at the matched course: max gust and mean temperature 09:00-17:00 America/New_York.
  const obs: Obs[] = [];
  let withWeather = 0;
  for (const round of matched) {
    const ssa = publishedRatingsSsa(round.officialSsa, round.pairs) ?? round.officialSsa;
    if (ssa == null) continue;
    const at = coords.get(round.ourCourse);
    let gust: number | null = null;
    let temp: number | null = null;
    if (at) {
      const url = "https://archive-api.open-meteo.com/v1/archive?latitude=" + at.lat.toFixed(4) + "&longitude=" + at.lng.toFixed(4) +
        "&start_date=" + round.date + "&end_date=" + round.date + "&hourly=wind_gusts_10m,temperature_2m&wind_speed_unit=mph" +
        "&temperature_unit=fahrenheit&timezone=America%2FNew_York";
      const body = await cachedJson(url) as { hourly?: { time?: string[]; wind_gusts_10m?: (number | null)[]; temperature_2m?: (number | null)[] } } | null;
      const hourly = body?.hourly;
      const window = (hourly?.time ?? []).flatMap((time, index) => {
        const hour = Number(time.slice(11, 13));
        return time.startsWith(round.date) && hour >= 9 && hour <= 17 ? [index] : [];
      });
      const gusts = window.map((i) => hourly?.wind_gusts_10m?.[i]).filter((v): v is number => typeof v === "number");
      const temps = window.map((i) => hourly?.temperature_2m?.[i]).filter((v): v is number => typeof v === "number");
      gust = gusts.length ? Math.round(Math.max(...gusts) * 10) / 10 : null;
      temp = temps.length ? Math.round(10 * temps.reduce((s, v) => s + v, 0) / temps.length) / 10 : null;
    }
    if (gust != null) withWeather += 1;
    obs.push({ tournId: round.tournId, round: round.round, date: round.date, layout: round.ourLayout, ssa, gust, temp, holes: round.holes, pairs: round.pairs });
  }

  // 6. Candidates (leave-one-event-out, earlier days only).
  const candidates: [string, Model, ((train: readonly Obs[]) => Partial<Model>)?][] = [
    ["current: median of 6 in 3y, gust 0.035/mph over 18 (cap 1.5)", CURRENT],
    ["no wind normalisation", { ...CURRENT, gust: { k: 0, threshold: 18, cap: 0 } }],
    ...[0.02, 0.05, 0.07, 0.1].map((k) => ["gust " + k + "/mph over 18", { ...CURRENT, gust: { ...CURRENT.gust, k } }] as [string, Model]),
    ...[0, 10, 14].map((threshold) => ["gust 0.035/mph over " + threshold, { ...CURRENT, gust: { ...CURRENT.gust, threshold } }] as [string, Model]),
    ["gust fitted per held-out event (slope over 18)", CURRENT, (train) => {
      const fit = withinLayoutSlope(train, (r) => r.gust == null ? null : Math.max(0, r.gust - 18));
      return { gust: { k: Math.max(0, fit.slope ?? CURRENT.gust.k), threshold: 18, cap: 3 } };
    }],
    ...[4, 8, 12].map((maxRounds) => ["median of " + maxRounds + " most recent in 3y", { ...CURRENT, maxRounds }] as [string, Model]),
    ["median of all in 3y", { ...CURRENT, maxRounds: 1000 }],
    ...[6, 12, 24].map((halfLifeMonths) => ["weighted median of all in 3y, half-life " + halfLifeMonths + " mo", { ...CURRENT, maxRounds: 1000, halfLifeMonths }] as [string, Model]),
    ["mean of 6", { ...CURRENT, stat: "mean" }],
    ["20% trimmed mean of 6", { ...CURRENT, stat: "trimmed" }],
    ["temperature fitted per held-out event", CURRENT, (train) => {
      const fit = withinLayoutSlope(train, (r) => r.temp);
      return { tempCoef: fit.slope ?? 0 };
    }],
    ["temperature-normalised baseline only (target at 60 F)", { ...CURRENT, tempTarget: false }, (train) => {
      const fit = withinLayoutSlope(train, (r) => r.temp);
      return { tempCoef: fit.slope ?? 0 };
    }],
    ["gust and temperature fitted jointly per held-out event", CURRENT, (train) => {
      const fit = withinLayoutTwo(train, (r) => r.gust == null ? null : Math.max(0, r.gust - 18), (r) => r.temp);
      return fit ? { gust: { k: Math.max(0, fit.a.coef), threshold: 18, cap: 3 }, tempCoef: fit.b.coef } : {};
    }],
    ...[-0.03, -0.05].map((tempCoef) => ["temperature fixed " + tempCoef + " strokes/F", { ...CURRENT, tempCoef }] as [string, Model]),
    ["linear time trend fitted per held-out event", CURRENT, (train) => {
      const fit = withinLayoutSlope(train, (r) => Date.parse(r.date) / (365.25 * DAY));
      return { trendPerYear: fit.slope ?? 0 };
    }],
  ];
  const reference = evaluate(CURRENT, obs).eventMae;
  const table = candidates.map(([name, model, fit]) => {
    const { eventMae, ...result } = evaluate(model, obs, fit);
    return { name, ...result, vsCurrent: pairedVsReference(eventMae, reference) };
  });

  const report = {
    requests: stats, historiesRead, playersPool: attendance.size, discoveredLocalEvents: discovered.size, newEventCandidates: fresh.length,
    eventsRead: eventsRead.length, seedEvents: seed.length, rounds: rounds.length, pdgaLayouts: new Set(rounds.map((r) => r.tournId + ":" + r.layoutId)).size,
    matchedRounds: obs.length, matchedEvents: new Set(obs.map((o) => o.tournId)).size, matchedLayouts: new Set(obs.map((o) => o.layout)).size,
    withWeather, withoutWeather: obs.length - withWeather,
    gustSlopeOver18: withinLayoutSlope(obs, (r) => r.gust == null ? null : Math.max(0, r.gust - 18)),
    gustSlopeLinear: withinLayoutSlope(obs, (r) => r.gust),
    tempSlope: withinLayoutSlope(obs, (r) => r.temp),
    gustAndTemp: withinLayoutTwo(obs, (r) => r.gust == null ? null : Math.max(0, r.gust - 18), (r) => r.temp),
    tempByMonth: [...new Set(obs.map((o) => Number(o.date.slice(5, 7))))].sort((a, b) => a - b).map((month) => {
      const list = obs.filter((o) => Number(o.date.slice(5, 7)) === month);
      return { month, rounds: list.length, meanTemp: Math.round(list.reduce((s, o) => s + (o.temp ?? 0), 0) / list.length),
        meanGust: Math.round(list.reduce((s, o) => s + (o.gust ?? 0), 0) / list.length) };
    }),
    trendPerYear: withinLayoutSlope(obs, (r) => Date.parse(r.date) / (365.25 * DAY)),
    table,
    perLayout: [...new Set(obs.map((o) => o.layout))].map((layout) => ({ layout, rounds: obs.filter((o) => o.layout === layout).length,
      events: new Set(obs.filter((o) => o.layout === layout).map((o) => o.tournId)).size })),
    obs: obs.map(({ holes, pairs, ...rest }) => ({ ...rest, pairs: pairs.length })),
    eventList: eventsRead,
  };
  if (env.GVDG_RATING_TUNING_OUT) writeFileSync(env.GVDG_RATING_TUNING_OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, obs: undefined }, null, 1));
  expect(obs.length).toBeGreaterThan(0);
});
