import type { Env } from "./env.js";
import * as db from "./db.js";
import { bearer, json } from "./http.js";
import { asInt } from "./input.js";
import { verifySession } from "./jwt.js";
import { publicHeatmapPayload } from "./hole-shot-marks.js";

export async function handleHoleHeatmap(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
): Promise<Response | null> {
  if (method !== "GET" || seg[0] !== "layouts" || seg[2] !== "heatmap" || seg.length !== 3) return null;
  const layoutId = asInt(seg[1]);
  const hole = asInt(new URL(request.url).searchParams.get("hole"));
  if (layoutId == null || hole == null || hole < 1 || hole > 36) {
    return json({ error: "invalid_request" }, 400, origin);
  }
  try {
    await db.harvestLayoutScorecardMarks(env.DB, layoutId);
  } catch {
    /* harvest is best-effort */
  }
  const rows = await db.listHoleShotMarks(env.DB, layoutId, hole);
  let memberId: string | null = null;
  const token = bearer(request);
  if (token && env.JWT_SECRET) {
    const claims = await verifySession(token, env.JWT_SECRET);
    if (claims && !claims.play) memberId = claims.sub;
  }
  return json(publicHeatmapPayload(rows, memberId, hole), 200, origin);
}
