import type { Env } from "./env.js";
import { requireAuth } from "./authz.js";
import { json, readJson } from "./http.js";

const DISC_KEY = (id: string) => `disc-color:${id}`;
const DISC_IDS = new Set([
  "orange",
  "blue",
  "gold",
  "forest",
  "white",
  "ink",
  "fire",
  "pink",
  "teal",
  "purple",
]);

export function sanitizeDiscColor(raw: unknown): string | null {
  const id = String(raw || "").trim().toLowerCase();
  return DISC_IDS.has(id) ? id : null;
}

export async function handleDiscColor(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const key = DISC_KEY(claims.sub);

  if (method === "GET") {
    const stored = await env.ROSTER.get(key);
    return json({ discColor: sanitizeDiscColor(stored) }, 200, origin);
  }

  if (method === "DELETE") {
    await env.ROSTER.delete(key);
    return json({ discColor: null }, 200, origin);
  }

  if (method === "PUT") {
    const body = await readJson(request);
    const discColor = sanitizeDiscColor(body?.discColor ?? body?.color ?? body);
    if (!discColor) return json({ error: "invalid_disc_color" }, 400, origin);
    await env.ROSTER.put(key, discColor);
    return json({ discColor }, 200, origin);
  }

  return json({ error: "method_not_allowed" }, 405, origin);
}
