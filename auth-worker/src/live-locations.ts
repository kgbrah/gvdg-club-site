export const LOCATION_STALE_MS = 90_000;
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

export function publicPlayerLocations(
  players: readonly { name: string; memberId?: string | null; removed?: boolean }[],
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
    if (!loc || now - loc.at > LOCATION_STALE_MS) continue;
    if (!locationOnCourse(loc.lat, loc.lng, holes)) continue;
    const initials = playerInitials(player.name);
    if (!initials) continue;
    out.push({ index, initials, lat: loc.lat, lng: loc.lng, at: loc.at });
  }
  return out;
}
