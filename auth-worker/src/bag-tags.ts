// Bag tag ranking. Lower number is better. A tie keeps the tag that came
// in better (the smaller number). Only the tags on the card move.

export interface TagPlayer {
  readonly memberId: string;
  readonly name: string;
  readonly tagNumber: number;
  readonly score: number;
}

export interface TagAssignment {
  readonly memberId: string;
  readonly name: string;
  readonly tagNumber: number;
}

export interface TagChange {
  readonly memberId: string;
  readonly name: string;
  readonly fromTag: number;
  readonly toTag: number;
}

export type SettleResult =
  | { ok: true; assignments: TagAssignment[]; changes: TagChange[] }
  | { ok: false; error: "need_two" | "invalid_player" | "duplicate" };

export function settleBagTags(players: readonly TagPlayer[]): SettleResult {
  if (players.length < 2) return { ok: false, error: "need_two" };
  const ids = new Set<string>();
  const tags = new Set<number>();
  for (const player of players) {
    if (!player.memberId || !player.name) return { ok: false, error: "invalid_player" };
    if (!Number.isInteger(player.tagNumber) || player.tagNumber < 1) return { ok: false, error: "invalid_player" };
    if (!Number.isInteger(player.score)) return { ok: false, error: "invalid_player" };
    if (ids.has(player.memberId) || tags.has(player.tagNumber)) return { ok: false, error: "duplicate" };
    ids.add(player.memberId);
    tags.add(player.tagNumber);
  }
  const ranked = [...players].sort((a, b) => a.score - b.score || a.tagNumber - b.tagNumber);
  const pool = [...tags].sort((a, b) => a - b);
  const assignments: TagAssignment[] = [];
  for (let index = 0; index < ranked.length; index += 1) {
    const player = ranked[index];
    const tagNumber = pool[index];
    if (!player || tagNumber == null) return { ok: false, error: "invalid_player" };
    assignments.push({ memberId: player.memberId, name: player.name, tagNumber });
  }
  const changes = assignments.flatMap((assignment) => {
    const before = players.find((player) => player.memberId === assignment.memberId);
    if (!before || before.tagNumber === assignment.tagNumber) return [];
    return [{ memberId: assignment.memberId, name: assignment.name, fromTag: before.tagNumber, toTag: assignment.tagNumber }];
  });
  return { ok: true, assignments, changes };
}

export function settleSummary(kind: "settle" | "challenge", changes: readonly TagChange[]): string {
  if (!changes.length) {
    return kind === "challenge" ? "Challenge played. Tags stayed put." : "Card settled. Tags stayed put.";
  }
  const bits = [...changes]
    .sort((a, b) => a.toTag - b.toTag)
    .map((change) => `${change.name} #${change.fromTag} → #${change.toTag}`);
  return (kind === "challenge" ? "Challenge: " : "Card settled: ") + bits.join(", ");
}
