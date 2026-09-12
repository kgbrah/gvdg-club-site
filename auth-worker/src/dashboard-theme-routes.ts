import type { Env } from "./env.js";
import { requireAuth } from "./authz.js";
import { json, readJson } from "./http.js";

const THEME_KEY = (id: string) => `dashboard-theme:${id}`;
const THEME_BODY_BYTES = 360_000;
const MAX_WALLPAPER_CHARS = 280_000;
const HEX = /^#[0-9a-fA-F]{6}$/;
const WALLPAPER_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MODES = new Set(["dark", "light"]);
const EXTRACT_MODES = new Set([
  "normal",
  "monochromatic",
  "mono",
  "analogous",
  "complementary",
  "pastel",
  "material",
  "colorful",
  "muted",
  "bright",
  "forest",
  "ocean",
  "fire",
]);
const EXTRACT_ALIASES: Record<string, string> = { mono: "monochromatic" };
const ADJUSTMENT_KEYS = [
  "vibrance",
  "saturation",
  "contrast",
  "brightness",
  "shadows",
  "highlights",
  "hueShift",
  "temperature",
  "tint",
  "blackPoint",
  "whitePoint",
  "gamma",
] as const;
const ADJUSTMENT_LIMITS: Record<(typeof ADJUSTMENT_KEYS)[number], { min: number; max: number; fallback: number }> = {
  vibrance: { min: -50, max: 50, fallback: 0 },
  saturation: { min: -100, max: 100, fallback: 0 },
  contrast: { min: -30, max: 30, fallback: 0 },
  brightness: { min: -30, max: 30, fallback: 0 },
  shadows: { min: -50, max: 50, fallback: 0 },
  highlights: { min: -50, max: 50, fallback: 0 },
  hueShift: { min: -180, max: 180, fallback: 0 },
  temperature: { min: -50, max: 50, fallback: 0 },
  tint: { min: -50, max: 50, fallback: 0 },
  blackPoint: { min: -30, max: 30, fallback: 0 },
  whitePoint: { min: -30, max: 30, fallback: 0 },
  gamma: { min: 0.5, max: 2, fallback: 1 },
};
const TOKEN_KEYS = [
  "primary",
  "primary-strong",
  "secondary",
  "accent",
  "green",
  "bg-primary",
  "bg-secondary",
  "bg-tertiary",
  "border-color",
  "text-primary",
  "text-secondary",
  "text-tertiary",
  "text-muted",
  "secondary-text",
] as const;

type ThemeTokens = Record<(typeof TOKEN_KEYS)[number], string>;

export interface DashboardTheme {
  mode: "dark" | "light";
  extractMode: string;
  preset: string | null;
  adjustments: Record<string, number>;
  sourcePalette: string[];
  palette: string[];
  tokens: ThemeTokens;
  wallpaper: string | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizeAdjustments(raw: unknown): Record<string, number> {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const adjustments: Record<string, number> = {};
  for (const key of ADJUSTMENT_KEYS) {
    const limit = ADJUSTMENT_LIMITS[key];
    const value = Number(source[key]);
    adjustments[key] = Number.isFinite(value) ? clamp(value, limit.min, limit.max) : limit.fallback;
  }
  return adjustments;
}

function sanitizeHexList(raw: unknown, max = 16): string[] {
  return Array.isArray(raw)
    ? raw.map((value) => String(value || "").toLowerCase()).filter((value) => HEX.test(value)).slice(0, max)
    : [];
}

function sanitizeTheme(raw: unknown): DashboardTheme | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const mode = MODES.has(String(source.mode)) ? (source.mode as "dark" | "light") : "dark";
  const extractModeRaw = EXTRACT_ALIASES[String(source.extractMode)] || String(source.extractMode);
  const extractMode = EXTRACT_MODES.has(extractModeRaw) && extractModeRaw !== "mono" ? extractModeRaw : "normal";
  const preset = typeof source.preset === "string" && source.preset.trim() && source.preset.length < 48
    ? source.preset.trim()
    : null;
  const adjustments = sanitizeAdjustments(source.adjustments);
  const palette = sanitizeHexList(source.palette);
  const sourcePalette = sanitizeHexList(source.sourcePalette);
  const tokenSource = source.tokens && typeof source.tokens === "object"
    ? source.tokens as Record<string, unknown>
    : {};
  const tokens = {} as ThemeTokens;
  for (const key of TOKEN_KEYS) {
    const value = String(tokenSource[key] || "");
    if (!HEX.test(value)) return null;
    tokens[key] = value.toLowerCase();
  }
  const wallpaper = typeof source.wallpaper === "string"
    && WALLPAPER_RE.test(source.wallpaper)
    && source.wallpaper.length <= MAX_WALLPAPER_CHARS
    ? source.wallpaper
    : null;
  return {
    mode,
    extractMode,
    preset,
    adjustments,
    sourcePalette,
    palette,
    tokens,
    wallpaper,
  };
}

export async function handleDashboardTheme(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const key = THEME_KEY(claims.sub);

  if (method === "GET") {
    const raw = await env.ROSTER.get(key);
    if (!raw) return json({ theme: null }, 200, origin);
    try {
      return json({ theme: sanitizeTheme(JSON.parse(raw)) }, 200, origin);
    } catch {
      return json({ theme: null }, 200, origin);
    }
  }

  if (method === "DELETE") {
    await env.ROSTER.delete(key);
    return json({ theme: null }, 200, origin);
  }

  if (method === "PUT") {
    const body = await readJson(request, THEME_BODY_BYTES);
    const theme = sanitizeTheme(body?.theme ?? body);
    if (!theme) return json({ error: "invalid_theme" }, 400, origin);
    await env.ROSTER.put(key, JSON.stringify(theme));
    return json({ theme }, 200, origin);
  }

  return json({ error: "method_not_allowed" }, 405, origin);
}
