import { parseLocationBody } from "./live-locations.js";
import { holeMarker, type ScorableHole } from "./db-courses.js";

export const MAP_MARK_KINDS = ["tee", "target"] as const;
export type MapMarkKind = (typeof MAP_MARK_KINDS)[number];

export const MAP_MARK_ACCURACY_MAX_M = 25;
export const MAP_MARK_ANCHOR_MAX_M = 80;
export const MAP_MARK_OUTLIER_M = 15;
export const MAP_MARK_SPREAD_MAX_M = 12;
export const MAP_MARK_PUBLISH_MEMBERS = 3;

const EARTH_RADIUS_M = 6371000;

export type MapMarkPoint = { lat: number; lng: number };

export type MapMarkInput = MapMarkPoint & {
  hole: number;
  kind: MapMarkKind;
  accuracyM: number | null;
};

export type MapMarkSample = MapMarkPoint & {
  member_id: string;
  accuracy_m?: number | null;
};

export type MapConsensus = MapMarkPoint & {
  hole: number;
  kind: MapMarkKind;
  samples: number;
  members: number;
  spread_m: number | null;
  published: boolean;
};

export function normalizeMapMarkKind(value: unknown): MapMarkKind | null {
  if (value === "tee") return "tee";
  if (value === "target" || value === "pin" || value === "basket") return "target";
  return null;
}

export function haversineMeters(a: MapMarkPoint, b: MapMarkPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function parseMapMarkBody(body: unknown): MapMarkInput | null {
  if (!body || typeof body !== "object") return null;
  const source = body as { hole?: unknown; kind?: unknown; accuracyM?: unknown; accuracy_m?: unknown };
  const hole = Number(source.hole);
  const kind = normalizeMapMarkKind(source.kind);
  const point = parseLocationBody(body);
  if (!Number.isInteger(hole) || hole < 1 || hole > 36 || !kind || !point) return null;
  const rawAcc = source.accuracyM ?? source.accuracy_m;
  let accuracyM: number | null = null;
  if (rawAcc != null && rawAcc !== "") {
    const acc = Number(rawAcc);
    if (!Number.isFinite(acc) || acc < 0) return null;
    accuracyM = acc;
  }
  return { hole, kind, lat: point.lat, lng: point.lng, accuracyM };
}

export function mapMarkAccuracyOk(accuracyM: number | null | undefined): boolean {
  if (accuracyM == null) return true;
  return Number.isFinite(accuracyM) && accuracyM <= MAP_MARK_ACCURACY_MAX_M;
}

export function mapMarkNearAnchor(
  point: MapMarkPoint,
  anchor: MapMarkPoint | null | undefined,
  maxM = MAP_MARK_ANCHOR_MAX_M,
): boolean {
  if (!anchor) return true;
  return haversineMeters(point, anchor) <= maxM;
}

export function holeAnchor(
  hole: { tee?: { lat?: number | null; lng?: number | null } | null; target?: { lat?: number | null; lng?: number | null } | null } | null | undefined,
  kind: MapMarkKind,
): MapMarkPoint | null {
  const marker = kind === "tee" ? hole?.tee : hole?.target;
  const lat = Number(marker?.lat);
  const lng = Number(marker?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function computeMapConsensus(
  hole: number,
  kind: MapMarkKind,
  samples: readonly MapMarkSample[],
): MapConsensus {
  const usable = samples.filter((row) => mapMarkAccuracyOk(row.accuracy_m ?? null));
  const byMember = new Map<string, MapMarkSample>();
  for (const row of usable) {
    if (!row.member_id) continue;
    byMember.set(row.member_id, row);
  }
  const unique = [...byMember.values()];
  const unpublished = (members: number, extra: Partial<MapConsensus> = {}): MapConsensus => ({
    hole,
    kind,
    lat: extra.lat ?? unique[0]?.lat ?? 0,
    lng: extra.lng ?? unique[0]?.lng ?? 0,
    samples: unique.length,
    members,
    spread_m: extra.spread_m ?? null,
    published: false,
  });
  if (unique.length < 1) return unpublished(0);

  const firstMedian = {
    lat: median(unique.map((row) => row.lat))!,
    lng: median(unique.map((row) => row.lng))!,
  };
  const clustered = unique.filter((row) => haversineMeters(row, firstMedian) <= MAP_MARK_OUTLIER_M);
  if (clustered.length < MAP_MARK_PUBLISH_MEMBERS) {
    return unpublished(clustered.length, firstMedian);
  }
  const lat = median(clustered.map((row) => row.lat))!;
  const lng = median(clustered.map((row) => row.lng))!;
  const center = { lat, lng };
  const spread = Math.max(...clustered.map((row) => haversineMeters(row, center)));
  return {
    hole,
    kind,
    lat: Number(lat.toFixed(5)),
    lng: Number(lng.toFixed(5)),
    samples: unique.length,
    members: clustered.length,
    spread_m: Math.round(spread * 10) / 10,
    published: spread <= MAP_MARK_SPREAD_MAX_M,
  };
}

export function applyMapConsensus<T extends {
  hole: number;
  tee?: { label?: string | null; lat?: number | null; lng?: number | null } | null;
  target?: { label?: string | null; lat?: number | null; lng?: number | null } | null;
}>(holes: readonly T[], consensus: readonly MapConsensus[]): T[] {
  if (!consensus.length) return holes.slice() as T[];
  const byHole = new Map<number, { tee?: MapConsensus; target?: MapConsensus }>();
  for (const row of consensus) {
    if (!row.published) continue;
    const current = byHole.get(row.hole) || {};
    current[row.kind] = row;
    byHole.set(row.hole, current);
  }
  return holes.map((hole) => {
    const overlay = byHole.get(hole.hole);
    if (!overlay) return hole;
    const next = { ...hole };
    if (overlay.tee) {
      const label = hole.tee?.label || "Tee";
      next.tee = holeMarker({ label, lat: overlay.tee.lat, lng: overlay.tee.lng });
    }
    if (overlay.target) {
      const label = hole.target?.label || "Basket";
      next.target = holeMarker({ label, lat: overlay.target.lat, lng: overlay.target.lng });
    }
    return next;
  });
}

export function overlaySnapshotHoles<T extends { holes?: ScorableHole[]; layoutId?: number | null }>(
  snapshot: T,
  consensus: readonly MapConsensus[],
): T {
  if (!Array.isArray(snapshot.holes) || !consensus.length) return snapshot;
  return { ...snapshot, holes: applyMapConsensus(snapshot.holes, consensus) };
}
