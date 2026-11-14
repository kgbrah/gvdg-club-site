import type { PlayerState } from "./scoring.js";

export interface JoinRequest {
  id: string;
  memberId: string;
  name: string;
  photo: string | null;
  cardId: string;
}

export interface PublicJoinRequest {
  id: string;
  name: string;
  cardId: string;
}

function sameCard(playerCard: string | null | undefined, cardId: string | null): boolean {
  return (playerCard ?? null) === (cardId ?? null);
}

function hasNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/** A card has started once any player still on it has a stroke on any hole. */
export function cardHasScoredHole(players: readonly PlayerState[], cardId: string | null): boolean {
  return players.some((player) => {
    if (player.removed || !sameCard(player.cardId, cardId)) return false;
    if (Object.values(player.scores ?? {}).some(hasNumber)) return true;
    return Object.values(player.scorecards ?? {}).some((votes) => Object.values(votes ?? {}).some(hasNumber));
  });
}

export function publicJoinRequests(requests: readonly JoinRequest[] | null | undefined): PublicJoinRequest[] {
  return (requests ?? []).map((request) => ({ id: request.id, name: request.name, cardId: request.cardId }));
}
