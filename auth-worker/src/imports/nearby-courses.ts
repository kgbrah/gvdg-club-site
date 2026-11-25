// DiscGolfAPI course import. Pulls every listed North Carolina course plus nearby
// listings within 250 miles of Greenville, skips ones already in the club catalog (name or GPS),
// and mints a par-3 default layout so a card can start immediately.
// Attribution required: https://discgolfapi.com/licence/

import { haversineMiles } from "../distance.js";

export const CLUB_ORIGIN = { lat: 35.6127, lng: -77.3664 } as const;
export const NEARBY_MILES = 100;
export const DAY_TRIP_MILES = 250;
export const MIN_HOLES = 6;
export const MAX_HOLES = 36;
export const DISCGOLFAPI_HOST = "io.discgolfapi.com";
export const DISCGOLFAPI_ATTRIBUTION = "Course data supplied by DiscGolfAPI.";
export const NEARBY_REGIONS = ["NC", "VA", "SC", "MD", "WV", "DE", "GA", "TN"] as const;
export const HOME_REGION = "NC";
export const DISCGOLFAPI_PAGE = 250;

// Bounding boxes [code, minLat, maxLat, minLng, maxLng] covering DiscGolfAPI US states,
// Canadian provinces/territories, GB nations, AU states, and DE states. Used to map a
// player's GPS coordinates + radius to relevant DiscGolfAPI region queries without
// hardcoding Greenville or scanning all 93 regions on every request.
export const DISCGOLFAPI_REGION_BOXES: ReadonlyArray<
  readonly [code: string, minLat: number, maxLat: number, minLng: number, maxLng: number]
> = [
  // US Northeast / Mid-Atlantic
  ["PA", 39.71, 42.27, -80.53, -74.68],
  ["NY", 40.49, 45.02, -79.77, -71.85],
  ["NJ", 38.92, 41.36, -75.57, -73.89],
  ["DE", 38.45, 39.84, -75.79, -75.04],
  ["MD", 37.91, 39.73, -79.49, -75.04],
  ["VA", 36.54, 39.47, -83.68, -75.24],
  ["WV", 37.20, 40.64, -82.65, -77.72],
  ["CT", 40.98, 42.06, -73.73, -71.78],
  ["MA", 41.23, 42.89, -73.51, -69.92],
  ["RI", 41.14, 42.02, -71.87, -71.12],
  ["VT", 42.72, 45.02, -73.44, -71.46],
  ["NH", 42.69, 45.31, -72.56, -70.61],
  ["ME", 43.05, 47.46, -71.09, -66.94],
  // US Southeast
  ["NC", 33.84, 36.59, -84.33, -75.45],
  ["SC", 32.03, 35.22, -83.36, -78.54],
  ["GA", 30.35, 35.01, -85.61, -80.84],
  ["FL", 24.51, 31.01, -87.64, -80.03],
  ["AL", 30.22, 35.01, -88.48, -84.89],
  ["MS", 30.17, 35.00, -91.66, -88.09],
  ["TN", 34.98, 36.68, -90.32, -81.64],
  ["KY", 36.49, 39.15, -89.58, -81.96],
  // US Midwest
  ["OH", 38.40, 41.98, -84.82, -80.51],
  ["IN", 37.77, 41.77, -88.10, -84.78],
  ["MI", 41.69, 48.31, -90.42, -82.41],
  ["IL", 36.97, 42.51, -91.52, -87.02],
  ["WI", 42.49, 47.31, -92.89, -86.25],
  ["MN", 43.49, 49.39, -97.24, -89.49],
  ["IA", 40.37, 43.51, -96.64, -90.14],
  ["MO", 35.99, 40.62, -95.78, -89.09],
  ["ND", 45.93, 49.01, -104.05, -96.55],
  ["SD", 42.47, 45.95, -104.06, -96.43],
  ["NE", 40.00, 43.01, -104.06, -95.30],
  ["KS", 36.99, 40.01, -102.06, -94.58],
  // US South Central
  ["AR", 33.00, 36.50, -94.62, -89.64],
  ["LA", 28.92, 33.02, -94.05, -88.81],
  ["OK", 33.61, 37.01, -103.01, -94.43],
  ["TX", 25.83, 36.51, -106.65, -93.50],
  // US West
  ["NM", 31.33, 37.00, -109.06, -103.00],
  ["AZ", 31.33, 37.01, -114.82, -109.04],
  ["CO", 36.99, 41.01, -109.07, -102.04],
  ["UT", 36.99, 42.01, -114.06, -109.04],
  ["WY", 40.99, 45.01, -111.06, -104.05],
  ["MT", 44.35, 49.01, -116.06, -104.03],
  ["ID", 41.98, 49.01, -117.25, -111.04],
  ["WA", 45.54, 49.01, -124.79, -116.91],
  ["OR", 41.99, 46.30, -124.57, -116.46],
  ["NV", 35.00, 42.01, -120.01, -114.03],
  ["CA", 32.53, 42.01, -124.42, -114.13],
  ["AK", 51.21, 71.39, -179.15, -129.97],
  ["HI", 18.91, 22.24, -160.25, -154.80],
  // Canada
  ["AB", 48.99, 60.01, -120.01, -110.00],
  ["BC", 48.30, 60.01, -139.06, -114.05],
  ["MB", 48.99, 60.01, -102.01, -88.94],
  ["NB", 44.59, 48.08, -69.06, -63.77],
  ["NL", 46.60, 60.38, -67.81, -52.61],
  ["NS", 43.39, 47.04, -66.39, -59.68],
  ["NT", 60.00, 78.77, -136.47, -102.00],
  ["NU", 51.65, 83.12, -120.47, -61.20],
  ["ON", 41.67, 56.86, -95.16, -74.32],
  ["PE", 45.94, 47.07, -64.42, -61.96],
  ["QC", 44.99, 62.59, -79.77, -57.10],
  ["SK", 48.99, 60.01, -110.01, -101.36],
  ["YT", 60.00, 69.65, -141.01, -123.80],
  // Great Britain
  ["ENG", 49.86, 55.82, -6.42, 1.77],
  ["WLS", 51.37, 53.44, -5.36, -2.64],
  ["SCT", 54.63, 60.86, -8.65, -0.72],
  ["NIR", 54.02, 55.32, -8.18, -5.43],
  // Australia
  ["NSW", -37.51, -28.15, 140.99, 153.64],
  ["VIC", -39.16, -33.98, 140.96, 149.98],
  ["QLD", -29.18, -10.68, 137.99, 153.56],
  ["SA", -38.07, -25.99, 129.00, 141.01],
  ["TAS", -43.65, -39.57, 143.81, 148.50],
  // Germany
  ["BB", 51.35, 53.56, 11.26, 14.77],
  ["BW", 47.53, 49.80, 7.51, 10.50],
  ["HB", 53.01, 53.61, 8.48, 8.99],
];

export const KNOWN_DISCGOLFAPI_REGIONS: ReadonlySet<string> = new Set(
  DISCGOLFAPI_REGION_BOXES.map(([code]) => code),
);

const ALWAYS_DUP_MILES = 0.12;
const SIMILAR_DUP_MILES = 3;
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
  confidence?: number | null;
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
  confidence_score?: unknown;
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

/** Query DiscGolfAPI by region without a `country=US` filter so northern US border
 *  courses (e.g., Erie PA, NY, MT, MI, WI) that DiscGolfAPI filed under `CA` are included. */
export function discGolfApiRegionUrl(region: string, limit = DISCGOLFAPI_PAGE, offset = 0): string {
  const params = new URLSearchParams({
    region: region.trim().toUpperCase(),
    limit: String(limit),
    offset: String(Math.max(0, offset)),
  });
  return `https://${DISCGOLFAPI_HOST}/v1/courses?${params.toString()}`;
}

function clampCoord(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** DiscGolfAPI region codes whose bounding box reaches within `miles` of `origin`,
 *  ordered closest-box-first and capped at `maxRegions`. */
export function regionsNearPoint(
  origin: { lat: number; lng: number },
  miles: number,
  maxRegions = 10,
): string[] {
  if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) return [];
  const radius = Math.max(1, Math.min(250, Math.round(miles)));
  const latDelta = radius / 69;
  const cos = Math.cos((origin.lat * Math.PI) / 180);
  const lngDelta = radius / (69 * (Number.isFinite(cos) && Math.abs(cos) > 0.2 ? Math.abs(cos) : 0.2));
  const minQLat = origin.lat - latDelta;
  const maxQLat = origin.lat + latDelta;
  const minQLng = origin.lng - lngDelta;
  const maxQLng = origin.lng + lngDelta;
  const hits: { code: string; dist: number }[] = [];
  for (const [code, minLat, maxLat, minLng, maxLng] of DISCGOLFAPI_REGION_BOXES) {
    if (maxLat < minQLat || minLat > maxQLat || maxLng < minQLng || minLng > maxQLng) continue;
    const nearestLat = clampCoord(origin.lat, minLat, maxLat);
    const nearestLng = clampCoord(origin.lng, minLng, maxLng);
    const dist = haversineMiles(origin, { lat: nearestLat, lng: nearestLng });
    if (dist <= radius + 15) hits.push({ code, dist });
  }
  hits.sort((a, b) => a.dist - b.dist || a.code.localeCompare(b.code));
  return hits.slice(0, Math.max(1, maxRegions)).map((hit) => hit.code);
}

export function isDuplicateCourse(cand: NearbyCourseCandidate, row: NearbyExistingCourse): boolean {
  return isDuplicate(cand, {
    name: row.name,
    location: row.location ?? "",
    lat: finite(row.lat),
    lng: finite(row.lng),
  });
}

export function uniqueCourseName(name: string, location: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const city = cityOf(location);
  const loc = location.trim();
  const candidates = [
    city ? `${name}, ${city}` : "",
    loc && loc !== city ? `${name}, ${loc}` : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!taken.has(candidate)) return candidate;
  }
  const base = candidates[0] || `${name} (nearby)`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

export function dedupeNearbyCandidates(candidates: NearbyCourseCandidate[]): NearbyCourseCandidate[] {
  const ordered = candidates.slice().sort((a, b) => {
    const confDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (confDiff !== 0) return confDiff;
    const holeDiff = b.holes - a.holes;
    if (holeDiff !== 0) return holeDiff;
    return (a.source_id ?? "").localeCompare(b.source_id ?? "");
  });
  const kept: NearbyCourseCandidate[] = [];
  for (const cand of ordered) {
    if (isBogusListing(cand)) continue;
    if (kept.some((existing) => isDuplicateCourse(cand, existing))) continue;
    kept.push(cand);
  }
  return kept;
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

export function defaultPar3Holes(count: number): { hole: number; par: number; par_source: "placeholder" }[] {
  const n = Math.max(MIN_HOLES, Math.min(MAX_HOLES, Math.round(count)));
  return Array.from({ length: n }, (_, i) => ({ hole: i + 1, par: 3, par_source: "placeholder" }));
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
    confidence: finite(c.confidence_score),
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
