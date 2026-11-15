import type { Env } from "./env.js";
import { requireAuth } from "./authz.js";
import { corsHeaders, json } from "./http.js";
import { parseExportCursor, parsePlayHistoryFilter, personalPlayCsv, personalPlayExport, readPersonalPlayPage, loadPlayHistory } from "./play-history.js";

export async function handleMyPlayHistory(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims?.member || claims.member.mustChangePin) return json({ error: "unauthorized" }, 401, origin);
  const filters = parsePlayHistoryFilter(new URL(request.url).searchParams);
  if (!filters) return json({ error: "invalid_history_filters" }, 400, origin);
  const history = await loadPlayHistory(env.DB, claims.sub, filters);
  return json(history, 200, origin, { "Cache-Control": "private, no-store" });
}

export async function handleMyPlayExport(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims?.member || claims.member.mustChangePin) return json({ error: "unauthorized" }, 401, origin);
  const params = new URL(request.url).searchParams;
  const format = params.get("format") ?? "json";
  const cursor = parseExportCursor(params.get("cursor"));
  if ((format !== "json" && format !== "csv") || !cursor) return json({ error: "invalid_export_parameters" }, 400, origin);
  const { rounds, clips, next } = await readPersonalPlayPage(env.DB, claims.sub, cursor);
  const data = personalPlayExport(claims.sub, rounds, clips);
  const filename = "gvdg-play-history." + format;
  const headers = {
    ...corsHeaders(origin),
    "Access-Control-Expose-Headers": "Content-Disposition, X-GVDG-Next-Export",
    "Cache-Control": "private, no-store",
    "Content-Disposition": 'attachment; filename="' + filename + '"',
    "Content-Type": (format === "csv" ? "text/csv" : "application/json") + "; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...(next ? { "X-GVDG-Next-Export": next } : {}),
  };
  return new Response(format === "csv" ? personalPlayCsv(data) : JSON.stringify(data), { headers });
}
