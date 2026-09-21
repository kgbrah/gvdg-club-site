export const HEATMAP_FIELD_CAP = 250;
export const HEATMAP_YOU_CAP = 80;
export const HEATMAP_HOLE_MIN = 1;
export const HEATMAP_HOLE_MAX = 36;
export const HEATMAP_HARVEST_ROUNDS = 80;

export type ShotMark = {
  lat: number;
  lng: number;
  n: number;
  memberId: string;
};

export type HeatmapPoint = { lat: number; lng: number; n: number };

export function parseThrowPoint(raw: unknown, index = 0): HeatmapPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const lat = Number((raw as { lat?: unknown }).lat);
  const lng = Number((raw as { lng?: unknown }).lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const n = Number((raw as { n?: unknown }).n);
  return {
    lat: Number(lat.toFixed(5)),
    lng: Number(lng.toFixed(5)),
    n: Number.isInteger(n) && n >= 1 ? n : index + 1,
  };
}

export function marksFromThrows(throws: unknown): HeatmapPoint[] {
  if (!Array.isArray(throws)) return [];
  const out: HeatmapPoint[] = [];
  for (const row of throws) {
    const parsed = parseThrowPoint(row, out.length);
    if (!parsed) continue;
    out.push({ ...parsed, n: out.length + 1 });
    if (out.length >= 18) break;
  }
  return out;
}

export function marksFromScorecard(raw: unknown): { hole: number; throws: HeatmapPoint[] }[] {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const hole = Number((item as { hole?: unknown }).hole);
    if (!Number.isInteger(hole) || hole < HEATMAP_HOLE_MIN || hole > HEATMAP_HOLE_MAX) return [];
    const throws = marksFromThrows((item as { throws?: unknown }).throws);
    return throws.length ? [{ hole, throws }] : [];
  });
}

function capPoints(rows: ShotMark[], cap: number): HeatmapPoint[] {
  const drives = rows.filter((row) => row.n === 1);
  const rest = rows.filter((row) => row.n !== 1);
  const picked = drives.concat(rest).slice(0, cap);
  return picked.map((row) => ({ lat: row.lat, lng: row.lng, n: row.n }));
}

export function publicHeatmapPayload(rows: ShotMark[], memberId: string | null, hole: number) {
  const mine = memberId ? rows.filter((row) => row.memberId === memberId) : [];
  const field = memberId ? rows.filter((row) => row.memberId !== memberId) : rows;
  const lies = capPoints(field, HEATMAP_FIELD_CAP);
  return {
    hole,
    samples: field.length,
    drives: lies.filter((row) => row.n === 1),
    lies,
    you: capPoints(mine, HEATMAP_YOU_CAP),
  };
}

export function shotMemberKey(memberId: string | null | undefined): string {
  const id = String(memberId || "").trim();
  return id.slice(0, 80);
}

export function shotRoundKey(roundCode: string | null | undefined, eventId?: number | null): string {
  const code = String(roundCode || "").trim();
  if (code) return code.slice(0, 24);
  const event = Number(eventId);
  if (Number.isInteger(event) && event > 0) return `event:${event}`;
  return "";
}
