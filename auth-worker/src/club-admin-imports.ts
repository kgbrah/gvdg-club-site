import type { Env } from "./env.js";
import * as db from "./db.js";
import { safeFetch, normalizeDgs, normalizeCsvEvents, parseCsvRows, parseUdiscLayouts, ImportError, mergeUdiscCalendars, normalizeUdiscEventsUrl, parseUdiscCalendar, udiscSchedulePageUrl, parseUdiscStandings, parseUdiscLeaderboard, tagStandingsFromBoards } from "./imports.js";
import {
  DAY_TRIP_MILES,
  DISCGOLFAPI_ATTRIBUTION,
  DISCGOLFAPI_HOST,
  DISCGOLFAPI_PAGE,
  NEARBY_REGIONS,
  defaultLayoutName,
  defaultPar3Holes,
  discGolfApiTotal,
  discGolfApiUrl,
  parseDiscGolfApiCourses,
  planNearbyCourseImport,
} from "./imports/nearby-courses.js";
import { json, readJson } from "./http.js";
import { asStr } from "./input.js";
import { runUdiscLayoutImportTick } from "./udisc-layout-import.js";
import { bustCourseCatalogCache } from "./course-catalog-cache.js";
import { saveUdiscLeague } from "./udisc-league-save.js";
import type { UdiscImportCandidate } from "./imports/udisc-events.js";
import type { UdiscStandings } from "./imports/udisc-standings.js";

const DEFAULT_DGS_FEED = "https://raw.githubusercontent.com/mostlysober252/GVDG-DGS-Scraper-2.0/main/tournaments.json";
const IMPORT_BODY_BYTES = 600_000;

export async function handleAdminImport(request: Request, env: Env, origin: string | null, adminId = "admin"): Promise<Response> {
  const kind = new URL(request.url).pathname.split("/").filter(Boolean)[2];
  const b = (await readJson(request, IMPORT_BODY_BYTES)) ?? {};
  try {
    if (kind === "dgs") {
      const url = asStr(b.feedUrl, 500) ?? DEFAULT_DGS_FEED;
      const text = await safeFetch(url, ["raw.githubusercontent.com", "discgolfscene.com"]);
      let feed: unknown;
      try { feed = JSON.parse(text); } catch { return json({ error: "import_parse_failed" }, 422, origin); }
      return json({ source: "dgs", candidates: normalizeDgs(feed) }, 200, origin);
    }
    if (kind === "csv") {
      let csvText = typeof b.csv === "string" ? b.csv : null;
      if (csvText && csvText.length > 500_000) return json({ error: "csv_too_large" }, 413, origin);
      if (!csvText && typeof b.url === "string") csvText = await safeFetch(b.url, ["docs.google.com"]);
      if (!csvText) return json({ error: "invalid_request" }, 400, origin);
      return json({ source: "csv", candidates: normalizeCsvEvents(parseCsvRows(csvText)) }, 200, origin);
    }
    if (kind === "udisc-events" || kind === "udisc-league") {
      const target = normalizeUdiscEventsUrl(asStr(b.url, 500));
      if (!target) return json({ error: "invalid_request" }, 400, origin);
      const loaded = await loadUdiscLeague(target);
      if (kind === "udisc-league") {
        if (!b.save) return json({ error: "invalid_request" }, 400, origin);
        try {
          return json({ source: "udisc", ...(await saveUdiscLeague(env, adminId, loaded)) }, 200, origin);
        } catch (error) {
          if (error instanceof Error && error.message === "league_required") return json({ error: "invalid_request" }, 400, origin);
          throw error;
        }
      }
      const withCounts = loaded.events.map((event) => {
        const scored = loaded.standings?.events.find((item) => item.externalUrl && item.externalUrl === event.external_url);
        return scored ? { ...event, result_count: scored.results.length } : event;
      });
      return json({
        source: "udisc",
        candidates: loaded.league ? [loaded.league, ...withCounts] : withCounts,
        truncated: loaded.truncated,
        standings: loaded.standings?.standings || [],
        rounds_kept: loaded.standings?.roundsKept ?? null,
        result_events: loaded.standings?.events.length || 0,
        standings_mode: loaded.standings?.mode || "points",
      }, 200, origin);
    }
    if (kind === "udisc") {
      const url = asStr(b.url, 500);
      if (!url) return json({ error: "invalid_request" }, 400, origin);
      // UDisc ships its data as a large turbo-stream payload — allow more than the 1 MB default.
      const html = await safeFetch(url, ["udisc.com"], { maxBytes: 3_000_000 });
      const { name, udisc_course_id, layouts } = parseUdiscLayouts(html, url);
      // `candidate` keeps the old single-layout shape working; `layouts` exposes all of them.
      // `udisc_course_id` (course-level) lets the admin save it on the course to enable "Add to UDisc".
      return json({ source: "udisc", name, udisc_course_id, layouts, candidate: layouts[0] ?? null }, 200, origin);
    }
    if (kind === "nearby-courses") {
      return json(await importNearbyCourses(env, b && typeof b === "object" ? b as Record<string, unknown> : {}), 200, origin);
    }
    if (kind === "udisc-layouts") {
      return json({ source: "udisc-layouts", ...(await runUdiscLayoutImportTick(env)) }, 200, origin);
    }
    return json({ error: "not_found" }, 404, origin);
  } catch (e) {
    if (e instanceof ImportError) return json({ error: "import_failed", reason: e.message }, 400, origin);
    throw e;
  }
}

async function fetchUdiscHtml(url: string): Promise<string> {
  return safeFetch(url, ["udisc.com"], { maxBytes: 3_000_000, timeoutMs: 12_000 });
}

export async function loadUdiscLeague(target: { kind: "league" | "event"; fetchUrl: string; scheduleUrl: string | null }): Promise<{
  league: UdiscImportCandidate | null;
  events: UdiscImportCandidate[];
  standings: UdiscStandings | null;
  truncated: boolean;
}> {
  const pages = [parseUdiscCalendar(await fetchUdiscHtml(target.fetchUrl), target.fetchUrl)];
  const total = pages[0]?.resultsCount ?? pages[0]?.events.length ?? 0;
  if (target.scheduleUrl && total > pages[0]!.events.length) {
    for (let page = 2; page <= 3; page += 1) {
      if (mergeUdiscCalendars(pages).events.length >= total) break;
      try {
        const next = parseUdiscCalendar(await fetchUdiscHtml(udiscSchedulePageUrl(target.scheduleUrl, page)), target.scheduleUrl);
        pages.push(next);
        if (!next.events.length) break;
      } catch (error) {
        if (!(error instanceof ImportError)) throw error;
        break;
      }
    }
  }
  const calendar = mergeUdiscCalendars(pages);
  let standings: UdiscStandings | null = null;
  const shortId = calendar.league?.udisc_short_id;
  if (shortId) {
    try {
      standings = parseUdiscStandings(await fetchUdiscHtml(`https://udisc.com/leagues/${encodeURIComponent(shortId)}/standings`));
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
    }
  }
  if (!standings?.events.length) {
    standings = await loadLeaderboardStandings(calendar.league?.name || standings?.leagueName || null, calendar.events);
  }
  return {
    league: calendar.league,
    events: calendar.events,
    standings,
    truncated: calendar.resultsCount != null && calendar.events.length < calendar.resultsCount,
  };
}

async function loadLeaderboardStandings(leagueName: string | null, events: UdiscImportCandidate[]): Promise<UdiscStandings | null> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const played = events
    .filter((event) => event.type !== "league" && event.external_url && event.date && event.date <= today)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 6);
  const boards = [];
  for (const event of played) {
    const url = event.external_url!;
    const leaderboardUrl = url.endsWith("/leaderboard") ? url : `${url}/leaderboard`;
    try {
      const board = parseUdiscLeaderboard(await fetchUdiscHtml(leaderboardUrl));
      boards.push({
        name: event.name,
        date: event.date || null,
        externalUrl: url,
        venue: event.venue || null,
        finished: board.finished,
        results: board.results,
      });
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
    }
  }
  return tagStandingsFromBoards(leagueName, boards);
}

async function importNearbyCourses(env: Env, body: Record<string, unknown>): Promise<{
  source: "nearby-courses";
  attribution: string;
  imported: number;
  skipped: number;
  considered: number;
  courses: { name: string; location: string; miles: number; holes: number }[];
}> {
  const catalog: ReturnType<typeof parseDiscGolfApiCourses> = [];
  for (const region of NEARBY_REGIONS) {
    catalog.push(...(await fetchDiscGolfApiRegion(region)));
  }
  const existing = (await db.listCourses(env.DB)) as {
    name: string;
    location?: string | null;
    lat?: number | null;
    lng?: number | null;
  }[];
  const plan = planNearbyCourseImport(catalog, existing, { maxMiles: DAY_TRIP_MILES });
  const dryRun = body.dry_run === true;
  const imported: typeof plan.insert = [];
  if (!dryRun) {
    for (const course of plan.insert) {
      const row = await db.createCourseIfNew(env.DB, {
        name: course.name,
        location: course.location || null,
        lat: course.lat,
        lng: course.lng,
        is_default: 1,
        created_by: "nearby-courses",
      }) as { id: number } | null;
      if (!row) continue;
      const holes = defaultPar3Holes(course.holes);
      await db.createLayout(env.DB, {
        course_id: row.id,
        name: defaultLayoutName(),
        holes,
        total_par: holes.reduce((sum, h) => sum + h.par, 0),
        expected_holes: course.holes,
      });
      imported.push(course);
    }
    if (imported.length) {
      try { await bustCourseCatalogCache(); } catch { /* cache bust is best-effort */ }
    }
  }
  const applied = dryRun ? plan.insert : imported;
  return {
    source: "nearby-courses",
    attribution: DISCGOLFAPI_ATTRIBUTION,
    imported: applied.length,
    skipped: plan.skipped + (plan.insert.length - applied.length),
    considered: plan.considered,
    courses: applied.map((c) => ({ name: c.name, location: c.location, miles: c.miles, holes: c.holes })),
  };
}

async function fetchDiscGolfApiRegion(region: string) {
  const catalog: ReturnType<typeof parseDiscGolfApiCourses> = [];
  let offset = 0;
  for (let page = 0; page < 8; page += 1) {
    const text = await safeFetch(discGolfApiUrl(region, DISCGOLFAPI_PAGE, offset), [DISCGOLFAPI_HOST], {
      maxBytes: 2_000_000,
      timeoutMs: 15_000,
      headers: { Accept: "application/json" },
    });
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new ImportError("import_parse_failed"); }
    const rows = parseDiscGolfApiCourses(payload);
    catalog.push(...rows);
    const rawCount = payload && typeof payload === "object" && Array.isArray((payload as { courses?: unknown }).courses)
      ? ((payload as { courses: unknown[] }).courses.length)
      : rows.length;
    offset += DISCGOLFAPI_PAGE;
    if (rawCount < DISCGOLFAPI_PAGE || offset >= discGolfApiTotal(payload)) break;
  }
  return catalog;
}
