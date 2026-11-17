import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { haversineMiles } from "../src/distance.js";
import { enqueuePdgaEvent, runPdgaBaselineTick } from "../src/pdga-baseline-ingest.js";
import { pdgaBaselineOverview, pdgaCourseBaselines, pdgaValidationReport } from "../src/pdga-baseline-store.js";
import { pointsPerThrow, roundRatingForScore } from "../src/rating-engine.js";
import { pdgaTestDb } from "./pdga-test-db.js";

// Dry run against REAL public data, never the live D1: an in-memory database gets our public course
// list and nearby layouts from auth.gvdgclub.com, then the production ingest path reads the PDGA
// JSON endpoints for the chosen events (politely, one request at a time). Off by default:
//
//   GVDG_PDGA_DRY_RUN=1 GVDG_PDGA_DRY_RUN_EVENTS=104547,99178 GVDG_PDGA_DRY_RUN_OUT=/tmp/report.json \
//     npx vitest run test/pdga-baseline-dry-run.test.ts
const env = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const CLUB = { lat: 35.6127, lng: -77.3664 };
const API = env.GVDG_PDGA_DRY_RUN_API ?? "https://auth.gvdgclub.com";
const UA = "Mozilla/5.0 (compatible; GVDGClubBot/1.0; +https://gvdgclub.com)";

it.skipIf(!env.GVDG_PDGA_DRY_RUN)("dry-runs PDGA layout baselines on real data", { timeout: 3_600_000 }, async () => {
  const { db, sqlite } = await pdgaTestDb();
  const get = async (url: string) => {
    const response = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
    if (!response.ok) throw new Error(url + " " + response.status);
    return response.json() as Promise<Record<string, unknown>>;
  };
  type Course = { id: number; name: string; location: string | null; lat: number | null; lng: number | null; layouts?: unknown[] };
  // The public catalog falls back to a one-course list when its D1 read fails; retry until it is real.
  let courses: Course[] = [];
  for (let attempt = 0; attempt < 5 && courses.length < 50; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 5_000));
    courses = (await get(API + "/courses")).courses as Course[];
  }
  expect(courses.length).toBeGreaterThan(50);
  for (const course of courses) sqlite.prepare("INSERT INTO courses (id, name, location, lat, lng) VALUES (?, ?, ?, ?, ?)")
    .run(course.id, course.name, course.location, course.lat, course.lng);
  const nearby = courses.filter((course) => course.lat != null && course.lng != null &&
    haversineMiles(CLUB, { lat: course.lat, lng: course.lng }) <= Number(env.GVDG_PDGA_DRY_RUN_MILES ?? 45));
  for (const course of nearby) {
    const listed = course.layouts?.length ?? 0;
    let layouts: { id: number; name: string; holes: string }[] = [];
    // The catalog can also come back degraded (no layouts) while its D1 read fails: retry empties.
    for (let attempt = 0; attempt < 4 && (layouts.length < listed || !layouts.length); attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 3_000));
      layouts = (await get(API + "/courses/" + course.id + "/layouts")).layouts as typeof layouts;
    }
    expect(layouts.length, course.name + " layouts").toBeGreaterThanOrEqual(listed);
    expect(layouts.every((layout) => (layout as { course_id?: number }).course_id === course.id), course.name + " layout owner").toBe(true);
    for (const layout of layouts) sqlite.prepare("INSERT INTO course_layouts (id, course_id, name, holes) VALUES (?, ?, ?, ?)")
      .run(layout.id, course.id, layout.name, typeof layout.holes === "string" ? layout.holes : JSON.stringify(layout.holes));
  }

  // pdga.com answers 429 to bursts. Pace requests, wait out a 429, and cache bodies so a rerun is free.
  const withLayouts = sqlite.prepare("SELECT COUNT(DISTINCT course_id) AS count FROM course_layouts").get() as { count: number };
  expect(withLayouts.count, "nearby courses with layouts").toBeGreaterThanOrEqual(Math.ceil(nearby.length * 0.8));

  let requests = 0;
  let cached = 0;
  const cacheDir = env.GVDG_PDGA_DRY_RUN_CACHE;
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  const politeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const file = cacheDir ? cacheDir + "/" + String(input).replace(/^https:\/\/www\.pdga\.com\//, "").replace(/[^A-Za-z0-9]+/g, "_") + ".json" : null;
    if (file && existsSync(file)) {
      cached += 1;
      return new Response(readFileSync(file, "utf8"), { status: 200 });
    }
    for (let attempt = 0; ; attempt += 1) {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, Number(env.GVDG_PDGA_DRY_RUN_DELAY_MS ?? 1500)));
      const response = await fetch(input, init);
      if (response.status === 429 && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        continue;
      }
      const body = await response.text();
      if (file && response.ok) writeFileSync(file, body);
      return new Response(body, { status: response.status });
    }
  }) as typeof fetch;
  const now = new Date().toISOString();
  const ids = String(env.GVDG_PDGA_DRY_RUN_EVENTS ?? "").split(",").map((id) => Number(id.trim())).filter((id) => id > 0);
  const official = new Set(String(env.GVDG_PDGA_DRY_RUN_OFFICIAL ?? "").split(",").map((id) => Number(id.trim())));
  for (const tournId of ids) await enqueuePdgaEvent(db, { tournId, source: official.has(tournId) ? "member-history" : "admin", official: official.has(tournId) }, now);
  const runEnv = { DB: db, ROSTER: { list: async () => ({ keys: [], list_complete: true }), get: async () => null } } as unknown as Env;
  for (let tick = 0; tick < 200; tick += 1) {
    const summary = await runPdgaBaselineTick(runEnv, { doFetch: politeFetch, now, fetchBudget: 40, weatherBudget: 20, rematchAll: tick === 0 });
    if (summary.errors.length) console.log("tick " + tick + " errors " + summary.errors.join("; "));
    if (!summary.eventsTouched && !summary.weatherFetches) break;
  }

  const queue = sqlite.prepare("SELECT tourn_id, status, attempts, last_error, event_name, event_city, event_state, event_date FROM pdga_ingest_queue ORDER BY event_date").all();
  const rounds = sqlite.prepare(`SELECT r.tourn_id, r.round_number, r.pdga_layout_id, r.round_date, r.event_name, r.course_name, r.layout_name,
      r.hole_count, r.total_par, r.total_length_ft, r.official_ssa, r.rated_players, m.course_id, m.layout_id, m.quality, m.review_status, m.reason
    FROM pdga_rated_rounds r LEFT JOIN pdga_layout_matches m ON m.pdga_layout_id = r.pdga_layout_id ORDER BY r.round_date, r.tourn_id, r.round_number`).all();
  const matches = sqlite.prepare(`SELECT m.pdga_layout_id, m.quality, m.review_status, m.course_id, m.layout_id, m.reason, m.candidates_json,
      MAX(r.course_name) AS course_name, MAX(r.layout_name) AS layout_name, MAX(r.hole_count) AS holes, MAX(r.total_par) AS par,
      MAX(r.total_length_ft) AS length, COUNT(*) AS rounds, GROUP_CONCAT(DISTINCT r.tourn_id) AS events
    FROM pdga_layout_matches m JOIN pdga_rated_rounds r ON r.pdga_layout_id = m.pdga_layout_id GROUP BY m.pdga_layout_id ORDER BY course_name`).all();
  const matchedCourses = [...new Set((matches as { course_id: number | null; review_status: string }[])
    .filter((row) => row.review_status === "auto" && row.course_id != null).map((row) => row.course_id!))];
  const perCourse = [];
  for (const courseId of matchedCourses) perCourse.push(await pdgaCourseBaselines(db, courseId, now));
  // Per round: how well the engine's formula reproduces PDGA's published ratings from that round's own SSA.
  const formulaByRound = (sqlite.prepare(`SELECT r.tourn_id, r.round_number, r.pdga_layout_id, r.official_ssa, s.division, s.pairs_json
      FROM pdga_rated_rounds r JOIN pdga_round_scores s ON s.tourn_id = r.tourn_id AND s.round_number = r.round_number
        AND s.pdga_layout_id = r.pdga_layout_id WHERE r.official_ssa IS NOT NULL AND s.rated_count > 0`).all() as Record<string, unknown>[])
    .map((row) => {
      const ssa = Number(row.official_ssa);
      const errors = (JSON.parse(String(row.pairs_json)) as [number, number][])
        .map(([score, rating]) => roundRatingForScore(score, ssa, pointsPerThrow(ssa)) - rating);
      return { tournId: row.tourn_id, round: row.round_number, layout: row.pdga_layout_id, division: row.division, ssa,
        pairs: errors.length, meanError: errors.reduce((sum, error) => sum + error, 0) / errors.length, maxAbs: Math.max(...errors.map(Math.abs)) };
    });
  const loadedLayouts = sqlite.prepare(`SELECT c.id AS course_id, c.name AS course, c.location, l.id, l.name, json_array_length(l.holes) AS holes,
      (SELECT SUM(json_extract(h.value, '$.par')) FROM json_each(l.holes) h) AS par
    FROM course_layouts l JOIN courses c ON c.id = l.course_id ORDER BY c.id, l.id`).all();
  const weather = sqlite.prepare(`SELECT r.weather_status, COUNT(*) AS rounds, MIN(r.wind_gust_mph) AS min_gust, MAX(r.wind_gust_mph) AS max_gust,
      SUM(CASE WHEN r.wind_gust_mph > 18 THEN 1 ELSE 0 END) AS above_threshold
    FROM pdga_rated_rounds r JOIN pdga_layout_matches m ON m.pdga_layout_id = r.pdga_layout_id
    WHERE m.review_status IN ('auto', 'confirmed') GROUP BY r.weather_status`).all();
  const gusts = sqlite.prepare(`SELECT r.tourn_id, r.round_number, r.round_date, r.wind_gust_mph, m.layout_id FROM pdga_rated_rounds r
    JOIN pdga_layout_matches m ON m.pdga_layout_id = r.pdga_layout_id WHERE m.review_status IN ('auto', 'confirmed') ORDER BY r.round_date`).all();
  const validation = await pdgaValidationReport(db);
  // The same validation with recency but without wind normalisation, to separate the two effects.
  sqlite.exec("UPDATE pdga_rated_rounds SET weather_status = 'pending'");
  const validationWithoutWind = await pdgaValidationReport(db);
  const report = {
    weather, gusts, validationWithoutWind,
    loadedLayouts,
    formulaByRound,
    requests, cachedResponses: cached, queue, rounds, matches, perCourse, overview: await pdgaBaselineOverview(db), validation,
    courses: courses.length, nearbyCourses: nearby.length,
  };
  if (env.GVDG_PDGA_DRY_RUN_OUT) writeFileSync(env.GVDG_PDGA_DRY_RUN_OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.validation, null, 2));
  expect(rounds.length).toBeGreaterThan(0);
});
