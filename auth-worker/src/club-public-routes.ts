import type { Env } from "./env.js";
import * as db from "./db.js";
import { computeLeagueStandings, computeRoundWinners, computeTeamStandings } from "./scoring.js";
import { RYDER_CUP_LEAGUE_ID, buildRyderCupBoard, type RyderLeagueEvent } from "./ryder-board.js";
import { verifySession } from "./jwt.js";
import { bearer, json } from "./http.js";
import { RECORD_PAGE_DEFAULTS, asInt, parseWindow } from "./input.js";
import { handleTeeSignImage } from "./tee-sign-routes.js";
import { readD1OrFallback } from "./d1-retry.js";

const COURSE_CATALOG_CACHE_VERSION = "course-catalog-v2";
const COURSE_CATALOG_CACHE_NAME = "gvdg-course-catalog";

function courseCatalogCacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.set("__gvdg_cache", COURSE_CATALOG_CACHE_VERSION);
  return new Request(url.toString(), { method: "GET" });
}

const CATALOG_CORS = {
  "Access-Control-Allow-Origin": "*",
  Vary: "Accept-Encoding",
} as const;

async function cachedCourseCatalogJson(
  request: Request,
  origin: string | null,
  load: () => Promise<{ payload: unknown; cacheable: boolean }>,
): Promise<Response> {
  const loaded = await load();
  const cache = typeof caches === "undefined" ? null : await caches.open(COURSE_CATALOG_CACHE_NAME);
  const cacheKey = cache ? courseCatalogCacheKey(request) : null;
  if (loaded.cacheable) {
    const response = json(loaded.payload, 200, origin, {
      ...CATALOG_CORS,
      "Cache-Control": "private, no-store",
    });
    if (cache && cacheKey) await cache.put(cacheKey, response.clone());
    return response;
  }
  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }
  return json(loaded.payload, 200, origin, { ...CATALOG_CORS, "Cache-Control": "no-store" });
}

export async function handleClubPublic(
  request: Request,
  env: Env,
  origin: string | null,
  pathname: string,
  method: string,
  seg: string[],
): Promise<Response | null> {
  if (method === "GET" && pathname === "/courses") {
    return cachedCourseCatalogJson(request, origin, async () => {
      const listed = await db.listCoursesCatalog(env.DB);
      return { payload: { courses: listed.results }, cacheable: listed.cacheable };
    });
  }
  if (method === "GET" && pathname === "/leagues") return json({ leagues: await db.listLeagues(env.DB) }, 200, origin);
  // Club standings for member dashboards: active leagues (with team + player standings) + any live events.
  if (method === "GET" && pathname === "/leagues/active") {
    const leagues = await readD1OrFallback(
      async () => {
        const active = (await db.listActiveLeagues(env.DB)) as { id: number }[];
        return Promise.all(
          active.map(async (lg) => {
            const rows = (await db.leagueResultRows(env.DB, lg.id)) as { event_id?: number | null; member_id: string | null; name: string; place: number | null; to_par: number | null; match_result?: string | null; scoring_group?: string | null }[];
            return { league: lg, teamStandings: computeTeamStandings(rows), standings: computeLeagueStandings(rows), roundWinners: computeRoundWinners(rows) };
          }),
        );
      },
      () => [],
    );
    const liveEvents = await readD1OrFallback(() => db.listLiveEvents(env.DB), () => []);
    return json({ leagues, liveEvents }, 200, origin);
  }
  if (method === "GET" && seg[0] === "leagues" && seg.length === 2) {
    const lid = asInt(seg[1]);
    const league = lid == null ? null : await db.getLeague(env.DB, lid);
    if (!league) return json({ error: "not_found" }, 404, origin);
    const rows = (await db.leagueResultRows(env.DB, lid!)) as { event_id?: number | null; member_id: string | null; name: string; place: number | null; to_par: number | null; match_result?: string | null; scoring_group?: string | null }[];
    const standings = computeLeagueStandings(rows);
    const teamStandings = computeTeamStandings(rows);
    const roundWinners = computeRoundWinners(rows);
    const events = await db.listLeagueEvents(env.DB, lid!);
    const payload: Record<string, unknown> = { league, standings, teamStandings, roundWinners, events };
    if (lid === RYDER_CUP_LEAGUE_ID) {
      payload.board = buildRyderCupBoard(events as RyderLeagueEvent[], rows);
    }
    return json(payload, 200, origin);
  }
  if (method === "GET" && pathname === "/fundraisers") return json({ fundraisers: await db.listFundraisers(env.DB) }, 200, origin);
  if (method === "GET" && seg[0] === "fundraisers" && seg.length === 2) {
    const fid = asInt(seg[1]);
    const f = fid == null ? null : await db.getFundraiser(env.DB, fid);
    return f ? json({ fundraiser: f }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "GET" && pathname === "/registration/open") {
    const events = await readD1OrFallback(() => db.listOpenRegistrationEvents(env.DB), () => []);
    return json({ events }, 200, origin);
  }
  if (method === "GET" && pathname === "/payments/config") {
    return json({ enabled: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET), clientId: env.PAYPAL_CLIENT_ID ?? null, env: env.PAYPAL_ENV ?? "sandbox" }, 200, origin);
  }
  if (method === "GET" && pathname === "/meetings") {
    const meetings = await readD1OrFallback(() => db.listMeetings(env.DB), () => []);
    return json({ meetings }, 200, origin);
  }
  if (method === "GET" && seg[0] === "meetings" && seg.length === 2) {
    const mid = asInt(seg[1]);
    const m = mid == null ? null : await db.getMeeting(env.DB, mid);
    return m ? json({ meeting: m }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "GET" && pathname === "/events") {
    const p = new URL(request.url).searchParams;
    const q = parseWindow(p, { limit: RECORD_PAGE_DEFAULTS.events.defaultLimit }, { maxLimit: RECORD_PAGE_DEFAULTS.events.maxLimit });
    const requestedLimit = p.get("all") === "1" ? RECORD_PAGE_DEFAULTS.events.maxLimit : q.limit;
    const args: { status?: string; type?: string; limit?: number | null; offset?: number | null } = {
      status: p.get("status") ?? undefined,
      type: p.get("type") ?? undefined,
      limit: requestedLimit,
      offset: q.offset,
    };
    return json({ events: await db.listEvents(env.DB, args) }, 200, origin);
  }
  if (method === "GET" && seg[0] === "events" && seg.length === 2) {
    const id = asInt(seg[1]);
    const ev = id == null ? null : await db.getEvent(env.DB, id);
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
    if (seg[2] === "layouts") {
      return cachedCourseCatalogJson(request, origin, async () => {
        const listed = await db.listLayoutsCatalog(env.DB, cid);
        return { payload: { layouts: listed.results }, cacheable: listed.cacheable };
      });
    }
    return cachedCourseCatalogJson(request, origin, async () => {
      const listed = await db.listPositionsCatalog(env.DB, cid);
      return { payload: { positions: listed.results }, cacheable: listed.cacheable };
    });
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
