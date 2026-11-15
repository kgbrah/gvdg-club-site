import { playerScorerId, scoreTargetConflicts } from "./live-consensus.js";
import type { ScoreTarget } from "./live-format.js";
import { healthyTargets, isCardLocked, resolvedHoles, scoringState, targetAnchor } from "./live-state.js";
import { j, type LiveMeta } from "./live-types.js";
import type { PlayerState } from "./scoring.js";

export type WatchScope = Readonly<{ roundId: string; cardId: string | null; actorIndex: number }>;

export type WatchScoreOperation = Readonly<{
  sequence: number;
  targetId: string;
  binding: string;
  hole: number;
  previous: number | null;
  strokes: number | null;
}>;

export type WatchReceipts = ReadonlyArray<WatchScoreOperation>;
export type WatchWrite = Readonly<{ op: WatchScoreOperation; key: string; receipts: WatchReceipts }>;

export function watchActor(
  meta: LiveMeta | null,
  players: readonly PlayerState[],
  authMember: string | null,
  generation: string | null,
  scope?: WatchScope,
): WatchScope | Response {
  if (!meta || !generation || (scope && scope.roundId !== generation)) {
    return j({ error: scope ? "watch_round_changed" : "not_live" }, 409);
  }
  const actorIndex = authMember ? players.findIndex((player) => player.memberId === authMember && !player.removed) : -1;
  const player = players[actorIndex];
  if (!player) return j({ error: "not_on_card" }, 403);
  const cardId = player.cardId ?? null;
  if (scope && (scope.actorIndex !== actorIndex || scope.cardId !== cardId)) {
    return j({ error: "watch_card_changed" }, 409);
  }
  return { roundId: generation, cardId, actorIndex };
}

function watchTargetBinding(target: ScoreTarget): string {
  // A pair label can survive reassignment. Bind an offline score to the actual slots it was for.
  return target.playerIndexes.join(",");
}

export function readWatchCard(
  meta: LiveMeta | null,
  players: PlayerState[],
  authMember: string | null,
  generation: string | null,
  scope?: WatchScope,
  lastSequence = 0,
): Response {
  const actor = watchActor(meta, players, authMember, generation, scope);
  if (actor instanceof Response) return actor;
  if (!meta || (!scope && meta.status !== "live")) return j({ error: "not_live" }, 409);
  const locked = meta.status !== "live" || isCardLocked(meta.lockedCardIds, actor.cardId);
  if (!scope && locked) return j({ error: "card_locked" }, 409);
  const holes = resolvedHoles(meta);
  const scoring = scoringState(meta, players);
  const targets = healthyTargets(scoring).filter((target) => {
    const anchor = targetAnchor(players, target);
    return anchor && (anchor.player.cardId ?? null) === actor.cardId;
  });
  if (!targets.length && !scope) return j({ error: "invalid_score_targets" }, 409);
  const scorer = playerScorerId(actor.actorIndex);
  const conflicts = scoreTargetConflicts(players, holes, targets);
  return j({
    scope: actor,
    lastSequence,
    revision: meta.rev ?? 0,
    status: meta.status,
    locked: locked || !targets.length,
    courseName: meta.courseName ?? null,
    layoutName: meta.layoutName ?? null,
    startingHole: players[actor.actorIndex]?.startingHole ?? null,
    scoringStyle: scoring.config.scoringStyle,
    holes: holes.map(({ hole, par, distance_ft, target }) => ({
      hole, par, distanceFt: distance_ft,
      basket: target?.lat != null && target.lng != null ? { lat: target.lat, lng: target.lng } : null,
    })),
    targets: targets.map((target) => {
      const anchor = targetAnchor(players, target)!;
      const votes = Object.fromEntries(holes.flatMap(({ hole }) => {
        const vote = anchor.player.scorecards?.[hole]?.[scorer];
        return vote == null ? [] : [[hole, vote]];
      }));
      return {
        id: target.id,
        binding: watchTargetBinding(target),
        name: target.label,
        votes,
        scores: anchor.player.scores,
        conflicts: conflicts.filter((conflict) => conflict.targetId === target.id ||
          (target.type === "player" && conflict.playerIndex === anchor.index)).map((conflict) => conflict.hole),
      };
    }),
  });
}

function scoreValue(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30);
}

export function parseWatchScore(body: Record<string, unknown> | null): WatchScoreOperation | null {
  const { sequence, targetId, binding, hole, previous, strokes } = body ?? {};
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) return null;
  if (typeof targetId !== "string" || !targetId || targetId.length > 200) return null;
  if (typeof binding !== "string" || !/^\d+(,\d+)?$/.test(binding) || binding.length > 30) return null;
  if (typeof hole !== "number" || !Number.isInteger(hole) || hole < 1) return null;
  if (!scoreValue(previous) || !scoreValue(strokes)) return null;
  return { sequence, targetId, binding, hole, previous, strokes };
}

export function watchReceiptKey(roundId: string, deviceId: string): string {
  return `watch:receipts:${roundId}:${deviceId}`;
}

const RECEIPT_WINDOW = 64;

export function beginWatchScore(receipts: WatchReceipts, op: WatchScoreOperation): Response | null {
  const latest = receipts.at(-1)?.sequence ?? 0;
  if (op.sequence === latest + 1) return null;
  const prior = receipts.find((receipt) => receipt.sequence === op.sequence);
  if (prior) {
    const same = prior.targetId === op.targetId && prior.binding === op.binding && prior.hole === op.hole &&
      prior.previous === op.previous && prior.strokes === op.strokes;
    return same ? j({ sequence: op.sequence }) : j({ error: "watch_sequence_reused" }, 409);
  }
  return j({ error: "watch_sequence_out_of_order", lastSequence: latest }, 409);
}

export function addWatchReceipt(receipts: WatchReceipts, op: WatchScoreOperation): WatchReceipts {
  return [...receipts.slice(-(RECEIPT_WINDOW - 1)), op];
}

export function checkWatchScore(op: WatchScoreOperation, target: ScoreTarget, player: PlayerState, scorerId: string): Response | null {
  if (op.binding !== watchTargetBinding(target)) return j({ error: "watch_target_changed" }, 409);
  const previous = player.scorecards?.[op.hole]?.[scorerId] ?? null;
  return previous === op.previous ? null : j({ error: "watch_score_conflict", previous }, 409);
}
