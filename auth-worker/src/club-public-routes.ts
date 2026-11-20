import type { Env } from "./env.js";
import * as db from "./db.js";
import { computeLeagueStandings, computeRoundWinners, computeTeamStandings } from "./scoring.js";
import { RYDER_CUP_LEAGUE_ID, buildRyderCupBoard, type RyderLeagueEvent } from "./ryder-board.js";
import { verifySession } from "./jwt.js";
import { bearer, json } from "./http.js";
import { RECORD_PAGE_DEFAULTS, asInt, parseWindow } from "./input.js";
import { handleTeeSignImage } from "./tee-sign-routes.js";
import { readD1OrFallback } from "./d1-retry.js";
import { publicFieldsByEvent } from "./event-field.js";
import { COURSE_CATALOG_CACHE_NAME, courseCatalogCacheKey } from "./course-catalog-cache.js";
import { getUdiscImportState } from "./db-udisc-layout-imports.js";
import { listNearbyPdgaEvents, PDGA_EVENT_MILES } from "./pdga-events.js";
import { handicapCutoffDate, handicapsFromRounds, type HandicapRound } from "./handicap.js";
import { courseTrafficPayload } from "./course-traffic.js";

const CATALOG_CORS = {
  "Access-Control-Allow-Origin": "*",
  Vary: "Accept-Encoding",
} as const;

/** A good catalog is reused for this long before D1 is read again (admin course/map writes drop it sooner). */
const CATALOG_FRESH_MS = 60_000;
const CATALOG_STAMP = "X-Gvdg-Catalog-At";
/** How long the edge keeps a good catalog as the last-good fallback for D1 outages. */
const CATALOG_KEEP_S = 86_400;

async function cachedCourseCatalogJson(
  request: Request,
  origin: string | null,
  load: () => Promise<{ payload: unknown; cacheable: boolean }>,
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<Response> {
  const cache = typeof caches === "undefined" ? null : await caches.open(COURSE_CATALOG_CACHE_NAME);
  const cacheKey = cache ? courseCatalogCacheKey(request) : null;
  // Serve a recent good copy without touching D1: the full catalog is three bulk reads (~1-3s), and reading
  // it on every request is what pushed those reads toward their timeout and into the fallback.
  const cached = cache && cacheKey ? await cache.match(cacheKey) : undefined;
  const cachedAt = Number(cached?.headers.get(CATALOG_STAMP));
  if (cached && Number.isFinite(cachedAt) && cachedAt > 0 && Date.now() - cachedAt < CATALOG_FRESH_MS) return forClient(cached);
  // The edge copy must itself be cacheable: Cloudflare's Cache API silently refuses responses marked
  // private/no-store, which is why this cache never held anything before. It is kept a day as the
  // last-good fallback; freshness is decided by the stamp above, and clients always get no-store.
  const store = async (payload: unknown, stamp: string) => {
    if (!cache || !cacheKey) return;
    await cache.put(cacheKey, json(payload, 200, origin, { ...CATALOG_CORS, "Cache-Control": `public, max-age=${CATALOG_KEEP_S}`, [CATALOG_STAMP]: stamp }));
  };
  // Older than a minute: answer with it now and rebuild it after the response, so no visitor waits the 1-3 s the
  // bulk read takes (an admin course or map change still drops the copy, so the next request rebuilds it first).
  if (cached && Number.isFinite(cachedAt) && cachedAt > 0 && typeof ctx?.waitUntil === "function") {
    ctx.waitUntil(load().then((loaded) => (loaded.cacheable ? store(loaded.payload, String(Date.now())) : undefined)).catch(() => {}));
    return forClient(cached);
  }
  const loaded = await load();
  if (loaded.cacheable) {
    const stamp = String(Date.now());
    const response = json(loaded.payload, 200, origin, { ...CATALOG_CORS, "Cache-Control": "private, no-store", [CATALOG_STAMP]: stamp });
    await store(loaded.payload, stamp);
    return response;
  }
  // D1 is degraded: a previous good catalog (even an older one) beats the built-in fallback.
  if (cached) return forClient(cached);
  return json(loaded.payload, 200, origin, { ...CATALOG_CORS, "Cache-Control": "no-store" });
}

/** A cached edge copy goes back to the browser as no-store, like a freshly built catalog. */
function forClient(cached: Response): Response {
  const response = new Response(cached.body, cached);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function handleClubPublic(
  request: Request,
  env: Env,
  origin: string | null,
  pathname: string,
  method: string,
  seg: string[],
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<Response | null> {
  if (method === "GET" && pathname === "/courses") {
    return cachedCourseCatalogJson(request, origin, async () => {
      const listed = await db.listCoursesCatalog(env.DB);
      return { payload: { courses: listed.results }, cacheable: listed.cacheable };
    }, ctx);
  }
  if (method === "GET" && pathname === "/course-traffic") {
    const payload = await courseTrafficPayload(env);
    return json(payload, 200, origin, { "Cache-Control": "no-store" });
  }
  if (method === "GET" && pathname === "/courses/map-import") {
    const listed = await db.listCoursesCatalog(env.DB);
    const courses = listed.results as { mapped?: number | boolean }[];
    const mapped = courses.filter((course) => Number(course.mapped) === 1 || course.mapped === true).length;
    let state = null as Awaited<ReturnType<typeof getUdiscImportState>>;
    try {
      state = await getUdiscImportState(env.DB);
    } catch {
      state = null;
    }
    return json({
      total: courses.length,
      mapped,
      remaining: Math.max(0, courses.length - mapped),
      last_status: state?.last_status ?? null,
      last_name: state?.last_name ?? null,
      last_course_id: state?.last_course_id ?? null,
      last_error: state?.last_error ?? null,
      last_run_at: state?.last_run_at ?? null,
      hydrated_at: state?.hydrated_at ?? null,
    }, 200, origin);
  }
  if (method === "GET" && pathname === "/pdga-events") {
    const url = new URL(request.url);
    // A missing parameter is not 0 (Number(null) is): without both, there's no location to search near.
    const rawLat = url.searchParams.get("lat");
    const rawLng = url.searchParams.get("lng");
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    if (!rawLat?.trim() || !rawLng?.trim() || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return json({ error: "location_required" }, 400, origin);
    }
    try {
      const events = await listNearbyPdgaEvents(env, { lat, lng });
      return json({ events, miles: PDGA_EVENT_MILES }, 200, origin, { "Cache-Control": "private, max-age=300" });
    } catch {
      return json({ events: [], miles: PDGA_EVENT_MILES }, 200, origin, { "Cache-Control": "no-store" });
    }
  }
  if (method === "GET" && pathname === "/leagues") return json({ leagues: await db.listLeagues(env.DB) }, 200, origin);
  if (method === "GET" && pathname === "/leagues/schedule") {
    const events = await readD1OrFallback(() => db.listLeagueSchedule(env.DB), () => []);
    return json({ events }, 200, origin);
  }
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
    const events = await readD1OrFallback(() => db.listOpenRegistrationEvents(env.DB), () => []) as { id?: number }[];
    const fields = await readD1OrFallback(
      () => publicFieldsByEvent(env, events.map((event) => Number(event.id)).filter((id) => Number.isInteger(id))),
      () => new Map<number, never[]>(),
    );
    return json({
      events: events.map((event) => ({
        ...event,
        field: fields.get(Number(event.id)) || [],
      })),
    }, 200, origin);
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
    if (id == null) return json({ error: "not_found" }, 404, origin);
    const ev = await db.getEvent(env.DB, id);
    if (!ev) return json({ error: "not_found" }, 404, origin);
    const fields = await readD1OrFallback(() => publicFieldsByEvent(env, [id]), () => new Map());
    // The event page's Entry and Divisions facts come from the registration settings (it said "Entry: Free" for a $50
    // event: the PDGA end-to-end test).
    const cfg = await readD1OrFallback(() => db.getEventConfig(env.DB, id), () => null) as Record<string, unknown> | null;
    let divisions: unknown = [];
    try { divisions = cfg?.divisions ? JSON.parse(String(cfg.divisions)) : []; } catch { divisions = []; }
    const settings = cfg ? {
      entry_fee_cents: cfg.entry_fee_cents ?? null,
      ctp_fee_cents: cfg.ctp_fee_cents ?? null,
      divisions: Array.isArray(divisions) ? divisions : [],
      ...(cfg.play_format ? { play_format: cfg.play_format } : {}),
    } : {};
    return json({ event: { ...ev, ...settings, field: fields.get(id) || [] } }, 200, origin);
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
  if (method === "GET" && seg[0] === "layouts" && seg.length === 3 && seg[2] === "handicaps") {
    const lid = asInt(seg[1]);
    if (lid == null) return json({ error: "not_found" }, 404, origin);
    const rounds = await readD1OrFallback(
      () => db.listLayoutHandicapRounds(env.DB, lid, handicapCutoffDate()),
      () => [],
    );
    const players = handicapsFromRounds((Array.isArray(rounds) ? rounds : []) as HandicapRound[]).map((player) => ({
      key: player.key,
      name: player.name,
      start: player.start,
      rounds: player.rounds,
      provisional: player.provisional,
    }));
    return json({ layoutId: lid, players, windowDays: 365, maxRounds: 5 }, 200, origin, { "Cache-Control": "private, max-age=60" });
  }
  if (method === "GET" && seg[0] === "courses" && seg.length === 3 && (seg[2] === "layouts" || seg[2] === "positions")) {
    const cid = asInt(seg[1]);
    if (cid == null) return json({ error: "not_found" }, 404, origin);
    if (seg[2] === "layouts") {
      return cachedCourseCatalogJson(request, origin, async () => {
        const listed = await db.listPublicLayoutsCatalog(env.DB, cid);
        return { payload: { layouts: listed.results }, cacheable: listed.cacheable };
      }, ctx);
    }
    return cachedCourseCatalogJson(request, origin, async () => {
      const listed = await db.listPositionsCatalog(env.DB, cid);
      return { payload: { positions: listed.results }, cacheable: listed.cacheable };
    }, ctx);
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
