// LiveEventDO — one Durable Object per in-progress event. Holds the live scorecard (layout pars +
// players + per-hole strokes) in DO storage, accepts score submissions, pushes leaderboard updates to
// WebSocket viewers, and on finalize writes results to D1 and marks the event final.
//
// Auth is enforced by the Worker BEFORE forwarding here (start/score/finalize are admin-gated; the
// snapshot + ws reads are public). The DO trusts requests it receives.

import { holeMarker } from "./db-courses.js";
import { normalizeScorecards, playerScorerId, purgeScorerVotes, purgeScoreTargetScorerVotes, recordScoreTargetVote } from "./live-consensus.js";
import { canCastCtpVote, dropLiveCtp, recordCtpVote, type LiveCtpStore } from "./live-ctp.js";
import { isLiveFormatError, normalizeLiveScoringConfig, normalizePairLabel, type LiveScoringConfig } from "./live-format.js";
import { finalizeLiveEvent } from "./live-finalize.js";
import { isLoggedInMemberId, locationMoved, locationOnCourse, locationsFromRecord, locationsToRecord, parseLocationBody, type LivePlayerLocation } from "./live-locations.js";
import { normalizeMapMarkKind } from "./course-map-marks.js";
import { sanitizeDiscColor } from "./disc-color-routes.js";
import { sanitizeProfilePhoto } from "./profile-photo.js";
import { parseThrowsBody } from "./play-stats.js";
import { replacePlayerHoleMarks } from "./db-hole-shot-marks.js";
import { shotRoundKey } from "./hole-shot-marks.js";
import { updateLivePairs } from "./live-pairs.js";
import { mineData, publicSnapshot } from "./live-snapshot.js";
import { attestationForCard, canEnterScorecard, cardKey, findPlayer, invalidScoreTargetsResponse, isCardLocked, issuesForCard, scoreTargetForBody, scorecardIssues, scoringState, targetAnchor } from "./live-state.js";
import { j, type CtpVoteBody, type LiveEnv, type LiveMeta, type LiveState, type OverrideBody, type PairAssignmentBody, type RemoveBody, type ScoreBody, type StartBody, type WeatherBody } from "./live-types.js";
import { assignCards, type PlayerState } from "./scoring.js";
import { createWeatherState, refreshWeatherState, WEATHER_REFRESH_MS } from "./weather.js";

// Stop the background weather alarm for a round "live" longer than this — a safety bound so an abandoned
// (started, never finalized) round can't keep polling Open-Meteo indefinitely.
const WEATHER_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export class LiveEventDO {
  private state: LiveState;
  private env: LiveEnv;
  private loaded = false;
  private meta: LiveMeta | null = null;
  private players: PlayerState[] = [];
  private liveCtps: LiveCtpStore = {};
  private locations = new Map<number, LivePlayerLocation>();

  constructor(state: LiveState, env: LiveEnv) {
    this.state = state;
    this.env = env;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.meta = (await this.state.storage.get<LiveMeta>("meta")) ?? null;
    this.players = (await this.state.storage.get<PlayerState[]>("players")) ?? [];
    this.liveCtps = (await this.state.storage.get<LiveCtpStore>("liveCtps")) ?? {};
    this.locations = locationsFromRecord(await this.state.storage.get("locations"));
    normalizeScorecards(this.players, this.meta?.holes ?? []);
    this.loaded = true;
  }
  private async persist(): Promise<void> {
    if (this.meta) this.meta.rev = (this.meta.rev ?? 0) + 1; // one bump per mutation (persist is the mutation marker)
    await this.state.storage.put("meta", this.meta);
    await this.state.storage.put("players", this.players);
    await this.state.storage.put("liveCtps", this.liveCtps);
  }

  private async persistLocations(): Promise<void> {
    await this.state.storage.put("locations", locationsToRecord(this.locations));
  }

  /** Fetch latest weather and fold into meta WITHOUT persisting — the caller persists once. */
  private async refreshWeatherNow(): Promise<void> {
    if (this.meta?.weather) this.meta.weather = await refreshWeatherState(this.meta.weather);
  }
  /** Ensure a weather-refresh alarm is scheduled for a live, weather-tracked round (idempotent — never stacks). */
  private async scheduleWeatherAlarm(): Promise<void> {
    if (this.meta?.status !== "live" || !this.meta.weather) return;
    if ((await this.state.storage.getAlarm()) == null) await this.state.storage.setAlarm(Date.now() + WEATHER_REFRESH_MS);
  }
  /** DO alarm handler (Cloudflare invokes by name): refresh weather + reschedule while live; clear the
   *  alarm once the round is final/none or past the max-age bound. */
  async alarm(): Promise<void> {
    await this.load();
    const startedMs = Date.parse(this.meta?.startedAt ?? "");
    const stale = Number.isFinite(startedMs) && Date.now() - startedMs > WEATHER_MAX_AGE_MS;
    if (this.meta?.status !== "live" || !this.meta.weather || stale) {
      await this.state.storage.deleteAlarm();
      return;
    }
    // The alarm MUST NOT throw: an uncaught error here retries + wedges the Durable Object, making every
    // subsequent request (score/cancel/finalize) fail with "internal error". Guard the refresh + broadcast,
    // and always reschedule while the round is live so a transient hiccup doesn't stop weather updates.
    try {
      this.meta.weather = await refreshWeatherState(this.meta.weather);
      // Persist WITHOUT bumping rev: a weather refresh is not a scoring change, so it must not force every
      // scorekeeper's client to re-render the scorecard (which would reset scroll + any open dropdown). The
      // snapshot keeps its current rev; clients apply the new weather in-place off this same-rev broadcast.
      await this.state.storage.put("meta", this.meta);
      this.broadcast();
    } catch (error) {
      console.error(JSON.stringify({ message: "weather_alarm_failed", eventId: this.meta?.eventId ?? null, error: error instanceof Error ? error.message : String(error) }));
    }
    await this.state.storage.setAlarm(Date.now() + WEATHER_REFRESH_MS);
  }
  /** One-time weather backfill for a live round that started before it had a location (or before weather
   *  tracking existed): record the location, take an initial reading, and start the refresh alarm. */
  private async ensureWeather(b: WeatherBody): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    if (!this.meta.weather && b.weatherLocation) {
      this.meta.weather = createWeatherState(b.weatherLocation);
      await this.refreshWeatherNow();
      await this.persist();
      await this.scheduleWeatherAlarm();
      this.broadcast();
      return j(this.snapshot());
    }
    await this.scheduleWeatherAlarm();
    return j(this.snapshot());
  }

  async fetch(request: Request): Promise<Response> {
    await this.load();
    const action = new URL(request.url).pathname.split("/").filter(Boolean).pop();
    // Identity is set by the Worker AFTER it authenticates the caller — the DO trusts these headers and
    // never reads identity from the request body for authorization (the body is spoofable).
    const authMember = request.headers.get("X-Auth-Member");
    const authAdmin = request.headers.get("X-Auth-Admin") === "true";
    if (action === "ws") return this.handleWs(request);
    if (action === "mine") return this.mine(authMember); // a player's own card (authed read)
    if (request.method === "GET") return j(this.snapshot()); // public leaderboard/scorecard (no identity)
    const body = await request.json().catch(() => ({}));
    if (action === "start") return this.start(body as StartBody);
    if (action === "score") return this.score(body as ScoreBody, authMember, authAdmin);
    if (action === "ctp") return this.claimCtp(body as CtpVoteBody, authMember, authAdmin);
    if (action === "ctp-forget") return this.forgetCtp(body as { ctpId?: number }, authAdmin);
    if (action === "location") return this.pingLocation(body, authMember);
    if (action === "map-overlay") return this.overlayMap(body as { hole?: unknown; kind?: unknown; lat?: unknown; lng?: unknown }, authMember);
    if (action === "throws") return this.saveThrows(body, authMember, authAdmin);
    if (action === "join") return this.join(authMember, (body as { name?: string; photo?: unknown }).name, (body as { photo?: unknown }).photo);
    if (action === "guest") return this.addGuest(authMember, (body as { name?: string; team?: string }).name, (body as { team?: string }).team); // add a non-member to my card (+ pair label for doubles)
    if (action === "remove") return this.removePlayer(body as RemoveBody, authMember, authAdmin); // drop a player (accidental/left/no-show)
    if (action === "pairs") return this.updatePairs(body as PairAssignmentBody, authMember, authAdmin);
    if (action === "cancel") return this.cancel(authAdmin); // admin: scrap a mis-started round, reset to none
    if (action === "weather") return this.ensureWeather(body as WeatherBody); // one-time weather backfill
    if (action === "override") return this.override(body as OverrideBody);
    if (action === "finalize") return this.finalize(authMember, authAdmin, (body as { force?: boolean }).force === true);
    if (action === "finish-card") return this.finishCard(body as { playerIndex?: number }, authMember, authAdmin);
    return j({ error: "not_found" }, 404);
  }

  private snapshot() {
    return publicSnapshot(this.meta, this.players, this.liveCtps, this.locations);
  }

  private async start(b: StartBody): Promise<Response> {
    const holes = (Array.isArray(b.holes) ? b.holes : [])
      .filter((h) => h && typeof h.hole === "number" && typeof h.par === "number")
      .map((h) => ({ hole: h.hole, par: h.par, distance_ft: h.distance_ft ?? null, tee_sign_id: h.tee_sign_id ?? null, tee: holeMarker(h.tee), target: holeMarker(h.target) }));
    if (holes.length === 0 || (!b.eventId && !b.casual)) return j({ error: "invalid_start" }, 400);
    let roundConfig: LiveScoringConfig;
    try {
      roundConfig = normalizeLiveScoringConfig(b.liveScoringConfig);
    } catch (error) {
      if (isLiveFormatError(error)) return j({ error: "invalid_live_scoring_config", code: error.code, message: error.message }, 400);
      throw error;
    }
    this.meta = { eventId: b.eventId ?? 0, casual: !!b.casual, roundCode: b.roundCode ?? null, courseId: b.courseId ?? null, layoutId: b.layoutId ?? null, createdBy: b.createdBy ?? null, courseName: b.courseName ?? null, layoutName: b.layoutName ?? null, udiscCourseId: b.udiscCourseId ?? null, holes, status: "live", startedAt: b.startedAt ?? "", weather: createWeatherState(b.weatherLocation ?? null), roundConfig, overrides: {}, ctpBuyInRequired: b.ctpBuyInRequired === true };
    this.liveCtps = {};
    this.locations = new Map();
    this.players = (Array.isArray(b.players) ? b.players : []).map((p) => ({
      memberId: p.memberId ?? null,
      name: String(p.name ?? "Player"),
      division: p.division ?? null,
      team: p.team ?? p.pairLabel ?? null,
      startingHole: p.startingHole ?? null,
      cardId: p.cardId ?? null,
      ctpEligible: p.ctpEligible !== false,
      scores: {},
      scorecards: {},
      photo: sanitizeProfilePhoto(p.photo),
    }));
    assignCards(this.players, b.cardSize); // group into cards (by starting hole, else buckets of 4)
    await this.persist();
    // Take the FIRST weather reading OFF the round-start path: fire the alarm immediately rather than
    // blocking the start response on an Open-Meteo fetch. The alarm populates + broadcasts weather a moment
    // later, and then reschedules itself every 5 min for the life of the round.
    if (this.meta?.weather) await this.state.storage.setAlarm(Date.now());
    this.broadcast();
    return j(this.snapshot());
  }

  private findPlayer(b: ScoreBody): PlayerState | undefined {
    return findPlayer(b, this.players);
  }

  private async score(b: ScoreBody, authMember: string | null, authAdmin: boolean): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    const hole = Number(b.hole);
    if (!this.meta.holes.some((h) => h.hole === hole)) return j({ error: "bad_hole" }, 400);
    // JSON null withdraws the vote (hole goes unstarted if nobody else scored it). Narrow with
    // !== null: a `!clear &&` boolean does not narrow `number | null` for the 1–30 range check.
    const strokes = b.strokes === null ? null : Number(b.strokes);
    if (strokes !== null && (!Number.isInteger(strokes) || strokes < 1 || strokes > 30)) return j({ error: "bad_strokes" }, 400);
    const scoring = scoringState(this.meta, this.players);
    if (scoring.globalError) return invalidScoreTargetsResponse(scoring.globalError); // whole round unscorable (bad config)
    const target = scoreTargetForBody(b, this.players, scoring.targets);
    const anchor = target ? targetAnchor(this.players, target) : null;
    // Isolate a broken pair/card: block ONLY submissions touching a broken player (the target's anchor, else
    // the body player, else the scorer's own slot). A healthy pair keeps scoring even sharing a card — or a
    // single-card casual round — with a broken one.
    if (scoring.brokenPlayers.length) {
      const broken = new Set(scoring.brokenPlayers);
      const bodyPlayer = this.findPlayer(b);
      const touchedIndex = anchor
        ? anchor.index
        : bodyPlayer
          ? this.players.indexOf(bodyPlayer)
          : authMember
            ? this.players.findIndex((p) => p.memberId === authMember && !p.removed)
            : -1;
      if (touchedIndex >= 0 && broken.has(touchedIndex)) {
        const err = scoring.cardErrors.find((e) => e.playerIndexes.includes(touchedIndex)) ?? scoring.error;
        if (err) return invalidScoreTargetsResponse({ code: err.code, message: err.message });
      }
    }
    if (!target || !anchor) return j({ error: b.targetId ? "no_target" : "no_player" }, 404); // a removed player is no longer scorable
    if (!authAdmin && isCardLocked(this.meta.lockedCardIds, anchor.player.cardId)) return j({ error: "card_locked" }, 409);
    const meIndex = authMember ? this.players.findIndex((p) => p.memberId === authMember && !p.removed) : -1;
    const me = meIndex >= 0 ? this.players[meIndex] : undefined;
    // Authorize from the Worker-trusted identity ONLY: an admin may score anyone; otherwise the
    // submitter must be a player on the SAME card as the target. Body identity is for targeting, not auth.
    if (!authAdmin) {
      if (!me) return j({ error: "not_on_card" }, 403);
      if ((me.cardId ?? null) !== (anchor.player.cardId ?? null)) return j({ error: "wrong_card" }, 403);
    }
    if (b.scorerIndex != null && (!Number.isInteger(b.scorerIndex) || b.scorerIndex < 0)) return j({ error: "bad_scorer" }, 400);
    const scorerIndex = typeof b.scorerIndex === "number" ? b.scorerIndex : authAdmin ? anchor.index : meIndex;
    const scorer = this.players[scorerIndex];
    if (!scorer || scorer.removed) return j({ error: "bad_scorer" }, 400);
    if ((scorer.cardId ?? null) !== (anchor.player.cardId ?? null)) return j({ error: "scorer_wrong_card" }, 403);
    if (!authAdmin && !canEnterScorecard(scorer, authMember)) return j({ error: "wrong_scorer" }, 403);
    const scorerId = playerScorerId(scorerIndex);
    const conflict = recordScoreTargetVote({ players: this.players, target, scorerId, hole, strokes });
    if (!isCardLocked(this.meta.lockedCardIds, anchor.player.cardId) && this.meta.cardAttestations) {
      const key = cardKey(anchor.player.cardId);
      if (this.meta.cardAttestations[key]?.length) {
        const next = { ...this.meta.cardAttestations };
        delete next[key];
        this.meta.cardAttestations = next;
      }
    }
    await this.persist();
    if (conflict) {
      this.sendAll({ type: "conflict", ...conflict, from: conflict.values[0] ?? null, to: conflict.values[1] ?? null });
    }
    this.broadcast();
    return j(this.snapshot());
  }

  private mine(authMember: string | null): Response {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    return j(mineData(this.meta, this.players, authMember, this.liveCtps, this.locations));
  }

  /** Casual round: the authenticated caller joins (added once, on the single card "c0"). No-op if already in. */
  private async join(authMember: string | null, name?: string, photoRaw?: unknown): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "round_not_live" }, 409);
    if (!authMember) return j({ error: "unauthorized" }, 401);
    const photo = sanitizeProfilePhoto(photoRaw);
    const existing = this.players.find((p) => p.memberId === authMember);
    if (existing) {
      // Already a player: no-op — unless they were removed (accidental/left), in which case rejoining
      // reactivates the same slot (index stays stable) with a fresh, empty card.
      let changed = false;
      if (photo && existing.photo !== photo) {
        existing.photo = photo;
        changed = true;
      }
      if (existing.removed) {
        existing.removed = false;
        existing.name = String(name || existing.name).slice(0, 60);
        existing.scores = {};
        existing.scorecards = {};
        existing.scoredBy = {};
        changed = true;
      }
      if (changed) {
        await this.persist();
        this.broadcast();
      }
    } else {
      const cardId = this.meta.casual ? "c0" : (this.players[0]?.cardId ?? "c0");
      this.players.push({ memberId: authMember, name: String(name || "Player").slice(0, 60), division: null, startingHole: null, cardId, scores: {}, scorecards: {}, ctpEligible: this.meta.ctpBuyInRequired !== true, photo });
      await this.persist();
      this.broadcast();
    }
    return j(mineData(this.meta, this.players, authMember, this.liveCtps, this.locations));
  }

  /** Add a non-member guest to the caller's card (the caller must already be on the round). A pair label
   *  (team) may be supplied so a doubles walk-on is pairable immediately; it's stored as-is (the pairing
   *  is validated at scoring time once two players share a label), matching how start() records teams. */
  private async addGuest(authMember: string | null, name?: string, team?: string): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "round_not_live" }, 409);
    const me = authMember ? this.players.find((p) => p.memberId === authMember && !p.removed) : undefined;
    if (!me) return j({ error: "not_on_card" }, 403);
    if (isCardLocked(this.meta.lockedCardIds, me.cardId)) return j({ error: "card_locked" }, 409);
    const nm = String(name || "").trim();
    if (!nm) return j({ error: "name_required" }, 400);
    this.players.push({ memberId: null, name: nm.slice(0, 60), division: null, team: normalizePairLabel(team), startingHole: null, cardId: me.cardId ?? "c0", scores: {}, scorecards: {}, ctpEligible: this.meta.ctpBuyInRequired !== true });
    await this.persist();
    this.broadcast();
    return j(mineData(this.meta, this.players, authMember, this.liveCtps, this.locations));
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
      if (isCardLocked(this.meta.lockedCardIds, me.cardId)) return j({ error: "card_locked" }, 409);
    }
    // TOMBSTONE, don't splice: the array index is how live scorers target a player, and a casual round
    // has no WebSocket to resync other phones — splicing would shift every later index and silently
    // re-point their next score to the wrong player. Marking removed keeps indexes stable; the player is
    // filtered out of the card, snapshot, and standings, and their scores cleared so a rejoin starts fresh.
    target.removed = true;
    target.scores = {};
    target.scorecards = {};
    target.scoredBy = {};
    this.locations.delete(idx);
    const scoring = scoringState(this.meta, this.players);
    if (scoring.error) purgeScorerVotes(this.players, idx, this.meta.holes);
    else purgeScoreTargetScorerVotes(this.players, idx, this.meta.holes, scoring.targets); // drop this player's votes on cardmates + re-derive consensus, so a leaver can't pin a hole in permanent conflict
    await this.persist();
    this.broadcast();
    return j(mineData(this.meta, this.players, authMember, this.liveCtps, this.locations));
  }

  private async updatePairs(b: PairAssignmentBody, authMember: string | null, authAdmin: boolean): Promise<Response> {
    if (!authAdmin && authMember) {
      const me = this.players.find((p) => p.memberId === authMember && !p.removed);
      if (me && isCardLocked(this.meta?.lockedCardIds, me.cardId)) return j({ error: "card_locked" }, 409);
    }
    const result = updateLivePairs({ meta: this.meta, players: this.players, body: b, authMember, authAdmin });
    if (!result.ok) return j(result.body, result.status);
    if (result.changed) {
      this.players = result.players;
      await this.persist();
      this.broadcast();
    }
    return j(mineData(this.meta, this.players, authMember, this.liveCtps, this.locations));
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

  /** Admin: scrap the current round entirely (mis-started, wrong layout/format, etc.) and reset the DO to
   *  an empty "none" state. The Worker route separately returns the event to "scheduled" in D1. Refused
   *  once finalized — that round's results are already written, so it must not be silently reset. */
  private async cancel(authAdmin: boolean): Promise<Response> {
    if (!authAdmin) return j({ error: "forbidden" }, 403);
    if (this.meta?.status === "final") return j({ error: "round_already_final" }, 409);
    this.meta = null;
    this.players = [];
    this.liveCtps = {};
    this.locations = new Map();
    await this.persist();
    await this.state.storage.deleteAlarm(); // round reset — stop the background weather refresh
    this.broadcast(); // push the "none" snapshot so live viewers/scorekeepers see the round end
    return j(this.snapshot());
  }

  private async finalize(authMember: string | null, authAdmin: boolean, force = false): Promise<Response> {
    this.locations = new Map();
    return finalizeLiveEvent({
      meta: this.meta,
      players: this.players,
      liveCtps: this.liveCtps,
      env: this.env,
      authMember,
      authAdmin,
      force,
      persist: () => this.persist(),
      broadcast: () => this.broadcast(),
    });
  }

  /** Anyone on the card can lock it once every hole has a living consensus score. */
  private async finishCard(body: { playerIndex?: number }, authMember: string | null, authAdmin: boolean): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    const meIndex = authMember ? this.players.findIndex((player) => player.memberId === authMember && !player.removed) : -1;
    const me = meIndex >= 0 ? this.players[meIndex] : undefined;
    if (!me && !authAdmin) return j({ error: "not_on_card" }, 403);
    const requested = Number(body.playerIndex);
    const voterIndex = Number.isInteger(requested) ? requested : meIndex;
    const voter = voterIndex >= 0 ? this.players[voterIndex] : undefined;
    if (!voter || voter.removed) return j({ error: "no_player" }, 404);
    if (!authAdmin) {
      if (!me) return j({ error: "not_on_card" }, 403);
      if ((me.cardId ?? null) !== (voter.cardId ?? null)) return j({ error: "wrong_card" }, 403);
    }
    const cardId = voter.cardId ?? null;
    if (isCardLocked(this.meta.lockedCardIds, cardId)) return j(this.snapshot());
    const scoring = scoringState(this.meta, this.players);
    if (scoring.globalError) return invalidScoreTargetsResponse(scoring.globalError);
    const issues = issuesForCard(scorecardIssues(this.meta, this.players, this.meta.holes, scoring), cardId);
    if (issues.conflicts.length || issues.missing.length) {
      return j({ error: "scorecard_incomplete", conflicts: issues.conflicts, missing: issues.missing }, 409);
    }
    const key = cardKey(cardId);
    const votes = { ...(this.meta.cardAttestations || {}) };
    const agreed = new Set(votes[key] || []);
    agreed.add(voterIndex);
    votes[key] = [...agreed];
    this.meta.cardAttestations = votes;
    const attestation = attestationForCard(this.meta.cardAttestations, this.players, cardId);
    if (!attestation.complete) {
      await this.persist();
      this.broadcast();
      return j(this.snapshot());
    }
    if (this.meta.casual) return this.finalize(authMember, authAdmin, false);
    const locked = Array.isArray(this.meta.lockedCardIds) ? this.meta.lockedCardIds.slice() : [];
    if (!locked.includes(key)) locked.push(key);
    this.meta.lockedCardIds = locked;
    delete this.meta.cardAttestations[key];
    await this.persist();
    this.broadcast();
    return j(this.snapshot());
  }

  private async claimCtp(b: CtpVoteBody, authMember: string | null, authAdmin: boolean): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    if (this.meta.casual) return j({ error: "not_event_ctp" }, 409);
    const ctpId = Number(b.ctpId);
    const hole = Number(b.hole);
    const nomineeIndex = Number(b.nomineeIndex);
    if (!Number.isInteger(ctpId) || ctpId <= 0) return j({ error: "invalid_ctp" }, 400);
    if (!this.meta.holes.some((item) => item.hole === hole)) return j({ error: "bad_hole" }, 400);
    if (!Number.isInteger(nomineeIndex) || nomineeIndex < 0) return j({ error: "no_player" }, 400);

    const meIndex = authMember ? this.players.findIndex((player) => player.memberId === authMember && !player.removed) : -1;
    const me = meIndex >= 0 ? this.players[meIndex] : undefined;
    if (!authAdmin) {
      if (!me) return j({ error: "not_on_card" }, 403);
    }
    if (b.scorerIndex != null && (!Number.isInteger(b.scorerIndex) || b.scorerIndex < 0)) return j({ error: "bad_scorer" }, 400);
    const scorerIndex = typeof b.scorerIndex === "number" ? b.scorerIndex : authAdmin ? nomineeIndex : meIndex;
    const scorer = this.players[scorerIndex];
    if (!scorer || scorer.removed) return j({ error: "bad_scorer" }, 400);
    if (!authAdmin) {
      if ((me?.cardId ?? null) !== (scorer.cardId ?? null)) return j({ error: "wrong_card" }, 403);
      if (!canCastCtpVote(scorer, authMember, false)) return j({ error: "wrong_scorer" }, 403);
    }

    const result = recordCtpVote({
      store: this.liveCtps,
      players: this.players,
      ctp: { id: ctpId, hole, division: b.division ?? null },
      nomineeIndex,
      scorerIndex,
      now: new Date().toISOString(),
    });
    if (!result.ok) return j({ error: result.error }, result.status);
    this.liveCtps = result.store;
    await this.persist();
    this.broadcast();
    return j(this.snapshot());
  }

  private async forgetCtp(b: { ctpId?: number }, authAdmin: boolean): Promise<Response> {
    if (!authAdmin) return j({ error: "forbidden" }, 403);
    const ctpId = Number(b.ctpId);
    if (!Number.isInteger(ctpId) || ctpId <= 0) return j({ error: "invalid_ctp" }, 400);
    const next = dropLiveCtp(this.liveCtps, ctpId);
    if (next === this.liveCtps) return j(this.snapshot());
    this.liveCtps = next;
    await this.persist();
    this.broadcast();
    return j(this.snapshot());
  }

  private async overlayMap(body: { hole?: unknown; kind?: unknown; lat?: unknown; lng?: unknown }, authMember: string | null): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    if (!authMember) return j({ error: "unauthorized" }, 401);
    const onCard = this.players.some((player) => player.memberId === authMember && !player.removed);
    if (!onCard) return j({ error: "not_on_card" }, 403);
    const holeNum = Number(body.hole);
    const kind = normalizeMapMarkKind(body.kind);
    const parsed = parseLocationBody(body);
    if (!Number.isInteger(holeNum) || !kind || !parsed) return j({ error: "invalid_mark" }, 400);
    const hole = this.meta.holes.find((row) => row.hole === holeNum);
    if (!hole) return j({ error: "bad_hole" }, 400);
    const label = kind === "tee" ? (hole.tee?.label || "Tee") : (hole.target?.label || "Basket");
    const marker = holeMarker({ label, lat: parsed.lat, lng: parsed.lng });
    if (kind === "tee") hole.tee = marker;
    else hole.target = marker;
    await this.persist();
    this.broadcast();
    return j(this.snapshot());
  }

  private async pingLocation(body: unknown, authMember: string | null): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    if (!isLoggedInMemberId(authMember)) return j({ error: "members_only" }, 403);
    const parsed = parseLocationBody(body);
    if (!parsed) return j({ error: "bad_location" }, 400);
    if (!locationOnCourse(parsed.lat, parsed.lng, this.meta.holes)) return j({ error: "off_course" }, 400);
    const meIndex = this.players.findIndex((player) => player.memberId === authMember && !player.removed);
    if (meIndex < 0) return j({ error: "not_on_card" }, 403);
    const prev = this.locations.get(meIndex);
    this.locations.set(meIndex, { lat: parsed.lat, lng: parsed.lng, at: Date.now() });
    const me = this.players[meIndex];
    const photo = sanitizeProfilePhoto((body as { photo?: unknown }).photo);
    let photoChanged = false;
    if (me && photo && me.photo !== photo) {
      me.photo = photo;
      photoChanged = true;
    }
    if (photoChanged) await this.persist();
    else await this.persistLocations();
    if (photoChanged || locationMoved(prev, parsed)) this.broadcast();
    return j({ ok: true });
  }

  private async saveThrows(body: unknown, authMember: string | null, authAdmin: boolean): Promise<Response> {
    if (!this.meta || this.meta.status !== "live") return j({ error: "not_live" }, 409);
    const parsed = parseThrowsBody(body);
    if (!parsed) return j({ error: "bad_throws" }, 400);
    if (!this.meta.holes.some((hole) => hole.hole === parsed.hole)) return j({ error: "bad_hole" }, 400);
    const meIndex = authMember ? this.players.findIndex((player) => player.memberId === authMember && !player.removed) : -1;
    const me = meIndex >= 0 ? this.players[meIndex] : undefined;
    if (!me && !authAdmin) return j({ error: "not_on_card" }, 403);
    const requested = Number((body as { scorerIndex?: unknown }).scorerIndex);
    const index = Number.isInteger(requested) ? requested : meIndex;
    const player = index >= 0 ? this.players[index] : undefined;
    if (!player || player.removed) return j({ error: "no_player" }, 404);
    if (!authAdmin) {
      if (!me) return j({ error: "not_on_card" }, 403);
      if ((me.cardId ?? null) !== (player.cardId ?? null)) return j({ error: "wrong_card" }, 403);
      if (!canEnterScorecard(player, authMember) && index !== meIndex) return j({ error: "wrong_scorer" }, 403);
    }
    player.throws = { ...(player.throws || {}), [parsed.hole]: parsed.throws };
    player.throwAt = Date.now();
    const discColor = sanitizeDiscColor((body as { discColor?: unknown }).discColor);
    if (discColor) player.discColor = discColor;
    await this.persist();
    this.broadcast();
    void persistLiveThrows(this.env, this.meta, player.memberId, parsed.hole, parsed.throws);
    return j({ ok: true, hole: parsed.hole, throws: parsed.throws.length });
  }

  private handleWs(_request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    try { server.send(JSON.stringify({ type: "snapshot", ...this.snapshot() })); } catch { /* ignore */ }
    return new Response(null, { status: 101, webSocket: client });
  }

  private sendAll(obj: unknown): void {
    const msg = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch { /* ignore */ }
    }
  }
  private broadcast(): void {
    this.sendAll({ type: "snapshot", ...this.snapshot() });
  }
}

async function persistLiveThrows(
  env: LiveEnv,
  meta: LiveMeta,
  memberId: string | null | undefined,
  hole: number,
  throws: unknown,
): Promise<void> {
  const layoutId = Number(meta.layoutId);
  if (!Number.isInteger(layoutId) || layoutId <= 0) return;
  try {
    await replacePlayerHoleMarks(env.DB, {
      layoutId,
      hole,
      roundCode: shotRoundKey(meta.roundCode, meta.eventId),
      memberId: memberId || "",
      throws,
    });
  } catch {
    /* heatmap ingest never blocks scoring */
  }
}
