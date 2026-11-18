// Lost & Found disc reading: brand / mold / plastic / colours / stamp, plus any handwriting ("ink") with its
// type and a bounding box so the server can blur it out of the public photo. Provider chain follows
// vision.ts: Gemini first (the only provider trusted to box writing), then OpenRouter, then Workers AI.
// parseDiscExtraction is PURE (unit-tested). The ink text is PRIVATE: it is stored for matching and never
// returned to any client.

import type { VisionEnv } from "./vision.js";

export type InkType = "name" | "phone" | "initials" | "other";

/** Normalised box: fractions of the image, x0 < x1, y0 < y1, all within 0..1. */
export interface Box { x0: number; y0: number; x1: number; y1: number }

export interface InkItem {
  text: string;
  type: InkType;
  box: Box | null;
}

export interface DiscExtraction {
  brand: string;
  mold: string;
  plastic: string;
  colors: string[];
  stamp: string;
  ink: InkItem[];
  /** The model saw writing it could not read or box. */
  unreadable: boolean;
  confidence: "high" | "medium" | "low";
  parsed: boolean;
}

export type ExtractionStatus = "ok" | "unsure" | "empty";

export interface ExtractionResult extends DiscExtraction {
  source: string | null;
  status: ExtractionStatus;
}

export const LF_VISION_PROMPT =
  "This photo is for a disc golf club's lost-and-found. Read the disc and ALL handwriting on it. " +
  'Return ONLY JSON: {"brand":string|null,"mold":string|null,"plastic":string|null,"colors":[string],' +
  '"stamp":string|null,"ink":[{"text":string,"type":"name"|"phone"|"initials"|"other","box_2d":[ymin,xmin,ymax,xmax]}],' +
  '"unreadable_writing":boolean,"ink_confidence":"high"|"medium"|"low"}. ' +
  "brand/mold/plastic come from the printed stamp (e.g. Innova, Destroyer, Star). colors = the disc colour words. " +
  "ink = every piece of handwriting, marker, sticker or engraving that is NOT the printed factory stamp: names, " +
  "phone numbers, initials, numbers, notes - on the disc, its rim, or anything else in the photo. box_2d is " +
  "normalised 0-1000 and must cover the whole piece of writing. If you see writing you cannot read or cannot " +
  "box, set unreadable_writing true. Use null for anything not clearly visible. No text outside the JSON.";

export const LF_COMPARE_PROMPT =
  "Both photos show disc golf discs from a club lost-and-found. Are they the SAME physical disc (not just the same " +
  'model)? Look at wear, ink, stamp and colour. Return ONLY JSON: {"same":"yes"|"no"|"unsure"}.';

const COLOR_WORDS = [
  "red", "orange", "yellow", "green", "blue", "purple", "pink", "white", "black", "gray", "grey", "clear", "brown",
  "teal", "turquoise", "lime", "aqua", "cyan", "magenta", "tan", "gold", "silver", "glow", "tie-dye", "tiedye", "swirl",
] as const;

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function boxOf(value: unknown): Box | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map((v) => Number(v));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [ymin, xmin, ymax, xmax] = nums.map((n) => Math.max(0, Math.min(1000, n))) as [number, number, number, number];
  if (ymax <= ymin || xmax <= xmin) return null;
  return { x0: xmin / 1000, y0: ymin / 1000, x1: xmax / 1000, y1: ymax / 1000 };
}

export function normalizeColor(value: string): string | null {
  const word = value.toLowerCase().replace(/[^a-z-]/g, "");
  if (!word) return null;
  if (word === "grey") return "gray";
  if (word === "tiedye") return "tie-dye";
  return (COLOR_WORDS as readonly string[]).includes(word) ? word : null;
}

/** Pull the first JSON object out of model text (tolerates code fences / prose) and validate it. */
export function parseDiscExtraction(raw: unknown): DiscExtraction {
  const empty: DiscExtraction = { brand: "", mold: "", plastic: "", colors: [], stamp: "", ink: [], unreadable: false, confidence: "low", parsed: false };
  if (typeof raw !== "string" || !raw.trim()) return empty;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  let data: unknown;
  try { data = JSON.parse(raw.slice(start, end + 1)); } catch { return empty; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return empty;
  const o = data as Record<string, unknown>;
  const colors: string[] = [];
  for (const value of Array.isArray(o.colors) ? o.colors.slice(0, 6) : []) {
    for (const word of text(value, 30).split(/[\s/,&]+/)) {
      const color = normalizeColor(word);
      if (color && !colors.includes(color)) colors.push(color);
    }
  }
  const ink: InkItem[] = [];
  for (const item of Array.isArray(o.ink) ? o.ink.slice(0, 16) : []) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const words = text(row.text, 80);
    const type: InkType = row.type === "name" || row.type === "phone" || row.type === "initials" ? row.type : "other";
    const box = boxOf(row.box_2d ?? row.box);
    if (!words && !box) continue;
    ink.push({ text: words, type, box });
  }
  const confidence = o.ink_confidence === "high" || o.ink_confidence === "medium" ? o.ink_confidence : "low";
  return {
    brand: text(o.brand, 40),
    mold: text(o.mold, 40),
    plastic: text(o.plastic, 40),
    colors: colors.slice(0, 4),
    stamp: text(o.stamp, 80),
    ink,
    unreadable: o.unreadable_writing === true,
    // No writing at all is a confident answer; otherwise trust what the model said about itself.
    confidence: ink.length === 0 && o.unreadable_writing !== true && o.ink_confidence == null ? "high" : confidence,
    parsed: true,
  };
}

/** Only a provider that reliably boxes writing may unlock a public photo. */
export function trustedSource(source: string | null): boolean {
  return typeof source === "string" && source.startsWith("gemini:");
}

/** ok = safe to publish a redacted photo; unsure = keep the photo private and retry later. */
export function extractionStatus(read: DiscExtraction, source: string | null): ExtractionStatus {
  if (!read.parsed) return "empty";
  if (!trustedSource(source)) return "unsure";
  if (read.unreadable || read.confidence === "low") return "unsure";
  if (read.ink.some((item) => !item.box)) return "unsure";
  return "ok";
}

// ---- Normalisation for matching (PRIVATE values) ----

/** Lower-case name tokens ("Ada  LOVELACE" -> "ada lovelace"); "" when there is no plausible name. */
export function normalizeName(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\s'-]/g, " ")
    .replace(/['-]/g, "").split(/\s+/).filter((part) => part.length >= 2).join(" ");
}

/** The last 10 digits of a phone-like run of 7+ digits ("(252) 555-0134" -> "2525550134"). */
export function phoneDigits(value: string): string[] {
  const out: string[] = [];
  for (const run of value.match(/\+?[\d][\d\s().-]{5,}\d/g) ?? []) {
    const digits = run.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      const tail = digits.length > 10 ? digits.slice(-10) : digits;
      if (!out.includes(tail)) out.push(tail);
    }
  }
  return out;
}

export interface InkKeys { names: string[]; phones: string[]; initials: string[] }

export function inkKeys(items: readonly { text: string; type: InkType }[]): InkKeys {
  const names: string[] = [];
  const phones: string[] = [];
  const initials: string[] = [];
  for (const item of items) {
    for (const phone of phoneDigits(item.text)) if (!phones.includes(phone)) phones.push(phone);
    const letters = item.text.replace(/[^A-Za-z]/g, "");
    if (item.type === "initials" || (/^[A-Za-z.\s]{2,8}$/.test(item.text) && letters.length >= 2 && letters.length <= 3)) {
      const value = letters.toLowerCase();
      if (value.length >= 2 && value.length <= 3 && !initials.includes(value)) initials.push(value);
      continue;
    }
    const name = normalizeName(item.text.replace(/\d/g, " "));
    if (name && (item.type === "name" || name.includes(" ")) && !names.includes(name)) names.push(name);
  }
  return { names: names.slice(0, 8), phones: phones.slice(0, 6), initials: initials.slice(0, 6) };
}

// ---- Providers (I/O) ----

const DEFAULT_GEMINI_VISION = "gemini-2.5-flash";
const DEFAULT_OR_VISION = "nvidia/nemotron-nano-12b-v2-vl:free";
const DEFAULT_WAI_VISION = "@cf/meta/llama-3.2-11b-vision-instruct";
const TIMEOUT_MS = 20_000;

function base64Of(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

type GeminiData = { candidates?: { content?: { parts?: { text?: string }[] } }[] };

async function gemini(env: VisionEnv, parts: unknown[], maxTokens: number): Promise<string> {
  const model = (env.GEMINI_VISION_MODEL || DEFAULT_GEMINI_VISION).replace(/^models\//, "");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY || "" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: maxTokens, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("gemini_" + res.status);
  const data = (await res.json()) as GeminiData;
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
}

async function openRouter(env: VisionEnv, bytes: Uint8Array, contentType: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.OPENROUTER_API_KEY, "Content-Type": "application/json", "X-Title": "GVDG Lost and Found" },
    body: JSON.stringify({
      model: env.OPENROUTER_VISION_MODEL || DEFAULT_OR_VISION,
      messages: [{ role: "user", content: [
        { type: "text", text: LF_VISION_PROMPT },
        { type: "image_url", image_url: { url: `data:${contentType};base64,${base64Of(bytes)}` } },
      ] }],
      max_tokens: 900,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("openrouter_" + res.status);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data?.choices?.[0]?.message?.content ?? "";
}

async function workersAi(env: VisionEnv, bytes: Uint8Array): Promise<string> {
  const out = await Promise.race([
    env.AI!.run(env.VISION_MODEL || DEFAULT_WAI_VISION, { image: Array.from(bytes), prompt: LF_VISION_PROMPT, max_tokens: 900 }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("workers_ai_timeout")), TIMEOUT_MS)),
  ]);
  return out?.response ?? "";
}

function result(read: DiscExtraction, source: string | null): ExtractionResult {
  return { ...read, source, status: extractionStatus(read, source) };
}

/** Read one photo. Falls down the chain on errors or unparseable answers; never throws. */
export async function extractDisc(env: VisionEnv, bytes: Uint8Array, contentType: string): Promise<ExtractionResult> {
  if (env.VISION_DEV_STUB) {
    return result({ brand: "Innova", mold: "Destroyer", plastic: "Star", colors: ["orange"], stamp: "", ink: [], unreadable: false, confidence: "high", parsed: true }, "dev-stub");
  }
  if (env.GEMINI_API_KEY) {
    try {
      const model = env.GEMINI_VISION_MODEL || DEFAULT_GEMINI_VISION;
      const read = parseDiscExtraction(await gemini(env, [{ text: LF_VISION_PROMPT }, { inlineData: { mimeType: contentType, data: base64Of(bytes) } }], 1200));
      if (read.parsed) return result(read, "gemini:" + model);
    } catch { /* next provider */ }
  }
  if (env.OPENROUTER_API_KEY) {
    try {
      const read = parseDiscExtraction(await openRouter(env, bytes, contentType));
      if (read.parsed) return result(read, "openrouter:" + (env.OPENROUTER_VISION_MODEL || DEFAULT_OR_VISION));
    } catch { /* next provider */ }
  }
  if (env.AI) {
    try {
      const read = parseDiscExtraction(await workersAi(env, bytes));
      if (read.parsed) return result(read, "workers-ai:" + (env.VISION_MODEL || DEFAULT_WAI_VISION));
    } catch { /* give up */ }
  }
  return result(parseDiscExtraction(""), null);
}

export function parseCompare(raw: unknown): "same" | "different" | "unsure" | null {
  if (typeof raw !== "string") return null;
  const match = /"same"\s*:\s*"(yes|no|unsure)"/i.exec(raw);
  if (!match) return null;
  const value = match[1]!.toLowerCase();
  return value === "yes" ? "same" : value === "no" ? "different" : "unsure";
}

/** Gemini only: are two photos the same physical disc? null when unavailable. */
export async function compareDiscPhotos(
  env: VisionEnv, a: { bytes: Uint8Array; type: string }, b: { bytes: Uint8Array; type: string },
): Promise<"same" | "different" | "unsure" | null> {
  if (!env.GEMINI_API_KEY || env.VISION_DEV_STUB) return null;
  try {
    return parseCompare(await gemini(env, [
      { text: LF_COMPARE_PROMPT },
      { inlineData: { mimeType: a.type, data: base64Of(a.bytes) } },
      { inlineData: { mimeType: b.type, data: base64Of(b.bytes) } },
    ], 60));
  } catch {
    return null;
  }
}
