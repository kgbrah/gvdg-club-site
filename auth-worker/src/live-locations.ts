import { sanitizeProfilePhoto } from "./profile-photo.js";

export const LOCATION_STALE_MS = 90_000;
export const LOCATION_HOLD_MS = 6 * 60 * 60 * 1000; // keep last-known pin for a live round after GPS sleeps
export const LOCATION_MOVE_DEG = 0.00004; // ~4.4m; ignore consumer-GPS jitter
export const COURSE_PAD_DEG = 0.008; // ~900m around the layout bbox; drop home/off-course pings

export type LivePlayerLocation = {
  readonly lat: number;
  readonly lng: number;
  readonly at: number;
};

export type PublicPlayerLocation = {
  readonly index: number;
  readonly initials: string;
  readonly lat: number;
  readonly lng: number;
  readonly at: number;
  readonly fresh: boolean;
  readonly source: "gps" | "lie";
  readonly photo?: string;
};

type HoleCoords = {
  readonly tee?: { readonly lat?: number | null; readonly lng?: number | null } | null;
  readonly target?: { readonly lat?: number | null; readonly lng?: number | null } | null;
};

export function isLoggedInMemberId(memberId: string | null | undefined): boolean {
  if (!memberId) return false;
  return !memberId.startsWith("g_");
}

export function playerInitials(name: string | null | undefined): string {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const first = parts[0]![0] || "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] || "") : "";
  return (first + last).toUpperCase();
}

export function parseLocationBody(body: unknown): { lat: number; lng: number } | null {
  if (!body || typeof body !== "object") return null;
  const lat = Number((body as { lat?: unknown }).lat);
  const lng = Number((body as { lng?: unknown }).lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) };
}

export function locationMoved(
  prev: LivePlayerLocation | undefined,
  next: { lat: number; lng: number },
): boolean {
  if (!prev) return true;
  return Math.abs(prev.lat - next.lat) >= LOCATION_MOVE_DEG || Math.abs(prev.lng - next.lng) >= LOCATION_MOVE_DEG;
}

function finiteCoord(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export function courseLocationBounds(holes: readonly HoleCoords[] | null | undefined, padDeg = COURSE_PAD_DEG) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const hole of holes || []) {
    for (const point of [hole?.tee, hole?.target]) {
      const lat = finiteCoord(point?.lat);
      const lng = finiteCoord(point?.lng);
      if (lat == null || lng == null) continue;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  }
  if (!Number.isFinite(minLat)) return null;
  return {
    minLat: minLat - padDeg,
    maxLat: maxLat + padDeg,
    minLng: minLng - padDeg,
    maxLng: maxLng + padDeg,
  };
}

export function locationOnCourse(
  lat: number,
  lng: number,
  holes: readonly HoleCoords[] | null | undefined,
): boolean {
  const bounds = courseLocationBounds(holes);
  if (!bounds) return false;
  return lat >= bounds.minLat && lat <= bounds.maxLat && lng >= bounds.minLng && lng <= bounds.maxLng;
}

export function lastLiePoint(
  player: { throws?: Record<number, { lat?: number; lng?: number }[] | null> | null } | null | undefined,
): { lat: number; lng: number } | null {
  const throws = player?.throws;
  if (!throws || typeof throws !== "object") return null;
  const holes = Object.keys(throws).map(Number).filter((hole) => Number.isInteger(hole)).sort((a, b) => a - b);
  for (let i = holes.length - 1; i >= 0; i--) {
    const hole = holes[i];
    if (hole == null) continue;
    const rows = throws[hole];
    if (!Array.isArray(rows) || !rows.length) continue;
    const last = rows[rows.length - 1];
    const lat = Number(last?.lat);
    const lng = Number(last?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return null;
}

export function locationsToRecord(
  locations: ReadonlyMap<number, LivePlayerLocation>,
): Record<string, LivePlayerLocation> {
  const out: Record<string, LivePlayerLocation> = {};
  locations.forEach((value, index) => {
    out[String(index)] = value;
  });
  return out;
}

export function locationsFromRecord(raw: unknown): Map<number, LivePlayerLocation> {
  const out = new Map<number, LivePlayerLocation>();
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    const parsed = parseLocationBody(value);
    const at = Number((value as { at?: unknown } | null)?.at);
    if (!parsed) continue;
    out.set(index, { lat: parsed.lat, lng: parsed.lng, at: Number.isFinite(at) ? at : 0 });
  }
  return out;
}

export function publicPlayerLocations(
  players: readonly { name: string; memberId?: string | null; removed?: boolean; throws?: Record<number, { lat?: number; lng?: number }[] | null> | null; photo?: string | null }[],
  locations: ReadonlyMap<number, LivePlayerLocation>,
  now = Date.now(),
  holes: readonly HoleCoords[] | null | undefined = null,
): PublicPlayerLocation[] {
  const out: PublicPlayerLocation[] = [];
  for (let index = 0; index < players.length; index++) {
    const player = players[index];
    if (!player || player.removed) continue;
    if (!isLoggedInMemberId(player.memberId)) continue;
    const loc = locations.get(index);
    const fresh = Boolean(loc && now - loc.at <= LOCATION_STALE_MS);
    const held = Boolean(loc && now - loc.at <= LOCATION_HOLD_MS);
    const lie = lastLiePoint(player);
    const point = held && loc
      ? { lat: loc.lat, lng: loc.lng, at: loc.at, source: "gps" as const }
      : lie
        ? { lat: lie.lat, lng: lie.lng, at: loc?.at || 0, source: "lie" as const }
        : loc
          ? { lat: loc.lat, lng: loc.lng, at: loc.at, source: "gps" as const }
          : null;
    if (!point) continue;
    if (!locationOnCourse(point.lat, point.lng, holes)) continue;
    const initials = playerInitials(player.name);
    if (!initials) continue;
    const photo = sanitizeProfilePhoto(player.photo);
    out.push({
      index,
      initials,
      lat: point.lat,
      lng: point.lng,
      at: point.at,
      fresh: point.source === "gps" ? fresh : false,
      source: point.source,
      ...(photo ? { photo } : {}),
    });
  }
  return out;
}
