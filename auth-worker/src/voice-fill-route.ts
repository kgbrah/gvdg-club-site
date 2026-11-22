import type { Env } from "./env.js";
import { generateReply, type ChatMessage } from "./assistant.js";
import { assistantProviders } from "./assistant-route.js";
import { json, readBytesLimited } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import {
  eventFieldsFromModel,
  extractJsonObject,
  fillPrompt,
  shopFieldsFromModel,
  voiceForm,
} from "./voice-fill.js";

export const MAX_AUDIO_BYTES = 8_000_000;
const WHISPER_MODELS = ["@cf/openai/whisper-large-v3-turbo", "@cf/openai/whisper"] as const;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function whisperText(out: unknown): string {
  if (!out || typeof out !== "object") return "";
  const text = (out as { text?: unknown }).text;
  return typeof text === "string" ? text.trim() : "";
}

function easternToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/New_York",
    year: "numeric",
  }).format(new Date());
}

async function transcribe(env: Env, audio: string, form: "shop" | "event"): Promise<string> {
  if (!env.AI) return "";
  const prompt = form === "shop"
    ? "Innova Destroyer 175 grams eighteen dollars, six in stock, red disc."
    : "Saturday singles stroke play with handicap at the Farm, nine o'clock.";
  let lastError: unknown = null;
  for (const model of WHISPER_MODELS) {
    try {
      const run = env.AI.run.bind(env.AI) as (model: string, input: Record<string, unknown>) => Promise<unknown>;
      const out = await run(model, {
        audio,
        initial_prompt: prompt,
        language: "en",
        task: "transcribe",
        vad_filter: true,
      });
      const text = whisperText(out);
      if (text) return text;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return "";
}

export async function handleAdminVoiceFill(
  request: Request,
  env: Env,
  origin: string | null,
  adminId: string,
): Promise<Response> {
  const form = voiceForm(new URL(request.url).searchParams.get("form"));
  if (!form) return json({ error: "invalid_request" }, 400, origin);
  if (await kvRateLimited(env, "voice:" + adminId, 8, 60)) return json({ error: "rate_limited" }, 429, origin);
  if (!env.AI) return json({ error: "voice_unavailable" }, 503, origin);

  const bytes = await readBytesLimited(request, MAX_AUDIO_BYTES);
  if (!bytes) return json({ error: "audio_too_large" }, 413, origin);
  if (bytes.byteLength < 32) return json({ error: "invalid_audio" }, 400, origin);

  let transcript = "";
  try {
    transcript = await transcribe(env, bytesToBase64(bytes), form);
  } catch {
    return json({ error: "voice_unavailable" }, 502, origin);
  }
  if (!transcript) return json({ error: "empty_transcript" }, 422, origin);

  const prompt = fillPrompt(form, transcript, easternToday());
  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  const providers = assistantProviders(env);
  const reply = providers.length ? await generateReply(providers, messages) : null;
  const parsed = reply ? extractJsonObject(reply.reply) : null;
  const fields = form === "shop" ? shopFieldsFromModel(parsed) : eventFieldsFromModel(parsed);
  return json({ fields, transcript }, 200, origin);
}
