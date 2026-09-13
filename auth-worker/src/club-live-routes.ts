import type { Env } from "./env.js";
import * as db from "./db.js";
import { adminGate, requireAuth } from "./authz.js";
import { getMember } from "./roster.js";
import { json, readJson } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { asInt, asStr } from "./input.js";
import { isLiveFormatError, normalizeLiveScoringConfigFromLegacy, type LiveScoringConfig } from "./live-format.js";
import { scoringState } from "./live-state.js";
import { ctpEligibleForStart, parseCtpAddon, registrationPaidEntry } from "./live-ctp.js";
import { assignCards, type PlayerState } from "./scoring.js";
import { weatherLocationForCourse } from "./weather.js";
import { playersMatch } from "./player-identity.js";

type RosterPlayer = { memberId: string | null; name: string; division: string | null; startingHole: number | null; team: string | null };

/** Merge a live event's REGISTERED players with its manually-added (event_players) walk-ons into one roster
 *  so neither is dropped. Dedupe the same member (by member_id) and the same person (by name, including a
 *  guest token vs club member). Registrations are added first; a later club-member row with the same name
 *  replaces a guest so scoring uses the real member id. */
export function unionRosterPlayers(
  regs: readonly { member_id?: string | null; name?: string | null; division?: string | null; starting_hole?: number | null; team?: string | null }[],
  manual: readonly Record<string, unknown>[],
): RosterPlayer[] {
  const out: RosterPlayer[] = [];
  const seenMember = new Set<string>();
  const isGuest = (id: string | null) => Boolean(id && id.startsWith("g_"));
  const add = (p: RosterPlayer) => {
    if (p.memberId && seenMember.has(p.memberId)) return;
    const matchIdx = out.findIndex((existing) => playersMatch(existing.name, p.name));
    if (matchIdx >= 0) {
      const existing = out[matchIdx]!;
      if (isGuest(existing.memberId) && p.memberId && !isGuest(p.memberId)) {
        if (existing.memberId) seenMember.delete(existing.memberId);
        out[matchIdx] = p;
        if (p.memberId) seenMember.add(p.memberId);
      }
      return;
    }
    if (p.memberId) seenMember.add(p.memberId);
    out.push(p);
  };
  for (const r of regs) add({ memberId: r.member_id ?? null, name: String(r.name ?? "Player"), division: r.division ?? null, startingHole: r.starting_hole ?? null, team: r.team ?? null });
  for (const m of manual) add({ memberId: typeof m.member_id === "string" ? m.member_id : null, name: String(m.name ?? "Player"), division: typeof m.division === "string" ? m.division : null, startingHole: null, team: typeof m.team === "string" ? m.team : null });
  return out;
}

const LIVE_SCORE_IP_LIMIT = 180; // score writes per identity per minute (a card rarely exceeds a few)
const LIVE_LOCATION_LIMIT = 30; // GPS pings per identity per minute

export async function startLiveEvent(
  env: Env,
  origin: string | null,
  eid: number,
  startBody: Record<string, unknown> = {},
): Promise<Response> {
  const stub = env.LIVE.get(env.LIVE.idFromName("event:" + eid));
  const ev = (await db.getEvent(env.DB, eid)) as (Record<string, unknown> & { layout_id?: number | null; players?: Record<string, unknown>[] }) | null;
  if (!ev) return json({ error: "not_found" }, 404, origin);
  const holes = await db.getLayoutHoles(env.DB, ev.layout_id);
  if (!holes.length) return json({ error: "no_layout_holes" }, 400, origin);
  const evLayout = ev.layout_id != null ? ((await db.getLayout(env.DB, ev.layout_id)) as { name?: string | null; course_id?: number | null } | null) : null;
  const evCourse = evLayout?.course_id != null ? ((await db.getCourse(env.DB, evLayout.course_id)) as { name?: string | null; lat?: number | null; lng?: number | null } | null) : null;
  const weatherLocation = weatherLocationForCourse(evCourse, evLayout); // null unless the course has coords
  const eventConfig = (await db.getEventConfig(env.DB, eid)) as { live_scoring_config?: unknown; play_format?: unknown; ctp_fee_cents?: number | null } | null;
  let liveScoringConfig: LiveScoringConfig;
  try {
    liveScoringConfig = normalizeLiveScoringConfigFromLegacy({
      liveScoringConfig: startBody.liveScoringConfig,
      live_scoring_config: eventConfig?.live_scoring_config,
      play_format: eventConfig?.play_format,
      format: ev.format,
    });
  } catch (error) {
    if (isLiveFormatError(error)) return json({ error: "invalid_live_scoring_config" }, 400, origin);
    throw error;
  }
  const regs = (await db.listRegistrations(env.DB, eid)) as {
    member_id?: string;
    name?: string;
    division?: string | null;
    starting_hole?: number | null;
    team?: string | null;
    addons?: string | null;
    paid_entry?: number | boolean | null;
  }[];
  // Seed the round with BOTH registered players AND manually-added (event_players) walk-ons — nobody is
  // dropped regardless of how they were entered. (A registered player who was also manually added shows
  // once; the registration wins since it carries division / starting hole / check-in.)
  const roster = unionRosterPlayers(regs, Array.isArray(ev.players) ? ev.players : []);
  if (!roster.length) {
    return json({
      error: "empty_roster",
      message: "Add players in Registration before starting live scoring.",
    }, 400, origin);
  }
  const buyInRequired = (Number(eventConfig?.ctp_fee_cents) || 0) > 0;
  const enteredMemberIds = new Set(
    regs
      .filter((row) => row.member_id && parseCtpAddon(row.addons) && registrationPaidEntry(row))
      .map((row) => String(row.member_id)),
  );
  const players = roster.map((player) => ({
    ...player,
    ctpEligible: ctpEligibleForStart({ buyInRequired, memberId: player.memberId, enteredMemberIds }),
  }));
  const validationPlayers: PlayerState[] = players.map((player) => ({ ...player, scores: {}, scorecards: {} }));
  assignCards(validationPlayers);
  const targetValidation = scoringState({ eventId: eid, holes, status: "live", startedAt: "", roundConfig: liveScoringConfig }, validationPlayers);
  // Refuse a malformed prospective roster at start (odd/mis-paired card). Read globalError/cardErrors
  // explicitly rather than the `error` summary so this guard can't silently regress if the summary changes.
  const startError = targetValidation.globalError ?? targetValidation.cardErrors[0] ?? null;
  if (startError) {
    return json({ error: "invalid_score_targets", code: startError.code, message: startError.message }, 400, origin);
  }
  const r = await stub.fetch("https://do/start", { method: "POST", body: JSON.stringify({ eventId: eid, courseName: evCourse?.name ?? null, layoutName: evLayout?.name ?? null, holes, players, liveScoringConfig, startedAt: new Date().toISOString(), weatherLocation, ctpBuyInRequired: buyInRequired }) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 200) await db.updateEvent(env.DB, eid, { status: "live" });
  return json(data, r.status, origin);
}

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

  // Card-unanimous CTP claim: same identity as scoring. Worker checks the CTP exists on this event;
  // the DO records votes and only promotes a leader when every player on that card agrees.
  if (method === "POST" && sub === "ctp") {
    const body = (await readJson(request)) ?? {};
    const id = await scoreIdentity(request, env, body);
    if (!id.authMember) return json({ error: "unauthorized" }, 401, origin);
    if (await kvRateLimited(env, "live:" + id.authMember, LIVE_SCORE_IP_LIMIT, 60)) return json({ error: "rate_limited" }, 429, origin);
    const ctpId = asInt(body.ctpId);
    if (ctpId == null) return json({ error: "invalid_ctp" }, 400, origin);
    const ctps = (await db.listCtps(env.DB, eid)) as { id?: number; hole?: number; division?: string | null }[];
    const ctp = ctps.find((row) => Number(row.id) === ctpId);
    if (!ctp) return json({ error: "not_found" }, 404, origin);
    const r = await stub.fetch("https://do/ctp", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        ctpId,
        hole: asInt(ctp.hole) ?? body.hole,
        division: ctp.division ?? null,
      }),
      headers: { "X-Auth-Member": id.authMember, "X-Auth-Admin": String(id.authAdmin) },
    });
    return json(await r.json().catch(() => ({})), r.status, origin);
  }

  // Logged-in members on the card may share GPS so watchers see initials on hole maps.
  if (method === "POST" && sub === "location") {
    const body = (await readJson(request)) ?? {};
    const id = await scoreIdentity(request, env, body);
    if (!id.authMember) return json({ error: "unauthorized" }, 401, origin);
    if (await kvRateLimited(env, "live-loc:" + id.authMember, LIVE_LOCATION_LIMIT, 60)) return json({ error: "rate_limited" }, 429, origin);
    const r = await stub.fetch("https://do/location", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "X-Auth-Member": id.authMember },
    });
    return json(await r.json().catch(() => ({})), r.status, origin);
  }

  // Round control stays admin-only: start, finalize, cancel, and the round-scoped hole override.
  if (method === "POST" && (sub === "start" || sub === "finalize" || sub === "cancel" || sub === "override")) {
    const gate = await adminGate(request, env, origin);
    if (gate instanceof Response) return gate;

    // Cancel a mis-started round: reset the DO and return the event to "scheduled" so it can be re-started.
    if (sub === "cancel") {
      const r = await stub.fetch("https://do/cancel", { method: "POST", headers: { "X-Auth-Admin": "true" } });
      const data = await r.json().catch(() => ({}));
      if (r.status === 200) await db.updateEvent(env.DB, eid, { status: "scheduled" });
      return json(data, r.status, origin);
    }

    if (sub === "start") {
      const startBody = (await readJson(request)) ?? {};
      return startLiveEvent(env, origin, eid, startBody);
    }
    const body = (await readJson(request)) ?? {};
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
