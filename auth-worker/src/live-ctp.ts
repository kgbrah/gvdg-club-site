import { playerScorerId } from "./live-consensus.js";
import { canEnterScorecard } from "./live-state.js";
import type { PlayerState } from "./scoring.js";

export type CtpDefinition = {
  readonly id: number;
  readonly hole: number;
  readonly division?: string | null;
};

export type CtpConfirmedClaim = {
  readonly playerIndex: number;
  readonly at: string;
};

export type CtpLiveState = {
  readonly ctpId: number;
  readonly hole: number;
  readonly division: string | null;
  /** cardKey -> scorerId -> nominee player index */
  votes: Record<string, Record<string, number>>;
  /** cardKey -> last unanimous claim on that card */
  confirmed: Record<string, CtpConfirmedClaim>;
};

export type LiveCtpStore = Record<string, CtpLiveState>;

export type CtpLeader = {
  readonly ctpId: number;
  readonly hole: number;
  readonly playerIndex: number;
  readonly memberId: string | null;
  readonly name: string;
  readonly cardId: string | null;
};

export type PublicLiveCtpCard = {
  readonly cardId: string | null;
  readonly agreed: boolean;
  readonly nomineeIndex: number | null;
  readonly nomineeName: string | null;
  readonly votes: readonly { readonly playerIndex: number; readonly nomineeIndex: number }[];
};

export type PublicLiveCtp = {
  readonly id: number;
  readonly hole: number;
  readonly division: string | null;
  readonly leaderName: string | null;
  readonly leaderPlayerIndex: number | null;
  readonly cards: readonly PublicLiveCtpCard[];
};

export type CardLiveCtp = PublicLiveCtp & {
  readonly myVote: number | null;
  readonly agreed: boolean;
  readonly nomineeIndex: number | null;
  readonly nomineeName: string | null;
  readonly missingNames: readonly string[];
  readonly needed: number;
  readonly voted: number;
};

export type RecordCtpVoteInput = {
  readonly store: LiveCtpStore;
  readonly players: readonly PlayerState[];
  readonly ctp: CtpDefinition;
  readonly nomineeIndex: number;
  readonly scorerIndex: number;
  readonly now: string;
};

export type RecordCtpVoteResult =
  | { readonly ok: true; readonly store: LiveCtpStore; readonly leader: CtpLeader | null }
  | { readonly ok: false; readonly error: string; readonly status: number };

export function cardKey(cardId: string | null | undefined): string {
  return cardId ?? "null";
}

export function activeCardPlayers(players: readonly PlayerState[], cardId: string | null): { player: PlayerState; index: number }[] {
  const out: { player: PlayerState; index: number }[] = [];
  for (let index = 0; index < players.length; index++) {
    const player = players[index];
    if (!player || player.removed) continue;
    if ((player.cardId ?? null) !== cardId) continue;
    out.push({ player, index });
  }
  return out;
}

export function canCastCtpVote(player: PlayerState, authMember: string | null, authAdmin: boolean): boolean {
  if (authAdmin) return true;
  return canEnterScorecard(player, authMember);
}

export function parseCtpAddon(addons: unknown): boolean {
  if (addons == null) return false;
  try {
    const parsed = typeof addons === "string" ? JSON.parse(addons) : addons;
    return Boolean(parsed && typeof parsed === "object" && (parsed as { ctp?: unknown }).ctp === true);
  } catch {
    return false;
  }
}

export function ctpEligibleForStart(input: {
  readonly buyInRequired: boolean;
  readonly memberId: string | null | undefined;
  readonly enteredMemberIds: ReadonlySet<string>;
}): boolean {
  if (!input.buyInRequired) return true;
  return Boolean(input.memberId && input.enteredMemberIds.has(input.memberId));
}

export function playerCtpEligible(player: { readonly ctpEligible?: boolean } | null | undefined): boolean {
  return player?.ctpEligible !== false;
}

export function divisionMatches(ctpDivision: string | null | undefined, playerDivision: string | null | undefined): boolean {
  const ctp = String(ctpDivision || "").trim().toLowerCase();
  if (!ctp) return true;
  const player = String(playerDivision || "").trim().toLowerCase();
  if (!player) return false;
  return ctp === player;
}

export function agreedNominee(
  votes: Record<string, number> | undefined,
  card: readonly { index: number }[],
): number | null {
  if (!card.length) return null;
  const required = card.map((row) => playerScorerId(row.index));
  const first = votes?.[required[0]!];
  if (typeof first !== "number") return null;
  for (const scorerId of required) {
    if (votes?.[scorerId] !== first) return null;
  }
  return card.some((row) => row.index === first) ? first : null;
}

export function currentCtpLeader(state: CtpLiveState, players: readonly PlayerState[]): CtpLeader | null {
  let best: { at: string; playerIndex: number; cardId: string | null } | null = null;
  for (const [key, claim] of Object.entries(state.confirmed)) {
    const cardId = key === "null" ? null : key;
    const card = activeCardPlayers(players, cardId);
    if (agreedNominee(state.votes[key], card) !== claim.playerIndex) continue;
    if (!best || claim.at > best.at) best = { at: claim.at, playerIndex: claim.playerIndex, cardId };
  }
  if (!best) return null;
  const player = players[best.playerIndex];
  if (!player || player.removed || !playerCtpEligible(player)) return null;
  return {
    ctpId: state.ctpId,
    hole: state.hole,
    playerIndex: best.playerIndex,
    memberId: player.memberId ?? null,
    name: player.name,
    cardId: best.cardId,
  };
}

export function publicLiveCtps(store: LiveCtpStore, players: readonly PlayerState[]): PublicLiveCtp[] {
  return Object.values(store)
    .sort((a, b) => a.hole - b.hole || a.ctpId - b.ctpId)
    .map((state) => {
      const leader = currentCtpLeader(state, players);
      const cards = Object.keys(state.votes).map((key) => {
        const cardId = key === "null" ? null : key;
        const mates = activeCardPlayers(players, cardId);
        const votes = state.votes[key] ?? {};
        const nomineeIndex = agreedNominee(votes, mates);
        const nominee = nomineeIndex == null ? null : players[nomineeIndex];
        return {
          cardId,
          agreed: nomineeIndex != null,
          nomineeIndex,
          nomineeName: nominee && !nominee.removed ? nominee.name : null,
          votes: mates
            .filter((row) => typeof votes[playerScorerId(row.index)] === "number")
            .map((row) => ({ playerIndex: row.index, nomineeIndex: votes[playerScorerId(row.index)]! })),
        };
      });
      return {
        id: state.ctpId,
        hole: state.hole,
        division: state.division,
        leaderName: leader?.name ?? null,
        leaderPlayerIndex: leader?.playerIndex ?? null,
        cards,
      };
    });
}

export function cardLiveCtps(
  store: LiveCtpStore,
  players: readonly PlayerState[],
  cardId: string | null,
  myIndex: number | null,
): CardLiveCtp[] {
  const card = activeCardPlayers(players, cardId);
  const myScorer = myIndex == null ? null : playerScorerId(myIndex);
  return publicLiveCtps(store, players).map((row) => {
    const state = store[String(row.id)];
    const votes = state?.votes[cardKey(cardId)] ?? {};
    const nomineeIndex = state ? agreedNominee(votes, card) : null;
    const nominee = nomineeIndex == null ? null : players[nomineeIndex];
    const missingNames = card
      .filter((row) => typeof votes[playerScorerId(row.index)] !== "number")
      .map((row) => row.player.name);
    return {
      ...row,
      myVote: myScorer && typeof votes[myScorer] === "number" ? votes[myScorer]! : null,
      agreed: nomineeIndex != null,
      nomineeIndex,
      nomineeName: nominee && !nominee.removed ? nominee.name : null,
      missingNames,
      needed: card.length,
      voted: card.length - missingNames.length,
    };
  });
}

export function ctpAwardWinners(store: LiveCtpStore, players: readonly PlayerState[]): CtpLeader[] {
  const winners: CtpLeader[] = [];
  for (const state of Object.values(store)) {
    const leader = currentCtpLeader(state, players);
    if (leader) winners.push(leader);
  }
  return winners;
}

export function dropLiveCtp(store: LiveCtpStore, ctpId: number): LiveCtpStore {
  const key = String(ctpId);
  if (!(key in store)) return store;
  const next = { ...store };
  delete next[key];
  return next;
}

export function recordCtpVote(input: RecordCtpVoteInput): RecordCtpVoteResult {
  const scorer = input.players[input.scorerIndex];
  if (!scorer || scorer.removed) return { ok: false, error: "bad_scorer", status: 400 };
  const nominee = input.players[input.nomineeIndex];
  if (!nominee || nominee.removed) return { ok: false, error: "no_player", status: 404 };
  if (!playerCtpEligible(nominee)) return { ok: false, error: "not_in_ctp", status: 400 };
  if ((scorer.cardId ?? null) !== (nominee.cardId ?? null)) return { ok: false, error: "wrong_card", status: 403 };
  if (!divisionMatches(input.ctp.division, nominee.division)) return { ok: false, error: "wrong_division", status: 400 };

  const key = String(input.ctp.id);
  const existing = input.store[key];
  const state: CtpLiveState = existing
    ? {
        ...existing,
        votes: { ...existing.votes },
        confirmed: { ...existing.confirmed },
      }
    : {
        ctpId: input.ctp.id,
        hole: input.ctp.hole,
        division: input.ctp.division ?? null,
        votes: {},
        confirmed: {},
      };
  const card = cardKey(scorer.cardId);
  const cardVotes = { ...(state.votes[card] ?? {}) };
  cardVotes[playerScorerId(input.scorerIndex)] = input.nomineeIndex;
  state.votes = { ...state.votes, [card]: cardVotes };

  const mates = activeCardPlayers(input.players, scorer.cardId ?? null);
  const nomineeIndex = agreedNominee(cardVotes, mates);
  if (nomineeIndex != null) {
    const previous = state.confirmed[card];
    if (!previous || previous.playerIndex !== nomineeIndex) {
      state.confirmed = { ...state.confirmed, [card]: { playerIndex: nomineeIndex, at: input.now } };
    }
  }

  const store = { ...input.store, [key]: state };
  return { ok: true, store, leader: currentCtpLeader(state, input.players) };
}
