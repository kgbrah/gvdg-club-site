import { scorecardConsensusIssues } from "./live-consensus.js";
import { isLiveFormatError, normalizeLiveScoringConfig, scoreTargetsForPlayers, validateCardTargetsForScoring, type LiveScoringConfig, type ScoreTarget } from "./live-format.js";
import { computeLiveStandings, finalizeLiveStandings, type FinalLiveStanding, type LiveStanding, type PlayerState } from "./scoring.js";
import { j, type LiveMeta, type PublicScoreTarget, type ResolvedHole, type ScoreBody, type ScoringState } from "./live-types.js";

export function canEnterScorecard(player: PlayerState, authMember: string | null): boolean {
  return !player.memberId || player.memberId === authMember || player.memberId.startsWith("g_");
}

export function resolvedHoles(meta: LiveMeta | null): ResolvedHole[] {
  const overrides = meta?.overrides ?? {};
  return (meta?.holes ?? []).map((hole) => {
    const override = overrides[String(hole.hole)];
    return {
      hole: hole.hole,
      par: override?.par ?? hole.par,
      distance_ft: override?.distance_ft ?? hole.distance_ft ?? null,
      tee_sign_id: hole.tee_sign_id ?? null,
      overridden: override != null,
    };
  });
}

export function roundConfig(meta: LiveMeta | null): LiveScoringConfig {
  return normalizeLiveScoringConfig(meta?.roundConfig);
}

export function scoringState(meta: LiveMeta | null, players: readonly PlayerState[]): ScoringState {
  const config = roundConfig(meta);
  try {
    const targets = scoreTargetsForPlayers(players, config);
    validateRoundTargetsForScoring(players, targets, config);
    return { config, targets, error: null };
  } catch (error) {
    if (isLiveFormatError(error)) return { config, targets: [], error: { code: error.code, message: error.message } };
    throw error;
  }
}

export function invalidScoreTargetsResponse(error: { readonly code: string; readonly message: string }): Response {
  return j({ error: "invalid_score_targets", code: error.code, message: error.message }, 400);
}

export function publicScoreTargets(players: readonly PlayerState[], targets: readonly ScoreTarget[]): PublicScoreTarget[] {
  return targets.map((target) => ({
    id: target.id,
    type: target.type,
    label: target.label,
    playerIndexes: [...target.playerIndexes],
    members: target.playerIndexes.map((index) => players[index]?.name ?? "Player"),
  }));
}

export function scoreTargetForBody(body: ScoreBody, players: readonly PlayerState[], targets: readonly ScoreTarget[]): ScoreTarget | null {
  if (body.targetId) return targets.find((target) => target.id === body.targetId) ?? null;
  const player = findPlayer(body, players);
  if (!player || player.removed) return null;
  const playerIndex = players.indexOf(player);
  return targets.find((target) => target.playerIndexes.includes(playerIndex)) ?? null;
}

export function targetAnchor(players: readonly PlayerState[], target: ScoreTarget): { readonly index: number; readonly player: PlayerState } | null {
  for (const index of target.playerIndexes) {
    const player = players[index];
    if (player && !player.removed) return { index, player };
  }
  return null;
}

export function findPlayer(body: Pick<ScoreBody, "memberId" | "index" | "name">, players: readonly PlayerState[]): PlayerState | undefined {
  if (body.memberId) return players.find((player) => player.memberId === body.memberId);
  if (typeof body.index === "number") return players[body.index];
  if (body.name) return players.find((player) => player.name === body.name);
  return undefined;
}

export function scorecardIssues(meta: LiveMeta | null, players: PlayerState[], holes: { hole: number }[], scoring: ScoringState) {
  return scoring.error ? { conflicts: [], missing: [] } : scorecardConsensusIssues(players, holes, scoring.targets, { casual: !!meta?.casual, config: scoring.config });
}

export function computeRoundStandings(input: {
  readonly holes: readonly { readonly hole: number; readonly par: number }[];
  readonly players: readonly PlayerState[];
  readonly config: LiveScoringConfig;
  readonly targets: readonly ScoreTarget[];
}): LiveStanding[] {
  if (input.config.scoringStyle === "stroke") return computeLiveStandings(input);
  return targetCardGroups(input.players, input.targets).flatMap((targets) => computeLiveStandings({ ...input, targets }));
}

export function finalizeRoundStandings(input: {
  readonly holes: readonly { readonly hole: number; readonly par: number }[];
  readonly players: readonly PlayerState[];
  readonly config: LiveScoringConfig;
  readonly targets: readonly ScoreTarget[];
}): FinalLiveStanding[] {
  if (input.config.scoringStyle === "stroke") return finalizeLiveStandings(input);
  return targetCardGroups(input.players, input.targets).flatMap((targets) => finalizeLiveStandings({ ...input, targets }));
}

function validateRoundTargetsForScoring(players: readonly PlayerState[], targets: readonly ScoreTarget[], config: LiveScoringConfig): void {
  if (config.scoringStyle === "stroke") return validateCardTargetsForScoring(targets, config);
  for (const cardTargets of targetCardGroups(players, targets)) validateCardTargetsForScoring(cardTargets, config);
}

function targetCardGroups(players: readonly PlayerState[], targets: readonly ScoreTarget[]): ScoreTarget[][] {
  const groups = new Map<string, ScoreTarget[]>();
  for (const target of targets) {
    const anchor = targetAnchor(players, target);
    if (!anchor) continue;
    const key = anchor.player.cardId ?? "card:null";
    const group = groups.get(key) ?? [];
    group.push(target);
    groups.set(key, group);
  }
  return [...groups.values()];
}
