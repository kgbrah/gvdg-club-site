// DiscGolfAPI course import. Pulls every listed North Carolina course plus VA/SC listings
// within 150 miles of Greenville, skips ones already in the club catalog (name or GPS),
// and mints a par-3 default layout so a card can start immediately.
// Attribution required: https://discgolfapi.com/licence/

import { haversineMiles } from "../distance.js";

export const CLUB_ORIGIN = { lat: 35.6127, lng: -77.3664 } as const;
export const NEARBY_MILES = 100;
export const DAY_TRIP_MILES = 150;
export const MIN_HOLES = 6;
export const MAX_HOLES = 36;
export const DISCGOLFAPI_HOST = "io.discgolfapi.com";
export const DISCGOLFAPI_ATTRIBUTION = "Course data supplied by DiscGolfAPI.";
export const NEARBY_REGIONS = ["NC", "VA", "SC"] as const;
export const HOME_REGION = "NC";
export const DISCGOLFAPI_PAGE = 250;

const ALWAYS_DUP_MILES = 0.12;
const SIMILAR_DUP_MILES = 0.5;
const NAME_JACCARD = 0.45;

const STOP = new Set([
  "the", "at", "and", "of", "disc", "golf", "course", "dgc", "park", "community",
  "college", "university", "high", "school", "elementary", "middle",
]);

export interface NearbyExistingCourse {
  name: string;
  location?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface NearbyCourseCandidate {
  name: string;
  location: string;
  lat: number;
  lng: number;
  holes: number;
  miles: number;
  region: string;
  source_id: string | null;
  website: string | null;
}

export interface NearbyImportPlan {
  insert: NearbyCourseCandidate[];
  skipped: number;
  considered: number;
}

type ApiLayout = { holes?: unknown };
type ApiCourse = {
  id?: unknown;
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  lng?: unknown;
  locality?: unknown;
  region_code?: unknown;
  holes?: unknown;
  website?: unknown;
  existence_status?: unknown;
  operational_status?: unknown;
  primary_layout?: ApiLayout | null;
};

export function discGolfApiUrl(region: string, limit = DISCGOLFAPI_PAGE, offset = 0): string {
  const params = new URLSearchParams({
    country: "US",
    region,
    limit: String(limit),
    offset: String(Math.max(0, offset)),
  });
  return `https://${DISCGOLFAPI_HOST}/v1/courses?${params.toString()}`;
}

export function discGolfApiTotal(payload: unknown): number {
  const total = payload && typeof payload === "object" ? (payload as { total?: unknown }).total : null;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

export function parseDiscGolfApiCourses(payload: unknown): NearbyCourseCandidate[] {
  const courses = payload && typeof payload === "object" ? (payload as { courses?: unknown }).courses : null;
  if (!Array.isArray(courses)) return [];
  const out: NearbyCourseCandidate[] = [];
  for (const raw of courses) {
    const parsed = parseApiCourse(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function planNearbyCourseImport(
  catalog: NearbyCourseCandidate[],
  existing: NearbyExistingCourse[],
  opts: { origin?: { lat: number; lng: number }; maxMiles?: number } = {},
): NearbyImportPlan {
  const origin = opts.origin ?? CLUB_ORIGIN;
  const maxMiles = opts.maxMiles ?? DAY_TRIP_MILES;
  const nearby = catalog
    .map((c) => ({ ...c, miles: round1(haversineMiles(origin, { lat: c.lat, lng: c.lng })) }))
    .filter((c) => isHomeCourse(c) || c.miles <= maxMiles)
    .sort((a, b) => a.miles - b.miles || a.name.localeCompare(b.name));

  const taken = existing.map((row) => ({
    name: row.name,
    location: row.location ?? "",
    lat: finite(row.lat),
    lng: finite(row.lng),
  }));
  const takenNames = new Set(existing.map((row) => row.name));
  let skipped = 0;
  const insert: NearbyCourseCandidate[] = [];

  for (const cand of nearby) {
    if (isBogusListing(cand)) {
      skipped += 1;
      continue;
    }
    if (taken.some((row) => isDuplicate(cand, row))) {
      skipped += 1;
      continue;
    }
    const name = uniqueName(cand.name, cityOf(cand.location), takenNames);
    const next = { ...cand, name };
    insert.push(next);
    taken.push({ name, location: cand.location, lat: cand.lat, lng: cand.lng });
    takenNames.add(name);
  }
  return { insert, skipped, considered: nearby.length };
}

export function defaultPar3Holes(count: number): { hole: number; par: number }[] {
  const n = Math.max(MIN_HOLES, Math.min(MAX_HOLES, Math.round(count)));
  return Array.from({ length: n }, (_, i) => ({ hole: i + 1, par: 3 }));
}

export function defaultLayoutName(): string {
  return "Default (par 3s)";
}

export function normalizeCourseName(name: string): string {
  let s = name.toLowerCase();
  s = s.replace(/\bdiscgolfpark\b/g, "disc golf park");
  s = s.replace(/\bdisc\s*golf(\s*course)?\b/g, " ");
  s = s.replace(/\bdgc\b/g, " ");
  s = s.replace(/\bcc\b/g, " community college ");
  s = s.replace(/\bhs\b/g, " high school ");
  s = s.replace(/[^a-z0-9]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function parseApiCourse(raw: unknown): NearbyCourseCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as ApiCourse;
  const name = typeof c.name === "string" ? c.name.trim() : "";
  const lat = finite(c.lat);
  const lng = finite(c.lon) ?? finite(c.lng);
  const holes = holeCount(c);
  if (!name || lat == null || lng == null || holes == null) return null;
  if (holes < MIN_HOLES || holes > MAX_HOLES) return null;
  const existence = str(c.existence_status);
  if (existence && existence !== "existing") return null;
  const operational = str(c.operational_status);
  if (operational === "closed" || operational === "abandoned") return null;
  const locality = str(c.locality);
  const region = str(c.region_code);
  const location = [locality, region].filter(Boolean).join(", ");
  const website = str(c.website);
  return {
    name,
    location,
    lat,
    lng,
    holes,
    miles: 0,
    region: region || "",
    source_id: str(c.id),
    website,
  };
}

function isHomeCourse(c: NearbyCourseCandidate): boolean {
  if (c.region === HOME_REGION) return true;
  return /(^|,\s*)NC$/i.test(c.location.trim());
}

function holeCount(c: ApiCourse): number | null {
  const direct = int(c.holes);
  if (direct != null) return direct;
  return int(c.primary_layout?.holes);
}

function isBogusListing(c: NearbyCourseCandidate): boolean {
  const name = c.name.toLowerCase();
  const city = cityOf(c.location).toLowerCase();
  if (name.includes("western carolina") && city === "greenville") return true;
  if (name.includes("pop-up")) return true;
  return false;
}

function isDuplicate(
  cand: NearbyCourseCandidate,
  row: { name: string; location: string; lat: number | null; lng: number | null },
): boolean {
  const sameName = normalizeCourseName(cand.name) === normalizeCourseName(row.name);
  if (sameName) {
    const miles = pairMiles(cand, row);
    if (miles == null) return true;
    if (miles <= 5) return true;
    return false;
  }
  const miles = pairMiles(cand, row);
  if (miles == null) return false;
  if (miles <= ALWAYS_DUP_MILES) return true;
  if (miles <= SIMILAR_DUP_MILES && nameJaccard(cand.name, row.name) >= NAME_JACCARD) return true;
  return false;
}

function pairMiles(
  cand: NearbyCourseCandidate,
  row: { lat: number | null; lng: number | null },
): number | null {
  if (row.lat == null || row.lng == null) return null;
  return haversineMiles({ lat: cand.lat, lng: cand.lng }, { lat: row.lat, lng: row.lng });
}

function nameJaccard(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function tokens(name: string): Set<string> {
  const out = new Set<string>();
  for (const part of normalizeCourseName(name).split(" ")) {
    if (part.length > 2 && !STOP.has(part)) out.add(part);
  }
  return out;
}

function uniqueName(name: string, city: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const withCity = city ? `${name}, ${city}` : `${name} (nearby)`;
  if (!taken.has(withCity)) return withCity;
  let n = 2;
  while (taken.has(`${withCity} (${n})`)) n += 1;
  return `${withCity} (${n})`;
}

function cityOf(location: string): string {
  return location.split(",")[0]!.trim();
}

function finite(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function int(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v ? v : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
