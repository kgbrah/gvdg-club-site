import * as db from "./db.js";
import { EVENT_FORMATS, EVENT_STATUSES, EVENT_TYPES } from "./db.js";
import type { LayoutHole } from "./layouts.js";

export function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  return null;
}

export function asStr(v: unknown, max = 500): string | null {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null;
}

export function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export const inSet = (arr: readonly string[], v: unknown): v is string => typeof v === "string" && arr.includes(v);
export const isUniqueViolation = (e: unknown): boolean => /UNIQUE constraint failed/i.test(String(e));

export const jsonStringArray = (v: unknown, max: number): string | null =>
  Array.isArray(v) ? JSON.stringify(v.filter((x) => typeof x === "string").slice(0, max)) : null;

const validLat = (n: number | null): number | null => (n != null && n >= -90 && n <= 90 ? n : null);
const validLng = (n: number | null): number | null => (n != null && n >= -180 && n <= 180 ? n : null);

export function cleanPosition(raw: unknown): { label: string; lat: number | null; lng: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = asStr(o.label, 80);
  if (!label) return null;
  return { label, lat: validLat(asNum(o.lat)), lng: validLng(asNum(o.lng)) };
}

export function sanitizeHoles(raw: unknown[]): LayoutHole[] | null {
  const out: LayoutHole[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    const hole = asInt(o.hole);
    const par = asInt(o.par);
    if (hole == null || par == null || par < 1 || par > 15) return null;
    const md = asNum(o.manual_distance);
    out.push({
      hole,
      par,
      tee: cleanPosition(o.tee),
      target: cleanPosition(o.target),
      manual_distance: md != null && md > 0 ? md : null,
    });
  }
  return out;
}

export function validEventInput(b: Record<string, unknown>): db.EventInput | null {
  const name = asStr(b.name, 200);
  if (!inSet(EVENT_TYPES, b.type) || !name) return null;
  const status = b.status == null ? "scheduled" : b.status;
  if (!inSet(EVENT_STATUSES, status)) return null;
  let format: string | null = null;
  if (b.format != null && b.format !== "") {
    if (!inSet(EVENT_FORMATS, b.format)) return null;
    format = b.format;
  }
  const source = b.source == null ? "manual" : b.source;
  if (!inSet(["manual", "dgs", "csv", "udisc"], source)) return null;
  const ext = b.external_url == null ? null : asStr(b.external_url, 1000);
  if (b.external_url != null && (!ext || !/^https?:\/\//.test(ext))) return null;
  return {
    type: b.type as string,
    name,
    status,
    format,
    date: b.date == null ? null : asStr(b.date, 40),
    course_id: b.course_id == null ? null : asInt(b.course_id),
    layout_id: b.layout_id == null ? null : asInt(b.layout_id),
    league_id: b.league_id == null ? null : asInt(b.league_id),
    source,
    external_url: ext,
    notes: b.notes == null ? null : asStr(b.notes, 5000),
  };
}
