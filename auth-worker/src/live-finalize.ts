import * as db from "./db.js";
import { scorecardConsensusIssues } from "./live-consensus.js";
import { finalizeStandings, type FinalLiveStanding, type PlayerState } from "./scoring.js";
import { finalizeRoundStandings, invalidScoreTargetsResponse, resolvedHoles, roundConfig, scoringState } from "./live-state.js";
import { j, metadataJson, type LiveEnv, type LiveMeta } from "./live-types.js";
import { roundRatingForScoreWithWeather, solveSsa, type Propagator, type RatingMethod, type RatingStream } from "./rating-engine.js";
import { clearRoundRatingsForCasualRound, clearRoundRatingsForEvent, createRoundRating, findRatingAnchor, getLayoutRatingBaseline, upsertLayoutRatingBaseline, upsertPlayerRatingFromRounds } from "./rating-store.js";
import { ratingWeatherFromJson } from "./weather.js";

export type FinalizeLiveEventInput = {
  readonly meta: LiveMeta | null;
  readonly players: PlayerState[];
  readonly env: LiveEnv;
  readonly authMember: string | null;
  readonly authAdmin: boolean;
  readonly force: boolean;
  readonly persist: () => Promise<void>;
  readonly broadcast: () => void;
};

export async function finalizeLiveEvent(input: FinalizeLiveEventInput): Promise<Response> {
  const meta = input.meta;
  if (!meta) return j({ error: "not_started" }, 409);
  if (meta.casual && !input.authAdmin && !(input.authMember && input.players.some((player) => player.memberId === input.authMember && !player.removed))) {
    return j({ error: "not_on_card" }, 403);
  }
  if (meta.status === "final") {
    const scoring = scoringState(meta, input.players);
    const holes = resolvedHoles(meta);
    const standings = scoring.error ? finalizeStandings(holes, input.players) : finalizeRoundStandings({ holes, players: input.players, config: scoring.config, targets: scoring.targets });
    return j({ status: "final", standings });
  }
  const holes = resolvedHoles(meta);
  const scoring = scoringState(meta, input.players);
  if (scoring.error) return invalidScoreTargetsResponse(scoring.error);
  const issues = scorecardConsensusIssues(input.players, holes, scoring.targets, { casual: !!meta.casual });
  const incomplete = issues.conflicts.length > 0 || issues.missing.length > 0;
  if (incomplete && !(input.authAdmin && input.force)) {
    return j({ error: "scorecard_incomplete", conflicts: issues.conflicts, missing: issues.missing }, 409);
  }
  const forced = incomplete;
  meta.status = "final";
  const standings = finalizeRoundStandings({ holes, players: input.players, config: scoring.config, targets: scoring.targets });
  if (meta.casual || !meta.eventId) {
    if (meta.casual && meta.roundCode) {
      try {
        await persistCasualResults(input.env, meta, input.players, standings);
      } catch (error) {
        meta.status = "live";
        throw error;
      }
    }
    await input.persist();
    input.broadcast();
    await persistRatingsBestEffort(input.env, meta, standings); // ratings never gate the finalize
    return j({ status: "final", standings, forced });
  }
  try {
    await db.clearResults(input.env.DB, meta.eventId);
    await Promise.all(
      standings.map((standing) =>
        db.createResult(input.env.DB, {
          event_id: meta.eventId,
          member_id: standing.memberId,
          name: standing.name,
          place: standing.place,
          total: standing.total,
          to_par: standing.toPar,
          breakdown: JSON.stringify(standing.breakdown),
          scorecard: standing.holes.length ? JSON.stringify(standing.holes) : null,
          scoring_group: metadataJson(standing.scoringGroup),
          match_result: metadataJson(standing.matchResult),
        }),
      ),
    );
    await db.updateEvent(input.env.DB, meta.eventId, { status: "final" });
  } catch (error) {
    meta.status = "live";
    throw error;
  }
  await input.persist();
  input.broadcast();
  await persistRatingsBestEffort(input.env, meta, standings); // ratings never gate the finalize
  return j({ status: "final", standings, forced });
}

async function persistCasualResults(env: LiveEnv, meta: LiveMeta, players: PlayerState[], standings: FinalLiveStanding[]): Promise<void> {
  const holes = resolvedHoles(meta).map((hole) => ({ hole: hole.hole, par: hole.par, distance_ft: hole.distance_ft }));
  const config = roundConfig(meta);
  if (!meta.roundCode) throw new Error("casual_round_code_missing");
  await db.clearCasualRound(env.DB, meta.roundCode);
  const round = await db.createCasualRound(env.DB, {
    round_code: meta.roundCode,
    course_id: meta.courseId ?? null,
    layout_id: meta.layoutId ?? null,
    course_name: meta.courseName ?? null,
    layout_name: meta.layoutName ?? null,
    holes: JSON.stringify(holes),
    scoring_config: JSON.stringify(config),
    created_by: meta.createdBy ?? null,
    started_at: meta.startedAt || null,
  });
  const roundId = casualRoundId(round);
  if (roundId == null) throw new Error("casual_round_insert_failed");
  await Promise.all(
    standings.map((standing) =>
      db.createCasualResult(env.DB, {
        casual_round_id: roundId,
        member_id: standing.memberId,
        name: standing.name,
        division: standing.division,
        place: standing.place,
        total: standing.total,
        to_par: standing.toPar,
        breakdown: JSON.stringify(standing.breakdown),
        scorecard: standing.holes.length ? JSON.stringify(standing.holes) : null,
        scoring_group: metadataJson(standing.scoringGroup),
        match_result: metadataJson(standing.matchResult),
      }),
    ),
  );
}

function casualRoundId(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("id" in value)) return null;
  const id = value.id;
  return typeof id === "number" ? id : null;
}

/** Write round_ratings for a just-finalized round. BEST-EFFORT: any failure is logged, never thrown, so
 *  a rating glitch can never block or roll back a finalize (results are authoritative). NOTE: the daily
 *  ratings cron only RE-SOLVES existing round_ratings rows (it does not create them), so if this write
 *  fails the round stays unrated until finalize is run again (an admin force-finalize re-attempts it). */
async function persistRatingsBestEffort(env: LiveEnv, meta: LiveMeta, standings: FinalLiveStanding[]): Promise<void> {
  try {
    await persistRoundRatings(env, meta, standings);
  } catch (error) {
    console.error(JSON.stringify({ message: "round_ratings_persist_failed", eventId: meta.eventId, roundCode: meta.roundCode ?? null, error: error instanceof Error ? error.message : String(error) }));
  }
}

async function persistRoundRatings(env: LiveEnv, meta: LiveMeta, standings: FinalLiveStanding[]): Promise<void> {
  const stream: RatingStream = meta.casual ? "casual" : "competition";
  if (stream === "casual" && !meta.roundCode) return; // no durable key → nothing to attach ratings to
  const now = new Date().toISOString();
  const roundDate = meta.startedAt || now;
  const ranked = standings.filter((s) => s.place != null && s.memberId); // only completed, ranked, member rounds
  const ratingWeather = ratingWeatherFromJson(meta.weather ? JSON.stringify(meta.weather) : null);

  // Rating context: casual reads the per-layout SSA baseline; competition solves SSA from finishers' anchors.
  let context: { ssa: number; ppt: number; propagatorCount: number; ratingMethod: RatingMethod } | null = null;
  if (stream === "casual") {
    const baseline = await getLayoutRatingBaseline(env.DB, meta.layoutId ?? null);
    context = baseline ? { ssa: baseline.ssa, ppt: baseline.ppt, propagatorCount: baseline.propagatorCount, ratingMethod: "layout" } : null;
  } else {
    // Look up every finisher's anchor concurrently (local player_ratings; the cron later upgrades with PDGA).
    const anchors = await Promise.all(ranked.map((s) => findRatingAnchor(env.DB, { memberId: s.memberId })));
    const propagators: Propagator[] = [];
    ranked.forEach((s, i) => { if (anchors[i] != null) propagators.push({ score: s.total, rating: anchors[i] as number }); });
    const solved = solveSsa(propagators);
    context = solved ? { ssa: solved.ssa, ppt: solved.ppt, propagatorCount: solved.propagatorCount, ratingMethod: solved.status } : null;
  }

  // Idempotent replace: clear this round's prior ratings before rewriting (finalize can run again after a force).
  if (stream === "competition") await clearRoundRatingsForEvent(env.DB, meta.eventId);
  else if (meta.roundCode) await clearRoundRatingsForCasualRound(env.DB, meta.roundCode);

  await Promise.all(ranked.map((s) => {
    const rr = context ? roundRatingForScoreWithWeather({ score: s.total, ssa: context.ssa, ppt: context.ppt, weather: context.ratingMethod === "layout" ? ratingWeather : null }) : null;
    return createRoundRating(env.DB, {
      memberId: s.memberId as string,
      playerName: s.name,
      stream,
      eventId: stream === "competition" ? meta.eventId : null,
      casualRoundCode: stream === "casual" ? (meta.roundCode ?? null) : null,
      courseId: meta.courseId ?? null,
      layoutId: meta.layoutId ?? null,
      roundDate,
      total: s.total,
      toPar: s.toPar,
      roundRating: rr ? rr.roundRating : null,
      ssa: context ? context.ssa : null,
      ppt: context ? context.ppt : null,
      windGustMph: ratingWeather.windGustMph,
      weatherAdjustment: rr ? rr.weatherAdjustment : 0,
      propagatorCount: context ? context.propagatorCount : 0,
      ratingMethod: context ? context.ratingMethod : "unrated",
    });
  }));

  // Competition rounds refresh the per-layout SSA baseline that casual rounds lean on.
  if (stream === "competition" && context && meta.layoutId != null) {
    await upsertLayoutRatingBaseline(env.DB, { layoutId: meta.layoutId, eventId: meta.eventId, baseline: { ssa: context.ssa, ppt: context.ppt, propagatorCount: context.propagatorCount } });
  }

  // Roll each rated member's aggregate player_ratings row forward.
  const members = [...new Set(ranked.map((s) => s.memberId as string))];
  await Promise.all(members.map((memberId) => upsertPlayerRatingFromRounds(env.DB, { memberId, stream, now })));
}
