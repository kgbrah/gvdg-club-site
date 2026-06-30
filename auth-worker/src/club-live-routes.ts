import type { Env } from "./env.js";
import * as db from "./db.js";
import { adminGate, requireAuth } from "./authz.js";
import { getMember } from "./roster.js";
import { json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { asInt, asStr } from "./input.js";

const LIVE_SCORE_IP_LIMIT = 180; // score writes per identity per minute (a card rarely exceeds a few)

async function liveProxy(stub: DurableObjectStub, path: string, init: RequestInit | undefined, origin: string | null): Promise<Response> {
  const r = await stub.fetch("https://do" + path, init);
  const data = await r.json().catch(() => ({}));
  return json(data, r.status, origin);
}

/** Who is scoring: a signed-in member (admins get the all-cards bypass) or a guest registrant via their
 *  registration token (?gt= or body.guestToken -> "g_<token>"). Returns null identity if neither. The
 *  resolved identity is injected into the DO as a trusted header; the DO never trusts the body for authz. */
async function scoreIdentity(
  request: Request,
  env: Env,
  body: Record<string, unknown> | null,
): Promise<{ authMember: string | null; authAdmin: boolean }> {
  const claims = await requireAuth(request, env);
  if (claims) {
    const member = await getMember(env.ROSTER, claims.sub);
    return { authMember: claims.sub, authAdmin: member?.isAdmin === true };
  }
  const t = asStr(new URL(request.url).searchParams.get("gt") ?? undefined, 64) || (body ? asStr(body.guestToken, 64) : null);
  return { authMember: t ? "g_" + t : null, authAdmin: false };
}

export async function handleClubLive(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
): Promise<Response | null> {
  if (seg[0] !== "events" || seg[2] !== "live") return null;
  const eid = asInt(seg[1]);
  if (eid == null) return json({ error: "not_found" }, 404, origin);
  const sub = seg[3];
  const stub = env.LIVE.get(env.LIVE.idFromName("event:" + eid));

  // Public reads: the live leaderboard/scorecard snapshot and the WebSocket. No identity, memberIds redacted.
  if (method === "GET" && !sub) return liveProxy(stub, "/snapshot", undefined, origin);
  if (sub === "ws") return stub.fetch(request);

  // A player's own card (members via JWT, guests via ?gt= token) — tells the score app which card is theirs.
  if (method === "GET" && sub === "mine") {
    const id = await scoreIdentity(request, env, null);
    if (!id.authMember) return json({ error: "unauthorized" }, 401, origin);
    const r = await stub.fetch("https://do/mine", { headers: { "X-Auth-Member": id.authMember } });
    return json(await r.json().catch(() => ({})), r.status, origin);
  }

  // Score submission: any player (or guest) may score; the DO enforces that the target is on THEIR card.
  if (method === "POST" && sub === "score") {
    const body = (await readJson(request)) ?? {};
    const id = await scoreIdentity(request, env, body);
    if (!id.authMember) return json({ error: "unauthorized" }, 401, origin);
    if (await kvRateLimited(env, "live:" + id.authMember, LIVE_SCORE_IP_LIMIT, 60)) return json({ error: "rate_limited" }, 429, origin);
    const r = await stub.fetch("https://do/score", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "X-Auth-Member": id.authMember, "X-Auth-Admin": String(id.authAdmin) },
    });
    return json(await r.json().catch(() => ({})), r.status, origin);
  }

  // Round control stays admin-only: start, finalize, and the round-scoped hole override.
  if (method === "POST" && (sub === "start" || sub === "finalize" || sub === "override")) {
    const gate = await adminGate(request, env, origin);
    if (gate instanceof Response) return gate;

    if (sub === "start") {
      const startBody = (await readJson(request)) ?? {};
      const ev = (await db.getEvent(env.DB, eid)) as (Record<string, unknown> & { layout_id?: number | null; players?: Record<string, unknown>[] }) | null;
      if (!ev) return json({ error: "not_found" }, 404, origin);
      const holes = await db.getLayoutHoles(env.DB, ev.layout_id);
      if (!holes.length) return json({ error: "no_layout_holes" }, 400, origin);
      const evLayout = ev.layout_id != null ? ((await db.getLayout(env.DB, ev.layout_id)) as { name?: string | null; course_id?: number | null } | null) : null;
      const evCourse = evLayout?.course_id != null ? ((await db.getCourse(env.DB, evLayout.course_id)) as { name?: string | null } | null) : null;
      const regs = (await db.listRegistrations(env.DB, eid)) as { member_id?: string; name?: string; division?: string | null; starting_hole?: number | null }[];
      const players =
        regs.length && startBody!.from !== "players"
          ? regs.map((r) => ({ memberId: r.member_id ?? null, name: String(r.name ?? "Player"), division: r.division ?? null, startingHole: r.starting_hole ?? null }))
          : (Array.isArray(ev.players) ? ev.players : []).map((p) => ({ memberId: (p.member_id as string) ?? null, name: String(p.name ?? "Player"), division: (p.division as string) ?? null, startingHole: null }));
      const r = await stub.fetch("https://do/start", { method: "POST", body: JSON.stringify({ eventId: eid, courseName: evCourse?.name ?? null, layoutName: evLayout?.name ?? null, holes, players, startedAt: new Date().toISOString() }) });
      const data = await r.json().catch(() => ({}));
      if (r.status === 200) await db.updateEvent(env.DB, eid, { status: "live" });
      return json(data, r.status, origin);
    }
    const body = (await readJson(request)) ?? {};
    return liveProxy(stub, "/" + sub, { method: "POST", body: JSON.stringify(body) }, origin);
  }
  return json({ error: "not_found" }, 404, origin);
}
