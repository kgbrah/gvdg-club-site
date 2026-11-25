// Best-effort OpenStreetMap disc golf pin enrichment for unmapped courses (ODbL, © OpenStreetMap contributors).
// Fills missing hole tee/basket GPS pins on layouts without overwriting existing GPS pins or verified tee-sign rows.

import type { Env } from "./env.js";
import * as db from "./db.js";
import { D1KV } from "./d1kv.js";
import { bustCourseCatalogCache } from "./course-catalog-cache.js";
import type { PositionInput } from "./db-courses.js";
import { safeFetch } from "./imports/fetch.js";
import {
  OSM_API_HOST,
  OSM_USER_AGENT,
  osmMapBboxUrl,
  parseOsmDiscGolfHoles,
} from "./imports/osm-disc-golf.js";
import { enrichHoles, type LayoutHole } from "./layouts.js";

export const OSM_MAPS_D1KV_NS = "osm_maps";
export const OSM_CACHE_TTL_SEC = 2_592_000;
export const OSM_ERROR_TTL_SEC = 3_600;
const OSM_FETCH = { maxBytes: 3_000_000, timeoutMs: 5_000 } as const;

type CoordLike = { label?: unknown; lat?: unknown; lng?: unknown; source?: unknown } | null | undefined;

function hasValidCoord(marker: CoordLike): boolean {
  if (!marker || typeof marker !== "object") return false;
  const lat = Number(marker.lat);
  const lng = Number(marker.lng);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

function allLayoutHolesMapped(holesJson: unknown): boolean {
  let rows: unknown = holesJson;
  if (typeof holesJson === "string") {
    try {
      rows = JSON.parse(holesJson || "[]");
    } catch {
      return false;
    }
  }
  if (!Array.isArray(rows) || !rows.length) return false;
  return rows.every((row) => {
    if (!row || typeof row !== "object") return false;
    const item = row as { tee?: CoordLike; target?: CoordLike };
    return hasValidCoord(item.tee) && hasValidCoord(item.target);
  });
}

function validCourseOrigin(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (
    !Number.isFinite(nLat) ||
    !Number.isFinite(nLng) ||
    Math.abs(nLat) > 90 ||
    Math.abs(nLng) > 180 ||
    (nLat === 0 && nLng === 0)
  ) {
    return null;
  }
  return { lat: nLat, lng: nLng };
}

async function readOsmCache(env: Env, courseId: number): Promise<string | null> {
  if (!env.DB || typeof env.DB.prepare !== "function") return null;
  try {
    return await new D1KV(env.DB, OSM_MAPS_D1KV_NS).get("c:" + courseId);
  } catch {
    return null;
  }
}

async function writeOsmCache(env: Env, courseId: number, value: string, ttlSec: number): Promise<void> {
  if (!env.DB || typeof env.DB.prepare !== "function") return;
  try {
    await new D1KV(env.DB, OSM_MAPS_D1KV_NS).put("c:" + courseId, value, { expirationTtl: ttlSec });
  } catch {
    /* best-effort cache in tests lacking kv_store */
  }
}

export async function enrichCoursePinsFromOsm(
  env: Env,
  course: { id: number; name: string; lat?: number | null; lng?: number | null },
  opts?: { force?: boolean },
): Promise<{
  action: "applied" | "miss" | "skipped" | "failed";
  holesApplied?: number;
  layoutsUpdated?: number;
}> {
  const origin = validCourseOrigin(course.lat, course.lng);
  if (!origin || !Number.isInteger(course.id) || course.id <= 0) {
    return { action: "skipped" };
  }

  if (!opts?.force) {
    const cached = await readOsmCache(env, course.id);
    if (cached != null) return { action: "skipped" };
  }

  const existingLayouts = (await db.listLayouts(env.DB, course.id)) as {
    id: number;
    name?: string;
    holes?: unknown;
  }[];
  if (!existingLayouts.length || existingLayouts.every((layout) => allLayoutHolesMapped(layout.holes))) {
    await writeOsmCache(env, course.id, "mapped", OSM_CACHE_TTL_SEC);
    return { action: "skipped" };
  }

  let payload: unknown;
  try {
    const text = await safeFetch(osmMapBboxUrl(origin), [OSM_API_HOST], {
      ...OSM_FETCH,
      headers: {
        "User-Agent": OSM_USER_AGENT,
        Accept: "application/json",
      },
    });
    payload = JSON.parse(text);
  } catch {
    await writeOsmCache(env, course.id, "error", OSM_ERROR_TTL_SEC);
    return { action: "failed" };
  }

  const osmHoles = parseOsmDiscGolfHoles(payload, { name: course.name, lat: origin.lat, lng: origin.lng });
  if (!osmHoles.length) {
    await writeOsmCache(env, course.id, "miss", OSM_CACHE_TTL_SEC);
    return { action: "miss" };
  }

  const osmByHole = new Map(osmHoles.map((pin) => [pin.hole, pin]));
  const existingPositions = (await db.listPositions(env.DB, course.id)) as {
    kind: string;
    label: string;
  }[];
  const existingPosKeys = new Set(
    existingPositions.map((row) => `${String(row.kind).toLowerCase()}:${String(row.label).toLowerCase()}`),
  );
  const positionsToAdd: PositionInput[] = [];
  const appliedHoleNums = new Set<number>();
  let layoutsUpdated = 0;

  for (const layout of existingLayouts) {
    let rawRows: unknown[];
    try {
      rawRows = typeof layout.holes === "string"
        ? (JSON.parse(layout.holes || "[]") as unknown[])
        : Array.isArray(layout.holes)
          ? layout.holes
          : [];
    } catch {
      continue;
    }
    if (!Array.isArray(rawRows) || !rawRows.length) continue;

    let layoutChanged = false;
    const updatedRows = rawRows.map((item) => {
      if (!item || typeof item !== "object") return item;
      const row = item as Record<string, unknown>;
      const holeNum = Number(row.hole);
      const pin = Number.isInteger(holeNum) ? osmByHole.get(holeNum) : undefined;
      if (!pin) return item;

      const teeObj = (row.tee && typeof row.tee === "object" ? row.tee : null) as Record<string, unknown> | null;
      const targetObj = (row.target && typeof row.target === "object" ? row.target : null) as Record<string, unknown> | null;
      const needTee = !hasValidCoord(teeObj);
      const needTarget = !hasValidCoord(targetObj);
      if (!needTee && !needTarget) return item;

      layoutChanged = true;
      appliedHoleNums.add(holeNum);

      const nextTee = needTee
        ? {
            label: typeof teeObj?.label === "string" && teeObj.label.trim() ? teeObj.label.trim() : pin.tee.label,
            lat: pin.tee.lat,
            lng: pin.tee.lng,
            source: "osm" as const,
          }
        : row.tee;
      const nextTarget = needTarget
        ? {
            label:
              typeof targetObj?.label === "string" && targetObj.label.trim()
                ? targetObj.label.trim()
                : pin.target.label,
            lat: pin.target.lat,
            lng: pin.target.lng,
            source: "osm" as const,
          }
        : row.target;

      if (needTee) {
        const key = `tee:${pin.tee.label.toLowerCase()}`;
        if (!existingPosKeys.has(key)) {
          existingPosKeys.add(key);
          positionsToAdd.push({
            course_id: course.id,
            kind: "tee",
            label: pin.tee.label,
            lat: pin.tee.lat,
            lng: pin.tee.lng,
          });
        }
      }
      if (needTarget) {
        const key = `target:${pin.target.label.toLowerCase()}`;
        if (!existingPosKeys.has(key)) {
          existingPosKeys.add(key);
          positionsToAdd.push({
            course_id: course.id,
            kind: "target",
            label: pin.target.label,
            lat: pin.target.lat,
            lng: pin.target.lng,
          });
        }
      }

      return {
        ...row,
        tee: nextTee,
        target: nextTarget,
      };
    });

    if (layoutChanged) {
      const enriched = enrichHoles(updatedRows as unknown as LayoutHole[]);
      await db.updateLayout(env.DB, Number(layout.id), {
        holes: enriched.holes,
        total_par: enriched.total_par,
      });
      layoutsUpdated += 1;
    }
  }

  for (const pos of positionsToAdd) {
    await db.createPosition(env.DB, pos);
  }

  const holesApplied = appliedHoleNums.size;
  await writeOsmCache(env, course.id, `applied:${holesApplied}`, OSM_CACHE_TTL_SEC);
  if (layoutsUpdated > 0 || positionsToAdd.length > 0) {
    try {
      await bustCourseCatalogCache();
    } catch {
      /* bounded by the catalog's freshness window */
    }
  }

  return {
    action: layoutsUpdated > 0 ? "applied" : "skipped",
    holesApplied,
    layoutsUpdated,
  };
}

export async function runOsmPinEnrichmentTick(env: Env): Promise<{
  action: "applied" | "miss" | "skipped" | "failed" | "done";
  course_id?: number;
  name?: string;
  holesApplied?: number;
  layoutsUpdated?: number;
}> {
  const catalog = (await db.listCourses(env.DB)) as Array<{
    id?: number;
    name?: string;
    lat?: number | null;
    lng?: number | null;
    created_by?: string | null;
    mapped?: number | boolean | null;
  }>;

  const candidates = catalog
    .filter((c) => {
      const mapped = Number(c.mapped) === 1 || c.mapped === true;
      return !mapped && Number.isInteger(c.id) && Number(c.id) > 0 && validCourseOrigin(c.lat, c.lng) != null;
    })
    .sort((a, b) => {
      const aDiscover = a.created_by === "nearby-discover" ? 0 : 1;
      const bDiscover = b.created_by === "nearby-discover" ? 0 : 1;
      if (aDiscover !== bDiscover) return aDiscover - bDiscover;
      return Number(b.id) - Number(a.id);
    });

  for (const cand of candidates) {
    const courseId = Number(cand.id);
    const cached = await readOsmCache(env, courseId);
    if (cached != null) continue;
    const res = await enrichCoursePinsFromOsm(env, {
      id: courseId,
      name: String(cand.name || ""),
      lat: cand.lat ?? null,
      lng: cand.lng ?? null,
    });
    return {
      action: res.action,
      course_id: courseId,
      name: String(cand.name || ""),
      holesApplied: res.holesApplied ?? 0,
      layoutsUpdated: res.layoutsUpdated ?? 0,
    };
  }

  return { action: "done" };
}
