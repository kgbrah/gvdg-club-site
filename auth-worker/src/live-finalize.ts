import * as db from "./db.js";
import { scorecardConsensusIssues } from "./live-consensus.js";
import { ctpAwardWinners, type LiveCtpStore } from "./live-ctp.js";
import type { LiveScoringConfig } from "./live-format.js";
import { finalizeStandings, type FinalLiveStanding, type PlayerState } from "./scoring.js";
import { finalizeRoundStandings, healthyTargets, invalidScoreTargetsResponse, resolvedHoles, roundConfig, scoringState } from "./live-state.js";
import { j, metadataJson, type LiveEnv, type LiveMeta, type ResolvedHole, type ScoringState } from "./live-types.js";
import { liveRecoveryId } from "./live-recovery.js";
import { attachThrowsToScorecard } from "./live-snapshot.js";
import { repairRatingSource } from "./rating-repair.js";
import { queueRatingRepair } from "./rating-store.js";
import { mergePartnerPlayInputs, partnersForStanding, withPlayBreakdown } from "./play-stats.js";
import { ingestScorecardMarks } from "./db-hole-shot-marks.js";
import { shotRoundKey } from "./hole-shot-marks.js";
import { ratingWeatherFromJson } from "./weather.js";
import { archiveShotLedgerStmt, finalizedShotLedger, type ArchivedShotLedger, type ShotLedgerViews } from "./shot-ledgers.js";

export type FinalizeLiveEventInput = {
  readonly meta: LiveMeta | null;
  readonly players: PlayerState[];
  readonly liveCtps?: LiveCtpStore;
  readonly shotLedgers?: ShotLedgerViews;
  readonly env: LiveEnv;
  readonly authMember: string | null;
  readonly authAdmin: boolean;
  readonly force: boolean;
  readonly persist: () => Promise<void>;
  readonly broadcast: () => void;
  readonly onCommitted?: () => void;
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
    await persistRatingsBestEffort(input.env, meta);
    return j({ status: "final", standings: finalizeMixedStandings(holes, input.players, scoring) });
  }
  const holes = resolvedHoles(meta);
  const scoring = scoringState(meta, input.players);
  let standings: FinalLiveStanding[];
  let forced: boolean;
  if (scoring.globalError) {
    // The WHOLE round is unscorable (a corrupt round config). An admin may force past it onto per-player
    // STROKE standings for the whole field; everyone else gets the error so it can be repaired first.
    if (!(input.authAdmin && input.force)) return invalidScoreTargetsResponse(scoring.globalError);
    standings = finalizeStandings(holes, input.players);
    forced = true;
  } else if (scoring.cardErrors.length) {
    // One or more broken cards — e.g. a doubles/matchplay pair left with ONE active player after a partner
    // was removed. Non-admins / un-forced calls get the error so the card can be repaired (rejoin/withdraw).
    // An admin force finalizes HEALTHY cards in their REAL format and the broken card(s) as UNRANKED stroke
    // rows — so healthy standings are preserved instead of the whole field degrading to stroke.
    if (!(input.authAdmin && input.force)) {
      return j({ error: "invalid_score_targets", code: scoring.error?.code, message: scoring.error?.message, cardErrors: scoring.cardErrors }, 400);
    }
    standings = finalizeMixedStandings(holes, input.players, scoring);
    forced = true;
  } else {
    const issues = scorecardConsensusIssues(input.players, holes, scoring.targets, { casual: !!meta.casual, config: scoring.config });
    const incomplete = issues.conflicts.length > 0 || issues.missing.length > 0;
    if (incomplete && !(input.authAdmin && input.force)) {
      return j({ error: "scorecard_incomplete", conflicts: issues.conflicts, missing: issues.missing }, 409);
    }
    forced = incomplete;
    standings = finalizeRoundStandings({ holes, players: input.players, config: scoring.config, targets: scoring.targets });
  }
  const isPutting = scoring.config.scoringStyle === "putting";
  const shotArchives = new Map<string, Record<number, ArchivedShotLedger>>();
  standings = standings.map((standing) => {
    const merged = mergePartnerPlayInputs(partnersForStanding(standing, input.players));
    const explicit = !isPutting && input.shotLedgers ? finalizedShotLedger(input.shotLedgers, input.players, standing, meta, holes, merged.throws) : null;
    if (explicit && standing.memberId) shotArchives.set(standing.memberId, explicit.archive);
    return {
      ...standing,
      breakdown: isPutting ? standing.breakdown : (explicit ? { ...standing.breakdown, ...explicit.stats } : withPlayBreakdown(standing.breakdown, merged, holes)),
      holes: attachThrowsToScorecard(standing.holes, merged.throws),
    };
  });
  const layoutByHole = new Map(holes.map((hole) => [hole.hole, hole]));
  const scorecardForArchive = (standing: FinalLiveStanding) => {
    if (!standing.holes.length) return null;
    return JSON.stringify(standing.holes.map((score) => {
      const hole = layoutByHole.get(score.hole);
      if (!hole) return score;
      const throwsProvenance = standing.scoringGroup?.targetType === "pair" ? "team" : standing.memberId ? "member" : "unknown";
      return {
        ...score,
        layoutAtPlay: archivedLayoutHole(meta, hole),
        ...(scoreHasThrows(score) ? { throwsProvenance } : {}),
      };
    }));
  };
  meta.status = "final";
  if (meta.casual || !meta.eventId) {
    if (meta.casual && meta.roundCode) {
      try {
        await persistCasualResults(input.env, meta, standings, scorecardForArchive, shotArchives);
      } catch (error) {
        meta.status = "live";
        throw error;
      }
    }
    await input.onCommitted?.();
    await input.persist();
    input.broadcast();
    await persistRatingsBestEffort(input.env, meta); // ratings never gate the finalize
    void persistHeatmapMarksBestEffort(input.env, meta, standings);
    return j({ status: "final", standings, forced });
  }
  try {
    // Atomic: clear + all result rows in ONE D1 transaction, so a mid-write failure can't leave a partial
    // leaderboard (some players persisted, others not). Ratings below stay best-effort and never gate this.
    await db.runBatch(input.env.DB, [
      db.clearResultsStmt(input.env.DB, meta.eventId),
      ...standings.map((standing) =>
        db.createResultStmt(input.env.DB, {
          event_id: meta.eventId,
          member_id: standing.memberId,
          name: standing.name,
          place: standing.place,
          total: standing.total,
          to_par: standing.toPar,
          breakdown: JSON.stringify(standing.breakdown),
          scorecard: scorecardForArchive(standing),
          scoring_group: metadataJson(standing.scoringGroup),
          match_result: metadataJson(standing.matchResult),
        }),
      ),
      ...Array.from(shotArchives, ([memberId, archive]) => archiveShotLedgerStmt(input.env.DB, archive, memberId, { eventId: meta.eventId })),
      ...ctpAwardWinners(input.liveCtps ?? {}, input.players).map((winner) =>
        db.setCtpWinnerIfEmptyStmt(input.env.DB, winner.ctpId, meta.eventId, winner.memberId, winner.name),
      ),
      db.updateEventStatusStmt(input.env.DB, meta.eventId, "final"),
    ]);
  } catch (error) {
    meta.status = "live";
    throw error;
  }
  await input.onCommitted?.();
  await input.persist();
  input.broadcast();
  await persistRatingsBestEffort(input.env, meta); // ratings never gate the finalize
  void persistHeatmapMarksBestEffort(input.env, meta, standings);
  return j({ status: "final", standings, forced });
}

function scoreHasThrows(score: object) {
  return "throws" in score && Array.isArray(score.throws) && score.throws.length > 0;
}

function archivedLayoutHole(meta: LiveMeta, hole: ResolvedHole) {
  return {
    tee: hole.tee, target: hole.target, distance_ft: hole.distance_ft, overridden: hole.overridden,
    ...(meta.startedAt ? { roundStartedAt: meta.startedAt } : {}),
    ...(meta.courseId != null ? { courseId: meta.courseId } : {}),
    ...(meta.layoutId != null ? { layoutId: meta.layoutId } : {}),
    ...(meta.courseName ? { courseName: meta.courseName } : {}),
    ...(meta.layoutName ? { layoutName: meta.layoutName } : {}),
  };
}

/** Finalize a round that may mix healthy and broken cards. Healthy cards finalize in their REAL format
 *  (matchplay match_result / doubles teams); a broken card's players finalize as per-player STROKE rows
 *  written place=null (UNRANKED) — so they never collide on place with a healthy winner and, being unranked
 *  with no match_result, earn zero league place-points (computeLeagueStandings.placePoints). A whole-round
 *  globalError still finalizes the entire field as stroke (the pre-existing force fallback). */
function finalizeMixedStandings(holes: { hole: number; par: number }[], players: PlayerState[], scoring: ScoringState): FinalLiveStanding[] {
  if (scoring.globalError) return finalizeStandings(holes, players);
  if (scoring.cardErrors.length === 0) {
    return finalizeRoundStandings({ holes, players, config: scoring.config, targets: scoring.targets });
  }
  const healthy = healthyTargets(scoring);
  const healthyRows = finalizeRoundStandings({ holes, players, config: scoring.config, targets: healthy });
  // The broken pass is everyone the healthy pass did NOT cover — derived from the same targets, so every
  // non-removed player lands in EXACTLY one pass (no drop, no double-count even if a pair spans cards).
  const covered = new Set<number>();
  for (const target of healthy) for (const index of target.playerIndexes) covered.add(index);
  const brokenPlayers = players.filter((p, index) => !p.removed && !covered.has(index));
  const brokenRows = finalizeStandings(holes, brokenPlayers).map((row) => ({ ...row, place: null }));
  return [...healthyRows, ...brokenRows];
}

async function persistCasualResults(
  env: LiveEnv,
  meta: LiveMeta,
  standings: FinalLiveStanding[],
  scorecardForArchive: (standing: FinalLiveStanding) => string | null,
  shotArchives: ReadonlyMap<string, Record<number, ArchivedShotLedger>>,
): Promise<void> {
  const holes = resolvedHoles(meta).map((hole) => ({
    hole: hole.hole,
    par: hole.par,
    distance_ft: hole.distance_ft,
    layoutAtPlay: archivedLayoutHole(meta, hole),
    ...(hole.points != null && hole.points > 1 ? { points: hole.points } : {}),
  }));
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
    live_generation: liveRecoveryId(meta),
  });
  const roundId = casualRoundId(round);
  if (roundId == null) throw new Error("casual_round_insert_failed");
  // The round row must be inserted first (its id keys the results), then all result rows land atomically.
  try {
    await db.runBatch(
      env.DB,
      [...standings.map((standing) =>
        db.createCasualResultStmt(env.DB, {
          casual_round_id: roundId,
          member_id: standing.memberId,
          name: standing.name,
          division: standing.division,
          place: standing.place,
          total: standing.total,
          to_par: standing.toPar,
          breakdown: JSON.stringify(standing.breakdown),
          scorecard: scorecardForArchive(standing),
          scoring_group: metadataJson(standing.scoringGroup),
          match_result: metadataJson(standing.matchResult),
          live_player_index: standing.livePlayerIndex ?? null,
        }),
      ), ...Array.from(shotArchives, ([memberId, archive]) => archiveShotLedgerStmt(env.DB, archive, memberId, { casualRoundId: roundId }))],
    );
  } catch (error) {
    await db.clearCasualRound(env.DB, meta.roundCode).catch(() => {});
    throw error;
  }
}

function casualRoundId(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("id" in value)) return null;
  const id = value.id;
  return typeof id === "number" ? id : null;
}

async function persistHeatmapMarksBestEffort(
  env: LiveEnv,
  meta: LiveMeta,
  standings: FinalLiveStanding[],
): Promise<void> {
  const layoutId = Number(meta.layoutId);
  if (!Number.isInteger(layoutId) || layoutId <= 0) return;
  const roundCode = shotRoundKey(meta.roundCode, meta.eventId);
  try {
    for (const standing of standings) {
      await ingestScorecardMarks(env.DB, {
        layoutId,
        roundCode,
        memberId: standing.memberId || "",
        scorecard: standing.holes,
      });
    }
  } catch {
    /* heatmap ingest never blocks finalize */
  }
}

/** The authoritative result is already committed when we get here. A failed rating batch is safe to retry. */
async function persistRatingsBestEffort(env: LiveEnv, meta: LiveMeta): Promise<void> {
  if (!roundEarnsRatings(roundConfig(meta))) return;
  const stream = meta.casual ? "casual" : "competition";
  let sourceId = stream === "competition" ? meta.eventId : null;
  try {
    const weather = ratingWeatherFromJson(meta.weather ? JSON.stringify(meta.weather) : null);
    if (stream === "casual" && meta.roundCode) {
      const source = await env.DB.prepare("SELECT id FROM casual_rounds WHERE round_code = ?")
        .bind(meta.roundCode).first<{ id: number }>();
      sourceId = source?.id ?? null;
    }
    if (sourceId) await repairRatingSource(env.DB, stream, sourceId, weather.windGustMph);
  } catch (error) {
    if (sourceId) {
      try { await queueRatingRepair(env.DB, stream, sourceId); } catch { /* The durable result remains available to the next sweep. */ }
    }
    console.error(JSON.stringify({ message: "round_ratings_persist_failed", eventId: meta.eventId,
      roundCode: meta.roundCode ?? null, error: error instanceof Error ? error.message : String(error) }));
  }
}

/** PDGA-style round ratings are computed from an individual's own STROKE total, so only a singles stroke
 *  round earns them. Matchplay has no stroke rating; doubles partners share one team total (so a rating
 *  would enter a team score as each member's individual round). Both are excluded. */
export function roundEarnsRatings(config: LiveScoringConfig): boolean {
  return config.scoringStyle === "stroke" && config.groupFormat === "singles";
}
