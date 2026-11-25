// Pure parser for OpenStreetMap disc golf course features (ODbL, © OpenStreetMap contributors).
// Fetches and matches hole ways (disc_golf=hole) and tee/basket nodes within a single course cluster
// while rejecting nearby competing courses in the same park (e.g. Boulder Woods vs Quaker's Challenge).

import { haversineFeet } from "../distance.js";
import { normalizeCourseName } from "./nearby-courses.js";

export const OSM_API_HOST = "api.openstreetmap.org";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const OSM_USER_AGENT = "GVDGClubSite/1.0 (+https://gvdgclub.com)";
export const OSM_BBOX_METERS = 650;
export const OSM_MIN_HOLES = 3;

const FEET_PER_METER = 3.28084;
const CLUSTER_RADIUS_M = 750;
const MIN_HOLE_FT = 30;
const MAX_HOLE_FT = 2_000;

const GENERIC_TOKENS = new Set([
  "the", "at", "and", "of", "in", "for",
  "disc", "golf", "course", "dgc", "park",
]);

export interface OsmHolePins {
  hole: number;
  tee: { label: string; lat: number; lng: number; source: "osm" };
  target: { label: string; lat: number; lng: number; source: "osm" };
  par: number | null;
}

type OsmPoint = { lat: number; lng: number };
type OsmNode = OsmPoint & { id: number; tags: Record<string, string> };
type OsmWay = { id: number; nodes: number[]; tags: Record<string, string> };
type OsmRelation = { id: number; members: { type: string; ref: number }[]; tags: Record<string, string> };
type CourseCluster = OsmPoint & { name: string; memberWayIds: Set<number> };

export function osmMapBboxUrl(origin: { lat: number; lng: number }, meters = OSM_BBOX_METERS): string {
  const dLat = meters / 111_320;
  const cosLat = Math.max(Math.cos((origin.lat * Math.PI) / 180), 0.2);
  const dLng = meters / (111_320 * cosLat);
  const minLng = (origin.lng - dLng).toFixed(5);
  const minLat = (origin.lat - dLat).toFixed(5);
  const maxLng = (origin.lng + dLng).toFixed(5);
  const maxLat = (origin.lat + dLat).toFixed(5);
  return `https://${OSM_API_HOST}/api/0.6/map.json?bbox=${minLng},${minLat},${maxLng},${maxLat}`;
}

function distMeters(a: OsmPoint, b: OsmPoint): number {
  return haversineFeet(a, b) / FEET_PER_METER;
}

function toStringTags(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function parseHoleRef(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return n >= 1 && n <= 36 ? n : null;
}

function parseParTag(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return n >= 1 && n <= 15 ? n : null;
}

function distinctiveTokens(name: string): Set<string> {
  const tokens = new Set<string>();
  for (const part of normalizeCourseName(name).split(/\s+/).filter(Boolean)) {
    if (part.length >= 2 && !GENERIC_TOKENS.has(part)) tokens.add(part);
  }
  return tokens;
}

function courseMatchesName(targetName: string, candidateName: string): boolean {
  const normA = normalizeCourseName(targetName);
  const normB = normalizeCourseName(candidateName);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  const a = distinctiveTokens(targetName);
  const b = distinctiveTokens(candidateName);
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  if (!shared) return false;
  const jaccard = shared / (a.size + b.size - shared);
  return shared === a.size || shared === b.size || jaccard >= 0.45;
}

function centroidOfPoints(points: readonly OsmPoint[]): OsmPoint | null {
  if (!points.length) return null;
  let latSum = 0;
  let lngSum = 0;
  for (const p of points) {
    latSum += p.lat;
    lngSum += p.lng;
  }
  return { lat: latSum / points.length, lng: lngSum / points.length };
}

export function parseOsmDiscGolfHoles(
  payload: unknown,
  course: { name: string; lat: number; lng: number },
): OsmHolePins[] {
  if (!payload || typeof payload !== "object") return [];
  const rawElements = (payload as { elements?: unknown }).elements;
  if (!Array.isArray(rawElements)) return [];
  if (!Number.isFinite(course.lat) || !Number.isFinite(course.lng)) return [];

  const nodesById = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];

  for (const item of rawElements) {
    if (!item || typeof item !== "object") continue;
    const el = item as { type?: unknown; id?: unknown; lat?: unknown; lon?: unknown; nodes?: unknown; members?: unknown; tags?: unknown };
    const id = typeof el.id === "number" && Number.isInteger(el.id) ? el.id : null;
    if (id == null) continue;
    const tags = toStringTags(el.tags);
    if (el.type === "node") {
      if (typeof el.lat === "number" && Number.isFinite(el.lat) && typeof el.lon === "number" && Number.isFinite(el.lon)) {
        nodesById.set(id, { id, lat: el.lat, lng: el.lon, tags });
      }
    } else if (el.type === "way" && Array.isArray(el.nodes)) {
      const nodeIds = el.nodes.filter((nid): nid is number => typeof nid === "number" && Number.isInteger(nid));
      ways.push({ id, nodes: nodeIds, tags });
    } else if (el.type === "relation" && Array.isArray(el.members)) {
      const members = el.members
        .filter((m): m is { type: string; ref: number } => Boolean(m && typeof m === "object" && typeof (m as { type?: unknown }).type === "string" && typeof (m as { ref?: unknown }).ref === "number"))
        .map((m) => ({ type: m.type, ref: m.ref }));
      relations.push({ id, members, tags });
    }
  }

  const waysById = new Map(ways.map((w) => [w.id, w]));
  const wayCentroid = (w: OsmWay): OsmPoint | null =>
    centroidOfPoints(w.nodes.map((nid) => nodesById.get(nid)).filter((n): n is OsmNode => Boolean(n)));

  const courseClusters: CourseCluster[] = [];
  for (const node of nodesById.values()) {
    if (node.tags.leisure === "disc_golf_course") {
      courseClusters.push({ name: node.tags.name || "", lat: node.lat, lng: node.lng, memberWayIds: new Set() });
    }
  }
  for (const w of ways) {
    if (w.tags.leisure === "disc_golf_course") {
      const c = wayCentroid(w);
      if (c) courseClusters.push({ name: w.tags.name || "", lat: c.lat, lng: c.lng, memberWayIds: new Set([w.id]) });
    }
  }
  for (const rel of relations) {
    if (rel.tags.leisure === "disc_golf_course") {
      const pts: OsmPoint[] = [];
      const memberWayIds = new Set<number>();
      for (const m of rel.members) {
        if (m.type === "node") {
          const n = nodesById.get(m.ref);
          if (n) pts.push(n);
        } else if (m.type === "way") {
          memberWayIds.add(m.ref);
          const w = waysById.get(m.ref);
          const wc = w ? wayCentroid(w) : null;
          if (wc) pts.push(wc);
        }
      }
      const c = centroidOfPoints(pts);
      if (c) courseClusters.push({ name: rel.tags.name || "", lat: c.lat, lng: c.lng, memberWayIds });
    }
  }

  const basePoint: OsmPoint = { lat: course.lat, lng: course.lng };
  const matched = courseClusters
    .filter((f) => f.name && courseMatchesName(course.name, f.name) && distMeters(f, basePoint) <= CLUSTER_RADIUS_M)
    .sort((a, b) => distMeters(a, basePoint) - distMeters(b, basePoint))[0] ?? null;

  const clusterOrigin: OsmPoint = matched ? { lat: matched.lat, lng: matched.lng } : basePoint;
  const matchedRelationWayIds = matched?.memberWayIds ?? new Set<number>();
  const competingCourses = courseClusters.filter(
    (f) => (!f.name || !courseMatchesName(course.name, f.name)) && distMeters(f, clusterOrigin) > 80,
  );

  const acceptsPoint = (pt: OsmPoint): boolean => {
    const dCluster = distMeters(pt, clusterOrigin);
    if (dCluster > CLUSTER_RADIUS_M) return false;
    return competingCourses.every((other) => dCluster < distMeters(pt, other) * 0.85);
  };

  type HoleCandidate = {
    hole: number;
    tee: OsmPoint;
    target: OsmPoint;
    par: number | null;
    inRelation: boolean;
    distM: number;
  };
  const byHole = new Map<number, HoleCandidate>();

  for (const w of ways) {
    if (w.tags.disc_golf !== "hole" || w.nodes.length < 2) continue;
    const hole = parseHoleRef(w.tags.ref);
    if (hole == null) continue;
    const n0 = nodesById.get(w.nodes[0]!);
    const nLast = nodesById.get(w.nodes[w.nodes.length - 1]!);
    if (!n0 || !nLast) continue;
    const reversed = n0.tags.disc_golf === "basket" && nLast.tags.disc_golf === "tee";
    const tee = reversed ? nLast : n0;
    const target = reversed ? n0 : nLast;
    const feet = haversineFeet(tee, target);
    if (feet < MIN_HOLE_FT || feet > MAX_HOLE_FT) continue;
    const midpoint = { lat: (tee.lat + target.lat) / 2, lng: (tee.lng + target.lng) / 2 };
    const inRelation = matchedRelationWayIds.has(w.id);
    if (!inRelation && !acceptsPoint(midpoint)) continue;
    const distM = distMeters(midpoint, clusterOrigin);
    const prev = byHole.get(hole);
    if (
      !prev ||
      (inRelation && !prev.inRelation) ||
      (inRelation === prev.inRelation && distM < prev.distM)
    ) {
      byHole.set(hole, {
        hole,
        tee: { lat: tee.lat, lng: tee.lng },
        target: { lat: target.lat, lng: target.lng },
        par: parseParTag(w.tags.par),
        inRelation,
        distM,
      });
    }
  }

  const standaloneTees = new Map<number, OsmNode[]>();
  const standaloneBaskets = new Map<number, OsmNode[]>();
  for (const node of nodesById.values()) {
    const hole = parseHoleRef(node.tags.ref);
    if (hole == null || byHole.has(hole)) continue;
    if (node.tags.disc_golf === "tee" && acceptsPoint(node)) {
      const list = standaloneTees.get(hole) ?? [];
      list.push(node);
      standaloneTees.set(hole, list);
    } else if (node.tags.disc_golf === "basket" && acceptsPoint(node)) {
      const list = standaloneBaskets.get(hole) ?? [];
      list.push(node);
      standaloneBaskets.set(hole, list);
    }
  }

  for (let hole = 1; hole <= 36; hole += 1) {
    if (byHole.has(hole)) continue;
    const tees = standaloneTees.get(hole) ?? [];
    const baskets = standaloneBaskets.get(hole) ?? [];
    if (tees.length !== 1 || baskets.length !== 1) continue;
    const tee = tees[0]!;
    const target = baskets[0]!;
    const feet = haversineFeet(tee, target);
    if (feet < MIN_HOLE_FT || feet > MAX_HOLE_FT) continue;
    const midpoint = { lat: (tee.lat + target.lat) / 2, lng: (tee.lng + target.lng) / 2 };
    byHole.set(hole, {
      hole,
      tee: { lat: tee.lat, lng: tee.lng },
      target: { lat: target.lat, lng: target.lng },
      par: parseParTag(tee.tags.par) ?? parseParTag(target.tags.par),
      inRelation: false,
      distM: distMeters(midpoint, clusterOrigin),
    });
  }

  const out: OsmHolePins[] = [...byHole.values()]
    .sort((a, b) => a.hole - b.hole)
    .map((entry) => ({
      hole: entry.hole,
      tee: { label: `Hole ${entry.hole} tee`, lat: entry.tee.lat, lng: entry.tee.lng, source: "osm" },
      target: { label: `Hole ${entry.hole} basket`, lat: entry.target.lat, lng: entry.target.lng, source: "osm" },
      par: entry.par,
    }));

  return out.length >= OSM_MIN_HOLES ? out : [];
}
