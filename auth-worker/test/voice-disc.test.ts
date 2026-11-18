import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { audioFormat, DISC_PROMPT, MAX_VOICE_BYTES, voiceAttempts, voiceDailyBudget } from "../src/voice-disc-route.js";

const ORIGIN = "https://gvdgclub.com";
const SECRET = "test-" + "s".repeat(40);

function kv() {
  const rows = new Map<string, string>();
  return {
    rows,
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async () => ({ keys: [], list_complete: true }),
  };
}

let env: Env;
let calls: Array<{ url: string; auth: string | null; model: string; language: string; prompt: string | null; file: File }>;
let replies: Array<{ status: number; body: unknown }>;

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    ROSTER: kv(), RATELIMIT: kv(), JWT_SECRET: SECRET, SESSION_TTL_SEC: "900", ALLOWED_ORIGINS: ORIGIN,
    EXPECTED_ORIGIN: ORIGIN, OPENROUTER_API_KEY: "or_test", ...extra,
  } as unknown as Env;
}

const clip = (size = 4000) => new Uint8Array(size).fill(7);

async function post(body: Uint8Array, type = "audio/webm;codecs=opus", ip = "203.0.113.9") {
  const response = await worker.fetch(new Request("https://worker.example/voice/disc", {
    method: "POST", headers: { Origin: ORIGIN, "CF-Connecting-IP": ip, "Content-Type": type }, body: body as unknown as BodyInit,
  }), env, { waitUntil: () => {} } as unknown as ExecutionContext);
  return { status: response.status, data: await response.json() as Record<string, unknown>, cors: response.headers.get("Access-Control-Allow-Origin") };
}

beforeEach(() => {
  env = makeEnv();
  calls = [];
  replies = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const form = init?.body as FormData;
    calls.push({
      url: String(url), auth: new Headers(init?.headers).get("Authorization"), model: String(form.get("model")),
      language: String(form.get("language")), prompt: form.get("prompt") as string | null, file: form.get("file") as File,
    });
    const reply = replies.shift() ?? { status: 200, body: { text: " Orange Star Destroyer, 175 grams, hole 7. " } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("voice disc entry (Whisper via OpenRouter)", () => {
  it("sends the clip as is to OpenRouter's Whisper and returns the words", async () => {
    const result = await post(clip());
    expect(result).toMatchObject({ status: 200, data: { transcript: "Orange Star Destroyer, 175 grams, hole 7." }, cors: ORIGIN });
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toMatchObject({ url: "https://openrouter.ai/api/v1/audio/transcriptions", auth: "Bearer or_test", model: "openai/whisper-large-v3-turbo", language: "en" });
    expect(calls[0]!.file.name).toBe("disc.webm");
    expect(calls[0]!.file.type).toBe("audio/webm");
    expect(calls[0]!.file.size).toBe(4000);
  });

  it("iPhone clips go up as m4a", async () => {
    expect((await post(clip(), "audio/mp4")).status).toBe(200);
    expect(calls[0]!.file.name).toBe("disc.m4a");
    expect(audioFormat("audio/ogg; codecs=opus")).toBe("ogg");
    expect(audioFormat("video/webm")).toBeNull();
  });

  it("falls back to the next Whisper model when one is down, and a configured model goes first", async () => {
    replies.push({ status: 503, body: { error: "down" } });
    expect((await post(clip())).status).toBe(200);
    expect(calls.map((call) => call.model)).toEqual(["openai/whisper-large-v3-turbo", "openai/whisper-large-v3"]);
    env = makeEnv({ OPENROUTER_WHISPER_MODEL: "openai/whisper-1" });
    calls = [];
    await post(clip());
    expect(calls[0]!.model).toBe("openai/whisper-1");
  });

  it("stops at a credit or key problem instead of trying every model", async () => {
    replies.push({ status: 402, body: { error: "insufficient credits" } });
    expect((await post(clip())).status).toBe(502);
    expect(calls).toHaveLength(1);
  });

  it("uses Groq's free Whisper first, with the disc spelling hint, and OpenRouter only as the backup", async () => {
    env = makeEnv({ GROQ_API_KEY: "gsk_test" });
    expect(voiceAttempts(env).map((attempt) => attempt.provider + ":" + attempt.model)).toEqual([
      "groq:whisper-large-v3-turbo", "groq:whisper-large-v3", "openrouter:openai/whisper-large-v3-turbo", "openrouter:openai/whisper-large-v3"]);
    expect((await post(clip())).data.transcript).toBe("Orange Star Destroyer, 175 grams, hole 7.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!).toMatchObject({ url: "https://api.groq.com/openai/v1/audio/transcriptions", auth: "Bearer gsk_test", model: "whisper-large-v3-turbo",
      language: "en", prompt: DISC_PROMPT });
    expect(DISC_PROMPT).toContain("Buzzz");
    // Groq's free-plan limit: straight to OpenRouter (no point trying Groq's other model), which gets no prompt.
    calls = [];
    replies.push({ status: 429, body: { error: "rate limit" } });
    expect((await post(clip(), "audio/webm", "203.0.113.20")).status).toBe(200);
    expect(calls.map((call) => call.url.includes("groq") ? "groq" : "openrouter")).toEqual(["groq", "openrouter"]);
    expect(calls[1]!.prompt).toBeNull();
    // Groq alone works too.
    env = makeEnv({ GROQ_API_KEY: "gsk_test", OPENROUTER_API_KEY: "" });
    calls = [];
    expect((await post(clip(), "audio/webm", "203.0.113.21")).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("says when every model failed or nothing was heard", async () => {
    replies.push({ status: 500, body: {} }, { status: 500, body: {} });
    expect((await post(clip())).data.error).toBe("voice_unavailable");
    replies.push({ status: 200, body: { text: "   " } });
    expect(await post(clip())).toMatchObject({ status: 422, data: { error: "empty_transcript" } });
  });

  it("refuses without a key, a non-audio body, an empty clip or a long one", async () => {
    env = makeEnv({ OPENROUTER_API_KEY: "" });
    expect((await post(clip())).status).toBe(503);
    expect(voiceAttempts(env)).toEqual([]);
    env = makeEnv();
    expect((await post(clip(), "image/jpeg")).status).toBe(415);
    expect((await post(clip(10))).status).toBe(400);
    expect((await post(clip(MAX_VOICE_BYTES + 1))).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("caps each address a minute and the club a day", async () => {
    for (let index = 0; index < 8; index++) expect((await post(clip())).status).toBe(200);
    expect(await post(clip())).toMatchObject({ status: 429, data: { error: "rate_limited" } });
    expect((await post(clip(), "audio/webm", "203.0.113.10")).status).toBe(200);
    env = makeEnv({ VOICE_DAILY_BUDGET: "2" });
    expect(voiceDailyBudget(env)).toBe(2);
    expect((await post(clip(), "audio/webm", "198.51.100.1")).status).toBe(200);
    expect((await post(clip(), "audio/webm", "198.51.100.2")).status).toBe(200);
    expect(await post(clip(), "audio/webm", "198.51.100.3")).toMatchObject({ status: 429, data: { error: "voice_resting" } });
    expect(voiceDailyBudget(makeEnv({ VOICE_DAILY_BUDGET: "nope" }))).toBe(300);
  });
});
