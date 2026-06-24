// "Crotts" vision (T2): read a disc-golf tee sign photo into a per-layout suggestion. Mirrors
// assistant.ts's provider-chain pattern. parseVisionJson is PURE (unit-tested); the providers do I/O.
// Output is ONLY a suggestion — an admin confirms before anything reaches scoring.

export interface VisionRow {
  label: string;
  color: string | null;
  par: number | null;
  distance_ft: number | null;
  tee: string | null;
  target: string | null;
}
export interface VisionResult {
  hole: number | null;
  layouts: VisionRow[];
  source?: string | null; // 'openrouter:<model>' | 'workers-ai:<model>' | 'dev-stub' | null
}

export const VISION_PROMPT =
  "Read this disc golf tee sign. It may list several layouts/tee positions, often color-coded. " +
  'Return ONLY JSON: {"hole":int|null,"layouts":[{"label":string,"color":string|null,"par":int|null,' +
  '"distance_ft":int|null,"tee":string|null,"target":string|null}]}. One entry per layout/tee shown. ' +
  "color = the tee color word if shown (e.g. blue, red), else null. Null any field not clearly visible. " +
  "Do not include any text outside the JSON.";

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Pull the first JSON object out of model text (tolerates code fences / prose) and validate it. */
export function parseVisionJson(text: unknown): VisionResult {
  const empty: VisionResult = { hole: null, layouts: [] };
  if (typeof text !== "string" || !text.trim()) return empty;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  let data: unknown;
  try { data = JSON.parse(text.slice(start, end + 1)); } catch { return empty; }
  if (!data || typeof data !== "object") return empty;
  const o = data as Record<string, unknown>;
  const rawLayouts = Array.isArray(o.layouts) ? o.layouts : [];
  const layouts: VisionRow[] = [];
  for (const r of rawLayouts) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    layouts.push({
      label: row.label != null ? String(row.label) : "",
      color: row.color != null ? String(row.color) : null,
      par: clampInt(row.par, 1, 10),
      distance_ft: clampInt(row.distance_ft, 20, 2000),
      tee: row.tee != null ? String(row.tee) : null,
      target: row.target != null ? String(row.target) : null,
    });
  }
  return { hole: clampInt(o.hole, 1, 99), layouts };
}

// ---- providers (I/O; live-verified) ----
export interface VisionEnv {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_VISION_MODEL?: string;
  VISION_MODEL?: string;
  VISION_DEV_STUB?: string;
  AI?: { run(model: string, opts: Record<string, unknown>): Promise<{ response?: string }> };
}
const DEFAULT_OR_VISION = "nvidia/nemotron-nano-12b-v2-vl:free";
const DEFAULT_WAI_VISION = "@cf/meta/llama-3.2-11b-vision-instruct";

function dataUrlOf(bytes: Uint8Array, contentType: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `data:${contentType};base64,${btoa(bin)}`;
}

async function openRouterVision(env: VisionEnv, bytes: Uint8Array, contentType: string): Promise<VisionResult> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.OPENROUTER_API_KEY, "Content-Type": "application/json", "X-Title": "GVDG Crotts Vision" },
    body: JSON.stringify({
      model: env.OPENROUTER_VISION_MODEL || DEFAULT_OR_VISION,
      messages: [{ role: "user", content: [
        { type: "text", text: VISION_PROMPT },
        { type: "image_url", image_url: { url: dataUrlOf(bytes, contentType) } },
      ] }],
      max_tokens: 700,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("openrouter_" + res.status);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const out = parseVisionJson(data?.choices?.[0]?.message?.content ?? "");
  return { ...out, source: "openrouter:" + (env.OPENROUTER_VISION_MODEL || DEFAULT_OR_VISION) };
}

async function workersAiVision(env: VisionEnv, bytes: Uint8Array): Promise<VisionResult> {
  const model = env.VISION_MODEL || DEFAULT_WAI_VISION;
  const out = await env.AI!.run(model, { image: Array.from(bytes), prompt: VISION_PROMPT, max_tokens: 700 });
  return { ...parseVisionJson(out?.response ?? ""), source: "workers-ai:" + model };
}

// Local-only deterministic stub so the full pipeline is live-verifiable without AI creds.
function devStub(): VisionResult {
  return { hole: 7, source: "dev-stub", layouts: [
    { label: "Long", color: "blue", par: 4, distance_ft: 420, tee: null, target: null },
    { label: "Short", color: "white", par: 3, distance_ft: 285, tee: null, target: null },
  ] };
}

/** Provider chain: OpenRouter (if key) → Workers AI (if bound) → dev-stub (only if VISION_DEV_STUB) → empty.
 *  Never throws — returns an empty result if every path fails, so the candidate just awaits manual entry. */
export async function extractTeeSign(env: VisionEnv, bytes: Uint8Array, contentType: string): Promise<VisionResult> {
  if (env.OPENROUTER_API_KEY) {
    try { const r = await openRouterVision(env, bytes, contentType); if (r.layouts.length || r.hole != null) return r; } catch { /* fall through */ }
  }
  if (env.AI) {
    try { const r = await workersAiVision(env, bytes); if (r.layouts.length || r.hole != null) return r; } catch { /* fall through */ }
  }
  if (env.VISION_DEV_STUB) return devStub();
  return { hole: null, layouts: [], source: null };
}
