import type { Env } from "./env.js";
import * as db from "./db.js";
import { adminGate } from "./authz.js";
import { json, readJson } from "./http.js";
import { asInt } from "./input.js";

async function liveProxy(stub: DurableObjectStub, path: string, init: RequestInit | undefined, origin: string | null): Promise<Response> {
  const r = await stub.fetch("https://do" + path, init);
  const data = await r.json().catch(() => ({}));
  return json(data, r.status, origin);
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

  if (method === "GET" && !sub) return liveProxy(stub, "/snapshot", undefined, origin);
  if (sub === "ws") return stub.fetch(request);

  if (method === "POST" && (sub === "start" || sub === "score" || sub === "finalize" || sub === "override")) {
    const gate = await adminGate(request, env, origin);
    if (gate instanceof Response) return gate;

    if (sub === "start") {
      const startBody = (await readJson(request)) ?? {};
      const ev = (await db.getEvent(env.DB, eid)) as (Record<string, unknown> & { layout_id?: number | null; players?: Record<string, unknown>[] }) | null;
      if (!ev) return json({ error: "not_found" }, 404, origin);
      const holes = await db.getLayoutHoles(env.DB, ev.layout_id);
      if (!holes.length) return json({ error: "no_layout_holes" }, 400, origin);
      const regs = (await db.listRegistrations(env.DB, eid)) as { member_id?: string; name?: string; division?: string | null; starting_hole?: number | null }[];
      const players =
        regs.length && startBody!.from !== "players"
          ? regs.map((r) => ({ memberId: r.member_id ?? null, name: String(r.name ?? "Player"), division: r.division ?? null, startingHole: r.starting_hole ?? null }))
          : (Array.isArray(ev.players) ? ev.players : []).map((p) => ({ memberId: (p.member_id as string) ?? null, name: String(p.name ?? "Player"), division: (p.division as string) ?? null, startingHole: null }));
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
