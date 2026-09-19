import type { Env } from "./env.js";
import * as db from "./db.js";
import { safeFetch, normalizeDgs, normalizeCsvEvents, parseCsvRows, parseUdiscLayouts, ImportError } from "./imports.js";
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

const DEFAULT_DGS_FEED = "https://raw.githubusercontent.com/mostlysober252/GVDG-DGS-Scraper-2.0/main/tournaments.json";
const IMPORT_BODY_BYTES = 600_000;

export async function handleAdminImport(request: Request, env: Env, origin: string | null): Promise<Response> {
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