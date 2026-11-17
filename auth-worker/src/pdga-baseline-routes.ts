// Admin-only PDGA layout baseline tools, shown under Course health:
//   GET  /admin/pdga-baselines                      queue, review list, match counts
//   GET  /admin/pdga-baselines/courses/:courseId    per-layout PDGA rounds, baseline and provenance
//   GET  /admin/pdga-baselines/validation           prediction check against PDGA's own ratings
//   POST /admin/pdga-baselines/events   {tournId}   queue a PDGA event by hand
//   POST /admin/pdga-baselines/ingest               run one bounded ingest pass now
//   POST /admin/pdga-baselines/matches/:pdgaLayoutId {action: confirm|reject|assign, layoutId?}

import { adminGate } from "./authz.js";
import type { Env } from "./env.js";
import { json, readJson } from "./http.js";
import { enqueuePdgaEvent, PDGA_ADMIN_FETCHES, runPdgaBaselineTick } from "./pdga-baseline-ingest.js";
import { pdgaBaselineOverview, pdgaCourseBaselines, pdgaValidationReport, reviewPdgaMatch } from "./pdga-baseline-store.js";

const PRIVATE = { "Cache-Control": "private, no-store" };
export const PDGA_BASELINE_ROOT = "/admin/pdga-baselines";

function positiveId(value: unknown, max = 2_147_483_647): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,10}$/.test(text)) return null;
  const id = Number(text);
  return id > 0 && id <= max ? id : null;
}

export function isPdgaBaselineRoute(pathname: string): boolean {
  return pathname === PDGA_BASELINE_ROOT || pathname.startsWith(PDGA_BASELINE_ROOT + "/");
}

export async function handlePdgaBaselines(request: Request, env: Env, origin: string | null, doFetch: typeof fetch = fetch): Promise<Response> {
  const gate = await adminGate(request, env, origin);
  if (gate instanceof Response) return gate;
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(2);
  const method = request.method.toUpperCase();
  const now = new Date().toISOString();
  const reply = (body: unknown, status = 200) => json(body, status, origin, PRIVATE);

  if (!parts.length && method === "GET") return reply(await pdgaBaselineOverview(env.DB));
  if (parts.length === 1 && parts[0] === "validation" && method === "GET") return reply(await pdgaValidationReport(env.DB));
  if (parts.length === 2 && parts[0] === "courses" && method === "GET") {
    const courseId = positiveId(parts[1]);
    const report = courseId == null ? null : await pdgaCourseBaselines(env.DB, courseId, now);
    return report ? reply(report) : reply({ error: "not_found" }, 404);
  }
  if (parts.length === 1 && parts[0] === "events" && method === "POST") {
    const body = await readJson(request);
    // PDGA tournament IDs are six digits today; allow growth but not arbitrary integers.
    const tournId = positiveId(body?.tournId, 99_999_999);
    if (tournId == null) return reply({ error: "invalid_tourn_id" }, 400);
    await enqueuePdgaEvent(env.DB, { tournId, source: "admin", official: false }, now);
    return reply({ ok: true, tournId });
  }
  if (parts.length === 1 && parts[0] === "ingest" && method === "POST") {
    const summary = await runPdgaBaselineTick(env, { doFetch, now, fetchBudget: PDGA_ADMIN_FETCHES, weatherBudget: 12, rematchAll: true });
    return reply({ ok: true, summary });
  }
  if (parts.length === 2 && parts[0] === "matches" && method === "POST") {
    const pdgaLayoutId = positiveId(parts[1]);
    const body = await readJson(request);
    const action = body?.action;
    if (pdgaLayoutId == null || (action !== "confirm" && action !== "reject" && action !== "assign")) return reply({ error: "invalid_request" }, 400);
    const layoutId = action === "assign" ? positiveId(body?.layoutId) : null;
    if (action === "assign" && layoutId == null) return reply({ error: "layout_required" }, 400);
    const result = await reviewPdgaMatch(env.DB, pdgaLayoutId, action, layoutId, gate.adminId, now);
    return "error" in result ? reply({ error: result.error }, result.status) : reply({ ok: true });
  }
  return reply({ error: "not_found" }, 404);
}
