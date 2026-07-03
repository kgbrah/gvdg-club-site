import type { Env } from "./env.js";
import * as db from "./db.js";
import { computeLeagueStandings } from "./scoring.js";
import { verifySession } from "./jwt.js";
import { bearer, json } from "./http.js";
import { asInt } from "./input.js";
import { handleTeeSignImage } from "./tee-sign-routes.js";

type PublicEventFilters = {
  readonly status?: string;
  readonly type?: string;
};

const PUBLIC_EVENT_SELECT = `SELECT e.*, cfg.play_format, co.name AS course_name, l.name AS layout_name
  FROM events e
  LEFT JOIN event_config cfg ON cfg.event_id = e.id
  LEFT JOIN courses co ON co.id = e.course_id
  LEFT JOIN course_layouts l ON l.id = e.layout_id`;

async function listPublicEvents(database: db.D1Like, opts: PublicEventFilters = {}) {
  let sql = PUBLIC_EVENT_SELECT;
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.status) { where.push("e.status = ?"); binds.push(opts.status); }
  if (opts.type) { where.push("e.type = ?"); binds.push(opts.type); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY e.date DESC, e.id DESC";
  return (await database.prepare(sql).bind(...binds).all()).results;
}

async function getPublicEvent(database: db.D1Like, id: number) {
  const event = await database.prepare(PUBLIC_EVENT_SELECT + " WHERE e.id = ?").bind(id).first();
  if (!event) return null;
  const players = (await database.prepare("SELECT * FROM event_players WHERE event_id = ? ORDER BY name").bind(id).all()).results;
  return { ...event, players };
}

export async function handleClubPublic(
  request: Request,
  env: Env,
  origin: string | null,
  pathname: string,
  method: string,
  seg: string[],
): Promise<Response | null> {
  if (method === "GET" && pathname === "/courses") return json({ courses: await db.listCourses(env.DB) }, 200, origin);
  if (method === "GET" && pathname === "/leagues") return json({ leagues: await db.listLeagues(env.DB) }, 200, origin);
  if (method === "GET" && seg[0] === "leagues" && seg.length === 2) {
    const lid = asInt(seg[1]);
    const league = lid == null ? null : await db.getLeague(env.DB, lid);
    if (!league) return json({ error: "not_found" }, 404, origin);
    const standings = computeLeagueStandings((await db.leagueResultRows(env.DB, lid!)) as { member_id: string | null; name: string; place: number | null; to_par: number | null }[]);
    return json({ league, standings, events: await db.listLeagueEvents(env.DB, lid!) }, 200, origin);
  }
  if (method === "GET" && pathname === "/fundraisers") return json({ fundraisers: await db.listFundraisers(env.DB) }, 200, origin);
  if (method === "GET" && seg[0] === "fundraisers" && seg.length === 2) {
    const fid = asInt(seg[1]);
    const f = fid == null ? null : await db.getFundraiser(env.DB, fid);
    return f ? json({ fundraiser: f }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "GET" && pathname === "/registration/open") return json({ events: await db.listOpenRegistrationEvents(env.DB) }, 200, origin);
  if (method === "GET" && pathname === "/payments/config") {
    return json({ enabled: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET), clientId: env.PAYPAL_CLIENT_ID ?? null, env: env.PAYPAL_ENV ?? "sandbox" }, 200, origin);
  }
  if (method === "GET" && pathname === "/meetings") return json({ meetings: await db.listMeetings(env.DB) }, 200, origin);
  if (method === "GET" && seg[0] === "meetings" && seg.length === 2) {
    const mid = asInt(seg[1]);
    const m = mid == null ? null : await db.getMeeting(env.DB, mid);
    return m ? json({ meeting: m }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "GET" && pathname === "/events") {
    const p = new URL(request.url).searchParams;
    return json({ events: await listPublicEvents(env.DB, { status: p.get("status") ?? undefined, type: p.get("type") ?? undefined }) }, 200, origin);
  }
  if (method === "GET" && seg[0] === "events" && seg.length === 2) {
    const id = asInt(seg[1]);
    const ev = id == null ? null : await getPublicEvent(env.DB, id);
    return ev ? json({ event: ev }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "GET" && seg[0] === "events" && seg.length === 3 && seg[2] === "results") {
    const eid = asInt(seg[1]);
    return eid == null ? json({ error: "not_found" }, 404, origin) : json({ results: await db.listResults(env.DB, eid) }, 200, origin);
  }
  if (method === "GET" && seg[0] === "events" && seg.length === 3 && seg[2] === "ctps") {
    const eid = asInt(seg[1]);
    return eid == null ? json({ error: "not_found" }, 404, origin) : json({ ctps: await db.listCtps(env.DB, eid) }, 200, origin);
  }
  if (method === "GET" && seg[0] === "events" && seg.length === 3 && seg[2] === "ace-pot") {
    const eid = asInt(seg[1]);
    if (eid == null) return json({ error: "not_found" }, 404, origin);
    const [pot, cfg, contributors] = (await Promise.all([db.getAcePot(env.DB, eid), db.getEventConfig(env.DB, eid), db.aceContributors(env.DB, eid)])) as [Record<string, unknown> | null, { ace_fee_cents?: number } | null, number];
    const aceFee = cfg?.ace_fee_cents || 0;
    const carryIn = Number(pot?.carryover_in_cents || 0);
    return json({ ace_pot: { ...(pot || {}), contributors, ace_fee_cents: aceFee, total_cents: carryIn + contributors * aceFee } }, 200, origin);
  }
  if (method === "GET" && seg[0] === "courses" && seg.length === 3 && (seg[2] === "layouts" || seg[2] === "positions")) {
    const cid = asInt(seg[1]);
    if (cid == null) return json({ error: "not_found" }, 404, origin);
    return seg[2] === "layouts"
      ? json({ layouts: await db.listLayouts(env.DB, cid) }, 200, origin)
      : json({ positions: await db.listPositions(env.DB, cid) }, 200, origin);
  }
  if (method === "GET" && seg[0] === "courses" && seg.length === 3 && seg[2] === "tee-signs") {
    const cid = asInt(seg[1]);
    if (cid == null) return json({ error: "not_found" }, 404, origin);
    const token = bearer(request);
    const claims = token ? await verifySession(token, env.JWT_SECRET) : null;
    const statuses = claims ? ["official", "candidate"] : ["official"];
    return json({ teeSigns: await db.listTeeSignsByCourse(env.DB, cid, statuses) }, 200, origin);
  }
  if (method === "GET" && seg[0] === "tee-signs" && seg.length === 3 && seg[2] === "image") {
    const tsId = asInt(seg[1]);
    return handleTeeSignImage(request, env, origin, tsId ?? null);
  }
  return null;
}
