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
import { ImportError, parseUdiscCourseUrls, parseUdiscLayouts, safeFetch, udiscIndexUrl, udiscNcIndexUrl } from "./imports.js";
import {
  CLUB_ORIGIN,
  DAY_TRIP_MILES,
  defaultLayoutName as nearbyDefaultLayoutName,
  normalizeCourseName,
} from "./imports/nearby-courses.js";
import { normalizeUdiscCourseUrl, udiscSlugName, type UdiscLayout } from "./imports/udisc.js";
import { haversineMiles } from "./distance.js";
import { enrichHoles, type LayoutHole } from "./layouts.js";
import { layoutHasSatelliteMap, parseScorableHoles, type PositionInput } from "./db-courses.js";
import { bustCourseCatalogCache } from "./course-catalog-cache.js";

export const UDISC_LAYOUT_IMPORT_CRON = "*/15 * * * *";
export const UDISC_IMPORT_MAX_ATTEMPTS = 3;
export const UDISC_IMPORTS_PER_TICK = 4;
export const UDISC_IMPORT_PRIORITY = ["Ashe County Park"];
export const KNOWN_UDISC_URLS: Record<string, string> = {
  "ashe county park": "https://udisc.com/courses/ashe-county-park-wllg",
};
const UDISC_FETCH = { maxBytes: 3_000_000, timeoutMs: 20_000 } as const;
const UDISC_INDEX_PAGES = 20;

export function isUdiscLayoutCron(cron: string): boolean {
  const value = cron.trim();
  return value === UDISC_LAYOUT_IMPORT_CRON || /^\*\/15\b/.test(value);
}

export interface ImportCourse {
  id: number;
  name: string;
  location?: string | null;
  udisc_url?: string | null;
  udisc_course_id?: string | null;
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

function isMapped(course: ImportCourse): boolean {
  return Number(course.mapped) === 1 || course.mapped === true;
}

function hasUdiscId(course: ImportCourse): boolean {
  return Boolean(String(course.udisc_course_id ?? "").trim());
}

export function pickNextUdiscImportCourse(
  courses: ImportCourse[],
  imports: ImportAttempt[],
): ImportCourse | null {
  const byId = new Map(imports.map((row) => [row.course_id, row]));
  const isDone = (course: ImportCourse) => {
    const row = byId.get(course.id);
    if (!row) return false;
    if (DONE.has(row.status)) return true;
    return row.status === "failed" && row.attempts >= UDISC_IMPORT_MAX_ATTEMPTS;
  };
  const unmappedPending = courses.some((course) => !isMapped(course) && !isDone(course));
  const pending = courses.filter((course) => {
    if (isDone(course)) return false;
    if (unmappedPending && isMapped(course)) return false;
    if (isMapped(course) && hasUdiscId(course)) return false;
    return true;
  });
  pending.sort((a, b) => {
    const priorityA = importPriority(a);
    const priorityB = importPriority(b);
    if (priorityA !== priorityB) return priorityA - priorityB;
    const urlA = Boolean(normalizeUdiscCourseUrl(a.udisc_url) || knownUdiscUrl(a));
    const urlB = Boolean(normalizeUdiscCourseUrl(b.udisc_url) || knownUdiscUrl(b));
    if (urlA !== urlB) return urlA ? -1 : 1;
    const milesA = milesFromClub(a);
    const milesB = milesFromClub(b);
    if (milesA !== milesB) return milesA - milesB;
    return a.name.localeCompare(b.name);
  });
  return pending[0] ?? null;
}

export function knownUdiscUrl(course: { name?: string | null }): string | null {
  const key = normalizeCourseName(String(course.name || ""));
  return KNOWN_UDISC_URLS[key] ?? null;
}

function importPriority(course: ImportCourse): number {
  const key = normalizeCourseName(course.name);
  const index = UDISC_IMPORT_PRIORITY.findIndex((name) => normalizeCourseName(name) === key);
  return index === -1 ? UDISC_IMPORT_PRIORITY.length : index;
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

export function attachUdiscUrlsFromIndex(
  courses: ImportCourse[],
  urls: string[],
): { id: number; udisc_url: string }[] {
  const attached: { id: number; udisc_url: string }[] = [];
  const taken = new Set<string>();
  for (const course of courses) {
    if (normalizeUdiscCourseUrl(course.udisc_url)) continue;
    const known = knownUdiscUrl(course);
    const match = known || pickUdiscSearchMatch(course, urls.filter((url) => !taken.has(url)));
    if (!match) continue;
    taken.add(match);
    attached.push({ id: course.id, udisc_url: match });
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
  let courses = (await db.listCourses(env.DB)) as unknown as ImportCourse[];
  let imports: UdiscImportRow[] = [];
  let state = null as Awaited<ReturnType<typeof getUdiscImportState>>;
  try {
    imports = await listUdiscImports(env.DB);
    state = await getUdiscImportState(env.DB);
  } catch (error) {
    return finish(env, now, { action: "failed", remaining: unmappedCount(courses), error: error instanceof Error ? error.message : String(error) });
  }

  const missingUrl = courses.some((course) => !isMapped(course) && !normalizeUdiscCourseUrl(course.udisc_url));
  let indexUrls: string[] = [];
  let attached = 0;
  if (!state?.hydrated_at || missingUrl) {
    indexUrls = await fetchUdiscIndexUrls();
    const rows = attachUdiscUrlsFromIndex(courses, indexUrls);
    for (const row of rows) {
      await db.updateCourse(env.DB, row.id, { udisc_url: row.udisc_url });
    }
    attached = rows.length;
    if (rows.length) {
      courses = (await db.listCourses(env.DB)) as unknown as ImportCourse[];
    }
    if (!state?.hydrated_at) await markUdiscImportHydrated(env.DB, now);
  }

  let last: UdiscLayoutImportTick | null = null;
  for (let n = 0; n < UDISC_IMPORTS_PER_TICK; n += 1) {
    const next = pickNextUdiscImportCourse(courses, imports);
    if (!next) break;
    last = await importOneCourse(env, now, next, courses, indexUrls);
    imports = await listUdiscImports(env.DB).catch(() => imports);
    const updated = courses.find((course) => course.id === next.id);
    if (updated && last.udisc_url) updated.udisc_url = last.udisc_url;
    if (last.action === "imported" && last.mapped && updated) updated.mapped = 1;
  }

  if (!last) {
    return finish(env, now, {
      action: attached ? "hydrated" : "done",
      remaining: unmappedCount(courses),
      attached: attached || undefined,
    });
  }
  if (attached) last.attached = attached;
  return finish(env, now, last);
}

async function importOneCourse(
  env: Env,
  now: number,
  next: ImportCourse,
  courses: ImportCourse[],
  indexUrls: string[],
): Promise<UdiscLayoutImportTick> {
  const prior = (await listUdiscImports(env.DB).catch(() => [])) as ImportAttempt[];
  const attempts = ((prior.find((row) => row.course_id === next.id)?.attempts ?? 0) + 1);
  try {
    let resolved = await resolveUdiscUrl(next, indexUrls);
    if (!resolved) {
      await upsertUdiscImport(env.DB, {
        course_id: next.id,
        status: "no_url",
        attempts: UDISC_IMPORT_MAX_ATTEMPTS,
        attempted_at: now,
        finished_at: now,
        error: "no_udisc_url",
      });
      return {
        action: "skipped",
        remaining: unmappedCount(courses) - (isMapped(next) ? 0 : 1),
        course_id: next.id,
        name: next.name,
        error: "no_udisc_url",
      };
    }

    let html: string;
    try {
      html = await safeFetch(resolved, ["udisc.com"], UDISC_FETCH);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("fetch_failed_404")) {
        if (!indexUrls.length) indexUrls.push(...(await fetchUdiscIndexUrls()));
        const fresh = pickUdiscSearchMatch(next, indexUrls);
        if (fresh && fresh !== resolved) {
          resolved = fresh;
          html = await safeFetch(resolved, ["udisc.com"], UDISC_FETCH);
        } else {
          await upsertUdiscImport(env.DB, {
            course_id: next.id,
            status: "no_url",
            udisc_url: resolved,
            attempts: UDISC_IMPORT_MAX_ATTEMPTS,
            attempted_at: now,
            finished_at: now,
            error: "fetch_failed_404",
          });
          return {
            action: "skipped",
            remaining: unmappedCount(courses) - (isMapped(next) ? 0 : 1),
            course_id: next.id,
            name: next.name,
            udisc_url: resolved,
            error: "fetch_failed_404",
          };
        }
      } else {
        throw error;
      }
    }

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
      return {
        action: "skipped",
        remaining: unmappedCount(courses) - (isMapped(next) ? 0 : 1),
        course_id: next.id,
        name: next.name,
        udisc_url: resolved,
        error: "no_layouts",
      };
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
    return {
      action: "imported",
      remaining: Math.max(0, unmappedCount(courses) - (plan.mapped && !isMapped(next) ? 1 : 0)),
      course_id: next.id,
      name: next.name,
      udisc_url: resolved,
      layouts: plan.layouts.length,
      mapped: plan.mapped,
    };
  } catch (error) {
    const message = error instanceof ImportError ? error.message : error instanceof Error ? error.message : String(error);
    const exhausted = attempts >= UDISC_IMPORT_MAX_ATTEMPTS || message.includes("fetch_failed_404");
    await upsertUdiscImport(env.DB, {
      course_id: next.id,
      status: exhausted ? "no_url" : "failed",
      udisc_url: normalizeUdiscCourseUrl(next.udisc_url),
      attempts: exhausted ? UDISC_IMPORT_MAX_ATTEMPTS : attempts,
      attempted_at: now,
      error: message.slice(0, 500),
      finished_at: exhausted ? now : null,
    });
    return {
      action: exhausted ? "skipped" : "failed",
      remaining: unmappedCount(courses),
      course_id: next.id,
      name: next.name,
      error: message,
    };
  }
}

function unmappedCount(courses: ImportCourse[]): number {
  return courses.filter((course) => !isMapped(course)).length;
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
  if (tick.action === "imported" || tick.action === "hydrated") {
    try { await bustCourseCatalogCache(); } catch { /* cache bust is best-effort */ }
  }
  return tick;
}

async function fetchUdiscIndexUrls(): Promise<string[]> {
  const seen = new Set<string>();
  const urls: string[] = [];
  const sources = [
    (page: number) => udiscIndexUrl(CLUB_ORIGIN, DAY_TRIP_MILES, page),
    (page: number) => udiscNcIndexUrl(page),
  ];
  for (const source of sources) {
    for (let page = 1; page <= UDISC_INDEX_PAGES; page += 1) {
      try {
        const html = await safeFetch(source(page), ["udisc.com"], UDISC_FETCH);
        const pageUrls = parseUdiscCourseUrls(html);
        let fresh = 0;
        for (const url of pageUrls) {
          if (seen.has(url)) continue;
          seen.add(url);
          urls.push(url);
          fresh += 1;
        }
        if (page > 1 && fresh === 0) break;
      } catch {
        break;
      }
    }
  }
  return urls;
}

async function resolveUdiscUrl(course: ImportCourse, indexUrls: string[]): Promise<string | null> {
  const existing = normalizeUdiscCourseUrl(course.udisc_url) || knownUdiscUrl(course);
  if (existing) return existing;
  if (!indexUrls.length) indexUrls.push(...(await fetchUdiscIndexUrls()));
  return pickUdiscSearchMatch(course, indexUrls);
}
