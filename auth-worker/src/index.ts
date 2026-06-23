// GVDG member auth Worker — entrypoint.
// Routes: POST /login, GET /me, POST /set-pin, plus CORS preflight.

import { hashPin, verifyPin } from "./crypto.js";
import { signSession, verifySession } from "./jwt.js";
import { checkLockout, recordFailure, clearAttempts, type KVLike } from "./ratelimit.js";
import { resolveMember, getMember, setPin, updateProfile, type ProfilePatch } from "./roster.js";
import {
  registrationOptions,
  registrationVerify,
  authenticationOptions,
  authenticationVerify,
} from "./webauthn.js";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import * as db from "./db.js";
import { EVENT_TYPES, EVENT_STATUSES, EVENT_FORMATS, type D1Like } from "./db.js";
import { safeFetch, normalizeDgs, normalizeCsvEvents, parseCsvRows, parseUdiscLayout, ImportError } from "./imports.js";
import { enrichHoles, type LayoutHole } from "./layouts.js";
import { buildMessages, generateReply, MAX_HISTORY, type ChatTurn, type ChatMessage, type ReplyProvider } from "./assistant.js";

// Default discgolfscene feed = the club scraper's committed tournaments.json.
const DEFAULT_DGS_FEED = "https://raw.githubusercontent.com/mostlysober252/GVDG-DGS-Scraper-2.0/main/tournaments.json";

export interface Env {
  ROSTER: KVLike;
  RATELIMIT: KVLike;
  DB: D1Like; // Cloudflare D1 — club operations (events, courses, leagues, results, …)
  JWT_SECRET: string;
  /** Comma-separated allowlist of browser origins permitted to call the API. */
  ALLOWED_ORIGINS: string;
  SESSION_TTL_SEC?: string;
  // WebAuthn / passkeys relying-party config.
  RP_ID?: string;
  RP_NAME?: string;
  EXPECTED_ORIGIN?: string;
  // "Crotts" assistant brains. Primary = OpenRouter (free models); fallback = Cloudflare Workers AI.
  // OPENROUTER_API_KEY is a SECRET (wrangler secret put OPENROUTER_API_KEY); absent → skip OpenRouter.
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  AI?: { run(model: string, opts: { messages: { role: string; content: string }[]; max_tokens?: number }): Promise<{ response?: string }> };
  ASSISTANT_MODEL?: string;
  // Durable Object namespace for live scoring (one instance per in-progress event).
  LIVE: DurableObjectNamespace;
}

export { LiveEventDO } from "./live.js";

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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(
  data: unknown,
  status: number,
  origin: string | null,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...corsHeaders(origin), ...extraHeaders },
  });
}

/** Fail closed: a missing/short signing secret must never produce a weakly-signed token. */
function secretOk(env: Env): boolean {
  return typeof env.JWT_SECRET === "string" && env.JWT_SECRET.length >= 32;
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

async function requireAuth(request: Request, env: Env) {
  const token = bearer(request);
  return token ? verifySession(token, env.JWT_SECRET) : null;
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
    return json({ error: "locked_out", retryAfterSec: lock.retryAfterSec }, 423, origin, {
      "Retry-After": String(lock.retryAfterSec),
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
  return json(
    {
      token,
      mustChangePin: member.mustChangePin,
      name: member.name,
      pdgaNo: member.pdgaNo ?? null,
      udisc: member.udisc ?? null,
      photo: member.photo ?? null,
      isAdmin: member.isAdmin === true,
    },
    200,
    origin,
  );
}

async function handleMe(request: Request, env: Env, origin: string | null): Promise<Response> {
  const token = bearer(request);
  const claims = token ? await verifySession(token, env.JWT_SECRET) : null;
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  // Load the member so /me is authoritative (reflects PIN resets / profile changes), not just the token.
  const member = await getMember(env.ROSTER, claims.sub);
  if (!member) return json({ error: "unauthorized" }, 401, origin);
  return json(
    {
      sub: member.memberId,
      mustChangePin: member.mustChangePin,
      name: member.name,
      pdgaNo: member.pdgaNo ?? null,
      udisc: member.udisc ?? null,
      photo: member.photo ?? null,
      isAdmin: member.isAdmin === true,
    },
    200,
    origin,
  );
}

// Self-service profile fields a member may add when they couldn't be auto-matched.
const MAX_PHOTO_LEN = 200_000; // ~150KB of base64 — small avatar only
function validPhoto(p: string): boolean {
  return p.length <= MAX_PHOTO_LEN && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p);
}

async function handleProfile(request: Request, env: Env, origin: string | null): Promise<Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_request" }, 400, origin);

  const patch: ProfilePatch = {};
  if ("pdgaNo" in body) {
    const v = body.pdgaNo;
    if (v !== null && v !== "" && !(typeof v === "string" && /^\d+$/.test(v.trim()))) {
      return json({ error: "invalid_pdga" }, 400, origin);
    }
    patch.pdgaNo = v === null ? null : String(v).trim();
  }
  if ("udisc" in body) {
    const v = body.udisc;
    if (v !== null && v !== "" && !(typeof v === "string" && /^[A-Za-z0-9._-]{1,50}$/.test(v.trim()))) {
      return json({ error: "invalid_udisc" }, 400, origin);
    }
    patch.udisc = v === null ? null : String(v).trim();
  }
  if ("photo" in body) {
    const v = body.photo;
    if (v !== null && v !== "" && !(typeof v === "string" && validPhoto(v))) {
      return json({ error: "invalid_photo" }, 400, origin);
    }
    patch.photo = v === null || v === "" ? null : (v as string);
  }

  const result = await updateProfile(env.ROSTER, claims.sub, patch);
  if (!result.ok) return json({ error: "conflict", field: result.conflict }, 409, origin);
  const m = result.member;
  return json(
    { pdgaNo: m.pdgaNo ?? null, udisc: m.udisc ?? null, photo: m.photo ?? null, name: m.name, mustChangePin: m.mustChangePin },
    200,
    origin,
  );
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

// ============================ club API (D1) ============================
function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  return null;
}
function asStr(v: unknown, max = 500): string | null {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null;
}
function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
const inSet = (arr: readonly string[], v: unknown): v is string => typeof v === "string" && arr.includes(v);
const isUniqueViolation = (e: unknown): boolean => /UNIQUE constraint failed/i.test(String(e));
const validLat = (n: number | null): number | null => (n != null && n >= -90 && n <= 90 ? n : null);
const validLng = (n: number | null): number | null => (n != null && n >= -180 && n <= 180 ? n : null);

/** Sanitize a tee/target position object ({label, lat?, lng?}); null if no usable label. */
function cleanPosition(raw: unknown): { label: string; lat: number | null; lng: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = asStr(o.label, 80);
  if (!label) return null;
  return { label, lat: validLat(asNum(o.lat)), lng: validLng(asNum(o.lng)) };
}

/** Sanitize a layout's holes (incl. SAFARI tee/target + manual distance). Returns null if any
 *  hole is malformed, so the admin gets a clear 400 rather than silently dropped holes. */
function sanitizeHoles(raw: unknown[]): LayoutHole[] | null {
  const out: LayoutHole[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    const hole = asInt(o.hole);
    const par = asInt(o.par);
    if (hole == null || par == null || par < 1 || par > 15) return null;
    const md = asNum(o.manual_distance);
    out.push({
      hole, par,
      tee: cleanPosition(o.tee),
      target: cleanPosition(o.target),
      manual_distance: md != null && md > 0 ? md : null,
    });
  }
  return out;
}

/** Authenticated AND admin. Returns the admin's memberId, or a 401/403 Response. */
async function adminGate(request: Request, env: Env, origin: string | null): Promise<{ adminId: string } | Response> {
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const member = await getMember(env.ROSTER, claims.sub);
  if (!member || member.isAdmin !== true) return json({ error: "forbidden" }, 403, origin);
  return { adminId: member.memberId };
}

function validEventInput(b: Record<string, unknown>): db.EventInput | null {
  const name = asStr(b.name, 200);
  if (!inSet(EVENT_TYPES, b.type) || !name) return null;
  const status = b.status == null ? "scheduled" : b.status;
  if (!inSet(EVENT_STATUSES, status)) return null;
  let format: string | null = null;
  if (b.format != null && b.format !== "") {
    if (!inSet(EVENT_FORMATS, b.format)) return null;
    format = b.format;
  }
  const source = b.source == null ? "manual" : b.source;
  if (!inSet(["manual", "dgs", "csv", "udisc"], source)) return null;
  const ext = b.external_url == null ? null : asStr(b.external_url, 1000);
  if (b.external_url != null && (!ext || !/^https?:\/\//.test(ext))) return null;
  return {
    type: b.type as string, name, status, format,
    date: b.date == null ? null : asStr(b.date, 40),
    course_id: b.course_id == null ? null : asInt(b.course_id),
    layout_id: b.layout_id == null ? null : asInt(b.layout_id),
    league_id: b.league_id == null ? null : asInt(b.league_id),
    source, external_url: ext,
    notes: b.notes == null ? null : asStr(b.notes, 5000),
  };
}

// "Crotts" assistant. Public (no auth) but IP-throttled to bound AI cost/abuse.
const ASSISTANT_LIMIT = 20; // requests per IP per window
const ASSISTANT_WINDOW = 60; // seconds
const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct"; // Cloudflare Workers AI fallback
const DEFAULT_OR_MODEL = "meta-llama/llama-3.3-70b-instruct:free"; // OpenRouter free-tier primary

// Primary brain: OpenRouter (OpenAI-compatible). Uses a free model by default; the call throws on
// any non-2xx (e.g. the free model is unavailable/rate-limited) so the chain falls back to Workers AI.
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
// Fallback brain: Cloudflare Workers AI.
function workersAiProvider(env: Env): ReplyProvider {
  return {
    name: "workers-ai",
    async generate(messages: ChatMessage[]): Promise<string> {
      const out = await env.AI!.run(env.ASSISTANT_MODEL || DEFAULT_MODEL, { messages, max_tokens: 512 });
      return (out && out.response) || "";
    },
  };
}

async function assistantRateLimited(env: Env, ip: string): Promise<boolean> {
  const key = "asst:" + ip;
  const cur = parseInt((await env.RATELIMIT.get(key)) || "0", 10) || 0;
  if (cur >= ASSISTANT_LIMIT) return true;
  await env.RATELIMIT.put(key, String(cur + 1), { expirationTtl: ASSISTANT_WINDOW });
  return false;
}

async function handleAssistant(request: Request, env: Env, origin: string | null): Promise<Response> {
  const body = await readJson(request);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return json({ error: "invalid_request" }, 400, origin);
  if (message.length > 2000) return json({ error: "message_too_long" }, 413, origin);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await assistantRateLimited(env, ip)) return json({ error: "rate_limited" }, 429, origin);

  const history: ChatTurn[] = Array.isArray(body?.history)
    ? body.history.slice(-MAX_HISTORY).filter((t: unknown): t is ChatTurn => !!t && typeof t === "object" && typeof (t as ChatTurn).content === "string")
    : [];

  // Live club context (best-effort — never fail the chat if D1 is unavailable).
  let events: Record<string, unknown>[] = [];
  let courses: Record<string, unknown>[] = [];
  try { events = (await db.listEvents(env.DB, {})) as Record<string, unknown>[]; } catch { /* ignore */ }
  try { courses = (await db.listCourses(env.DB)) as Record<string, unknown>[]; } catch { /* ignore */ }

  const messages = buildMessages({
    userMessage: message,
    history,
    events: events.map((e) => ({ name: String(e.name ?? ""), date: (e.date as string) ?? null, status: (e.status as string) ?? null })),
    courses: courses.map((c) => ({ name: String(c.name ?? ""), location: (c.location as string) ?? null })),
  });

  // Provider chain: OpenRouter (free model) first, then Cloudflare Workers AI.
  const providers: ReplyProvider[] = [];
  if (env.OPENROUTER_API_KEY) providers.push(openRouterProvider(env));
  if (env.AI) providers.push(workersAiProvider(env));

  if (!providers.length) {
    // Local dev / no brain configured: deterministic stub so the UI + plumbing are verifiable.
    return json({ reply: "🥏 (dev stub) Hi, I'm Crotts! No AI provider is configured in this environment, so I can't think for real yet — but your message reached the worker and the club context loaded fine.", stub: true }, 200, origin);
  }
  const out = await generateReply(providers, messages);
  return out ? json({ reply: out.reply, provider: out.provider }, 200, origin) : json({ error: "assistant_unavailable" }, 502, origin);
}

// Forward a JSON request to the live-event Durable Object and re-emit its response with CORS.
async function liveProxy(stub: DurableObjectStub, path: string, init: RequestInit | undefined, origin: string | null): Promise<Response> {
  const r = await stub.fetch("https://do" + path, init);
  const data = await r.json().catch(() => ({}));
  return json(data, r.status, origin);
}

/** Handles /courses, /events, /leagues (public reads) and /admin/* (admin writes). Returns null if not a club route. */
async function clubApi(request: Request, env: Env, origin: string | null, pathname: string, method: string): Promise<Response | null> {
  const seg = pathname.split("/").filter(Boolean);

  // ---- public reads ----
  if (method === "GET" && pathname === "/courses") return json({ courses: await db.listCourses(env.DB) }, 200, origin);
  if (method === "GET" && pathname === "/leagues") return json({ leagues: await db.listLeagues(env.DB) }, 200, origin);
  if (method === "GET" && pathname === "/events") {
    const p = new URL(request.url).searchParams;
    return json({ events: await db.listEvents(env.DB, { status: p.get("status") ?? undefined, type: p.get("type") ?? undefined }) }, 200, origin);
  }
  if (method === "GET" && seg[0] === "events" && seg.length === 2) {
    const id = asInt(seg[1]);
    const ev = id == null ? null : await db.getEvent(env.DB, id);
    return ev ? json({ event: ev }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }

  // ---- live scoring (Durable Object): /events/:id/live[/{start,score,finalize,ws}] ----
  if (seg[0] === "events" && seg[2] === "live") {
    const eid = asInt(seg[1]);
    if (eid == null) return json({ error: "not_found" }, 404, origin);
    const sub = seg[3]; // undefined (snapshot) | start | score | finalize | ws
    const stub = env.LIVE.get(env.LIVE.idFromName("event:" + eid));

    if (method === "GET" && !sub) return liveProxy(stub, "/snapshot", undefined, origin); // public leaderboard
    if (sub === "ws") return stub.fetch(request); // public WebSocket viewer — forward the upgrade

    if (method === "POST" && (sub === "start" || sub === "score" || sub === "finalize")) {
      const gate = await adminGate(request, env, origin); // scorekeeping is admin-gated (Track G adds delegation)
      if (gate instanceof Response) return gate;

      if (sub === "start") {
        const ev = (await db.getEvent(env.DB, eid)) as (Record<string, unknown> & { layout_id?: number | null; players?: Record<string, unknown>[] }) | null;
        if (!ev) return json({ error: "not_found" }, 404, origin);
        let holes: { hole: number; par: number }[] = [];
        if (ev.layout_id) {
          const layout = (await db.getLayout(env.DB, Number(ev.layout_id))) as { holes?: string } | null;
          try { holes = JSON.parse(layout?.holes ?? "[]").map((h: Record<string, unknown>) => ({ hole: Number(h.hole), par: Number(h.par) })); } catch { holes = []; }
        }
        if (!holes.length) return json({ error: "no_layout_holes" }, 400, origin); // event needs a layout with pars
        const players = (Array.isArray(ev.players) ? ev.players : []).map((p) => ({ memberId: (p.member_id as string) ?? null, name: String(p.name ?? "Player"), division: (p.division as string) ?? null }));
        const r = await stub.fetch("https://do/start", { method: "POST", body: JSON.stringify({ eventId: eid, holes, players, startedAt: new Date().toISOString() }) });
        const data = await r.json().catch(() => ({}));
        if (r.status === 200) await db.updateEvent(env.DB, eid, { status: "live" });
        return json(data, r.status, origin);
      }
      const body = (await readJson(request)) ?? {};
      return liveProxy(stub, "/" + sub, { method: "POST", body: JSON.stringify(body) }, origin);
    }
    return json({ error: "not_found" }, 404, origin);
  }
  if (method === "GET" && seg[0] === "courses" && seg.length === 3 && (seg[2] === "layouts" || seg[2] === "positions")) {
    const cid = asInt(seg[1]);
    if (cid == null) return json({ error: "not_found" }, 404, origin);
    return seg[2] === "layouts"
      ? json({ layouts: await db.listLayouts(env.DB, cid) }, 200, origin)
      : json({ positions: await db.listPositions(env.DB, cid) }, 200, origin);
  }

  // ---- admin writes ----
  if (seg[0] !== "admin") return null;
  const gate = await adminGate(request, env, origin);
  if (gate instanceof Response) return gate;
  const adminId = gate.adminId;
  const sub = seg[1];
  const id = seg[2] != null ? asInt(seg[2]) : null;

  if (sub === "courses") {
    // tee/target position pool: /admin/courses/:id/positions[/:posId]
    if (seg[3] === "positions" && id != null) {
      if (method === "GET") return json({ positions: await db.listPositions(env.DB, id) }, 200, origin);
      if (method === "POST") {
        const b = await readJson(request);
        const kind = b && asStr(b.kind, 10);
        const pos = b && cleanPosition(b);
        if (!b || (kind !== "tee" && kind !== "target") || !pos) return json({ error: "invalid_position" }, 400, origin);
        const row = await db.createPosition(env.DB, { course_id: id, kind, label: pos.label, lat: pos.lat, lng: pos.lng });
        return json({ position: row }, 201, origin);
      }
      if (method === "PUT") {
        // bulk replace the pool (e.g. from a UDisc import)
        const b = (await readJson(request)) ?? {};
        const raw = Array.isArray(b.positions) ? b.positions : [];
        const positions: db.PositionInput[] = [];
        for (const r of raw) {
          const o = r as Record<string, unknown>;
          const kind = asStr(o?.kind, 10);
          const pos = cleanPosition(o);
          if ((kind === "tee" || kind === "target") && pos) positions.push({ course_id: id, kind, label: pos.label, lat: pos.lat, lng: pos.lng });
        }
        return json({ positions: await db.replacePositions(env.DB, id, positions) }, 200, origin);
      }
      if (method === "DELETE" && seg[4] != null) {
        const pid = asInt(seg[4]);
        if (pid == null) return json({ error: "not_found" }, 404, origin);
        await db.deletePosition(env.DB, id, pid);
        return json({ ok: true }, 200, origin);
      }
    }
    if (method === "POST") {
      const b = await readJson(request);
      const name = b && asStr(b.name, 200);
      if (!b || !name) return json({ error: "invalid_course" }, 400, origin);
      const udisc = b.udisc_url == null ? null : asStr(b.udisc_url, 1000);
      if (b.udisc_url != null && (!udisc || !/^https?:\/\//.test(udisc))) return json({ error: "invalid_course" }, 400, origin);
      try {
        const row = await db.createCourse(env.DB, { name, location: asStr(b.location, 200), udisc_url: udisc, lat: asNum(b.lat), lng: asNum(b.lng), created_by: adminId });
        return json({ course: row }, 201, origin);
      } catch (e) {
        if (isUniqueViolation(e)) return json({ error: "course_exists" }, 409, origin); // courses.name is UNIQUE
        throw e;
      }
    }
    if (method === "PATCH" && id != null) {
      const b = (await readJson(request)) ?? {};
      try {
        const row = await db.updateCourse(env.DB, id, { name: asStr(b.name, 200), location: asStr(b.location, 200), udisc_url: asStr(b.udisc_url, 1000), lat: asNum(b.lat), lng: asNum(b.lng) });
        return row ? json({ course: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
      } catch (e) {
        if (isUniqueViolation(e)) return json({ error: "course_exists" }, 409, origin);
        throw e;
      }
    }
    if (method === "DELETE" && id != null) { await db.deleteCourse(env.DB, id); return json({ ok: true }, 200, origin); }
  }

  if (sub === "events") {
    if (seg[3] === "players" && id != null) {
      if (method === "POST") {
        const b = await readJson(request);
        const name = b && asStr(b.name, 100);
        if (!b || !name) return json({ error: "invalid_player" }, 400, origin);
        const row = await db.addEventPlayer(env.DB, { event_id: id, member_id: asStr(b.member_id, 64), name, pdga_no: asStr(b.pdga_no, 20), division: asStr(b.division, 40), team: asStr(b.team, 40) });
        return json({ player: row }, 201, origin);
      }
      if (method === "DELETE" && seg[4] != null) {
        const pid = asInt(seg[4]);
        if (pid == null) return json({ error: "not_found" }, 404, origin);
        await db.removeEventPlayer(env.DB, id, pid);
        return json({ ok: true }, 200, origin);
      }
    }
    if (method === "POST" && seg.length === 2) {
      const b = await readJson(request);
      const v = b && validEventInput(b);
      if (!v) return json({ error: "invalid_event" }, 400, origin);
      const row = await db.createEvent(env.DB, { ...v, created_by: adminId });
      return json({ event: row }, 201, origin);
    }
    if (method === "PATCH" && id != null) {
      const b = (await readJson(request)) ?? {};
      if (b.status != null && !inSet(EVENT_STATUSES, b.status)) return json({ error: "invalid_event" }, 400, origin);
      if (b.format != null && b.format !== "" && !inSet(EVENT_FORMATS, b.format)) return json({ error: "invalid_event" }, 400, origin);
      const row = await db.updateEvent(env.DB, id, {
        name: asStr(b.name, 200), status: asStr(b.status), format: asStr(b.format),
        date: asStr(b.date, 40), course_id: b.course_id == null ? null : asInt(b.course_id),
        layout_id: b.layout_id == null ? null : asInt(b.layout_id), league_id: b.league_id == null ? null : asInt(b.league_id),
        notes: asStr(b.notes, 5000),
      });
      return row ? json({ event: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
    }
    if (method === "DELETE" && id != null) { await db.deleteEvent(env.DB, id); return json({ ok: true }, 200, origin); }
  }

  if (sub === "leagues") {
    if (method === "POST") {
      const b = await readJson(request);
      const name = b && asStr(b.name, 120);
      if (!b || !name) return json({ error: "invalid_league" }, 400, origin);
      const row = await db.createLeague(env.DB, { name, season: asStr(b.season, 40), format: asStr(b.format, 20), description: asStr(b.description, 2000), created_by: adminId });
      return json({ league: row }, 201, origin);
    }
    if (method === "DELETE" && id != null) { await db.deleteLeague(env.DB, id); return json({ ok: true }, 200, origin); }
  }

  if (sub === "import" && method === "POST") {
    const kind = seg[2];
    const b = (await readJson(request)) ?? {};
    try {
      if (kind === "dgs") {
        const url = asStr(b.feedUrl, 500) ?? DEFAULT_DGS_FEED;
        const text = await safeFetch(url, ["raw.githubusercontent.com", "discgolfscene.com"]);
        let feed: unknown;
        try { feed = JSON.parse(text); } catch { return json({ error: "import_parse_failed" }, 422, origin); }
        return json({ source: "dgs", candidates: normalizeDgs(feed) }, 200, origin);
      }
      if (kind === "csv") {
        let csvText = typeof b.csv === "string" ? b.csv : null;
        if (csvText && csvText.length > 500_000) return json({ error: "csv_too_large" }, 413, origin);
        if (!csvText && typeof b.url === "string") csvText = await safeFetch(b.url, ["docs.google.com"]);
        if (!csvText) return json({ error: "invalid_request" }, 400, origin);
        return json({ source: "csv", candidates: normalizeCsvEvents(parseCsvRows(csvText)) }, 200, origin);
      }
      if (kind === "udisc") {
        const url = asStr(b.url, 500);
        if (!url) return json({ error: "invalid_request" }, 400, origin);
        const html = await safeFetch(url, ["udisc.com"]);
        // Best-effort layout (pars + tee/target coords + position pool); falls back to name-only.
        return json({ source: "udisc", candidate: parseUdiscLayout(html, url) }, 200, origin);
      }
      return json({ error: "not_found" }, 404, origin);
    } catch (e) {
      if (e instanceof ImportError) return json({ error: "import_failed", reason: e.message }, 400, origin);
      throw e;
    }
  }

  if (sub === "layouts") {
    if (method === "POST") {
      const b = await readJson(request);
      const courseId = b && asInt(b.course_id);
      const clean = b && Array.isArray(b.holes) ? sanitizeHoles(b.holes) : null;
      if (!b || courseId == null || !clean || clean.length === 0) return json({ error: "invalid_layout" }, 400, origin);
      const { holes, total_par } = enrichHoles(clean); // compute distances (geo/par/manual) + total par
      const row = await db.createLayout(env.DB, { course_id: courseId, name: asStr(b.name, 60) ?? "Main", holes, total_par });
      return json({ layout: row }, 201, origin);
    }
    if (method === "PATCH" && id != null) {
      const b = (await readJson(request)) ?? {};
      let holes: LayoutHole[] | undefined;
      let total_par: number | undefined;
      if (Array.isArray(b.holes)) {
        const clean = sanitizeHoles(b.holes);
        if (!clean || clean.length === 0) return json({ error: "invalid_layout" }, 400, origin);
        ({ holes, total_par } = enrichHoles(clean));
      }
      const row = await db.updateLayout(env.DB, id, { name: asStr(b.name, 60), holes, total_par });
      return row ? json({ layout: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
    }
    if (method === "DELETE" && id != null) { await db.deleteLayout(env.DB, id); return json({ ok: true }, 200, origin); }
  }

  return json({ error: "not_found" }, 404, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(env, request);
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!secretOk(env)) return json({ error: "server_misconfigured" }, 500, origin);
    if (pathname === "/login" && method === "POST") return handleLogin(request, env, origin);
    if (pathname === "/me" && method === "GET") return handleMe(request, env, origin);
    if (pathname === "/set-pin" && method === "POST") return handleSetPin(request, env, origin);
    if (pathname === "/profile" && method === "POST") return handleProfile(request, env, origin);
    if (pathname === "/assistant" && method === "POST") return handleAssistant(request, env, origin);

    // --- passkeys / WebAuthn ---
    if (pathname === "/webauthn/register/options" && method === "POST") {
      const claims = await requireAuth(request, env);
      if (!claims) return json({ error: "unauthorized" }, 401, origin);
      const { status, data } = await registrationOptions(env, claims.sub);
      return json(data, status, origin);
    }
    if (pathname === "/webauthn/register/verify" && method === "POST") {
      const claims = await requireAuth(request, env);
      if (!claims) return json({ error: "unauthorized" }, 401, origin);
      const body = await readJson(request);
      if (!body) return json({ error: "invalid_request" }, 400, origin);
      const { status, data } = await registrationVerify(env, claims.sub, body as unknown as RegistrationResponseJSON);
      return json(data, status, origin);
    }
    if (pathname === "/webauthn/auth/options" && method === "POST") {
      const { status, data } = await authenticationOptions(env);
      return json(data, status, origin);
    }
    if (pathname === "/webauthn/auth/verify" && method === "POST") {
      const body = await readJson(request);
      if (!body) return json({ error: "invalid_request" }, 400, origin);
      const signToken = (claims: { sub: string; mustChangePin: boolean }) =>
        signSession(claims, env.JWT_SECRET, ttl(env));
      const { status, data } = await authenticationVerify(
        env,
        body as { flowId?: unknown; response?: AuthenticationResponseJSON },
        signToken,
      );
      return json(data, status, origin);
    }

    // --- club operations (events / courses / leagues / layouts) ---
    const club = await clubApi(request, env, origin, pathname, method);
    if (club) return club;

    return json({ error: "not_found" }, 404, origin);
  },
};
