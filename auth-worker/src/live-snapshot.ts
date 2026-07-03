import type { ScoreConflict } from "./live-consensus.js";
import type { PlayerState } from "./scoring.js";
import { canEnterScorecard, computeRoundStandings, publicScoreTargets, resolvedHoles, scorecardIssues, scoringState } from "./live-state.js";
import type { LiveMeta } from "./live-types.js";

export function publicSnapshot(meta: LiveMeta | null, players: PlayerState[]) {
  const holes = resolvedHoles(meta);
  const scoring = scoringState(meta, players);
  const issues = scorecardIssues(meta, players, holes, scoring);
  const standings = scoring.error
    ? []
    : computeRoundStandings({ holes, players, config: scoring.config, targets: scoring.targets }).map((standing) => ({
        name: standing.name,
        division: standing.division,
        thru: standing.thru,
        total: standing.total,
        toPar: standing.toPar,
        targetId: standing.targetId,
        targetType: standing.targetType,
        playerIndexes: standing.playerIndexes,
        members: standing.members,
        scoringGroup: standing.scoringGroup ?? null,
        match: standing.match ?? null,
      }));
  return {
    status: meta?.status ?? "none",
    rev: meta?.rev ?? 0,
    eventId: meta?.eventId ?? null,
    roundConfig: scoring.config,
    scoreTargets: publicScoreTargets(players, scoring.targets),
    scoreTargetError: scoring.error,
    courseName: meta?.courseName ?? null,
    layoutName: meta?.layoutName ?? null,
    udiscCourseId: meta?.udiscCourseId ?? null,
    weather: meta?.weather ?? null,
    holes,
    players: players
      .map((player, index) => ({ player, index }))
      .filter((item) => !item.player.removed)
      .map(({ player, index }) => ({
        index,
        cardId: player.cardId ?? null,
        name: player.name,
        division: player.division ?? null,
        team: player.team ?? null,
        startingHole: player.startingHole ?? null,
        scores: player.scores,
        scorecards: player.scorecards ?? {},
      })),
    conflicts: issues.conflicts,
    missing: issues.missing,
    standings,
    updatedAt: meta?.startedAt ?? null,
  };
}

export function mineData(meta: LiveMeta | null, players: PlayerState[], authMember: string | null): Record<string, unknown> {
  const holes = resolvedHoles(meta);
  const scoring = scoringState(meta, players);
  const standings = scoring.error
    ? []
    : computeRoundStandings({ holes, players, config: scoring.config, targets: scoring.targets }).map((standing) => ({
        name: standing.name,
        division: standing.division,
        thru: standing.thru,
        total: standing.total,
        toPar: standing.toPar,
        targetId: standing.targetId,
        targetType: standing.targetType,
        playerIndexes: standing.playerIndexes,
        members: standing.members,
        scoringGroup: standing.scoringGroup ?? null,
        match: standing.match ?? null,
      }));
  const meRaw = authMember ? players.findIndex((player) => player.memberId === authMember) : -1;
  const foundPlayer = meRaw >= 0 ? players[meRaw] : undefined;
  const meIdx = foundPlayer && !foundPlayer.removed ? meRaw : -1;
  const base = {
    eventId: meta?.eventId ?? 0,
    casual: !!meta?.casual,
    roundConfig: scoring.config,
    scoreTargets: publicScoreTargets(players, scoring.targets),
    scoreTargetError: scoring.error,
    courseName: meta?.courseName ?? null,
    layoutName: meta?.layoutName ?? null,
    udiscCourseId: meta?.udiscCourseId ?? null,
    weather: meta?.weather ?? null,
    status: meta?.status ?? "none",
    holes,
    standings,
  };
  if (meIdx < 0) return { ...base, cardId: null, playerIndex: null, cardmates: [], conflicts: [], missing: [] };
  const me = players[meIdx];
  if (!me) return { ...base, cardId: null, playerIndex: null, cardmates: [], conflicts: [], missing: [] };
  const cardId = me.cardId ?? null;
  const cardmates = players
    .map((player, index) => ({ player, index }))
    .filter((item) => !item.player.removed && (item.player.cardId ?? null) === cardId)
    .map(({ player, index }) => ({
      index,
      cardId: player.cardId ?? null,
      name: player.name,
      division: player.division ?? null,
      team: player.team ?? null,
      startingHole: player.startingHole ?? null,
      scores: player.scores,
      scorecards: player.scorecards ?? {},
      isMe: index === meIdx,
      canEnterScorecard: canEnterScorecard(player, authMember),
    }));
  const issues = scorecardIssues(meta, players, holes, scoring);
  return {
    ...base,
    cardId,
    playerIndex: meIdx,
    cardmates,
    conflicts: issues.conflicts.filter((conflict: ScoreConflict) => conflict.cardId === cardId),
    missing: issues.missing.filter((missing) => missing.cardId === cardId),
  };
}
