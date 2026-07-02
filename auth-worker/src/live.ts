// allow: SIZE_OK - cohesive Durable Object state machine; split only with dedicated replay/browser coverage.
// LiveEventDO — one Durable Object per in-progress event. Holds the live scorecard (layout pars +
// players + per-hole strokes) in DO storage, accepts score submissions, pushes leaderboard updates to
// WebSocket viewers, and on finalize writes results to D1 and marks the event final.
//
// Auth is enforced by the Worker BEFORE forwarding here (start/score/finalize are admin-gated; the
// snapshot + ws reads are public). The DO trusts requests it receives.

import * as db from "./db.js";
import { persistFinalizedRound } from "./live-finalize.js";
import { normalizeScorecards, playerScorerId, purgeScorerVotes, recordScoreVote, scorecardConsensusIssues } from "./live-consensus.js";
import { assignCards, computeLeaderboard, finalizeStandings, type PlayerState } from "./scoring.js";
import { createWeatherState, refreshWeatherState, weatherRefreshDue, type WeatherLocation, type WeatherState } from "./weather.js";

interface LiveEnv {
  DB: db.D1Like;
}
interface LiveState {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
  acceptWebSocket(socket: WebSocket): void;
  getWebSockets(): WebSocket[];
}
interface LiveMeta {
  eventId: number;
  casual?: boolean; // self-organizing casual round (no admin event); finalize writes casual_rounds/casual_results (not event results)
  roundCode?: string | null; // casual share code (the DO name suffix) — the durable key for casual_rounds
  courseId?: number | null; // casual: the layout's course + layout ids, kept so ratings can compute a per-layout SSA
  layoutId?: number | null;
  createdBy?: string | null; // casual: member id that started the round
  courseName?: string | null; // display-only: course + layout shown in the scorecard header
  layoutName?: string | null;
  udiscCourseId?: string | null; // UDisc numeric course id for the "Add to UDisc" applink (export bridge)
  holes: { hole: number; par: number; distance_ft?: number | null; tee_sign_id?: number | null }[];
  status: "none" | "live" | "final";
  startedAt: string;
  weather?: WeatherState | null;
  rev?: number; // monotonic revision, bumped on every mutation so clients can drop out-of-order snapshots
  // Single-use, ROUND-SCOPED hole overrides (e.g. short baskets today). They live only here, in the
  // live round — the course layout is never touched, so the hole reverts to its verified value after
  // the round. Keyed by hole number (string for JSON safety).
  overrides?: Record<string, { par?: number; distance_ft?: number }>;
}
interface StartBody {
  eventId?: number;
  casual?: boolean;
  roundCode?: string | null;
  courseId?: number | null;
  layoutId?: number | null;
  createdBy?: string | null;
  courseName?: string | null;
  layoutName?: string | null;
  udiscCourseId?: string | null;
  holes: { hole: number; par: number; distance_ft?: number | null; tee_sign_id?: number | null }[];
  players: { memberId?: string | null; name: string; division?: string | null; startingHole?: number | null; cardId?: string | null; ratingAnchor?: number | null }[];
  startedAt?: string;
  cardSize?: number;
  weatherLocation?: WeatherLocation | null;
}
interface ScoreBody {
  memberId?: string | null;
  index?: number;
  name?: string;
  scorerIndex?: number | null;
  hole: number;
  strokes: number;
}
interface OverrideBody {
  hole: number;
  par?: number | null;
  distance_ft?: number | null;
  clear?: boolean;
}
interface WeatherBody {
  weatherLocation?: WeatherLocation | null;
}
interface RemoveBody {
  memberId?: string | null;
  index?: number;
  name?: string;
}

const j = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function canEnterScorecard(player: PlayerState, authMember: string | null): boolean {
  return !player.memberId || player.memberId === authMember || player.memberId.startsWith("g_");
}
function finiteRatingAnchor(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class LiveEventDO {
  private state: LiveState;
  private env: LiveEnv;
  private loaded = false;
  private meta: LiveMeta | null = null;
  private players: PlayerState[] = [];

  constructor(state: LiveState, env: LiveEnv) {
    this.state = state;
    this.env = env;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.meta = (await this.state.storage.get<LiveMeta>("meta")) ?? null;
    this.players = (await this.state.storage.get<PlayerState[]>("players")) ?? [];
    normalizeScorecards(this.players, this.meta?.holes ?? []);
    this.loaded = true;
  }
  private async persist(): Promise<void> {
    if (this.meta) this.meta.rev = (this.meta.rev ?? 0) + 1; // one bump per mutation (persist is the mutation marker)
    await this.state.storage.put("meta", this.meta);
    await this.state.storage.put("players", this.players);
  }
  private async refreshWeatherIfDue(force = false): Promise<void> {
    const meta = this.meta;
    if (!meta?.weather) return;
    if (!force && !weatherRefreshDue(meta.weather)) return;
    meta.weather = await refreshWeatherState(meta.weather);
    await this.persist();
  }

  async fetch(request: Request): Promise<Response> {
    await this.load();
    const action = new URL(request.url).pathname.split("/").filter(Boolean).pop();
    // Identity is set by the Worker AFTER it authenticates the caller — the DO trusts these headers and
    // never reads identity from the request body for authorization (the body is spoofable).
    const authMember = request.headers.get("X-Auth-Member");
    const authAdmin = request.headers.get("X-Auth-Admin") === "true";
    if (action === "ws") {
      await this.refreshWeatherIfDue();
      return this.handleWs(request);
    }
    if (action === "mine") {
      await this.refreshWeatherIfDue();
      return this.mine(authMember); // a player's own card (authed read)
    }
    if (request.method === "GET") {
      await this.refreshWeatherIfDue();
      return j(this.snapshot()); // public leaderboard/scorecard (no identity)
    }
    const body = await request.json().catch(() => ({}));
    if (action === "start") return this.start(body as StartBody);
    if (action === "cancel") return this.cancel(authAdmin);
    if (action === "score") return this.score(body as ScoreBody, authMember, authAdmin);
    if (action === "join") return this.join(authMember, body as { name?: string; ratingAnchor?: number | null }); // casual round: caller joins
    if (action === "guest") return this.addGuest(authMember, (body as { name?: string }).name); // add a non-member to my card
    if (action === "remove") return this.removePlayer(body as RemoveBody, authMember, authAdmin); // drop a player (accidental/left/no-show)
    if (action === "weather") return this.ensureWeather(body as WeatherBody);
    if (action === "override") return this.override(body as OverrideBody);
    if (action === "finalize") return this.finalize(authMember, authAdmin, (body as { force?: boolean }).force === true);
    return j({ error: "not_found" }, 404);
  }

  /** meta.holes with any round-scoped overrides applied — the par the scorecard/leaderboard use, plus
   *  an optional temporary distance + an `overridden` flag for the tee-sign render. */
  private resolvedHoles(): { hole: number; par: number; distance_ft: number | null; tee_sign_id: number | null; overridden: boolean }[] {
    const ov = this.meta?.overrides ?? {};
    return (this.meta?.holes ?? []).map((h) => {
      const o = ov[String(h.hole)];
      return { hole: h.hole, par: o?.par ?? h.par, distance_ft: o?.distance_ft ?? h.distance_ft ?? null, tee_sign_id: h.tee_sign_id ?? null, overridden: !!o };
    });
  }

  private snapshot() {
    if (!this.meta || this.meta.status === "none") {
      return {
        status: "none",
        rev: this.meta?.rev ?? 0,
        eventId: null,
        courseName: null,
        layoutName: null,
        udiscCourseId: null,
        weather: null,
        holes: [],
        players: [],
        conflicts: [],
        missing: [],
        standings: [],
        updatedAt: null,
      };
    }
    const holes = this.resolvedHoles();
    const issues = scorecardConsensusIssues(this.players, holes);
    return {
      status: this.meta?.status ?? "none",
      rev: this.meta?.rev ?? 0,
      eventId: this.meta?.eventId ?? null,
      courseName: this.meta?.courseName ?? null,
      layoutName: this.meta?.layoutName ?? null,
      udiscCourseId: this.meta?.udiscCourseId ?? null,
      weather: this.meta?.weather ?? null,
      holes, // {hole, par, distance_ft, overridden} — par/distance reflect any round override
      // players (with per-hole scores + their stable index) drive the scorekeeper grid;
      // standings drive the public leaderboard.
      // PUBLIC payload: identify players by their stable `index` and `cardId`. memberId is REDACTED here
      // because guest member ids are "g_<token>" capability tokens — never expose them to ws/snapshot
      // readers. The authed /mine endpoint is how a player learns which index/card is theirs. Removed
      // (tombstoned) players are filtered out, but each kept player retains its absolute array index.
      players: this.players
        .map((p, index) => ({ p, index }))
        .filter((x) => !x.p.removed)
        .map(({ p, index }) => ({ index, cardId: p.cardId ?? null, name: p.name, division: p.division ?? null, startingHole: p.startingHole ?? null, scores: p.scores, scorecards: p.scorecards ?? {} })),
      conflicts: issues.conflicts,
      // Holes where a required (member) scorer hasn't voted yet — drives the "what's blocking finalize"
      // panel. Safe to expose publicly: identifies players by stable index/name, never memberId.
      missing: issues.missing,
      standings: computeLeaderboard(holes, this.players).map((s) => ({ name: s.name, division: s.division, thru: s.thru, total: s.total, toPar: s.toPar })),
      updatedAt: this.meta?.startedAt ?? null,
    };
  }

  private async start(b: StartBody): Promise<Response> {
    if (this.meta?.status === "live") return j({ error: "round_already_live" }, 409);
    if (this.meta?.status === "final") return j({ error: "round_already_final" }, 409);
    const previousRev = this.meta?.rev ?? 0;
    const holes = (Array.isArray(b.holes) ? b.holes : [])
      .filter((h) => h && typeof h.hole === "number" && typeof h.par === "number")
      .map((h) => ({ hole: h.hole, par: h.par, distance_ft: h.distance_ft ?? null, tee_sign_id: h.tee_sign_id ?? null }));
    if (holes.length === 0 || (!b.eventId && !b.casual)) return j({ error: "invalid_start" }, 400);
    this.meta = {
      eventId: b.eventId ?? 0,
      casual: !!b.casual,
      roundCode: b.roundCode ?? null,
      courseId: b.courseId ?? null,
      layoutId: b.layoutId ?? null,
      createdBy: b.createdBy ?? null,
      courseName: b.courseName ?? null,
      layoutName: b.layoutName ?? null,
      udiscCourseId: b.udiscCourseId ?? null,
      holes,
      status: "live",
      startedAt: b.startedAt ?? "",
      weather: createWeatherState(b.weatherLocation ?? null),
      overrides: {},
      rev: previousRev,
    };
    this.players = (Array.isArray(b.players) ? b.players : []).map((p) => ({
      memberId: p.memberId ?? null,
      name: String(p.name ?? "Player"),
      division: p.division ?? null,
      startingHole: p.startingHole ?? null,
      cardId: p.cardId ?? null,
      ratingAnchor: finiteRatingAnchor(p.ratingAnchor),
      scores: {},
      scorecards: {},
    }));
    assignCards(this.players, b.cardSize); // group into cards (by starting hole, else buckets of 4)
    await this.refreshWeatherIfDue(true);
    await this.persist();
    this.broadcast();
    return j(this.snapshot());
  }

  private async cancel(authAdmin: boolean): Promise<Response> {
    if (!authAdmin) return j({ error: "forbidden" }, 403);
    if (this.meta?.status === "final") return j({ error: "round_already_final" }, 409);
    const previousRev = this.meta?.rev ?? 0;
    this.meta = {
      eventId: this.meta?.eventId ?? 0,
      casual: this.meta?.casual === true,
      roundCode: this.meta?.roundCode ?? null,
      courseId: this.meta?.courseId ?? null,
      layoutId: this.meta?.layoutId ?? null,
      createdBy: this.meta?.createdBy ?? null,
      courseName: null,
      layoutName: null,
      udiscCourseId: null,
      holes: [],
      status: "none",
      startedAt: "",
      weather: null,
      overrides: {},
      rev: previousRev,
    };
    this.players = [];
    await this.persist();
    this.broadcast();
    return j(this.snapshot());
  }

  private async ensureWeather(b: WeatherBody): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    if (!this.meta.weather && b.weatherLocation) {
      this.meta.weather = createWeatherState(b.weatherLocation);
      await this.refreshWeatherIfDue(true);
      this.broadcast();
      return j(this.snapshot());
    }
    await this.refreshWeatherIfDue();
    return j(this.snapshot());
  }

  private findPlayer(b: ScoreBody): PlayerState | undefined {
    if (b.memberId) return this.players.find((p) => p.memberId === b.memberId);
    if (typeof b.index === "number") return this.players[b.index];
    if (b.name) return this.players.find((p) => p.name === b.name);
    return undefined;
  }

  private async score(b: ScoreBody, authMember: string | null, authAdmin: boolean): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    const hole = Number(b.hole);
    const strokes = Number(b.strokes);
    if (!this.meta.holes.some((h) => h.hole === hole)) return j({ error: "bad_hole" }, 400);
    if (!Number.isInteger(strokes) || strokes < 1 || strokes > 30) return j({ error: "bad_strokes" }, 400);
    const player = this.findPlayer(b);
    if (!player || player.removed) return j({ error: "no_player" }, 404); // a removed player is no longer scorable
    const targetIndex = this.players.indexOf(player);
    const meIndex = authMember ? this.players.findIndex((p) => p.memberId === authMember && !p.removed) : -1;
    const me = meIndex >= 0 ? this.players[meIndex] : undefined;
    // Authorize from the Worker-trusted identity ONLY: an admin may score anyone; otherwise the
    // submitter must be a player on the SAME card as the target. Body identity is for targeting, not auth.
    if (!authAdmin) {
      if (!me) return j({ error: "not_on_card" }, 403);
      if ((me.cardId ?? null) !== (player.cardId ?? null)) return j({ error: "wrong_card" }, 403);
    }
    if (b.scorerIndex != null && (!Number.isInteger(b.scorerIndex) || b.scorerIndex < 0)) return j({ error: "bad_scorer" }, 400);
    const scorerIndex = typeof b.scorerIndex === "number" ? b.scorerIndex : authAdmin ? targetIndex : meIndex;
    const scorer = this.players[scorerIndex];
    if (!scorer || scorer.removed) return j({ error: "bad_scorer" }, 400);
    if ((scorer.cardId ?? null) !== (player.cardId ?? null)) return j({ error: "scorer_wrong_card" }, 403);
    if (!authAdmin && !canEnterScorecard(scorer, authMember)) return j({ error: "wrong_scorer" }, 403);
    const scorerId = playerScorerId(scorerIndex);
    const conflict = recordScoreVote({ players: this.players, targetIndex, scorerId, hole, strokes });
    await this.refreshWeatherIfDue();
    await this.persist();
    if (conflict) {
      this.sendAll({ type: "conflict", ...conflict, from: conflict.values[0] ?? null, to: conflict.values[1] ?? null });
    }
    this.broadcast();
    return j(this.snapshot());
  }

  /** The authenticated caller's own card: which player they are, their cardmates, and the holes — so the
   *  score app renders just their group. memberIds stay internal; cardmates are keyed by stable index. */
  private mineData(authMember: string | null): Record<string, unknown> {
    const holes = this.resolvedHoles();
    const meRaw = authMember ? this.players.findIndex((p) => p.memberId === authMember) : -1;
    const me = meRaw >= 0 ? this.players[meRaw] : undefined;
    const base = { eventId: this.meta?.eventId ?? 0, casual: !!this.meta?.casual, courseName: this.meta?.courseName ?? null, layoutName: this.meta?.layoutName ?? null, udiscCourseId: this.meta?.udiscCourseId ?? null, weather: this.meta?.weather ?? null, status: this.meta?.status ?? "none", holes };
    if (!me || me.removed) return { ...base, cardId: null, playerIndex: null, cardmates: [], conflicts: [], missing: [] };
    const meIdx = meRaw;
    const cardId = me.cardId ?? null;
    const cardmates = this.players
      .map((p, index) => ({ p, index }))
      .filter((x) => !x.p.removed && (x.p.cardId ?? null) === cardId)
      .map(({ p, index }) => ({
        index,
        cardId: p.cardId ?? null,
        name: p.name,
        division: p.division ?? null,
        startingHole: p.startingHole ?? null,
        scores: p.scores,
        scorecards: p.scorecards ?? {}, // per-scorer votes so the client can show/edit the caller's OWN vote during a conflict
        isMe: index === meIdx,
        canEnterScorecard: canEnterScorecard(p, authMember),
      }));
    const issues = scorecardConsensusIssues(this.players, holes);
    return {
      ...base,
      cardId,
      playerIndex: meIdx,
      cardmates,
      conflicts: issues.conflicts.filter((c) => c.cardId === cardId),
      missing: issues.missing.filter((m) => m.cardId === cardId),
    };
  }
  private mine(authMember: string | null): Response {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    return j(this.mineData(authMember));
  }

  /** Casual round: the authenticated caller joins (added once, on the single card "c0"). No-op if already in. */
  private async join(authMember: string | null, b?: { name?: string; ratingAnchor?: number | null }): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "round_not_live" }, 409);
    if (!authMember) return j({ error: "unauthorized" }, 401);
    const ratingAnchor = finiteRatingAnchor(b?.ratingAnchor);
    const existing = this.players.find((p) => p.memberId === authMember);
    if (existing) {
      // Already a player: no-op — unless they were removed (accidental/left), in which case rejoining
      // reactivates the same slot (index stays stable) with a fresh, empty card.
      if (existing.removed) {
        existing.removed = false;
        existing.name = String(b?.name || existing.name).slice(0, 60);
        existing.ratingAnchor = ratingAnchor;
        existing.scores = {};
        existing.scorecards = {};
        existing.scoredBy = {};
        await this.persist();
        this.broadcast();
      }
    } else {
      const cardId = this.meta.casual ? "c0" : (this.players[0]?.cardId ?? "c0");
      this.players.push({ memberId: authMember, name: String(b?.name || "Player").slice(0, 60), division: null, startingHole: null, cardId, ratingAnchor, scores: {}, scorecards: {} });
      await this.persist();
      this.broadcast();
    }
    return j(this.mineData(authMember));
  }

  /** Add a non-member guest to the caller's card (the caller must already be on the round). */
  private async addGuest(authMember: string | null, name?: string): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "round_not_live" }, 409);
    const me = authMember ? this.players.find((p) => p.memberId === authMember && !p.removed) : undefined;
    if (!me) return j({ error: "not_on_card" }, 403);
    const nm = String(name || "").trim();
    if (!nm) return j({ error: "name_required" }, 400);
    this.players.push({ memberId: null, name: nm.slice(0, 60), division: null, startingHole: null, cardId: me.cardId ?? "c0", scores: {}, scorecards: {} });
    await this.persist();
    this.broadcast();
    return j(this.mineData(authMember));
  }

  /** Remove a player from the card — a casual-round player who registered by accident, had to leave
   *  before the round ended, or no-showed. Authorized from the Worker-trusted identity ONLY (body
   *  identity is for targeting, never auth): an admin may remove anyone; otherwise the caller must be a
   *  member on the SAME card as the target, and may remove themselves. Targets by index, then memberId,
   *  then name; if a name is supplied it must still match the player now at that index, so a stale or
   *  shifted index can't drop the wrong person. Splicing re-indexes later players — every client
   *  re-renders from the returned card (the remover) or the broadcast snapshot. */
  private async removePlayer(b: RemoveBody, authMember: string | null, authAdmin: boolean): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    let idx = -1;
    if (typeof b.index === "number" && Number.isInteger(b.index)) idx = b.index;
    else if (b.memberId) idx = this.players.findIndex((p) => p.memberId === b.memberId);
    else if (b.name) idx = this.players.findIndex((p) => p.name === b.name);
    const target = idx >= 0 ? this.players[idx] : undefined;
    if (!target || target.removed) return j({ error: "no_player" }, 404);
    if (b.name != null && target.name !== b.name) return j({ error: "player_moved" }, 409); // stale index guard
    if (!authAdmin) {
      const me = authMember ? this.players.find((p) => p.memberId === authMember && !p.removed) : undefined;
      if (!me) return j({ error: "not_on_card" }, 403);
      if ((me.cardId ?? null) !== (target.cardId ?? null)) return j({ error: "wrong_card" }, 403);
    }
    // TOMBSTONE, don't splice: the array index is how live scorers target a player, and a casual round
    // has no WebSocket to resync other phones — splicing would shift every later index and silently
    // re-point their next score to the wrong player. Marking removed keeps indexes stable; the player is
    // filtered out of the card, snapshot, and standings, and their scores cleared so a rejoin starts fresh.
    target.removed = true;
    target.scores = {};
    target.scorecards = {};
    target.scoredBy = {};
    purgeScorerVotes(this.players, idx, this.meta.holes); // drop this player's votes on cardmates + re-derive consensus, so a leaver can't pin a hole in permanent conflict
    await this.persist();
    this.broadcast();
    return j(this.mineData(authMember));
  }

  // Round-scoped single-use override of a hole's par/distance. Admin-gated at the Worker. The layout
  // is never mutated, so the hole reverts to its verified value once this round ends.
  private async override(b: OverrideBody): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    const hole = Number(b.hole);
    if (!this.meta.holes.some((h) => h.hole === hole)) return j({ error: "bad_hole" }, 400);
    const overrides = this.meta.overrides ?? (this.meta.overrides = {});
    if (b.clear) {
      delete overrides[String(hole)];
    } else {
      const entry: { par?: number; distance_ft?: number } = {};
      const par = Number(b.par);
      const dist = Number(b.distance_ft);
      if (b.par != null && Number.isInteger(par) && par >= 1 && par <= 15) entry.par = par;
      if (b.distance_ft != null && Number.isFinite(dist) && dist >= 20 && dist <= 2000) entry.distance_ft = Math.round(dist);
      if (entry.par == null && entry.distance_ft == null) return j({ error: "empty_override" }, 400);
      overrides[String(hole)] = entry;
    }
    await this.persist();
    this.broadcast();
    return j(this.snapshot());
  }

  private async finalize(authMember: string | null, authAdmin: boolean, force = false): Promise<Response> {
    if (!this.meta || this.meta.status === "none") return j({ error: "not_started" }, 409);
    // Casual rounds are only member-gated at the route, so anyone with the code could otherwise finalize
    // (lock) someone else's round — require the caller to actually be on the card. Admin events bypass
    // (they're admin-gated at the route and meta.casual is false).
    if (this.meta.casual && !authAdmin && !(authMember && this.players.some((p) => p.memberId === authMember && !p.removed))) {
      return j({ error: "not_on_card" }, 403);
    }
    // Idempotent under a double-submit: claim finalization SYNCHRONOUSLY (before any await) so a second
    // finalize that interleaves at one of the awaits below sees status==='final' and short-circuits,
    // instead of racing clearResults + concurrent inserts into duplicate result rows.
    if (this.meta.status === "final") {
      return j({ status: "final", standings: finalizeStandings(this.resolvedHoles(), this.players), forced: false, weather: this.meta.weather ?? null });
    }
    const holes = this.resolvedHoles();
    // A round finalizes only when the whole card AGREES: no active-scorer conflicts AND every required
    // (member) cardmate has voted on every hole. Guests are optional (requiredScorerIds), but a guest's
    // differing vote still blocks as a conflict. An admin may FORCE past an incomplete board (e.g. a
    // cardmate left without matching, or a solo-scorekeeper card); leavers otherwise self-heal via
    // purgeScorerVotes. The blocking issues are returned so the client can show exactly what's missing.
    const issues = scorecardConsensusIssues(this.players, holes);
    const incomplete = issues.conflicts.length > 0 || issues.missing.length > 0;
    if (incomplete && !(authAdmin && force)) {
      return j({ error: "scorecard_incomplete", conflicts: issues.conflicts, missing: issues.missing }, 409);
    }
    await this.refreshWeatherIfDue(true);
    const forced = incomplete; // an admin pushed a not-fully-agreed card through
    this.meta.status = "final";
    const standings = finalizeStandings(holes, this.players);
    const weatherJson = this.meta.weather ? JSON.stringify(this.meta.weather) : null;
    try {
      await persistFinalizedRound({
        db: this.env.DB,
        meta: {
          eventId: this.meta.eventId,
          casual: this.meta.casual === true,
          roundCode: this.meta.roundCode ?? null,
          courseId: this.meta.courseId ?? null,
          layoutId: this.meta.layoutId ?? null,
          createdBy: this.meta.createdBy ?? null,
          courseName: this.meta.courseName ?? null,
          layoutName: this.meta.layoutName ?? null,
          startedAt: this.meta.startedAt,
          holesJson: JSON.stringify(holes.map((h) => ({ hole: h.hole, par: h.par, distance_ft: h.distance_ft }))),
          weatherJson,
        },
        standings,
        players: this.players,
      });
    } catch (e) {
      this.meta.status = "live"; // roll back the in-memory claim so the admin can retry finalize
      throw e;
    }
    await this.persist();
    this.broadcast();
    return j({ status: "final", standings, forced, weather: this.meta.weather ?? null });
  }

  private handleWs(_request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    try { server.send(JSON.stringify({ type: "snapshot", ...this.snapshot() })); } catch (error) { if (!(error instanceof Error || error instanceof DOMException)) throw error; }
    return new Response(null, { status: 101, webSocket: client });
  }

  private sendAll(obj: unknown): void {
    const msg = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch (error) { if (!(error instanceof Error || error instanceof DOMException)) throw error; }
    }
  }
  private broadcast(): void {
    this.sendAll({ type: "snapshot", ...this.snapshot() });
  }
}
