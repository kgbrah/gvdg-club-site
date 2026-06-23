// GVDG member auth Worker — entrypoint.
// Routes: POST /login, GET /me, POST /set-pin, plus CORS preflight.

import { hashPin, verifyPin } from "./crypto.js";
import { signSession, verifySession } from "./jwt.js";
import { checkLockout, recordFailure, clearAttempts, type KVLike } from "./ratelimit.js";
import { resolveMember, setPin } from "./roster.js";

export interface Env {
  ROSTER: KVLike;
  RATELIMIT: KVLike;
  JWT_SECRET: string;
  /** Comma-separated allowlist of browser origins permitted to call the API. */
  ALLOWED_ORIGINS: string;
  SESSION_TTL_SEC?: string;
}

// A well-formed but unmatchable hash. Verifying a submitted PIN against this when the
// identifier is unknown keeps login timing ~constant, preventing user enumeration via timing.
const DUMMY_HASH =
  "pbkdf2$sha256$120000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function allowedOrigin(env: Env, request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allow = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  return allow.includes(origin) ? origin : null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...corsHeaders(origin) },
  });
}

function ttl(env: Env): number {
  const n = Number(env.SESSION_TTL_SEC);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

function rateKey(identifier: string): string {
  return identifier.trim().toLowerCase();
}

function bearer(request: Request): string | null {
  const h = request.headers.get("Authorization") ?? "";
  const m = h.match(/^Bearer (.+)$/);
  return m ? m[1]! : null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await request.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function handleLogin(request: Request, env: Env, origin: string | null): Promise<Response> {
  const body = await readJson(request);
  const identifier = typeof body?.identifier === "string" ? body.identifier : "";
  const pin = typeof body?.pin === "string" ? body.pin : "";
  if (!identifier || !pin) return json({ error: "invalid_request" }, 400, origin);

  const rk = rateKey(identifier);
  const now = Date.now();

  const lock = await checkLockout(env.RATELIMIT, rk, now);
  if (lock.locked) {
    return new Response(JSON.stringify({ error: "locked_out", retryAfterSec: lock.retryAfterSec }), {
      status: 423,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(lock.retryAfterSec),
        ...SECURITY_HEADERS,
        ...corsHeaders(origin),
      },
    });
  }

  const member = await resolveMember(env.ROSTER, identifier);
  // Always run a verify (against a dummy hash if unknown) to equalize timing / avoid enumeration.
  const ok = await verifyPin(pin, member?.pinHash ?? DUMMY_HASH);

  if (!member || !ok) {
    await recordFailure(env.RATELIMIT, rk, now);
    return json({ error: "invalid_credentials" }, 401, origin);
  }

  await clearAttempts(env.RATELIMIT, rk);
  const token = await signSession({ sub: member.memberId, mustChangePin: member.mustChangePin }, env.JWT_SECRET, ttl(env));
  return json({ token, mustChangePin: member.mustChangePin, name: member.name }, 200, origin);
}

async function handleMe(request: Request, env: Env, origin: string | null): Promise<Response> {
  const token = bearer(request);
  const claims = token ? await verifySession(token, env.JWT_SECRET) : null;
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  return json({ sub: claims.sub, mustChangePin: claims.mustChangePin }, 200, origin);
}

async function handleSetPin(request: Request, env: Env, origin: string | null): Promise<Response> {
  const token = bearer(request);
  const claims = token ? await verifySession(token, env.JWT_SECRET) : null;
  if (!claims) return json({ error: "unauthorized" }, 401, origin);

  const body = await readJson(request);
  const newPin = typeof body?.newPin === "string" ? body.newPin : "";
  if (!/^\d{4}$/.test(newPin)) return json({ error: "invalid_pin_format" }, 400, origin);

  await setPin(env.ROSTER, claims.sub, await hashPin(newPin));
  const fresh = await signSession({ sub: claims.sub, mustChangePin: false }, env.JWT_SECRET, ttl(env));
  return json({ token: fresh, mustChangePin: false }, 200, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(env, request);
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (pathname === "/login" && method === "POST") return handleLogin(request, env, origin);
    if (pathname === "/me" && method === "GET") return handleMe(request, env, origin);
    if (pathname === "/set-pin" && method === "POST") return handleSetPin(request, env, origin);

    return json({ error: "not_found" }, 404, origin);
  },
};
