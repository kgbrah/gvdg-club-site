import type { PlayerState } from "./scoring.js";

export interface ScoreHole {
  hole: number;
}

export interface ScoreConflict {
  cardId: string | null;
  playerIndex: number;
  playerName: string;
  hole: number;
  values: number[];
}

export interface MissingScoreConsensus {
  cardId: string | null;
  playerIndex: number;
  playerName: string;
  hole: number;
  missing: number;
  required: number;
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
      const seeded: Record<string, number> = {};
      const requiredScorers = cardScorerIds(players, player);
      const legacyScorer = player.scoredBy?.[hole] ?? null;
      const scorerIds = requiredScorers.length > 0 ? requiredScorers : legacyScorer ? [legacyScorer] : ["legacy"];
      for (const scorerId of scorerIds) seeded[scorerId] = strokes;
      scorecards[hole] = seeded;
    }
    for (const hole of holeSet) syncConsensusScore(player, hole);
  }
}

export function recordScoreVote(input: RecordScoreVoteInput): ScoreConflict | null {
  const target = input.players[input.targetIndex];
  if (!target) return null;
  target.scores = target.scores ?? {};
  const scorecards = (target.scorecards ??= {});
  const votes = (scorecards[input.hole] ??= {});
  votes[input.scorerId] = input.strokes;
  syncConsensusScore(target, input.hole);
  return scoreConflictFor(input.players, input.targetIndex, input.hole);
}

export function scoreConflicts(players: PlayerState[], holes: ScoreHole[]): ScoreConflict[] {
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

export function scorecardConsensusIssues(players: PlayerState[], holes: ScoreHole[]): ConsensusIssues {
  const missing: MissingScoreConsensus[] = [];
  for (let index = 0; index < players.length; index++) {
    const player = players[index];
    if (!player) continue;
    const requiredScorers = cardScorerIds(players, player);
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

function scoreConflictFor(players: PlayerState[], playerIndex: number, hole: number): ScoreConflict | null {
  const player = players[playerIndex];
  if (!player || player.removed) return null;
  const values = uniqueSorted(Object.values(player.scorecards?.[hole] ?? {}));
  if (values.length <= 1) return null;
  return { cardId: player.cardId ?? null, playerIndex, playerName: player.name, hole, values };
}

function syncConsensusScore(player: PlayerState, hole: number): void {
  const values = uniqueSorted(Object.values(player.scorecards?.[hole] ?? {}));
  const agreed = values[0];
  if (values.length === 1 && agreed != null) {
    player.scores[hole] = agreed;
  } else {
    delete player.scores[hole];
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
