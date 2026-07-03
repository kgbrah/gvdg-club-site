import * as db from "./db.js";
import { adminGate, requireAuth } from "./authz.js";
import { getMember } from "./roster.js";
import { json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { asInt, asStr } from "./input.js";
import { enrichLiveEventFormats, liveRoundFormats } from "./club-live-formats.js";
import { findRatingAnchor } from "./rating-store.js";
import { weatherLocationForCourse, type WeatherLocation } from "./weather.js";
import type { KVLike } from "./ratelimit.js";

const LIVE_SCORE_IP_LIMIT = 180; // score writes per identity per minute (a card rarely exceeds a few)

type LiveStub = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};
type LiveNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): LiveStub;
};
export type ClubLiveEnv = {
  readonly DB: db.D1Like;
  readonly LIVE: LiveNamespace;
  readonly RATELIMIT: KVLike;
  readonly ROSTER: KVLike;
  readonly JWT_SECRET: string;
};
type StartPlayer = {
  readonly memberId: string | null;
  readonly name: string;
  readonly team?: string | null;
  readonly division: string | null;
  readonly startingHole: number | null;
  readonly pdgaNo?: string | null;
};
type LiveJson = Record<string, unknown>;
type LiveEventRow = Record<string, unknown> & {
  readonly course_id?: number | null;
  readonly layout_id?: number | null;
  readonly format?: string | null;
  readonly players?: Record<string, unknown>[];
};
type LiveLayoutRow = {
  readonly id?: number | null;
  readonly name?: string | null;
  readonly course_id?: number | null;
  readonly holes?: string | null;
};
type LiveCourseRow = {
  readonly id?: number | null;
  readonly name?: string | null;
  readonly location?: string | null;
  readonly lat?: number | null;
  readonly lng?: number | null;
  readonly udisc_course_id?: string | null;
};

async function liveProxy(stub: LiveStub, path: string, init: RequestInit | undefined, origin: string | null): Promise<Response> {
  const r = await stub.fetch("https://do" + path, init);
  const data = await r.json().catch(() => ({}));
  return json(data, r.status, origin);
}
async function liveJson(stub: LiveStub, path: string, init?: RequestInit): Promise<{ readonly data: LiveJson; readonly status: number }> {
  const r = await stub.fetch("https://do" + path, init);
  const parsed: unknown = await r.json().catch(() => ({}));
  return { data: isRecord(parsed) ? parsed : {}, status: r.status };
}
function isRecord(value: unknown): value is LiveJson {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function needsWeatherBackfill(data: LiveJson, status: number): boolean {
  return status === 200 && data["status"] === "live" && data["weather"] == null;
}
function rowString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}
function rowNumber(row: Record<string, unknown> | null, key: string): number | null {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function normalizedTeam(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}
function teamValidationError(teamRequired: boolean, players: readonly StartPlayer[]): Record<string, unknown> | null {
  if (!teamRequired) return null;
  for (const player of players) {
    if (!normalizedTeam(player.team)) return { error: "team_required", player: player.name };
  }
  if (new Set(players.map((player) => normalizedTeam(player.team))).size < 2) return { error: "not_enough_teams" };
  return null;
}
async function liveWeatherLocationFromSnapshot(env: ClubLiveEnv, data: LiveJson): Promise<WeatherLocation | null> {
  const udiscCourseId = rowString(data, "udiscCourseId");
  const courseName = rowString(data, "courseName");
  const layoutName = rowString(data, "layoutName");
  let course: LiveCourseRow | null = null;
  if (udiscCourseId) {
    course = (await env.DB.prepare("SELECT * FROM courses WHERE udisc_course_id = ? LIMIT 1").bind(udiscCourseId).first()) as LiveCourseRow | null;
  }
  if (!course && courseName) {
    course = (await env.DB.prepare("SELECT * FROM courses WHERE lower(name) = lower(?) LIMIT 1").bind(courseName).first()) as LiveCourseRow | null;
  }
  if (!course) return null;
  const courseId = rowNumber(course, "id");
  const layout =
    courseId != null && layoutName
      ? ((await env.DB.prepare("SELECT * FROM course_layouts WHERE course_id = ? AND lower(name) = lower(?) LIMIT 1").bind(courseId, layoutName).first()) as LiveLayoutRow | null)
      : null;
  return weatherLocationForCourse(course, layout);
}
async function liveWeatherLocation(env: ClubLiveEnv, eid: number, data: LiveJson): Promise<WeatherLocation | null> {
  const ev = (await db.getEvent(env.DB, eid)) as LiveEventRow | null;
  if (ev) {
    const evLayout = ev.layout_id != null ? ((await db.getLayout(env.DB, ev.layout_id)) as LiveLayoutRow | null) : null;
    const courseId = evLayout?.course_id ?? ev.course_id ?? null;
    const evCourse = courseId != null ? ((await db.getCourse(env.DB, courseId)) as LiveCourseRow | null) : null;
    const location = weatherLocationForCourse(evCourse, evLayout);
    if (location) return location;
  }
  return liveWeatherLocationFromSnapshot(env, data);
}
async function ensureLiveWeather(stub: LiveStub, env: ClubLiveEnv, eid: number, data: LiveJson): Promise<LiveJson | null> {
  const weatherLocation = await liveWeatherLocation(env, eid, data);
  if (!weatherLocation) return null;
  const updated = await liveJson(stub, "/weather", { method: "POST", body: JSON.stringify({ weatherLocation }) });
  return updated.status === 200 ? updated.data : null;
}
async function liveSnapshotWithWeather(stub: LiveStub, env: ClubLiveEnv, eid: number, origin: string | null): Promise<Response> {
  const first = await liveJson(stub, "/snapshot");
  const enriched = await enrichLiveEventFormats(env, eid, first.data, first.status);
  if (!needsWeatherBackfill(enriched, first.status)) return json(enriched, first.status, origin);
  const updated = await ensureLiveWeather(stub, env, eid, enriched);
  const out = updated ? await enrichLiveEventFormats(env, eid, updated, 200) : enriched;
  return json(out, updated ? 200 : first.status, origin);
}
async function liveMineWithWeather(stub: LiveStub, env: ClubLiveEnv, eid: number, headers: HeadersInit, origin: string | null): Promise<Response> {
  const first = await liveJson(stub, "/mine", { headers });
  const enriched = await enrichLiveEventFormats(env, eid, first.data, first.status);
  if (!needsWeatherBackfill(enriched, first.status)) return json(enriched, first.status, origin);
  const updated = await ensureLiveWeather(stub, env, eid, enriched);
  if (!updated) return json(enriched, first.status, origin);
  const second = await liveJson(stub, "/mine", { headers });
  const secondEnriched = await enrichLiveEventFormats(env, eid, second.data, second.status);
  return json(secondEnriched, second.status, origin);
}

async function withRatingAnchor(env: ClubLiveEnv, player: StartPlayer) {
  const member = player.memberId ? await getMember(env.ROSTER, player.memberId) : null;
  const ratingAnchor = await findRatingAnchor(env.DB, { memberId: player.memberId, pdgaNo: player.pdgaNo ?? member?.pdgaNo ?? null });
  return {
    memberId: player.memberId,
    name: player.name,
    team: player.team ?? null,
    division: player.division,
    startingHole: player.startingHole,
    ratingAnchor,
  };
}

/** Who is scoring: a signed-in member (admins get the all-cards bypass) or a guest registrant via their
 *  registration token (?gt= or body.guestToken -> "g_<token>"). Returns null identity if neither. The
 *  resolved identity is injected into the DO as a trusted header; the DO never trusts the body for authz. */
async function scoreIdentity(
  request: Request,
  env: ClubLiveEnv,
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
  env: ClubLiveEnv,
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
  if (method === "GET" && !sub) return liveSnapshotWithWeather(stub, env, eid, origin);
  if (sub === "ws") return stub.fetch(request);

  // A player's own card (members via JWT, guests via ?gt= token) — tells the score app which card is theirs.
  if (method === "GET" && sub === "mine") {
    const id = await scoreIdentity(request, env, null);
    if (!id.authMember) return json({ error: "unauthorized" }, 401, origin);
    return liveMineWithWeather(stub, env, eid, { "X-Auth-Member": id.authMember }, origin);
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

  if (method === "POST" && (sub === "start" || sub === "cancel" || sub === "finalize" || sub === "override")) {
    const gate = await adminGate(request, env, origin);
    if (gate instanceof Response) return gate;

    if (sub === "start") {
      const startBody = (await readJson(request)) ?? {};
      const ev = (await db.getEvent(env.DB, eid)) as LiveEventRow | null;
      if (!ev) return json({ error: "not_found" }, 404, origin);
      const evConfig = (await db.getEventConfig(env.DB, eid)) as { readonly play_format?: string | null } | null;
      const roundFormats = liveRoundFormats(rowString(ev, "format"), rowString(evConfig ?? {}, "play_format"));
      if (!roundFormats) return json({ error: "invalid_event_format" }, 400, origin);
      const holes = await db.getLayoutHoles(env.DB, ev.layout_id);
      if (!holes.length) return json({ error: "no_layout_holes" }, 400, origin);
      const evLayout = ev.layout_id != null ? ((await db.getLayout(env.DB, ev.layout_id)) as LiveLayoutRow | null) : null;
      const courseId = evLayout?.course_id ?? ev.course_id ?? null;
      const evCourse = courseId != null ? ((await db.getCourse(env.DB, courseId)) as LiveCourseRow | null) : null;
      const weatherLocation = weatherLocationForCourse(evCourse, evLayout);
      const regs = (await db.listRegistrations(env.DB, eid)) as { member_id?: string; name?: string; team?: string | null; division?: string | null; starting_hole?: number | null }[];
      const rawPlayers: StartPlayer[] =
        regs.length && startBody.from !== "players"
          ? regs.map((r) => ({ memberId: r.member_id ?? null, name: String(r.name ?? "Player"), team: r.team ?? null, division: r.division ?? null, startingHole: r.starting_hole ?? null }))
          : (Array.isArray(ev.players) ? ev.players : []).map((p) => ({ memberId: rowString(p, "member_id"), name: String(p.name ?? "Player"), team: rowString(p, "team"), division: rowString(p, "division"), startingHole: null, pdgaNo: rowString(p, "pdga_no") }));
      const teamError = teamValidationError(roundFormats.teamRequired, rawPlayers);
      if (teamError) return json(teamError, 400, origin);
      const players = await Promise.all(rawPlayers.map((player) => withRatingAnchor(env, player)));
      const r = await stub.fetch("https://do/start", { method: "POST", body: JSON.stringify({ eventId: eid, courseId: ev.course_id ?? evLayout?.course_id ?? null, layoutId: ev.layout_id ?? null, courseName: evCourse?.name ?? null, layoutName: evLayout?.name ?? null, format: roundFormats.format, playFormat: roundFormats.playFormat, teamRequired: roundFormats.teamRequired, holes, players, startedAt: new Date().toISOString(), weatherLocation }) });
      const data = await r.json().catch(() => ({}));
      if (r.status === 200) await db.updateEvent(env.DB, eid, { status: "live" });
      return json(data, r.status, origin);
    }
    const body = (await readJson(request)) ?? {};
    if (sub === "cancel") {
      if (body.confirm_live_scorecard_cancel !== true) return json({ error: "live_scorecard_cancel_confirmation_required" }, 409, origin);
      const status = await db.getEventStatus(env.DB, eid);
      if (status == null) return json({ error: "not_found" }, 404, origin);
      if (status === "final") return json({ error: "round_already_final" }, 409, origin);
      const r = await stub.fetch("https://do/cancel", { method: "POST", headers: { "X-Auth-Admin": "true" }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (r.status === 200) await db.updateEvent(env.DB, eid, { status: "scheduled" });
      return json(data, r.status, origin);
    }
    if (sub === "finalize") {
      // This route already passed adminGate, so the caller is a club admin → allow the force override
      // (finalize past scorecards that don't fully agree). Force comes from ?force=1 or body.force.
      const force = body.force === true || new URL(request.url).searchParams.get("force") === "1";
      return liveProxy(stub, "/finalize", { method: "POST", headers: { "X-Auth-Admin": "true" }, body: JSON.stringify({ ...body, force }) }, origin);
    }
    return liveProxy(stub, "/" + sub, { method: "POST", body: JSON.stringify(body) }, origin);
  }
  return json({ error: "not_found" }, 404, origin);
}
