import * as db from "./db.js";
import { scorecardConsensusIssues } from "./live-consensus.js";
import { finalizeStandings, type FinalLiveStanding, type PlayerState } from "./scoring.js";
import { finalizeRoundStandings, invalidScoreTargetsResponse, resolvedHoles, roundConfig, scoringState } from "./live-state.js";
import { j, metadataJson, type LiveEnv, type LiveMeta } from "./live-types.js";

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
  const issues = scorecardConsensusIssues(input.players, holes, scoring.targets);
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
