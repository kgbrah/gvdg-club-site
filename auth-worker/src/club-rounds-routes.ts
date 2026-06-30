// Self-organizing CASUAL rounds (no admin event): a member starts a round on a course layout and gets a
// short code; cardmates join with the code, anyone on the round can add guests, and everyone on it keeps
// score on one shared card. Reuses the LiveEventDO (keyed "round:<code>") and its scoring/leaderboard.
// Round control + scoring require a member (the DO binds writes to the Worker-injected identity); the
// snapshot + WebSocket are public reads. Casual finalize does not write D1 event results.

import type { Env } from "./env.js";
import * as db from "./db.js";
import { requireAuth } from "./authz.js";
import { getMember } from "./roster.js";
import { json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { asInt } from "./input.js";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // unambiguous (no 0/O/1/I/L)
function genCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}
function roundStub(env: Env, code: string): DurableObjectStub {
  return env.LIVE.get(env.LIVE.idFromName("round:" + code));
}
async function proxy(stub: DurableObjectStub, path: string, init: RequestInit | undefined, origin: string | null): Promise<Response> {
  const r = await stub.fetch("https://do" + path, init);
  return json(await r.json().catch(() => ({})), r.status, origin);
}

export async function handleCasualRounds(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
): Promise<Response | null> {
  if (seg[0] !== "rounds") return null;

  // POST /rounds — a member starts a casual round on a layout; returns the share code.
  if (method === "POST" && seg.length === 1) {
    const claims = await requireAuth(request, env);
    if (!claims) return json({ error: "unauthorized" }, 401, origin);
    if (await kvRateLimited(env, "round-create:" + claims.sub, 10, 60)) return json({ error: "rate_limited" }, 429, origin);
    const b = (await readJson(request)) ?? {};
    const layoutId = asInt(b.layout_id);
    if (layoutId == null) return json({ error: "invalid_request" }, 400, origin);
    const holes = await db.getLayoutHoles(env.DB, layoutId);
    if (!holes.length) return json({ error: "no_layout_holes" }, 400, origin);
    const member = await getMember(env.ROSTER, claims.sub);
    const code = genCode();
    const r = await roundStub(env, code).fetch("https://do/start", {
      method: "POST",
      body: JSON.stringify({ casual: true, holes, players: [{ memberId: claims.sub, name: member?.name ?? "Player" }], startedAt: new Date().toISOString() }),
    });
    if (r.status !== 200) return json({ error: "start_failed" }, 502, origin);
    return json({ code }, 201, origin);
  }

  const code = (seg[1] || "").toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return json({ error: "not_found" }, 404, origin);
  const stub = roundStub(env, code);
  const sub = seg[2];

  // Public reads: snapshot + WebSocket (memberIds redacted, identified by index).
  if (method === "GET" && sub === "live" && !seg[3]) return proxy(stub, "/snapshot", undefined, origin);
  if (sub === "live" && seg[3] === "ws") return stub.fetch(request);

  // Everything else needs a member (the DO binds the write to this identity, never the body).
  const claims = await requireAuth(request, env);
  if (!claims) return json({ error: "unauthorized" }, 401, origin);
  const hdr = { "X-Auth-Member": claims.sub };

  if (method === "POST" && sub === "join") {
    const member = await getMember(env.ROSTER, claims.sub);
    return proxy(stub, "/join", { method: "POST", headers: hdr, body: JSON.stringify({ name: member?.name ?? "Player" }) }, origin);
  }
  if (method === "POST" && sub === "guest") {
    const b = (await readJson(request)) ?? {};
    return proxy(stub, "/guest", { method: "POST", headers: hdr, body: JSON.stringify({ name: b.name }) }, origin);
  }
  if (method === "POST" && sub === "remove") {
    // Drop a player from the round (accidental join, left early, or no-show). The DO authorizes from the
    // injected member identity (admin or same-card); index+name target the player (name guards a stale index).
    if (await kvRateLimited(env, "round-remove:" + claims.sub, 30, 60)) return json({ error: "rate_limited" }, 429, origin);
    const b = (await readJson(request)) ?? {};
    return proxy(stub, "/remove", { method: "POST", headers: hdr, body: JSON.stringify({ index: b.index, name: b.name }) }, origin);
  }
  if (method === "POST" && sub === "finalize") {
    return proxy(stub, "/finalize", { method: "POST", headers: hdr, body: "{}" }, origin);
  }
  if (sub === "live" && method === "GET" && seg[3] === "mine") {
    const r = await stub.fetch("https://do/mine", { headers: hdr });
    return json(await r.json().catch(() => ({})), r.status, origin);
  }
  if (sub === "live" && method === "POST" && seg[3] === "score") {
    if (await kvRateLimited(env, "live:" + claims.sub, 180, 60)) return json({ error: "rate_limited" }, 429, origin);
    const b = (await readJson(request)) ?? {};
    const r = await stub.fetch("https://do/score", { method: "POST", headers: { ...hdr, "X-Auth-Admin": "false" }, body: JSON.stringify(b) });
    return json(await r.json().catch(() => ({})), r.status, origin);
  }
  return json({ error: "not_found" }, 404, origin);
}
