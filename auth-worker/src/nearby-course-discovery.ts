import type { Env } from "./env.js";
import * as db from "./db.js";
import { D1KV } from "./d1kv.js";
import { readD1OrFallback } from "./d1-retry.js";
import { haversineMiles } from "./distance.js";
import { bustCourseCatalogCache } from "./course-catalog-cache.js";
import { safeFetch } from "./imports/fetch.js";
import { hydrateCourseFromUdiscOnDemand, isPlaceholderLayout } from "./udisc-layout-import.js";
import {
  DISCGOLFAPI_HOST,
  DISCGOLFAPI_PAGE,
  KNOWN_DISCGOLFAPI_REGIONS,
  dedupeNearbyCandidates,
  defaultLayoutName,
  defaultPar3Holes,
  discGolfApiRegionUrl,
  discGolfApiTotal,
  isDuplicateCourse,
  parseDiscGolfApiCourses,
  regionsNearPoint,
  uniqueCourseName,
  type NearbyCourseCandidate,
  type NearbyExistingCourse,
} from "./imports/nearby-courses.js";
import { COVERAGE_ORDER, layoutQuality, type Coverage } from "../../src/shared/course-quality.js";

export const NEARBY_DISCOVER_CACHE_NAME = "gvdg-discgolfapi-regions";
export const NEARBY_DISCOVER_D1KV_NS = "dgc_regions";
export const REGION_CACHE_TTL_SEC = 86_400;
export const MAX_NEARBY_RESULTS = 60;
const MAX_PAGES_PER_REGION = 4;
const SOURCE_ID_RE = /^[A-Za-z0-9_-]{2,120}$/;

type CompactCandidate = {
  id: string;
  n: string;
  l: string;
  la: number;
  ln: number;
  h: number;
  r: string;
  w?: string | null;
  c?: number | null;
};

export interface DiscoveredCourse {
  id: string;
  external: true;
  source: "discgolfapi";
  source_id: string;
  name: string;
  location: string;
  lat: number;
  lng: number;
  holes: number;
  miles: number;
  region: string;
  mapped: 0;
  coverage: "scorable";
  layouts: [];
}

function toCompact(rows: NearbyCourseCandidate[], fallbackRegion: string): CompactCandidate[] {
  return rows
    .filter((c) => c.source_id && SOURCE_ID_RE.test(c.source_id))
    .map((c) => ({
      id: c.source_id!,
      n: c.name,
      l: c.location,
      la: c.lat,
      ln: c.lng,
      h: c.holes,
      r: c.region || fallbackRegion,
      ...(c.website ? { w: c.website } : {}),
      ...(c.confidence != null ? { c: c.confidence } : {}),
    }));
}

function fromCompact(raw: unknown, fallbackRegion: string): NearbyCourseCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: NearbyCourseCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<CompactCandidate>;
    if (
      typeof row.id !== "string" ||
      !SOURCE_ID_RE.test(row.id) ||
      typeof row.n !== "string" ||
      !row.n.trim() ||
      typeof row.la !== "number" ||
      !Number.isFinite(row.la) ||
      typeof row.ln !== "number" ||
      !Number.isFinite(row.ln) ||
      typeof row.h !== "number" ||
      !Number.isInteger(row.h)
    ) {
      continue;
    }
    out.push({
      source_id: row.id,
      name: row.n,
      location: typeof row.l === "string" ? row.l : "",
      lat: row.la,
      lng: row.ln,
      holes: row.h,
      miles: 0,
      region: typeof row.r === "string" && row.r ? row.r : fallbackRegion,
      website: typeof row.w === "string" ? row.w : null,
      confidence: typeof row.c === "number" && Number.isFinite(row.c) ? row.c : null,
    });
  }
  return out;
}

function regionCacheRequest(code: string): Request {
  return new Request(`https://cache.internal/discgolfapi/v1/region/${encodeURIComponent(code)}`, {
    method: "GET",
  });
}

async function readRegionEdgeCache(code: string): Promise<NearbyCourseCandidate[] | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(NEARBY_DISCOVER_CACHE_NAME);
    const hit = await cache.match(regionCacheRequest(code));
    if (!hit) return null;
    return fromCompact(await hit.json(), code);
  } catch {
    return null;
  }
}

async function writeRegionEdgeCache(code: string, payloadJson: string): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(NEARBY_DISCOVER_CACHE_NAME);
    await cache.put(
      regionCacheRequest(code),
      new Response(payloadJson, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${REGION_CACHE_TTL_SEC}`,
        },
      }),
    );
  } catch {
    /* edge cache is best-effort */
  }
}

async function readRegionD1Cache(env: Env, code: string): Promise<NearbyCourseCandidate[] | null> {
  if (!env.DB || typeof env.DB.prepare !== "function") return null;
  try {
    const kv = new D1KV(env.DB, NEARBY_DISCOVER_D1KV_NS);
    const hit = await kv.get("v1:" + code);
    if (!hit) return null;
    return fromCompact(JSON.parse(hit), code);
  } catch {
    return null;
  }
}

async function writeRegionD1Cache(env: Env, code: string, payloadJson: string): Promise<void> {
  if (!env.DB || typeof env.DB.prepare !== "function") return;
  try {
    const kv = new D1KV(env.DB, NEARBY_DISCOVER_D1KV_NS);
    await kv.put("v1:" + code, payloadJson, { expirationTtl: REGION_CACHE_TTL_SEC });
  } catch {
    /* D1KV cache is best-effort (e.g., unit-test mocks without kv_store) */
  }
}

export async function fetchDiscGolfApiRegionCached(env: Env, region: string): Promise<NearbyCourseCandidate[]> {
  const code = String(region || "").trim().toUpperCase();
  if (!KNOWN_DISCGOLFAPI_REGIONS.has(code)) return [];

  const edgeHit = await readRegionEdgeCache(code);
  if (edgeHit) return edgeHit;

  const d1Hit = await readRegionD1Cache(env, code);
  if (d1Hit) {
    await writeRegionEdgeCache(code, JSON.stringify(toCompact(d1Hit, code)));
    return d1Hit;
  }

  const rawRows: NearbyCourseCandidate[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES_PER_REGION; page += 1) {
    const text = await safeFetch(discGolfApiRegionUrl(code, DISCGOLFAPI_PAGE, offset), [DISCGOLFAPI_HOST], {
      maxBytes: 2_000_000,
      timeoutMs: 10_000,
      headers: { Accept: "application/json" },
    });
    const payload = JSON.parse(text) as unknown;
    const parsed = parseDiscGolfApiCourses(payload).filter(
      (c) => c.source_id && SOURCE_ID_RE.test(c.source_id),
    );
    for (const row of parsed) {
      rawRows.push(row.region ? row : { ...row, region: code });
    }
    const rawCount =
      payload && typeof payload === "object" && Array.isArray((payload as { courses?: unknown }).courses)
        ? (payload as { courses: unknown[] }).courses.length
        : parsed.length;
    offset += DISCGOLFAPI_PAGE;
    if (rawCount < DISCGOLFAPI_PAGE || offset >= discGolfApiTotal(payload)) break;
  }

  const deduped = dedupeNearbyCandidates(rawRows).map((c) => ({
    ...c,
    region: c.region && KNOWN_DISCGOLFAPI_REGIONS.has(c.region.toUpperCase()) ? c.region.toUpperCase() : code,
  }));
  const payloadJson = JSON.stringify(toCompact(deduped, code));
  await Promise.all([writeRegionD1Cache(env, code, payloadJson), writeRegionEdgeCache(code, payloadJson)]);
  return deduped;
}

function searchTokens(value: string): string[] {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export async function findNearbyExternalCourses(
  env: Env,
  opts: { lat: number; lng: number; miles?: number; query?: string },
): Promise<{ courses: DiscoveredCourse[]; miles: number; regions: string[] }> {
  const targetMiles = Math.max(1, Math.min(250, Math.round(opts.miles ?? 50)));
  const origin = { lat: opts.lat, lng: opts.lng };
  const regions = regionsNearPoint(origin, targetMiles);
  if (!regions.length) return { courses: [], miles: targetMiles, regions: [] };

  const [existingRes, regionResults] = await Promise.all([
    readD1OrFallback(
      () => env.DB.prepare("SELECT id, name, location, lat, lng FROM courses").all<NearbyExistingCourse>(),
      () => ({ results: [] as NearbyExistingCourse[], success: true }),
      4_000,
    ),
    Promise.allSettled(
      regions.map(async (code) => ({
        code,
        rows: await fetchDiscGolfApiRegionCached(env, code),
      })),
    ),
  ]);

  const existing = existingRes.results ?? [];
  const combined: NearbyCourseCandidate[] = [];
  for (const res of regionResults) {
    if (res.status !== "fulfilled") continue;
    for (const row of res.value.rows) {
      combined.push({
        ...row,
        region:
          row.region && KNOWN_DISCGOLFAPI_REGIONS.has(row.region.toUpperCase())
            ? row.region.toUpperCase()
            : res.value.code,
      });
    }
  }

  const deduped = dedupeNearbyCandidates(combined);
  const queryTokens = searchTokens(opts.query || "");

  const matched = deduped
    .map((cand) => ({
      ...cand,
      miles: Math.round(haversineMiles(origin, { lat: cand.lat, lng: cand.lng }) * 10) / 10,
    }))
    .filter((cand) => cand.miles <= targetMiles && SOURCE_ID_RE.test(cand.source_id || ""))
    .filter((cand) => !existing.some((row) => isDuplicateCourse(cand, row)))
    .filter((cand) => {
      if (!queryTokens.length) return true;
      const hay = `${cand.name} ${cand.location}`.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
      return queryTokens.every((token) => hay.includes(token));
    })
    .sort((a, b) => a.miles - b.miles || a.name.localeCompare(b.name))
    .slice(0, MAX_NEARBY_RESULTS);

  return {
    miles: targetMiles,
    regions,
    courses: matched.map((cand) => ({
      id: `discgolfapi:${cand.source_id}`,
      external: true,
      source: "discgolfapi",
      source_id: cand.source_id!,
      name: cand.name,
      location: cand.location,
      lat: cand.lat,
      lng: cand.lng,
      holes: cand.holes,
      miles: cand.miles,
      region: cand.region,
      mapped: 0,
      coverage: "scorable",
      layouts: [],
    })),
  };
}

function summarizeDiscoveredCourse(
  course: Record<string, unknown>,
  layouts: Record<string, unknown>[],
): Record<string, unknown> {
  let coverage: Coverage = "listed";
  let mapped = 0;
  const summaries = layouts.map((layout) => {
    const quality = layoutQuality(layout);
    if (COVERAGE_ORDER[quality.status] > COVERAGE_ORDER[coverage]) coverage = quality.status;
    if (quality.mappedCount > 0) mapped = 1;
    const updated = [layout.updated_at, layout.map_updated_at]
      .filter((v): v is string => typeof v === "string")
      .sort()
      .at(-1);
    return {
      id: layout.id,
      name: layout.name,
      coverage: quality.status,
      updated_at: updated ?? null,
      expected_holes: typeof layout.expected_holes === "number" ? layout.expected_holes : null,
    };
  });
  return {
    ...course,
    mapped,
    coverage,
    layouts: summaries,
  };
}

async function ensureCourseLayouts(
  env: Env,
  courseId: number,
  expectedHoles: number,
): Promise<Record<string, unknown>[]> {
  let listed = await db.listPublicLayoutsCatalog(env.DB, courseId);
  if (!listed.results.length) {
    const holes = defaultPar3Holes(expectedHoles);
    await db.createLayout(env.DB, {
      course_id: courseId,
      name: defaultLayoutName(),
      holes,
      total_par: holes.reduce((sum, hole) => sum + hole.par, 0),
      expected_holes: expectedHoles,
    });
    listed = await db.listPublicLayoutsCatalog(env.DB, courseId);
  }
  return listed.results;
}

async function hydrateAndReloadCourse(
  env: Env,
  courseRow: Record<string, unknown>,
  expectedHoles: number,
  created: boolean,
): Promise<{ created: boolean; course: Record<string, unknown>; layouts: Record<string, unknown>[] }> {
  const courseId = Number(courseRow.id);
  let currentCourse = courseRow;
  let layouts = await ensureCourseLayouts(env, courseId, expectedHoles);
  let hydrated = false;
  if (layouts.length === 0 || layouts.every((layout) => isPlaceholderLayout(layout))) {
    try {
      const result = await hydrateCourseFromUdiscOnDemand(env, {
        id: courseId,
        name: String(currentCourse.name || ""),
        location: typeof currentCourse.location === "string" ? currentCourse.location : null,
        udisc_url: typeof currentCourse.udisc_url === "string" ? currentCourse.udisc_url : null,
        udisc_course_id: typeof currentCourse.udisc_course_id === "string" ? currentCourse.udisc_course_id : null,
        lat: typeof currentCourse.lat === "number" ? currentCourse.lat : null,
        lng: typeof currentCourse.lng === "number" ? currentCourse.lng : null,
        mapped: 0,
      });
      if (result.action === "imported") {
        hydrated = true;
        const refreshed = (await db.getCourse(env.DB, courseId)) as Record<string, unknown> | null;
        if (refreshed) currentCourse = refreshed;
        layouts = (await db.listPublicLayoutsCatalog(env.DB, courseId)).results;
      }
    } catch {
      /* placeholder layout stays scorable and the 15-minute cron retries later */
    }
  }
  if (created || hydrated) {
    try {
      await bustCourseCatalogCache();
    } catch {
      /* bounded by the catalog's freshness window */
    }
  }
  return {
    created,
    course: summarizeDiscoveredCourse(currentCourse, layouts),
    layouts,
  };
}

export async function materializeDiscoveredCourse(
  env: Env,
  input: { source: string; sourceId: string; region: string },
): Promise<
  | { error: "invalid_request" | "not_found" }
  | { created: boolean; course: Record<string, unknown>; layouts: Record<string, unknown>[] }
> {
  const source = String(input.source || "").trim().toLowerCase();
  const sourceId = String(input.sourceId || "").trim();
  const region = String(input.region || "").trim().toUpperCase();
  if (source !== "discgolfapi" || !SOURCE_ID_RE.test(sourceId) || !KNOWN_DISCGOLFAPI_REGIONS.has(region)) {
    return { error: "invalid_request" };
  }

  const candidates = await fetchDiscGolfApiRegionCached(env, region);
  const cand = candidates.find((row) => row.source_id === sourceId);
  if (!cand) return { error: "not_found" };

  const existingRes = await env.DB.prepare("SELECT * FROM courses ORDER BY id").all<Record<string, unknown>>();
  const existingRows = existingRes.results ?? [];

  const existingMatch = existingRows.find((row) =>
    isDuplicateCourse(cand, {
      name: String(row.name || ""),
      location: typeof row.location === "string" ? row.location : null,
      lat: typeof row.lat === "number" ? row.lat : null,
      lng: typeof row.lng === "number" ? row.lng : null,
    }),
  );
  if (existingMatch) {
    return hydrateAndReloadCourse(env, existingMatch, cand.holes, false);
  }

  const takenNames = new Set(existingRows.map((row) => String(row.name || "")).filter(Boolean));
  const name = uniqueCourseName(cand.name, cand.location, takenNames);
  const inserted = (await db.createCourseIfNew(env.DB, {
    name,
    location: cand.location || null,
    lat: cand.lat,
    lng: cand.lng,
    is_default: 0,
    created_by: "nearby-discover",
  })) as Record<string, unknown> | null;

  let created = Boolean(inserted);
  let courseRow = inserted;
  if (!courseRow) {
    // Concurrent insert raced on unique course name: re-read from D1.
    const reloadRes = await env.DB.prepare("SELECT * FROM courses ORDER BY id").all<Record<string, unknown>>();
    const rows = reloadRes.results ?? [];
    courseRow =
      rows.find((row) => String(row.name || "") === name) ??
      rows.find((row) =>
        isDuplicateCourse(cand, {
          name: String(row.name || ""),
          location: typeof row.location === "string" ? row.location : null,
          lat: typeof row.lat === "number" ? row.lat : null,
          lng: typeof row.lng === "number" ? row.lng : null,
        }),
      ) ??
      null;
    created = false;
  }
  if (!courseRow) return { error: "not_found" };

  return hydrateAndReloadCourse(env, courseRow, cand.holes, created);
}
