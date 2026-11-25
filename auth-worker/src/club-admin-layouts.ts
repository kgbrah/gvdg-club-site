import type { Env } from "./env.js";
import * as db from "./db.js";
import { enrichHoles, verifiedOf, type LayoutHole } from "./layouts.js";
import { json, readJson } from "./http.js";
import { asInt, asStr, sanitizeHoles } from "./input.js";

export async function handleAdminLayouts(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  id: number | null,
): Promise<Response | null> {
  if (method === "POST") {
    const b = await readJson(request);
    const courseId = b && asInt(b.course_id);
    const clean = b && Array.isArray(b.holes) ? sanitizeHoles(b.holes) : null;
    if (!b || courseId == null || !clean || clean.length === 0) return json({ error: "invalid_layout" }, 400, origin);
    const { holes, total_par } = enrichHoles(clean);
    const row = await db.createLayout(env.DB, { course_id: courseId, name: asStr(b.name, 60) ?? "Main", holes, total_par });
    return json({ layout: row }, 201, origin);
  }
  if (method === "PATCH" && id != null) {
    const b = (await readJson(request)) ?? {};
    let holes: LayoutHole[] | undefined;
    let total_par: number | undefined;
    if (Array.isArray(b.holes)) {
      const clean = sanitizeHoles(b.holes);
      if (!clean || clean.length === 0) return json({ error: "invalid_layout" }, 400, origin);
      const existing = (await db.getLayout(env.DB, id)) as { holes?: string } | null;
      const verifiedByHole = new Map<number, ReturnType<typeof verifiedOf>>();
      const udiscDistByHole = new Map<number, number>();
      const storedHoleNums = new Set<number>();
      try {
        for (const h of JSON.parse(existing?.holes ?? "[]") as LayoutHole[]) {
          const holeNum = Number(h.hole);
          storedHoleNums.add(holeNum);
          const v = verifiedOf(h);
          if (v) verifiedByHole.set(holeNum, v);
          if (typeof h.udisc_distance_ft === "number" && Number.isFinite(h.udisc_distance_ft) && h.udisc_distance_ft > 0) {
            udiscDistByHole.set(holeNum, Math.round(h.udisc_distance_ft));
          }
        }
      } catch {
        storedHoleNums.clear();
        verifiedByHole.clear();
        udiscDistByHole.clear();
      }
      if (verifiedByHole.size > 0) {
        const submitted = new Set(clean.map((h) => Number(h.hole)));
        const sameHoleSet = submitted.size === storedHoleNums.size && [...storedHoleNums].every((n) => submitted.has(n));
        if (!sameHoleSet) return json({ error: "verified_layout_locked" }, 409, origin);
      }
      for (const h of clean) {
        const holeNum = Number(h.hole);
        const v = verifiedByHole.get(holeNum);
        if (v) h.verified = v;
        if (h.udisc_distance_ft == null && udiscDistByHole.has(holeNum)) {
          h.udisc_distance_ft = udiscDistByHole.get(holeNum);
        }
      }
      ({ holes, total_par } = enrichHoles(clean));
    }
    const row = await db.updateLayout(env.DB, id, { name: asStr(b.name, 60), holes, total_par });
    return row ? json({ layout: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "DELETE" && id != null) {
    await db.deleteLayout(env.DB, id);
    return json({ ok: true }, 200, origin);
  }
  return null;
}
