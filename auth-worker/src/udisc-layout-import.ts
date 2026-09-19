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
    // Club courses already in the DB: pull UDisc layouts first when we never stored a UDisc id.
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
