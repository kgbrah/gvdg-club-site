import type { Env } from "./env.js";
import * as db from "./db.js";
import { buildMessages, generateReply, MAX_HISTORY, type ChatMessage, type ChatTurn, type ReplyProvider } from "./assistant.js";
import { clientIp, json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";

const ASSISTANT_BODY_BYTES = 64_000;
const ASSISTANT_LIMIT = 20;
const ASSISTANT_WINDOW = 60;
const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const DEFAULT_OR_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

function openRouterProvider(env: Env): ReplyProvider {
  return {
    name: "openrouter",
    async generate(messages: ChatMessage[]): Promise<string> {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.OPENROUTER_API_KEY,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://greenvillediscgolf.com",
          "X-Title": "GVDG Crotts",
        },
        body: JSON.stringify({ model: env.OPENROUTER_MODEL || DEFAULT_OR_MODEL, messages, max_tokens: 512 }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error("openrouter_" + res.status);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return data?.choices?.[0]?.message?.content ?? "";
    },
  };
}

function workersAiProvider(env: Env): ReplyProvider {
  return {
    name: "workers-ai",
    async generate(messages: ChatMessage[]): Promise<string> {
      const out = await env.AI.run(env.ASSISTANT_MODEL || DEFAULT_MODEL, { messages, max_tokens: 512 });
      return typeof out.response === "string" ? out.response : "";
    },
  };
}

export async function handleAssistant(request: Request, env: Env, origin: string | null): Promise<Response> {
  const body = await readJson(request, ASSISTANT_BODY_BYTES);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return json({ error: "invalid_request" }, 400, origin);
  if (message.length > 2000) return json({ error: "message_too_long" }, 413, origin);

  if (await kvRateLimited(env, "asst:" + clientIp(request), ASSISTANT_LIMIT, ASSISTANT_WINDOW)) return json({ error: "rate_limited" }, 429, origin);

  const history: ChatTurn[] = Array.isArray(body?.history)
    ? body.history.slice(-MAX_HISTORY).filter((t: unknown): t is ChatTurn => !!t && typeof t === "object" && typeof (t as ChatTurn).content === "string")
    : [];

  let events: Record<string, unknown>[] = [];
  let courses: Record<string, unknown>[] = [];
  try {
    events = (await db.listEvents(env.DB, {})) as Record<string, unknown>[];
  } catch {
    events = [];
  }
  try {
    courses = (await db.listCourses(env.DB)) as Record<string, unknown>[];
  } catch {
    courses = [];
  }

  const messages = buildMessages({
    userMessage: message,
    history,
    events: events.map((e) => ({ name: String(e.name ?? ""), date: (e.date as string) ?? null, status: (e.status as string) ?? null })),
    courses: courses.map((c) => ({ name: String(c.name ?? ""), location: (c.location as string) ?? null })),
  });

  const providers: ReplyProvider[] = [];
  if (env.OPENROUTER_API_KEY) providers.push(openRouterProvider(env));
  if (env.AI) providers.push(workersAiProvider(env));

  if (!providers.length) {
    return json({ reply: "🥏 (dev stub) Hi, I'm Crotts! No AI provider is configured in this environment, so I can't think for real yet — but your message reached the worker and the club context loaded fine.", stub: true }, 200, origin);
  }
  const out = await generateReply(providers, messages);
  return out ? json({ reply: out.reply, provider: out.provider }, 200, origin) : json({ error: "assistant_unavailable" }, 502, origin);
}
