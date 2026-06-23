// Pure layout helpers — enrich each hole with a best-estimate distance and sum total par.
// Holes embed their chosen tee/target (label + optional coords); the SAFARI editor (L3) picks
// those from the course's position pool (course_positions), so a hole may link ANY tee to ANY
// target. Distance precedence is delegated to estimateDistance (manual > geo > par > none).

import { estimateDistance, type DistanceSource, type LatLng } from "./distance.js";

export interface LayoutHole {
  hole: number;
  par: number;
  tee?: ({ label?: string | null } & LatLng) | null;
  target?: ({ label?: string | null } & LatLng) | null;
  manual_distance?: number | null;
  distance_ft?: number | null;
  distance_source?: DistanceSource | null;
}

export interface EnrichedLayout {
  holes: LayoutHole[];
  total_par: number;
}

/** Recompute each hole's distance_ft/distance_source and the layout's total par. Idempotent:
 *  re-running preserves manual overrides because manual_distance is carried on the hole. */
export function enrichHoles(holes: LayoutHole[]): EnrichedLayout {
  let total_par = 0;
  const out = (holes ?? []).map((h) => {
    const par = Number(h.par) || 0;
    total_par += par;
    const { distance_ft, source } = estimateDistance({
      manual: h.manual_distance ?? null,
      tee: h.tee,
      target: h.target,
      par,
    });
    return { ...h, par, distance_ft, distance_source: source };
  });
  return { holes: out, total_par };
}
