import type { Env } from "./env.js";
import * as db from "./db.js";
import {
  getUdiscImportState,
  listUdiscImports,
  markUdiscImportHydrated,
  recordUdiscImportTick,
  upsertUdiscImport,
  type UdiscImportRow,
} from "./db-udisc-layout-imports.js";
import { ImportError, parseUdiscCourseUrls, parseUdiscLayouts, safeFetch, udiscSearchUrl } from "./imports.js";
import {
  CLUB_ORIGIN,
  DISCGOLFAPI_HOST,
  NEARBY_REGIONS,
  defaultLayoutName as nearbyDefaultLayoutName,
  discGolfApiUrl,
  normalizeCourseName,
  parseDiscGolfApiCourses,
  type NearbyCourseCandidate,
} from "./imports/nearby-courses.js";
import { normalizeUdiscCourseUrl, udiscSlugName, type UdiscLayout } from "./imports/udisc.js";
import { haversineMiles } from "./distance.js";
import { enrichHoles, type LayoutHole } from "./layouts.js";
import { layoutHasSatelliteMap, parseScorableHoles, type PositionInput } from "./db-courses.js";

export const UDISC_LAYOUT_IMPORT_CRON = "*/15 * * * *";
export const UDISC_IMPORT_MAX_ATTEMPTS = 3;
const UDISC_FETCH = { maxBytes: 3_000_000, timeoutMs: 20_000 } as const;

export function isUdiscLayoutCron(cron: string): boolean {
  const value = cron.trim();
  return value === UDISC_LAYOUT_IMPORT_CRON || /^\*\/15\b/.test(value);
}

export interface ImportCourse {
  id: number;
  name: string;
  location?: string | null;
  udisc_url?: string | null;
  lat?: number | null;
  lng?: number | null;
  mapped?: number | boolean | null;
}

export interface ImportAttempt {
  course_id: number;
  status: string;
  attempts: number;
}

const DONE = new Set(["imported", "skipped", "no_url", "no_layouts"]);

export function pickNextUdiscImportCourse(
  courses: ImportCourse[],
  imports: ImportAttempt[],
): ImportCourse | null {
  const byId = new Map(imports.map((row) => [row.course_id, row]));
  const pending = courses.filter((course) => {
    if (Number(course.mapped) === 1 || course.mapped === true) return false;
    const row = byId.get(course.id);
    if (!row) return true;
    if (DONE.has(row.status)) return false;
    if (row.status === "failed" && row.attempts >= UDISC_IMPORT_MAX_ATTEMPTS) return false;
    return true;
  });
  pending.sort((a, b) => {
    const urlA = Boolean(normalizeUdiscCourseUrl(a.udisc_url));
    const urlB = Boolean(normalizeUdiscCourseUrl(b.udisc_url));
    if (urlA !== urlB) return urlA ? -1 : 1;
    const milesA = milesFromClub(a);
    const milesB = milesFromClub(b);
    if (milesA !== milesB) return milesA - milesB;
    return a.name.localeCompare(b.name);
  });
  return pending[0] ?? null;
}

function milesFromClub(course: ImportCourse): number {
  const lat = Number(course.lat);
  const lng = Number(course.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 9999;
  return haversineMiles(CLUB_ORIGIN, { lat, lng });
}

export function nameTokens(value: string): Set<string> {
  return new Set(normalizeCourseName(value).split(" ").filter(Boolean));
}

export function tokenJaccard(a: string, b: string): number {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.size || !right.size) return 0;
  let inter = 0;
  for (const token of left) if (right.has(token)) inter += 1;
  return inter / (left.size + right.size - inter);
}

export function pickUdiscSearchMatch(
  course: { name: string; location?: string | null },
  urls: string[],
): string | null {
  const scored = urls
    .map((url) => {
      const slug = udiscSlugName(url);
      const exact = normalizeCourseName(slug) === normalizeCourseName(course.name) ? 1 : 0;
      const nameScore = Math.max(exact, tokenJaccard(course.name, slug));
      const loc = course.location ? tokenJaccard(course.location, slug) * 0.15 : 0;
      return { url, score: nameScore + loc };
    })
    .filter((row) => row.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  const top = scored[0];
  if (!top) return null;
  const second = scored[1];
  if (second && top.score - second.score < 0.1 && top.score < 0.99) return null;
  return top.url;
}

export function attachUdiscUrlsFromCatalog(
  courses: ImportCourse[],
  catalog: NearbyCourseCandidate[],
): { id: number; udisc_url: string }[] {
  const attached: { id: number; udisc_url: string }[] = [];
  const taken = new Set<number>();
  for (const api of catalog) {
    const url = normalizeUdiscCourseUrl(api.website);
    if (!url) continue;
    let best: { course: ImportCourse; score: number } | null = null;
    for (const course of courses) {
      if (taken.has(course.id) || normalizeUdiscCourseUrl(course.udisc_url)) continue;
      const miles =
        Number.isFinite(Number(course.lat)) && Number.isFinite(Number(course.lng))
          ? haversineMiles({ lat: Number(course.lat), lng: Number(course.lng) }, { lat: api.lat, lng: api.lng })
          : 99;
      if (miles > 0.5) continue;
      const score = Math.max(
        normalizeCourseName(course.name) === normalizeCourseName(api.name) ? 1 : 0,
        tokenJaccard(course.name, api.name),
      );
      if (score < 0.45) continue;
      if (!best || score > best.score) best = { course, score };
    }
    if (!best) continue;
    taken.add(best.course.id);
    attached.push({ id: best.course.id, udisc_url: url });
  }
  return attached;
}

export function isPlaceholderLayout(layout: { name?: unknown; holes?: unknown }): boolean {
  if (layoutHasSatelliteMap(layout.holes)) return false;
  if (String(layout.name ?? "") === nearbyDefaultLayoutName()) return true;
  const holes = parseScorableHoles(layout.holes);
  return holes.length > 0 && holes.every((hole) => hole.par === 3 && !hole.tee && !hole.target);
}

function holesFromUdisc(layout: UdiscLayout): LayoutHole[] {
  return layout.holes.map((hole) => ({
    hole: hole.hole,
    par: hole.par,
    tee: hole.tee,
    target: hole.target,
  }));
}

export type LayoutApply =
  | { action: "update"; layoutId: number; name: string; holes: LayoutHole[]; total_par: number }
  | { action: "create"; name: string; holes: LayoutHole[]; total_par: number };

export function planUdiscLayoutApply(opts: {
  existingLayouts: { id: number; name: string; holes?: unknown }[];
  existingPositions: { kind: string; label: string; lat?: number | null; lng?: number | null }[];
  layouts: UdiscLayout[];
}): { layouts: LayoutApply[]; positions: PositionInput[]; mapped: boolean } {
  const layouts: LayoutApply[] = [];
  const positions = mergePositions(opts.existingPositions, opts.layouts.flatMap((layout) => layout.positions));
  let placeholder = opts.existingLayouts.find((layout) => isPlaceholderLayout(layout)) ?? null;
  const usedIds = new Set<number>();

  for (const layout of opts.layouts) {
    const name = (layout.name && layout.name.trim()) || "Main";
    const { holes, total_par } = enrichHoles(holesFromUdisc(layout));
    const sameName = opts.existingLayouts.find(
      (row) => !usedIds.has(row.id) && db.normalizeLayoutLabel(row.name) === db.normalizeLayoutLabel(name),
    );
    if (sameName && layoutHasSatelliteMap(sameName.holes)) {
      usedIds.add(sameName.id);
      continue;
    }
    if (sameName) {
      usedIds.add(sameName.id);
      layouts.push({ action: "update", layoutId: sameName.id, name, holes, total_par });
      continue;
    }
    if (placeholder) {
      usedIds.add(placeholder.id);
      layouts.push({ action: "update", layoutId: placeholder.id, name, holes, total_par });
      placeholder = null;
      continue;
    }
    layouts.push({ action: "create", name, holes, total_par });
  }
  const mapped = opts.layouts.some((layout) =>
    layout.holes.some((hole) => hole.tee?.lat != null && hole.tee?.lng != null && hole.target?.lat != null && hole.target?.lng != null),
  );
  return { layouts, positions, mapped };
}

export function mergePositions(
  existing: { kind: string; label: string; lat?: number | null; lng?: number | null }[],
  incoming: { kind: "tee" | "target"; label: string; lat: number | null; lng: number | null }[],
): PositionInput[] {
  const byKey = new Map<string, PositionInput>();
  for (const row of existing) {
    if (row.kind !== "tee" && row.kind !== "target") continue;
    byKey.set(`${row.kind}:${row.label.toLowerCase()}`, {
      course_id: 0,
      kind: row.kind,
      label: row.label,
      lat: row.lat ?? null,
      lng: row.lng ?? null,
    });
  }
  for (const row of incoming) {
    const key = `${row.kind}:${row.label.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { course_id: 0, kind: row.kind, label: row.label, lat: row.lat, lng: row.lng });
      continue;
    }
    if (prev.lat == null && row.lat != null) prev.lat = row.lat;
    if (prev.lng == null && row.lng != null) prev.lng = row.lng;
  }
  return [...byKey.values()];
}

export type UdiscLayoutImportTick = {
  action: "idle" | "hydrated" | "imported" | "skipped" | "failed" | "done";
  remaining: number;
  course_id?: number;
  name?: string;
  udisc_url?: string | null;
  layouts?: number;
  mapped?: boolean;
  attached?: number;
  error?: string;
};

export async function runUdiscLayoutImportTick(env: Env): Promise<UdiscLayoutImportTick> {
  const now = Date.now();
  const courses = (await db.listCourses(env.DB)) as unknown as ImportCourse[];
  let imports: UdiscImportRow[] = [];
  let state = null as Awaited<ReturnType<typeof getUdiscImportState>>;
  try {
    imports = await listUdiscImports(env.DB);
    state = await getUdiscImportState(env.DB);
  } catch (error) {
    return finish(env, now, { action: "failed", remaining: unmappedCount(courses), error: error instanceof Error ? error.message : String(error) });
  }

  if (!state?.hydrated_at) {
    const attached = await hydrateUdiscUrls(env, courses);
    await markUdiscImportHydrated(env.DB, now);
    const remaining = unmappedCount((await db.listCourses(env.DB)) as unknown as ImportCourse[]);
    return finish(env, now, { action: "hydrated", remaining, attached: attached.length });
  }

  const next = pickNextUdiscImportCourse(courses, imports);
  if (!next) {
    return finish(env, now, { action: "done", remaining: unmappedCount(courses) });
  }

  const prior = imports.find((row) => row.course_id === next.id);
  const attempts = (prior?.attempts ?? 0) + 1;
  try {
    const resolved = await resolveUdiscUrl(next);
    if (!resolved) {
      await upsertUdiscImport(env.DB, {
        course_id: next.id,
        status: "no_url",
        attempts,
        attempted_at: now,
        finished_at: now,
        error: "no_udisc_url",
      });
      return finish(env, now, {
        action: "skipped",
        remaining: unmappedCount(courses) - 1,
        course_id: next.id,
        name: next.name,
        error: "no_udisc_url",
      });
    }

    const html = await safeFetch(resolved, ["udisc.com"], UDISC_FETCH);
    const parsed = parseUdiscLayouts(html, resolved);
    if (!parsed.layouts.length) {
      await db.updateCourse(env.DB, next.id, { udisc_url: resolved, udisc_course_id: parsed.udisc_course_id });
      await upsertUdiscImport(env.DB, {
        course_id: next.id,
        status: "no_layouts",
        udisc_url: resolved,
        attempts,
        attempted_at: now,
        finished_at: now,
        error: "no_layouts",
      });
      return finish(env, now, {
        action: "skipped",
        remaining: unmappedCount(courses) - (Number(next.mapped) === 1 ? 0 : 1),
        course_id: next.id,
        name: next.name,
        udisc_url: resolved,
        error: "no_layouts",
      });
    }

    const existingLayouts = (await db.listLayouts(env.DB, next.id)) as { id: number; name: string; holes?: unknown }[];
    const existingPositions = (await db.listPositions(env.DB, next.id)) as {
      kind: string;
      label: string;
      lat?: number | null;
      lng?: number | null;
    }[];
    const plan = planUdiscLayoutApply({ existingLayouts, existingPositions, layouts: parsed.layouts });

    await db.updateCourse(env.DB, next.id, { udisc_url: resolved, udisc_course_id: parsed.udisc_course_id });
    const newPositions = plan.positions.filter((pos) => {
      return !existingPositions.some((row) => row.kind === pos.kind && row.label.toLowerCase() === pos.label.toLowerCase());
    });
    for (const pos of newPositions) {
      await db.createPosition(env.DB, { ...pos, course_id: next.id });
    }
    for (const layout of plan.layouts) {
      if (layout.action === "update") {
        await db.updateLayout(env.DB, layout.layoutId, { name: layout.name, holes: layout.holes, total_par: layout.total_par });
      } else {
        await db.createLayout(env.DB, { course_id: next.id, name: layout.name, holes: layout.holes, total_par: layout.total_par });
      }
    }

    await upsertUdiscImport(env.DB, {
      course_id: next.id,
      status: "imported",
      udisc_url: resolved,
      layouts_imported: plan.layouts.length,
      mapped: plan.mapped ? 1 : 0,
      attempts,
      attempted_at: now,
      finished_at: now,
    });
    return finish(env, now, {
      action: "imported",
      remaining: Math.max(0, unmappedCount(courses) - (plan.mapped ? 1 : 0)),
      course_id: next.id,
      name: next.name,
      udisc_url: resolved,
      layouts: plan.layouts.length,
      mapped: plan.mapped,
    });
  } catch (error) {
    const message = error instanceof ImportError ? error.message : error instanceof Error ? error.message : String(error);
    await upsertUdiscImport(env.DB, {
      course_id: next.id,
      status: "failed",
      udisc_url: normalizeUdiscCourseUrl(next.udisc_url),
      attempts,
      attempted_at: now,
      error: message.slice(0, 500),
      finished_at: attempts >= UDISC_IMPORT_MAX_ATTEMPTS ? now : null,
    });
    return finish(env, now, {
      action: "failed",
      remaining: unmappedCount(courses),
      course_id: next.id,
      name: next.name,
      error: message,
    });
  }
}

function unmappedCount(courses: ImportCourse[]): number {
  return courses.filter((course) => Number(course.mapped) !== 1 && course.mapped !== true).length;
}

async function finish(env: Env, now: number, tick: UdiscLayoutImportTick): Promise<UdiscLayoutImportTick> {
  try {
    await recordUdiscImportTick(env.DB, {
      last_course_id: tick.course_id ?? null,
      last_status: tick.action,
      last_name: tick.name ?? null,
      last_error: tick.error ?? null,
      last_run_at: now,
    });
  } catch {
    /* progress table is best-effort */
  }
  return tick;
}

async function hydrateUdiscUrls(env: Env, courses: ImportCourse[]): Promise<{ id: number; udisc_url: string }[]> {
  const catalog: NearbyCourseCandidate[] = [];
  for (const region of NEARBY_REGIONS) {
    try {
      const text = await safeFetch(discGolfApiUrl(region), [DISCGOLFAPI_HOST], {
        maxBytes: 2_000_000,
        timeoutMs: 15_000,
        headers: { Accept: "application/json" },
      });
      catalog.push(...parseDiscGolfApiCourses(JSON.parse(text)));
    } catch {
      /* keep going with whatever regions loaded */
    }
  }
  const attached = attachUdiscUrlsFromCatalog(courses, catalog);
  for (const row of attached) {
    await db.updateCourse(env.DB, row.id, { udisc_url: row.udisc_url });
  }
  return attached;
}

async function resolveUdiscUrl(course: ImportCourse): Promise<string | null> {
  const existing = normalizeUdiscCourseUrl(course.udisc_url);
  if (existing) return existing;
  const query = [course.name, course.location].filter(Boolean).join(" ");
  const html = await safeFetch(udiscSearchUrl(query), ["udisc.com"], UDISC_FETCH);
  return pickUdiscSearchMatch(course, parseUdiscCourseUrls(html));
}
