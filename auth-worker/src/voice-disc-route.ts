// POST /voice/disc: a few seconds of someone describing a disc ("orange Star Destroyer, 175 grams, hole 7") ->
// { transcript }. Whisper large-v3-turbo on Groq's free plan first (GROQ_API_KEY; it takes a spelling hint, so
// "Buzzz" and "Teebird3" come back right), then Whisper through OpenRouter (OPENROUTER_API_KEY, about $0.0002 a
// minute) when Groq is missing, rate-limited or down. The page maps the words onto its pick-lists
// (src/shared/disc-catalog.js), so no chat model is involved.
//
// Open to anyone who can post (members and guests alike), so it is capped: per address a minute, and a club-wide
// daily budget (VOICE_DAILY_BUDGET, default 300 clips; Groq's free plan allows about 2,000 requests a day). The audio
// is forwarded as is (multipart, no re-encoding) and never stored. Free-plan friendly: no CPU work beyond copying bytes.
import type { Env } from "./env.js";
import { clientIp, json } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions";
const GROQ_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];
const OPENROUTER_MODELS = ["openai/whisper-large-v3-turbo", "openai/whisper-large-v3"];
/** Whisper's spelling hint (Groq only; OpenRouter ignores prompts). Disc words it otherwise gets wrong. */
export const DISC_PROMPT = "Disc golf disc. Innova Star Destroyer, Champion Teebird3, Mako3, Roc3, Aviar. Discraft ESP Buzzz, Z Zone. "
  + "Dynamic Discs Lucid Judge. Latitude 64 Opto River. MVP Neutron Volt, Axiom Envy. Kastaplast K1 Berg. Discmania MD3, P2. "
  + "Orange, 175 grams, hole 7.";
/** ~60 s of Opus; a disc takes 5–15 s and the page stops recording at 15. */
export const MAX_VOICE_BYTES = 1_500_000;
const DEFAULT_DAILY_BUDGET = 300;
const PER_MINUTE = 8;

const FORMATS: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "aac",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
};

type VoiceEnv = Env & { VOICE_DAILY_BUDGET?: string; OPENROUTER_WHISPER_MODEL?: string; GROQ_API_KEY?: string };

interface Attempt {
  provider: "groq" | "openrouter";
  endpoint: string;
  key: string;
  model: string;
  prompt: boolean;
}

export function voiceDailyBudget(env: Env): number {
  const value = Number((env as VoiceEnv).VOICE_DAILY_BUDGET);
  return Number.isInteger(value) && value > 0 && value <= 20_000 ? value : DEFAULT_DAILY_BUDGET;
}

/** Groq's models first (free), then OpenRouter's (a configured OPENROUTER_WHISPER_MODEL leads those). */
export function voiceAttempts(env: Env): Attempt[] {
  const voiceEnv = env as VoiceEnv;
  const attempts: Attempt[] = [];
  const groq = String(voiceEnv.GROQ_API_KEY || "").trim();
  if (groq) for (const model of GROQ_MODELS) attempts.push({ provider: "groq", endpoint: GROQ_ENDPOINT, key: groq, model, prompt: true });
  const openRouter = String(env.OPENROUTER_API_KEY || "").trim();
  if (openRouter) {
    const configured = String(voiceEnv.OPENROUTER_WHISPER_MODEL || "").trim();
    const models = configured ? [configured, ...OPENROUTER_MODELS.filter((model) => model !== configured)] : OPENROUTER_MODELS;
    for (const model of models) attempts.push({ provider: "openrouter", endpoint: OPENROUTER_ENDPOINT, key: openRouter, model, prompt: false });
  }
  return attempts;
}

export function audioFormat(contentType: string | null): string | null {
  const type = (String(contentType || "").split(";")[0] ?? "").trim().toLowerCase();
  return FORMATS[type] || null;
}

export async function handleVoiceDisc(request: Request, env: Env, origin: string | null): Promise<Response> {
  const attempts = voiceAttempts(env);
  if (!attempts.length) return json({ error: "voice_unavailable" }, 503, origin);
  const type = (String(request.headers.get("content-type") || "").split(";")[0] ?? "").trim().toLowerCase();
  const format = audioFormat(type);
  if (!format) return json({ error: "invalid_audio" }, 415, origin);
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_VOICE_BYTES) return json({ error: "audio_too_large" }, 413, origin);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_VOICE_BYTES) return json({ error: "audio_too_large" }, 413, origin);
  if (bytes.byteLength < 256) return json({ error: "invalid_audio" }, 400, origin);

  if (await kvRateLimited(env, "voicedisc:m:" + clientIp(request), PER_MINUTE, 60)) return json({ error: "rate_limited" }, 429, origin);
  if (await kvRateLimited(env, "voicedisc:" + new Date().toISOString().slice(0, 10), voiceDailyBudget(env), 2 * 86_400)) {
    return json({ error: "voice_resting" }, 429, origin);
  }

  const deadProviders = new Set<string>();
  for (const attempt of attempts) {
    if (deadProviders.has(attempt.provider)) continue;
    const form = new FormData();
    form.append("file", new File([bytes], "disc." + format, { type }));
    form.append("model", attempt.model);
    form.append("language", "en");
    if (attempt.prompt) {
      form.append("prompt", DISC_PROMPT);
      form.append("temperature", "0");
    }
    const headers: Record<string, string> = { Authorization: "Bearer " + attempt.key };
    if (attempt.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://gvdgclub.com";
      headers["X-Title"] = "GVDG voice disc entry";
    }
    let response: Response;
    try {
      response = await fetch(attempt.endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(20_000) });
    } catch {
      continue;
    }
    if (!response.ok) {
      console.warn(JSON.stringify({ message: "voice_disc_upstream", provider: attempt.provider, model: attempt.model, status: response.status }));
      // A bad key, no credit or the provider's own limit won't change with its other model: go to the next provider.
      if ([401, 402, 403, 429].includes(response.status)) deadProviders.add(attempt.provider);
      continue;
    }
    const data = await response.json().catch(() => null) as { text?: unknown } | null;
    const transcript = typeof data?.text === "string" ? data.text.replace(/\s+/g, " ").trim().slice(0, 400) : "";
    if (!transcript) return json({ error: "empty_transcript" }, 422, origin);
    return json({ transcript }, 200, origin);
  }
  return json({ error: "voice_unavailable" }, 502, origin);
}
