export const LOCATION_STALE_MS = 90_000;
export const LOCATION_MOVE_DEG = 0.00004; // ~4.4m; ignore consumer-GPS jitter

export type LivePlayerLocation = {
  readonly lat: number;
  readonly lng: number;
  readonly at: number;
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

export function publicPlayerLocations(
  players: readonly { name: string; memberId?: string | null; removed?: boolean }[],
  locations: ReadonlyMap<number, LivePlayerLocation>,
  now = Date.now(),
): { index: number; initials: string; lat: number; lng: number }[] {
  const out: { index: number; initials: string; lat: number; lng: number }[] = [];
  for (let index = 0; index < players.length; index++) {
    const player = players[index];
    if (!player || player.removed) continue;
    if (!isLoggedInMemberId(player.memberId)) continue;
    const loc = locations.get(index);
    if (!loc || now - loc.at > LOCATION_STALE_MS) continue;
    const initials = playerInitials(player.name);
    if (!initials) continue;
    out.push({ index, initials, lat: loc.lat, lng: loc.lng });
  }
  return out;
}
