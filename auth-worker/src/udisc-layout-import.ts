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
  udisc_course_id?: string | number | null;
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
    const row = byId.get(course.id);
    if (row) {
      if (DONE.has(row.status)) return false;
      if (row.status === "failed" && row.attempts >= UDISC_IMPORT_MAX_ATTEMPTS) return false;
    }
    const mapped = Number(course.mapped) === 1 || course.mapped === true;
    if (!mapped) return true;
    if (course.udisc_course_id) return false;
    return Boolean(normalizeUdiscCourseUrl(course.udisc_url));
  });
  pending.sort((a, b) => {
    const mappedA = Number(a.mapped) === 1 || a.mapped === true ? 1 : 0;
    const mappedB = Number(b.mapped) === 1 || b.mapped === true ? 1 : 0;
    if (mappedA !== mappedB) return mappedB - mappedA;
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
