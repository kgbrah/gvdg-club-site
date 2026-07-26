import type { LiveScoringConfig, ScoreTarget } from "./live-format.js";
import type { PlayerState } from "./scoring.js";
import { scoreTargetConflicts, scoreTargetConsensusIssues } from "./live-target-consensus.js";

export {
  purgeScoreTargetScorerVotes,
  recordScoreTargetVote,
  scoreTargetConflicts,
  scoreTargetConsensusIssues,
  type RecordScoreTargetVoteInput,
} from "./live-target-consensus.js";

export interface ScoreHole {
  hole: number;
}

export interface ScoreConflict {
  cardId: string | null;
  playerIndex: number;
  playerName: string;
  hole: number;
  values: number[];
  targetId?: string;
  targetType?: ScoreTarget["type"];
  playerIndexes?: number[];
}

export interface MissingScoreConsensus {
  cardId: string | null;
  playerIndex: number;
  playerName: string;
  hole: number;
  missing: number;
  required: number;
  targetId?: string;
  targetType?: ScoreTarget["type"];
  playerIndexes?: number[];
}

export interface ConsensusIssues {
  conflicts: ScoreConflict[];
  missing: MissingScoreConsensus[];
}

export interface RecordScoreVoteInput {
  players: PlayerState[];
  targetIndex: number;
  scorerId: string;
  hole: number;
  strokes: number;
}

export function playerScorerId(index: number): string {
  return "player:" + index;
}

export function normalizeScorecards(players: PlayerState[], holes: ScoreHole[]): void {
  const holeSet = new Set(holes.map((h) => h.hole));
  for (let index = 0; index < players.length; index++) {
    const player = players[index];
    if (!player || player.removed) continue;
    player.scores = player.scores ?? {};
    const scorecards = (player.scorecards ??= {});
    for (const [holeText, strokes] of Object.entries(player.scores)) {
      const hole = Number(holeText);
      if (!holeSet.has(hole) || typeof strokes !== "number") continue;
      const existing = scorecards[hole];
      if (existing && Object.keys(existing).length > 0) continue;
      // Seed a legacy (pre-consensus) score under a SINGLE non-active "legacy" marker — NOT one fabricated
      // vote per cardmate. activeVoteValues ignores a non-card-scorer id, so syncConsensusScore preserves
      // the displayed legacy score (via the 0-active-votes branch), and the FIRST real vote by any active
      // scorer becomes the consensus without colliding with phantom cardmate votes.
      scorecards[hole] = { legacy: strokes };
    }
    for (const hole of holeSet) syncConsensusScore(players, player, hole);
  }
}

export function recordScoreVote(input: RecordScoreVoteInput): ScoreConflict | null {
  const target = input.players[input.targetIndex];
  if (!target || target.removed) return null;
  target.scores = target.scores ?? {};
  const scorecards = (target.scorecards ??= {});
  const votes = (scorecards[input.hole] ??= {});
  votes[input.scorerId] = input.strokes;
  syncConsensusScore(input.players, target, input.hole);
  return scoreConflictFor(input.players, input.targetIndex, input.hole);
}

export function scoreConflicts(players: PlayerState[], holes: ScoreHole[], targets?: readonly ScoreTarget[]): ScoreConflict[] {
  if (targets) return scoreTargetConflicts(players, holes, targets);
  const conflicts: ScoreConflict[] = [];
  for (let index = 0; index < players.length; index++) {
    const player = players[index];
    if (!player || player.removed) continue;
    for (const hole of holes) {
      const conflict = scoreConflictFor(players, index, hole.hole);
      if (conflict) conflicts.push(conflict);
    }
  }
  return conflicts;
}

export function scorecardConsensusIssues(players: PlayerState[], holes: ScoreHole[], targets?: readonly ScoreTarget[], opts: { readonly casual?: boolean; readonly config?: LiveScoringConfig } = {}): ConsensusIssues {
  if (targets) return scoreTargetConsensusIssues(players, holes, targets, opts);
  const missing: MissingScoreConsensus[] = [];
  for (let index = 0; index < players.length; index++) {
    const player = players[index];
    if (!player || player.removed) continue;
    const requiredScorers = requiredScorerIds(players, player);
    if (requiredScorers.length === 0) continue;
    for (const hole of holes) {
      const votes = player.scorecards?.[hole.hole] ?? {};
      const missingCount = requiredScorers.filter((scorerId) => votes[scorerId] == null).length;
      if (missingCount === 0) continue;
      missing.push({
        cardId: player.cardId ?? null,
        playerIndex: index,
        playerName: player.name,
        hole: hole.hole,
        missing: missingCount,
        required: requiredScorers.length,
      });
    }
  }
  return { conflicts: scoreConflicts(players, holes), missing };
}

/** A round is ready to finalize when the whole card agrees: NO active-scorer conflicts AND every participating
 *  member scorekeeper has voted on every hole. Guests are optional unless their score conflicts. */
export function isScoreboardComplete(players: PlayerState[], holes: ScoreHole[], targets?: readonly ScoreTarget[]): boolean {
  const issues = scorecardConsensusIssues(players, holes, targets);
  return issues.conflicts.length === 0 && issues.missing.length === 0;
}

function scoreConflictFor(players: PlayerState[], playerIndex: number, hole: number): ScoreConflict | null {
  const player = players[playerIndex];
  if (!player || player.removed) return null;
  const values = activeVoteValues(players, player, hole);
  if (values.length <= 1) return null;
  return { cardId: player.cardId ?? null, playerIndex, playerName: player.name, hole, values };
}

function syncConsensusScore(players: PlayerState[], player: PlayerState, hole: number): void {
  const values = activeVoteValues(players, player, hole);
  if (values.length === 1) {
    const score = values[0];
    if (score != null) player.scores[hole] = score;
  } else if (values.length > 1) {
    delete player.scores[hole]; // genuine disagreement among active scorers → blank until reconciled
  }
  // values.length === 0: no active votes remain (e.g. the sole scorekeeper left, or a removed scorer's
  // vote was purged) — KEEP the last-known score so a departed scorer's entered scores aren't wiped and
  // the round still finalizes. A hole that was never scored simply stays unset.
}

/** Distinct stroke values among votes cast by scorers CURRENTLY ACTIVE on the card. Votes from removed
 *  players (or stale/unknown scorer ids no longer on the card) are ignored — so a departed scorer can't
 *  pin a hole in permanent conflict or block consensus, and this self-heals already-persisted data. */
function activeVoteValues(players: PlayerState[], target: PlayerState, hole: number): number[] {
  const active = new Set(cardScorerIds(players, target));
  const out: number[] = [];
  for (const [scorerId, strokes] of Object.entries(target.scorecards?.[hole] ?? {})) {
    if (active.has(scorerId) && typeof strokes === "number") out.push(strokes);
  }
  return uniqueSorted(out);
}

/** A player has left the card (tombstoned): drop the votes they cast on their cardmates and re-derive
 *  the consensus for each affected hole, so their stale vote can't keep a hole in permanent conflict and
 *  any now-agreed score is restored immediately. */
export function purgeScorerVotes(players: PlayerState[], removedIndex: number, holes: ScoreHole[]): void {
  const removedId = playerScorerId(removedIndex);
  for (const player of players) {
    if (!player || player.removed || !player.scorecards) continue;
    for (const hole of holes) {
      const votes = player.scorecards[hole.hole];
      if (votes && removedId in votes) {
        delete votes[removedId];
        syncConsensusScore(players, player, hole.hole);
      }
    }
  }
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function cardScorerIds(players: PlayerState[], target: PlayerState): string[] {
  const cardId = target.cardId ?? null;
  const ids: string[] = [];
  for (let index = 0; index < players.length; index++) {
    const player = players[index];
    if (!player || player.removed || (player.cardId ?? null) !== cardId) continue;
    ids.push(playerScorerId(index));
  }
  return ids;
}

/** Scorers required before a scorecard counts as complete: member players on the card who have kept any score.
 *  Before anyone starts scoring, fall back to all member cardmates so an empty card cannot be finalized. */
export function requiredScorerIds(players: PlayerState[], target: PlayerState): string[] {
  const voted = cardVotedScorerIds(players, target);
  const activeMembers = cardScorerIds(players, target).filter((scorerId) => isRequiredMemberScorer(players, scorerId));
  const participating = activeMembers.filter((scorerId) => voted.has(scorerId));
  return participating.length ? participating : activeMembers;
}

function cardVotedScorerIds(players: PlayerState[], target: PlayerState): Set<string> {
  const cardId = target.cardId ?? null;
  const active = new Set(cardScorerIds(players, target));
  const ids = new Set<string>();
  for (const player of players) {
    if (!player || player.removed || (player.cardId ?? null) !== cardId) continue;
    for (const votes of Object.values(player.scorecards ?? {})) {
      for (const scorerId of Object.keys(votes ?? {})) {
        if (active.has(scorerId)) ids.add(scorerId);
      }
    }
  }
  return ids;
}

function isRequiredMemberScorer(players: PlayerState[], scorerId: string): boolean {
  const index = scorerIndexFromId(scorerId);
  const player = index == null ? undefined : players[index];
  return Boolean(player && !player.removed && player.memberId && !player.memberId.startsWith("g_"));
}

function scorerIndexFromId(scorerId: string): number | null {
  if (!scorerId.startsWith("player:")) return null;
  const index = Number(scorerId.slice("player:".length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}
