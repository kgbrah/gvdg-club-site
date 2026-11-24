export const AUDIENCES = ["private", "friends", "club", "public"] as const;
export const DIFFICULTIES = ["unknown", "beginner", "intermediate", "advanced"] as const;
export const AMENITIES = ["restrooms", "drinkingWater", "practiceBasket", "accessibleParking", "stepFreeRoute"] as const;
export const CONDITIONS = ["unknown", "yes", "no"] as const;
export const REPORT_REASONS = ["abuse", "unsafe", "misleading", "other"] as const;
export const CONNECTION_ACTIONS = ["request", "accept", "remove", "block", "unblock"] as const;
export const MODERATION_ACTIONS = ["approve", "hide", "dismiss"] as const;

export type Audience = typeof AUDIENCES[number];
export type Condition = typeof CONDITIONS[number];
export type Difficulty = typeof DIFFICULTIES[number];
export type Amenity = typeof AMENITIES[number];
export type Amenities = Record<Amenity, Condition>;
export type ConnectionAction = typeof CONNECTION_ACTIONS[number];
export type ModerationAction = typeof MODERATION_ACTIONS[number];
export type ReportReason = typeof REPORT_REASONS[number];

export function exact(row: Record<string, unknown> | null, keys: readonly string[]) {
  return Boolean(row && Object.keys(row).every((key) => keys.includes(key)));
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.find((option) => option === value) ?? null;
}

export function safeText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ? text : null;
}

export function profileKey(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) ? value : null;
}

export function positiveId(value: unknown) {
  const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^\d{1,12}$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null;
}

export function revision(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

export function profileInput(row: Record<string, unknown> | null) {
  if (!row || !exact(row, ["audience", "displayName", "bio", "shareProgress", "sharePdga", "revision"])) return null;
  const audience = oneOf(row.audience, AUDIENCES);
  const displayName = safeText(row.displayName, 60);
  const bio = safeText(row.bio, 300);
  const rev = revision(row.revision);
  if (!audience || displayName === null || (audience !== "private" && !displayName) || bio === null
    || rev === null || typeof row.shareProgress !== "boolean"
    || (row.sharePdga !== undefined && typeof row.sharePdga !== "boolean")) return null;
  const privateProfile = audience === "private";
  return {
    audience,
    displayName,
    bio,
    shareProgress: !privateProfile && row.shareProgress,
    sharePdga: !privateProfile && Boolean(row.sharePdga),
    revision: rev,
  };
}
export type ProfileInput = NonNullable<ReturnType<typeof profileInput>>;

export function metadataInput(row: Record<string, unknown> | null) {
  if (!row || !exact(row, ["difficulty", "amenities", "notes", "revision"])) return null;
  const difficulty = oneOf(row.difficulty, DIFFICULTIES);
  const notes = safeText(row.notes, 400);
  const rev = revision(row.revision);
  if (!difficulty || notes === null || rev === null || !row.amenities || typeof row.amenities !== "object" || Array.isArray(row.amenities)) return null;
  const fields = row.amenities as Record<string, unknown>;
  if (!exact(fields, AMENITIES)) return null;
  const amenities = {} as Amenities;
  for (const key of AMENITIES) {
    const field = oneOf(fields[key], CONDITIONS);
    if (!field) return null;
    amenities[key] = field;
  }
  return { difficulty, amenities, notes, revision: rev };
}
export type MetadataInput = NonNullable<ReturnType<typeof metadataInput>>;

export function reviewInput(row: Record<string, unknown> | null) {
  if (!row || !exact(row, ["rating", "text", "revision"])) return null;
  const rating = positiveId(row.rating);
  const text = safeText(row.text, 1200);
  const rev = revision(row.revision);
  return typeof row.rating === "number" && rating !== null && rating <= 5 && text !== null && rev !== null ? { rating, text, revision: rev } : null;
}
export type ReviewInput = NonNullable<ReturnType<typeof reviewInput>>;
