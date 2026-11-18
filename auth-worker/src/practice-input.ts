export const PRACTICE_KINDS = ["disc", "throw", "putting"] as const;
export const SHOT_TYPES = ["backhand", "forehand", "overhand", "roller", "other"] as const;
export const REMOTE_LIMITS = { disc: 400, throw: 3000, putting: 2000 };

export type PracticeKind = typeof PRACTICE_KINDS[number];
type Unit = "ft" | "m";
type Distance = { distance: number; unit: Unit; meters: number };
type Point = { lat: number; lng: number; accuracyM?: number };
export type DiscRecord = {
  brand: string; model: string; plastic: string; weightGrams: number | null; notes: string; inBag: boolean; archived: boolean;
  /** Optional (newer clients): the disc's colour, and what's written on it (private; used only to match found discs). */
  color?: string; ink?: string;
};
export type ThrowRecord = Distance & {
  discId: string; shotType: typeof SHOT_TYPES[number]; date: string; origin?: Point; end?: Point;
};
export type PuttingStation = Distance & { attempts: number; makes: number };
export type PuttingRecord = { date: string; stations: PuttingStation[] };
export type PracticeRecord = DiscRecord | ThrowRecord | PuttingRecord;

export interface PracticeMutation {
  opId: string;
  id: string;
  kind: PracticeKind;
  action: "save" | "delete";
  expectedRevision: number;
  record: PracticeRecord | null;
}

function object(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every((key) => keys.includes(key)) ? row : null;
}

function text(value: unknown, limit: number, optional = false): string | null {
  if (value === undefined && optional) return "";
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (clean.length > limit || (!optional && !clean) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(clean)) return null;
  return clean;
}

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function integer(value: unknown, min: number, max: number): number | null {
  const number = finite(value, min, max);
  return number !== null && Number.isInteger(number) ? number : null;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) ? value : null;
}

function dateOnly(value: unknown, now: number): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)) return null;
  const time = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value
    || time < Date.UTC(1990, 0, 1) || time > now + 86_400_000) return null;
  return value;
}

function point(value: unknown): Point | null {
  const row = object(value, ["lat", "lng", "accuracyM"]);
  if (!row) return null;
  const lat = finite(row.lat, -90, 90);
  const lng = finite(row.lng, -180, 180);
  const accuracyM = row.accuracyM === undefined ? undefined : finite(row.accuracyM, 0, 10_000);
  if (lat === null || lng === null || accuracyM === null) return null;
  return {
    lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)),
    ...(accuracyM !== undefined ? { accuracyM: Number(accuracyM.toFixed(1)) } : {}),
  };
}

export function normalizeDistance(distance: unknown, unit: unknown, maxMeters: number): Distance | null {
  if (unit !== "ft" && unit !== "m") return null;
  const value = finite(distance, 0.1, unit === "ft" ? maxMeters / 0.3048 : maxMeters);
  if (value === null) return null;
  const normalized = Number(value.toFixed(3));
  return { distance: normalized, unit, meters: Number((normalized * (unit === "ft" ? 0.3048 : 1)).toFixed(3)) };
}

function disc(value: unknown): DiscRecord | null {
  const row = object(value, ["brand", "model", "plastic", "weightGrams", "notes", "inBag", "archived", "color", "ink"]);
  if (!row) return null;
  const color = text(row.color, 30, true);
  const ink = text(row.ink, 120, true);
  if (color === null || ink === null) return null;
  const brand = text(row.brand, 80);
  const model = text(row.model, 80);
  const plastic = text(row.plastic, 80, true);
  const notes = text(row.notes, 480, true);
  const weightGrams = row.weightGrams == null ? null : finite(row.weightGrams, 40, 220);
  if (brand === null || model === null || plastic === null || notes === null
    || (row.weightGrams != null && weightGrams === null)
    || typeof row.inBag !== "boolean" || typeof row.archived !== "boolean" || (row.archived && row.inBag)) return null;
  const record: DiscRecord = { brand, model, plastic, weightGrams, notes, inBag: row.inBag, archived: row.archived };
  // Older records stay byte-for-byte as they were; the new fields appear only when set.
  if (color) record.color = color;
  if (ink) record.ink = ink;
  return record;
}

function measuredThrow(value: unknown, now: number): ThrowRecord | null {
  const row = object(value, ["discId", "shotType", "distance", "unit", "date", "origin", "end"]);
  if (!row) return null;
  const discId = uuid(row.discId);
  const shotType = SHOT_TYPES.find((type) => type === row.shotType);
  const date = dateOnly(row.date, now);
  const distance = normalizeDistance(row.distance, row.unit, 1500);
  const origin = row.origin === undefined ? undefined : point(row.origin);
  const end = row.end === undefined ? undefined : point(row.end);
  if (!discId || !shotType || !date || !distance || origin === null || end === null
    || Boolean(origin) !== Boolean(end)) return null;
  return { ...distance, discId, shotType, date, ...(origin && end ? { origin, end } : {}) };
}

function putting(value: unknown, now: number): PuttingRecord | null {
  const row = object(value, ["date", "stations"]);
  if (!row) return null;
  const date = dateOnly(row.date, now);
  if (!date || !Array.isArray(row.stations) || !row.stations.length || row.stations.length > 12) return null;
  const stations: PuttingStation[] = [];
  const seen = new Set<number>();
  let total = 0;
  for (const value of row.stations) {
    const station = object(value, ["distance", "unit", "attempts", "makes"]);
    if (!station) return null;
    const distance = normalizeDistance(station.distance, station.unit, 100);
    const attempts = integer(station.attempts, 1, 500);
    const makes = integer(station.makes, 0, attempts ?? 0);
    if (!distance || attempts === null || makes === null || seen.has(distance.meters)) return null;
    seen.add(distance.meters);
    stations.push({ ...distance, attempts, makes });
    total += attempts;
  }
  return total <= 1000 ? { date, stations } : null;
}

export function parsePracticeMutation(value: unknown, owner: string, now = Date.now()): PracticeMutation | null {
  const row = object(value, ["owner", "opId", "id", "kind", "action", "expectedRevision", "record"]);
  if (!row || row.owner !== owner) return null;
  const opId = uuid(row.opId);
  const id = uuid(row.id);
  const kind = PRACTICE_KINDS.find((entry) => entry === row.kind);
  const action = row.action;
  const expectedRevision = integer(row.expectedRevision, 0, 1_000_000);
  if (opId === null || id === null || kind === undefined || expectedRevision === null || (action !== "save" && action !== "delete")) return null;
  if (action === "delete") {
    if (expectedRevision === 0 || row.record !== undefined) return null;
    return { opId, id, kind, action, expectedRevision, record: null };
  }
  const record = kind === "disc" ? disc(row.record) : kind === "throw" ? measuredThrow(row.record, now) : putting(row.record, now);
  return record ? { opId, id, kind, action, expectedRevision, record } : null;
}
