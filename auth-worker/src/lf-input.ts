// Lost & Found request validation. Pure: everything a client sends is re-checked here; handlers never
// trust ids, statuses or owner fields from the body.

import { cleanLine, cleanText } from "./market-input.js";

export const POST_KINDS = ["found", "lost"] as const;
export type PostKind = (typeof POST_KINDS)[number];
export const LF_REPORT_REASONS = ["not_mine", "wrong_info", "inappropriate", "spam", "privacy", "other"] as const;
export const MAX_FOUND_PHOTOS = 3;
export const MAX_LOST_PHOTOS = 2;
export const MAX_CELEBRATION_PHOTOS = 2;
export const POST_DAYS = 90;
export const CAPTION_MAX = 200;
export const MESSAGE_MAX = 500;

type Fail = { ok: false; field: string };
type Ok<T> = { ok: true; value: T };

export interface PostInput {
  kind: PostKind;
  brand: string;
  mold: string;
  plastic: string;
  color: string;
  courseId: number | null;
  area: string;
  /** Grams, 100–200, from the weight pick-list; null = not given. */
  weightG: number | null;
  /** The hole it was found or lost on, 1–40; null = not on a hole / not given. */
  hole: number | null;
  eventDate: string | null;
  holding: "finder" | "club_bin" | null;
  binNote: string;
  rewardNote: string;
  privateInk: string;
}

/** YYYY-MM-DD within the last year and not after tomorrow (time zones). "" / null = not given. */
export function parseEventDate(value: unknown, now = Date.now()): string | null | undefined {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const at = Date.parse(value + "T12:00:00Z");
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) return undefined;
  if (at > now + 36 * 3_600_000 || at < now - 366 * 86_400_000) return undefined;
  return value;
}

function positiveInt(value: unknown): number | null | undefined {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A whole number in [min, max]; "" / null / undefined = not given (null); anything else is invalid (undefined). */
function boundedInt(value: unknown, min: number, max: number): number | null | undefined {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

export function parsePost(body: Record<string, unknown>, now = Date.now()): Ok<PostInput> | Fail {
  const kind = typeof body.kind === "string" && (POST_KINDS as readonly string[]).includes(body.kind) ? body.kind as PostKind : null;
  if (!kind) return { ok: false, field: "kind" };
  const brand = cleanLine(body.brand, 40);
  if (brand == null) return { ok: false, field: "brand" };
  const mold = cleanLine(body.mold, 40);
  if (mold == null) return { ok: false, field: "mold" };
  const plastic = cleanLine(body.plastic, 40);
  if (plastic == null) return { ok: false, field: "plastic" };
  const color = cleanLine(body.color, 40);
  if (color == null) return { ok: false, field: "color" };
  const courseId = positiveInt(body.courseId);
  if (courseId === undefined) return { ok: false, field: "courseId" };
  const area = cleanLine(body.area, 60);
  if (area == null) return { ok: false, field: "area" };
  const weightG = boundedInt(body.weightG, 100, 200);
  if (weightG === undefined) return { ok: false, field: "weightG" };
  const hole = boundedInt(body.hole, 1, 40);
  if (hole === undefined) return { ok: false, field: "hole" };
  const eventDate = parseEventDate(body.eventDate, now);
  if (eventDate === undefined) return { ok: false, field: "eventDate" };
  let holding: PostInput["holding"] = null;
  let binNote = "";
  let rewardNote = "";
  let privateInk = "";
  if (kind === "found") {
    holding = body.holding === "club_bin" ? "club_bin" : "finder";
    const note = cleanLine(body.binNote, 80);
    if (note == null) return { ok: false, field: "binNote" };
    if (holding === "club_bin" && !note) return { ok: false, field: "binNote" };
    binNote = holding === "club_bin" ? note : "";
  } else {
    const reward = cleanLine(body.rewardNote, 80);
    if (reward == null) return { ok: false, field: "rewardNote" };
    rewardNote = reward;
    const ink = cleanText(body.privateInk, 120);
    if (ink == null) return { ok: false, field: "privateInk" };
    privateInk = ink;
    // A lost post needs something to match on.
    if (!brand && !mold && !color && !privateInk) return { ok: false, field: "mold" };
  }
  return { ok: true, value: { kind, brand, mold, plastic, color, courseId, area, weightG, hole, eventDate, holding, binNote, rewardNote, privateInk } };
}

export function discTitle(row: { brand?: string | null; plastic?: string | null; mold?: string | null; color?: string | null }): string {
  const parts = [row.brand, row.plastic, row.mold].map((part) => String(part || "").trim()).filter(Boolean);
  if (!parts.length) return row.color ? `${String(row.color).trim()} disc`.slice(0, 80) : "Disc";
  return parts.join(" ").slice(0, 130);
}

export function parseCaption(value: unknown): string | null {
  const text = cleanText(value, CAPTION_MAX);
  return text == null ? null : text;
}

export function parseMessage(value: unknown): string | null {
  const text = cleanText(value, MESSAGE_MAX);
  return text ? text : null;
}

export function parseBinNote(value: unknown): string | null {
  const text = cleanLine(value, 80);
  return text ? text : null;
}
